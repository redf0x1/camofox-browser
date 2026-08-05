/**
 * Tests for spawnXvfb() -displayfd atomic display allocation.
 *
 * These tests use a controlled-child harness that mocks child_process.spawn
 * to simulate Xvfb's fd3 protocol — no real Xvfb binary or Linux display
 * environment is required. This allows the tests to run on macOS CI.
 *
 * Coverage:
 * 1. Concurrent display uniqueness — parallel calls get distinct displays
 * 2. Split fd3 chunks — display number delivered across multiple writes
 * 3. Early exit / spawn error — rejects with proper error
 * 4. Timeout child termination — Xvfb child is killed on timeout
 * 5. Idempotent cleanup — cleanupChild() safe to call multiple times
 * 6. Display reuse after cleanup — a new spawn gets a fresh display
 */

const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

// ── Mock infrastructure ────────────────────────────────────────────
//
// We mock child_process.spawn to return a fake ChildProcess that we
// control: we can emit fd3 data in chunks, trigger errors, simulate
// exit, etc. This is the "controlled-child harness" the maintainer
// requested.
//
// Jest mock factories can't reference out-of-scope variables, so we
// use the `mock` prefix convention and define everything lazily.

const mockSpawnedProcesses = [];

class MockChildProcess extends EventEmitter {
  constructor(args) {
    super();
    this.pid = Math.floor(Math.random() * 100000) + 1000;
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
    this.args = args;
    // stdio: [stdin, stdout, stderr, fd3]
    this.stdio = [
      'ignore',
      new PassThrough(),
      new PassThrough(),
      new PassThrough(),
    ];
    this._killSignals = [];
  }

  kill(signal) {
    this._killSignals.push(signal);
    if (this.killed) return false;
    // First kill is SIGTERM; process doesn't actually die until we
    // emit 'exit' (simulated by the test).
    // For cleanup tests: after SIGKILL we mark as killed.
    if (signal === 'SIGKILL') {
      this.killed = true;
    }
    return true;
  }

  // Test helpers — simulate Xvfb behavior
  emitFd3Data(data) {
    this.stdio[3].push(Buffer.from(data));
  }

  emitFd3End() {
    this.stdio[3].end();
  }

  emitExit(code, signal) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }

  emitError(err) {
    this.emit('error', err);
  }
}

// ── Mocks ───────────────────────────────────────────────────────────

jest.mock('node:child_process', () => ({
  spawn: jest.fn((cmd, args, options) => {
    const proc = new MockChildProcess(args);
    mockSpawnedProcesses.push(proc);
    return proc;
  }),
}));

jest.mock('camoufox-js/dist/pkgman.js', () => ({
  installedVerStr: jest.fn(() => '1.0.0'),
}));

jest.mock('playwright-core', () => ({
  firefox: {
    launchPersistentContext: jest.fn(async () => ({
      pages: jest.fn(() => []),
      newPage: jest.fn(async () => ({})),
      close: jest.fn(async () => {}),
      on: jest.fn(),
    })),
  },
}));

jest.mock('camoufox-js', () => ({
  launchOptions: jest.fn(async (opts) => opts),
}));

jest.mock('camoufox-js/dist/fingerprints.js', () => ({
  generateFingerprint: jest.fn(() => ({ mocked: true })),
}));

jest.mock('../../dist/src/middleware/logging', () => ({
  log: jest.fn(),
}));

jest.mock('../../dist/src/utils/config', () => ({
  loadConfig: jest.fn(() => ({
    maxSessions: 10,
    downloadsDir: '/tmp/camofox-test/downloads',
    profilesDir: '/tmp/camofox-test/profiles',
    headless: 'virtual',
    vncResolution: '1920x1080x24',
    proxy: { host: '', port: '', username: '', password: '' },
    fingerprintDefaults: {
      os: ['linux'],
      allowWebgl: true,
      humanize: false,
      screen: { width: 1920, height: 1080 },
    },
  })),
}));

jest.mock('../../dist/src/utils/sidecar-version', () => ({
  readVersionedSidecar: jest.fn(() => null),
  writeVersionedSidecar: jest.fn(),
}));

jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'),
  mkdirSync: jest.fn(),
  existsSync: jest.fn(() => false),
}));

// ── Test suite ──────────────────────────────────────────────────────

const { spawnXvfbForTests: spawnXvfb } = require('../../dist/src/services/context-pool');

describe('spawnXvfb -displayfd atomic display allocation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSpawnedProcesses.length = 0;
  });

  afterEach(() => {
    // Clean up any lingering fake processes
    for (const proc of mockSpawnedProcesses) {
      proc.removeAllListeners();
    }
  });

  // Helper to get the most recently spawned process
  const lastSpawn = () => mockSpawnedProcesses[mockSpawnedProcesses.length - 1];

  // ── 1. Concurrent display uniqueness ───────────────────────────
  //
  // Two parallel spawnXvfb() calls must get distinct display numbers.
  // With -displayfd, Xvfb itself picks the display, so each call
  // gets whatever Xvfb assigns. We simulate two Xvfb instances
  // writing different display numbers to fd3.

  test('concurrent calls get distinct display numbers', async () => {
    const promise1 = spawnXvfb();
    const promise2 = spawnXvfb();

    expect(mockSpawnedProcesses).toHaveLength(2);

    mockSpawnedProcesses[0].emitFd3Data('99\n');
    mockSpawnedProcesses[1].emitFd3Data('100\n');

    const [result1, result2] = await Promise.all([promise1, promise2]);

    expect(result1.display).toBe(':99');
    expect(result2.display).toBe(':100');
    expect(result1.display).not.toBe(result2.display);
  });

  // ── 2. Split fd3 chunks ────────────────────────────────────────
  //
  // Xvfb might write the display number in multiple chunks (e.g.
  // "9" then "9\n"). The parser must buffer until the newline and
  // only then accept the complete record.

  test('handles split fd3 chunks across multiple writes', async () => {
    const promise = spawnXvfb();
    const proc = lastSpawn();

    // Deliver "9" then "9\n" — the parser must NOT accept "9" alone
    proc.emitFd3Data('9');
    await new Promise((r) => setTimeout(r, 10));

    // Promise should still be pending
    let resolved = false;
    await Promise.race([
      promise.then(() => { resolved = true; }),
      new Promise((r) => setTimeout(r, 50)),
    ]);
    expect(resolved).toBe(false);

    // Now deliver the rest
    proc.emitFd3Data('9\n');

    const result = await promise;
    expect(result.display).toBe(':99');
  });

  test('handles display number split at digit boundary', async () => {
    const promise = spawnXvfb();
    const proc = lastSpawn();

    // "1" then "0" then "2\n" — must not accept "1" or "10" prematurely
    proc.emitFd3Data('1');
    await new Promise((r) => setTimeout(r, 10));
    proc.emitFd3Data('0');
    await new Promise((r) => setTimeout(r, 10));

    let resolved = false;
    await Promise.race([
      promise.then(() => { resolved = true; }),
      new Promise((r) => setTimeout(r, 50)),
    ]);
    expect(resolved).toBe(false);

    proc.emitFd3Data('2\n');
    const result = await promise;
    expect(result.display).toBe(':102');
  });

  test('ignores non-digit content before the display number', async () => {
    const promise = spawnXvfb();
    const proc = lastSpawn();

    // Xvfb might emit a leading newline or whitespace
    proc.emitFd3Data('\n');
    await new Promise((r) => setTimeout(r, 10));
    proc.emitFd3Data('44\n');

    const result = await promise;
    expect(result.display).toBe(':44');
  });

  // ── 3. Early exit / spawn error ────────────────────────────────

  test('rejects when Xvfb exits early with non-zero code', async () => {
    const promise = spawnXvfb();
    const proc = lastSpawn();

    proc.emitExit(1, null);

    await expect(promise).rejects.toThrow('Xvfb exited early (code=1, signal=null)');
  });

  test('rejects when Xvfb exits with a signal', async () => {
    const promise = spawnXvfb();
    const proc = lastSpawn();

    proc.emitExit(null, 'SIGSEGV');

    await expect(promise).rejects.toThrow('Xvfb exited early (code=null, signal=SIGSEGV)');
  });

  test('rejects when spawn emits an error', async () => {
    const promise = spawnXvfb();
    const proc = lastSpawn();

    proc.emitError(new Error('spawn EACCES'));

    await expect(promise).rejects.toThrow('spawn EACCES');
  });

  test('rejects when fd3 closes before writing display number', async () => {
    const promise = spawnXvfb();
    const proc = lastSpawn();

    proc.emitFd3End();

    await expect(promise).rejects.toThrow('fd3 closed before writing display number');
  });

  // ── 4. Timeout child termination ───────────────────────────────
  //
  // When the 5s timeout fires, the Xvfb child must be killed
  // (SIGTERM, then SIGKILL after 3s). Previously the timeout
  // rejected without terminating the child, leaking the process.

  test('terminates Xvfb child on timeout', async () => {
    jest.useFakeTimers();
    let rejection = null;
    const promise = spawnXvfb().catch((err) => { rejection = err; });
    const proc = lastSpawn();

    // Fast-forward past the 5s timeout
    jest.advanceTimersByTime(5001);
    await promise;

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection.message).toBe('Xvfb start timeout');

    // SIGTERM should have been sent
    expect(proc._killSignals).toContain('SIGTERM');

    // Fast-forward past the 3s SIGKILL timer
    jest.advanceTimersByTime(3001);
    expect(proc._killSignals).toContain('SIGKILL');

    jest.useRealTimers();
  });

  // ── 5. Idempotent cleanup ──────────────────────────────────────
  //
  // cleanupChild() must be safe to call multiple times from different
  // error paths. If both the timeout and the exit handler fire,
  // the child should only receive one set of kill signals.

  test('cleanup is idempotent — exit after timeout does not double-kill', async () => {
    jest.useFakeTimers();
    let rejection = null;
    const promise = spawnXvfb().catch((err) => { rejection = err; });
    const proc = lastSpawn();

    // Fire timeout
    jest.advanceTimersByTime(5001);

    // While the timeout is being processed, Xvfb also exits
    proc.emitExit(0, null);

    await promise;

    // SIGTERM should appear at most once (cleanupChild is idempotent)
    const sigtermCount = proc._killSignals.filter((s) => s === 'SIGTERM').length;
    expect(sigtermCount).toBeLessThanOrEqual(1);

    jest.useRealTimers();
  });

  test('cleanup is idempotent — error then exit does not double-kill', async () => {
    const promise = spawnXvfb();
    const proc = lastSpawn();

    proc.emitError(new Error('spawn ENOENT'));
    proc.emitExit(1, null);

    try {
      await promise;
    } catch {
      // expected
    }

    const sigtermCount = proc._killSignals.filter((s) => s === 'SIGTERM').length;
    expect(sigtermCount).toBeLessThanOrEqual(1);
  });

  // ── 6. Display reuse after cleanup ─────────────────────────────
  //
  // After a failed spawnXvfb (e.g. timeout), a subsequent call
  // should be able to get a display from a new Xvfb process.

  test('subsequent call succeeds after a failed spawn', async () => {
    // First call fails (timeout)
    jest.useFakeTimers();
    const promise1 = spawnXvfb().catch((err) => err);
    jest.advanceTimersByTime(5001);
    const rejection = await promise1;
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection.message).toBe('Xvfb start timeout');
    jest.useRealTimers();

    // Second call succeeds
    const promise2 = spawnXvfb();
    expect(mockSpawnedProcesses).toHaveLength(2);
    mockSpawnedProcesses[1].emitFd3Data('55\n');

    const result = await promise2;
    expect(result.display).toBe(':55');
  });

  // ── 7. Successful spawn returns the process ───────────────────

  test('returns the ChildProcess on success', async () => {
    const promise = spawnXvfb();
    const proc = lastSpawn();

    proc.emitFd3Data('77\n');

    const result = await promise;
    expect(result.display).toBe(':77');
    expect(result.process).toBe(proc);
  });
});