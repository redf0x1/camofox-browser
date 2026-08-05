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
 * 3. Multi-record same-chunk — blank, malformed, CRLF, multiple records
 * 4. Early exit / spawn error / fd3 error / fd3 close — rejects with proper error
 * 5. Timeout child termination — Xvfb child is killed on timeout
 * 6. Idempotent cleanup — exactly one SIGTERM, no SIGKILL after observed exit
 * 7. No signals after successful startup
 * 8. Display reuse after cleanup — a new spawn gets a fresh display
 * 9. Native Xvfb contract (Linux-only, gated on which Xvfb)
 */

const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { execSync } = require('node:child_process');

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
    this._exited = false;
  }

  kill(signal) {
    this._killSignals.push(signal);
    if (this._exited) return false;
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

  emitFd3Error(err) {
    this.stdio[3].destroy(err);
  }

  emitFd3Close() {
    // Simulate pipe close without end — destroy the stream
    this.stdio[3].destroy();
  }

  emitExit(code, signal) {
    this._exited = true;
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
  // Preserve execSync for the native Xvfb detection helper
  execSync: jest.requireActual('node:child_process').execSync,
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
    for (const proc of mockSpawnedProcesses) {
      proc.removeAllListeners();
    }
  });

  const lastSpawn = () => mockSpawnedProcesses[mockSpawnedProcesses.length - 1];

  // ── 1. Concurrent display uniqueness ───────────────────────────

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

  test('handles split fd3 chunks across multiple writes', async () => {
    const promise = spawnXvfb();
    const proc = lastSpawn();

    proc.emitFd3Data('9');
    await new Promise((r) => setTimeout(r, 10));

    let resolved = false;
    await Promise.race([
      promise.then(() => { resolved = true; }),
      new Promise((r) => setTimeout(r, 50)),
    ]);
    expect(resolved).toBe(false);

    proc.emitFd3Data('9\n');

    const result = await promise;
    expect(result.display).toBe(':99');
  });

  test('handles display number split at digit boundary', async () => {
    const promise = spawnXvfb();
    const proc = lastSpawn();

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

  // ── 3. Multi-record same-chunk ────────────────────────────────
  //
  // A single data event may contain multiple newline-delimited records.
  // The parser must process ALL complete records in the buffer, skip
  // blank/malformed lines, and resolve on the first valid display number.

  test('processes blank leading record then valid display in same chunk', async () => {
    const promise = spawnXvfb();
    const proc = lastSpawn();

    // "\n44\n" — blank line then valid display, all in one write
    proc.emitFd3Data('\n44\n');

    const result = await promise;
    expect(result.display).toBe(':44');
  });

  test('processes malformed record then valid display in same chunk', async () => {
    const promise = spawnXvfb();
    const proc = lastSpawn();

    // "invalid\n44\n" — malformed line then valid display
    proc.emitFd3Data('invalid\n44\n');

    const result = await promise;
    expect(result.display).toBe(':44');
  });

  test('processes multiple valid records — resolves on first', async () => {
    const promise = spawnXvfb();
    const proc = lastSpawn();

    // "99\n100\n" — two valid records, should resolve on the first
    proc.emitFd3Data('99\n100\n');

    const result = await promise;
    expect(result.display).toBe(':99');
  });

  test('handles CRLF line endings', async () => {
    const promise = spawnXvfb();
    const proc = lastSpawn();

    // "44\r\n" — CRLF instead of LF
    proc.emitFd3Data('44\r\n');

    const result = await promise;
    expect(result.display).toBe(':44');
  });

  test('handles EOF without newline — rejects after timeout', async () => {
    jest.useFakeTimers();
    let rejection = null;
    const promise = spawnXvfb().catch((err) => { rejection = err; });
    const proc = lastSpawn();

    // Write data without a newline — no complete record
    proc.emitFd3Data('99');

    // Fast-forward past timeout — no data event will complete the record
    jest.advanceTimersByTime(5001);
    await promise;

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection.message).toBe('Xvfb start timeout');

    // Should have sent exactly one SIGTERM for cleanup
    expect(proc._killSignals.filter((s) => s === 'SIGTERM')).toHaveLength(1);

    jest.useRealTimers();
  });

  // ── 4. Early exit / spawn error / fd3 error / fd3 close ────────

  test('rejects when Xvfb exits early with non-zero code', async () => {
    const promise = spawnXvfb();
    const proc = lastSpawn();

    proc.emitExit(1, null);

    await expect(promise).rejects.toThrow('Xvfb exited early (code=1, signal=null)');
    // No cleanup signals — child already exited, cleanupChild() is a no-op
    expect(proc._killSignals).toHaveLength(0);
  });

  test('rejects when Xvfb exits with a signal', async () => {
    const promise = spawnXvfb();
    const proc = lastSpawn();

    proc.emitExit(null, 'SIGSEGV');

    await expect(promise).rejects.toThrow('Xvfb exited early (code=null, signal=SIGSEGV)');
    expect(proc._killSignals).toHaveLength(0);
  });

  test('rejects when spawn emits an error', async () => {
    const promise = spawnXvfb();
    const proc = lastSpawn();

    proc.emitError(new Error('spawn EACCES'));

    await expect(promise).rejects.toThrow('spawn EACCES');
    expect(proc._killSignals.filter((s) => s === 'SIGTERM')).toHaveLength(1);
  });

  test('rejects when fd3 stream emits an error', async () => {
    const promise = spawnXvfb();
    const proc = lastSpawn();

    proc.emitFd3Error(new Error('EPIPE'));

    await expect(promise).rejects.toThrow('fd3 stream error: EPIPE');
    // Exactly one SIGTERM for cleanup
    expect(proc._killSignals.filter((s) => s === 'SIGTERM')).toHaveLength(1);
  });

  test('rejects when fd3 closes before writing display number', async () => {
    const promise = spawnXvfb();
    const proc = lastSpawn();

    proc.emitFd3End();

    await expect(promise).rejects.toThrow('fd3 closed before writing display number');
    expect(proc._killSignals.filter((s) => s === 'SIGTERM')).toHaveLength(1);
  });

  test('rejects when fd3 pipe closes without end event', async () => {
    const promise = spawnXvfb();
    const proc = lastSpawn();

    proc.emitFd3Close();

    // Should reject with either 'closed' or 'closed before writing'
    await expect(promise).rejects.toThrow(/fd3 stream (closed|closed before writing) display number/);
    expect(proc._killSignals.filter((s) => s === 'SIGTERM')).toHaveLength(1);
  });

  // ── 5. Timeout child termination ───────────────────────────────

  test('terminates Xvfb child on timeout with exactly one SIGTERM', async () => {
    jest.useFakeTimers();
    let rejection = null;
    const promise = spawnXvfb().catch((err) => { rejection = err; });
    const proc = lastSpawn();

    jest.advanceTimersByTime(5001);
    await promise;

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection.message).toBe('Xvfb start timeout');

    // Exactly one SIGTERM — not zero, not two
    expect(proc._killSignals.filter((s) => s === 'SIGTERM')).toHaveLength(1);

    // SIGKILL should NOT have been sent yet (child hasn't exited)
    expect(proc._killSignals).not.toContain('SIGKILL');

    // Fast-forward past the 3s SIGKILL timer — child still alive
    jest.advanceTimersByTime(3001);
    expect(proc._killSignals.filter((s) => s === 'SIGKILL')).toHaveLength(1);

    jest.useRealTimers();
  });

  // ── 6. Idempotent cleanup with exact assertions ─────────────────

  test('cleanup is idempotent — exit after timeout: exactly one SIGTERM, no SIGKILL after exit', async () => {
    jest.useFakeTimers();
    let rejection = null;
    const promise = spawnXvfb().catch((err) => { rejection = err; });
    const proc = lastSpawn();

    // Fire timeout
    jest.advanceTimersByTime(5001);

    // While the timeout is being processed, Xvfb also exits
    proc.emitExit(0, null);

    await promise;

    // Exactly one SIGTERM (cleanupChild is idempotent)
    expect(proc._killSignals.filter((s) => s === 'SIGTERM')).toHaveLength(1);

    // No SIGKILL — the escalation timer was canceled by onChildExit
    expect(proc._killSignals).not.toContain('SIGKILL');

    // Advance past the SIGKILL timer — should NOT fire
    jest.advanceTimersByTime(3001);
    expect(proc._killSignals).not.toContain('SIGKILL');

    jest.useRealTimers();
  });

  test('cleanup is idempotent — error then exit: exactly one SIGTERM, no SIGKILL after exit', async () => {
    const promise = spawnXvfb().catch(() => {});
    const proc = lastSpawn();

    proc.emitError(new Error('spawn ENOENT'));
    proc.emitExit(1, null);

    await promise;

    // Exactly one SIGTERM
    expect(proc._killSignals.filter((s) => s === 'SIGTERM')).toHaveLength(1);
    // No SIGKILL — timer was canceled by exit
    expect(proc._killSignals).not.toContain('SIGKILL');
  });

  test('no duplicate escalation — only one SIGKILL when child stays alive', async () => {
    jest.useFakeTimers();
    let rejection = null;
    const promise = spawnXvfb().catch((err) => { rejection = err; });
    const proc = lastSpawn();

    // Fire timeout
    jest.advanceTimersByTime(5001);
    await promise;

    // One SIGTERM
    expect(proc._killSignals.filter((s) => s === 'SIGTERM')).toHaveLength(1);

    // Advance past SIGKILL timer
    jest.advanceTimersByTime(3001);
    // Exactly one SIGKILL
    expect(proc._killSignals.filter((s) => s === 'SIGKILL')).toHaveLength(1);

    // Advance further — no additional SIGKILL
    jest.advanceTimersByTime(3001);
    expect(proc._killSignals.filter((s) => s === 'SIGKILL')).toHaveLength(1);

    jest.useRealTimers();
  });

  // ── 7. No signals after successful startup ─────────────────────

  test('no kill signals sent after successful startup', async () => {
    const promise = spawnXvfb();
    const proc = lastSpawn();

    proc.emitFd3Data('77\n');

    const result = await promise;
    expect(result.display).toBe(':77');

    // No kill signals should have been sent — child is alive and healthy
    expect(proc._killSignals).toHaveLength(0);
  });

  test('post-success exit sends no cleanup signals and schedules no new timer', async () => {
    jest.useFakeTimers();
    const promise = spawnXvfb();
    const proc = lastSpawn();

    // Successful startup
    proc.emitFd3Data('77\n');
    const result = await promise;
    expect(result.display).toBe(':77');

    // No signals so far
    expect(proc._killSignals).toHaveLength(0);

    // Child exits normally after startup — no cleanup signals
    proc.emitExit(0, null);

    // Still no signals — exit handler does not call cleanupChild()
    expect(proc._killSignals).toHaveLength(0);

    // Advance past the 3s SIGKILL escalation window — no timer should fire
    jest.advanceTimersByTime(3001);
    expect(proc._killSignals).toHaveLength(0);

    jest.useRealTimers();
  });

  test('post-success exit does not create new escalation timer', async () => {
    jest.useFakeTimers();
    const promise = spawnXvfb();
    const proc = lastSpawn();

    // Successful startup
    proc.emitFd3Data('42\n');
    await promise;

    // Exit after success
    proc.emitExit(0, null);

    // Advance well beyond any escalation timer
    jest.advanceTimersByTime(10000);
    expect(proc._killSignals).toHaveLength(0);

    jest.useRealTimers();
  });

  test('early exit sends no SIGTERM or SIGKILL even after advancing timers', async () => {
    jest.useFakeTimers();
    const promise = spawnXvfb().catch((err) => err);
    const proc = lastSpawn();

    // Exit before fd3 data arrives
    proc.emitExit(1, null);

    const rejection = await promise;
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection.message).toBe('Xvfb exited early (code=1, signal=null)');

    // No signals at all — child already dead
    expect(proc._killSignals).toHaveLength(0);

    // Advance past any potential escalation timer
    jest.advanceTimersByTime(3001);
    expect(proc._killSignals).toHaveLength(0);

    jest.useRealTimers();
  });

  test('exit after timeout: timeout sends SIGTERM, exit cancels SIGKILL timer', async () => {
    jest.useFakeTimers();
    let rejection = null;
    const promise = spawnXvfb().catch((err) => { rejection = err; });
    const proc = lastSpawn();

    // Fire timeout — sends SIGTERM and schedules SIGKILL timer
    jest.advanceTimersByTime(5001);

    // While timeout is processing, Xvfb exits
    proc.emitExit(0, null);

    await promise;

    // Timeout sent exactly one SIGTERM (child was alive at that point)
    expect(proc._killSignals.filter((s) => s === 'SIGTERM')).toHaveLength(1);

    // Exit canceled the SIGKILL timer — no SIGKILL even after advancing
    jest.advanceTimersByTime(3001);
    expect(proc._killSignals).not.toContain('SIGKILL');

    jest.useRealTimers();
  });

  // ── 8. Display reuse after cleanup ────────────────────────────

  test('subsequent call succeeds after a failed spawn', async () => {
    jest.useFakeTimers();
    const promise1 = spawnXvfb().catch((err) => err);
    jest.advanceTimersByTime(5001);
    const rejection = await promise1;
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection.message).toBe('Xvfb start timeout');
    jest.useRealTimers();

    const promise2 = spawnXvfb();
    expect(mockSpawnedProcesses).toHaveLength(2);
    mockSpawnedProcesses[1].emitFd3Data('55\n');

    const result = await promise2;
    expect(result.display).toBe(':55');
  });

  // ── 9. Successful spawn returns the process ────────────────────

  test('returns the ChildProcess on success', async () => {
    const promise = spawnXvfb();
    const proc = lastSpawn();

    proc.emitFd3Data('77\n');

    const result = await promise;
    expect(result.display).toBe(':77');
    expect(result.process).toBe(proc);
  });
});

