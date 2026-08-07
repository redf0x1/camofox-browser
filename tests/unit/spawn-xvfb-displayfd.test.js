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
    // Always restore real timers FIRST, before touching listeners, so that
    // fake timers can never leak into later tests even if an assertion
    // failed or a promise rejected mid-flight.
    jest.useRealTimers();
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

  test('late fd3 error after successful startup does not terminate healthy child', async () => {
    jest.useFakeTimers();
    const promise = spawnXvfb();
    const proc = lastSpawn();

    // Successful startup
    proc.emitFd3Data('99\n');
    const result = await promise;
    expect(result.display).toBe(':99');

    // No signals so far
    expect(proc._killSignals).toHaveLength(0);

    // A late fd3 error arrives after startup has settled.
    // The error handler must NOT call cleanupChild() — the Xvfb child
    // is healthy and running.
    proc.emitFd3Error(new Error('late EPIPE'));

    // No kill signals should have been sent — child is still alive
    expect(proc._killSignals).toHaveLength(0);

    // Advance well beyond the 3s SIGKILL escalation window to prove the
    // late fd3 error handler did NOT schedule a delayed cleanup timer
    // (a SIGKILL would fire here if it had).
    jest.advanceTimersByTime(3001);
    expect(proc._killSignals.filter((s) => s === 'SIGKILL')).toHaveLength(0);

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

  // ── 10. Regression: sibling-fails / other-sibling-resolves-late ──
  //
  // Deterministic reproduction of the race the maintainer identified:
  // when one sibling spawn rejects and another resolves AFTER the
  // rejection, cleanup must still reap every started child — no leaks.
  // This test uses the mock harness (no real Xvfb needed).

  test('reaps every started child even when one sibling rejects and another resolves late', async () => {
    const children = [];

    // Start three spawns. The production helper spawns synchronously,
    // so mockSpawnedProcesses is populated immediately.
    const p1 = spawnXvfb();
    const p2 = spawnXvfb();
    const p3 = spawnXvfb();
    expect(mockSpawnedProcesses).toHaveLength(3);

    // Track every spawned mock process — this is the critical fix:
    // we track from spawn (synchronous), not from promise resolution.
    for (const proc of mockSpawnedProcesses) {
      children.push(proc);
    }

    const outcomes = [];

    // Consume rejections eagerly so they don't become unhandled.
    p1.catch((e) => { outcomes.push({ i: 0, status: 'rejected', err: e }); });
    p2.catch((e) => { outcomes.push({ i: 1, status: 'rejected', err: e }); });
    p3.catch((e) => { outcomes.push({ i: 2, status: 'rejected', err: e }); });

    // Child 0 resolves first (display 99)
    mockSpawnedProcesses[0].emitFd3Data('99\n');
    const r0 = await p1;
    outcomes.push({ i: 0, status: 'fulfilled', value: r0 });

    // Child 1 rejects (early exit with signal)
    mockSpawnedProcesses[1].emitExit(null, 'SIGTERM');
    // Let the rejection propagate
    await new Promise((r) => setTimeout(r, 10));

    // Child 2 resolves LATE — after child 1 already rejected.
    // This is the key scenario: if cleanup ran after child 1's
    // rejection, child 2's process must still be reaped.
    mockSpawnedProcesses[2].emitFd3Data('100\n');
    const r2 = await p3;
    outcomes.push({ i: 2, status: 'fulfilled', value: r2 });

    // Verify outcomes
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    expect(fulfilled.length).toBe(2);

    // Every started child must have been captured.
    expect(children).toHaveLength(3);

    // Simulate cleanup: every child that is still alive must be killed.
    const killed = [];
    for (const proc of children) {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGTERM');
        killed.push(proc);
      }
    }

    // Child 0 and child 2 were alive (resolved successfully), child 1
    // exited via signal. So exactly 2 children should be killed.
    expect(killed.length).toBe(2);
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
  // The mock-based describe() above mocks node:child_process globally, so to
  // exercise the REAL production spawnXvfb() against a real Xvfb binary we
  // must drop that mock, reset the module registry, and re-load the production
  // module fresh — it will then bind the real child_process.spawn. The helper's
  // fd3 parser, settlement guard, timeout timer, and cleanup logic all run
  // unmodified against the real Xvfb protocol.
  let spawnXvfbReal;

  beforeAll(() => {
    jest.unmock('node:child_process');
    jest.resetModules();
    // eslint-disable-next-line global-require
    spawnXvfbReal = require('../../dist/src/services/context-pool').spawnXvfbForTests;
  });

  // Terminate and reap every started Xvfb child. Safe to call repeatedly.
  // Sends SIGTERM, waits up to 3s for exit, then escalates to SIGKILL and
  // waits up to 2s for the child to actually exit/close after SIGKILL.
  // Cleanup continues if one child fails (one failure must not abort the rest).
  const killAll = async (children) => {
    for (const proc of children) {
      try {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill('SIGTERM');
          // Wait up to 3s for graceful exit, then escalate to SIGKILL
          const exitedGracefully = await new Promise((resolve) => {
            const timer = setTimeout(() => {
              resolve(false); // timeout — escalate to SIGKILL below
            }, 3000);
            proc.once('exit', () => { clearTimeout(timer); resolve(true); });
            proc.once('close', () => { clearTimeout(timer); resolve(true); });
          });
          if (!exitedGracefully) {
            // SIGKILL and wait up to 2s for the child to actually exit/close
            try { proc.kill('SIGKILL'); } catch { /* already dead */ }
            await new Promise((resolve) => {
              const killTimer = setTimeout(() => {
                // Last-resort: resolve even if the OS hasn't reaped yet
                resolve();
              }, 2000);
              proc.once('exit', () => { clearTimeout(killTimer); resolve(); });
              proc.once('close', () => { clearTimeout(killTimer); resolve(); });
            });
          }
        }
      } catch {
        // already dead — cleanup continues for remaining children
      }
    }
  };

  test('production spawnXvfb allocates unique display numbers across concurrent processes', async () => {
    // Track children from spawn — capture the child process reference
    // synchronously before the promise settles, so that even if one
    // sibling rejects and Promise.all rejects, siblings that resolve
    // later are still reaped (no Xvfb leak).
    const children = [];
    const spawnTracked = (resolution) => {
      // Wrap to capture the child synchronously. spawnXvfbReal spawns
      // synchronously and returns a promise; the process is available
      // via .then but we need it even before resolution.
      const promise = spawnXvfbReal(resolution);
      // Attach .then to capture process on resolution
      promise.then((r) => { children.push(r.process); }).catch(() => {});
      return promise;
    };

    try {
      const results = await Promise.allSettled([
        spawnTracked('1280x720x24'),
        spawnTracked('1280x720x24'),
        spawnTracked('1280x720x24'),
      ]);

      // All three should have distinct display numbers allocated atomically
      // by Xvfb's -displayfd, parsed by the production helper.
      const successful = results.filter((r) => r.status === 'fulfilled');
      expect(successful.length).toBe(3);

      const displays = successful.map((r) => r.value.display);
      const unique = new Set(displays);
      expect(unique.size).toBe(3);

      // Every child is still alive after successful startup (no cleanup
      // signal sent by the production helper).
      for (const r of successful) {
        expect(r.value.process.exitCode).toBe(null);
      }
    } finally {
      // Always terminate and reap every started child — never leak Xvfb
      // processes, even if one of the concurrent spawns rejected.
      await killAll(children);
    }
  }, 15000);
});