// ── Native Xvfb contract tests (Linux-only) ─────────────────────────
//
// These tests run only when Xvfb is available on the system. They verify
// that real Xvfb -displayfd allocates unique display numbers across
// concurrent processes — complementing the mock-based tests above.
//
// The repo's CI runs on ubuntu-latest which has Xvfb pre-installed.

function hasXvfb() {
  try {
    execSync('which Xvfb', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const nativeDescribe = hasXvfb() ? describe : describe.skip;

nativeDescribe('spawnXvfb native Xvfb contract (Linux-only)', () => {

  test('native Xvfb allocates unique display numbers across concurrent processes', async () => {
    // Use the REAL spawn — not the mock. jest.mock replaces the module
    // globally, so we need jest.requireActual to get the real implementation.
    const { spawn: realSpawnFn } = jest.requireActual('node:child_process');

    const spawnReal = () => new Promise((resolve, reject) => {
      const proc = realSpawnFn('Xvfb', [
        '-displayfd', '3',
        '-screen', '0', '1280x720x24',
        '-ac', '-nolisten', 'tcp',
      ], {
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      });

      const timeout = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch {}
        reject(new Error('Xvfb start timeout'));
      }, 10000);

      const fd3 = proc.stdio[3];
      let buf = '';
      fd3.on('data', (chunk) => {
        buf += chunk.toString();
        const idx = buf.indexOf('\n');
        if (idx !== -1) {
          const line = buf.slice(0, idx).trim();
          const match = line.match(/^(\d+)$/);
          if (match) {
            clearTimeout(timeout);
            resolve({ display: `:${match[1]}`, process: proc });
          }
        }
      });

      proc.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      proc.once('exit', (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`Xvfb exited early (code=${code}, signal=${signal})`));
      });
    });

    // Spawn 3 concurrent Xvfb processes
    const results = await Promise.all([spawnReal(), spawnReal(), spawnReal()]);

    // All should have distinct displays
    const displays = results.map((r) => r.display);
    const unique = new Set(displays);
    expect(unique.size).toBe(3);

    // Cleanup
    for (const r of results) {
      try { r.process.kill('SIGTERM'); } catch {}
    }
  }, 15000);
});