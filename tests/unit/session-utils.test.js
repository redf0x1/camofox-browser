function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// session.ts imports context-pool, which imports camoufox-js (ESM). These unit tests only
// need withUserLimit(), so we mock the heavy dependencies to keep Jest in CommonJS mode.
jest.mock('../../dist/src/services/context-pool', () => {
  return {
    contextPool: {
      onEvict: () => {},
      ensureContext: async () => ({ context: {} }),
      closeContext: async () => {},
      closeAll: async () => {},
    },
  };
});

jest.mock('../../dist/src/middleware/logging', () => ({
  log: () => {},
}));

jest.mock('../../dist/src/utils/config', () => ({
  loadConfig: () => ({ proxy: { host: '' }, serverEnv: {} }),
}));

jest.mock('../../dist/src/services/tab', () => ({
  clearTabLock: () => {},
  clearAllTabLocks: () => {},
}));

describe('session.ts utilities (unit)', () => {
  /** @type {(userId: string, max: number, op: () => Promise<any>) => Promise<any>} */
  let withUserLimit;
  /** @type {() => void} */
  let clearAllState;
  /** @type {(userId: string) => ({active:number, queueLength:number} | null)} */
  let __getUserConcurrencyStateForTests;

  beforeEach(() => {
    jest.resetModules();
    ({
      withUserLimit,
      clearAllState,
      __getUserConcurrencyStateForTests,
    } = require('../../dist/src/services/session'));

    clearAllState();
  });

  afterEach(() => {
    // Best-effort cleanup in case a test fails mid-flight.
    try {
      clearAllState();
    } catch {}
    jest.useRealTimers();
  });

  test('allows operations within concurrency limit', async () => {
    const events = [];
    const d1 = deferred();
    const d2 = deferred();

    const p1 = withUserLimit('userA', 2, async () => {
      events.push('op1-start');
      return d1.promise;
    });

    const p2 = withUserLimit('userA', 2, async () => {
      events.push('op2-start');
      return d2.promise;
    });

    await Promise.resolve();
    expect(events).toEqual(['op1-start', 'op2-start']);

    d1.resolve('r1');
    d2.resolve('r2');

    await expect(p1).resolves.toBe('r1');
    await expect(p2).resolves.toBe('r2');
  });

  test('queues operations beyond concurrency limit', async () => {
    const events = [];
    const d1 = deferred();
    const d2 = deferred();

    const p1 = withUserLimit('userA', 1, async () => {
      events.push('op1-start');
      return d1.promise;
    });

    const p2 = withUserLimit('userA', 1, async () => {
      events.push('op2-start');
      return d2.promise;
    });

    await Promise.resolve();
    expect(events).toEqual(['op1-start']);

    d1.resolve('r1');
    await expect(p1).resolves.toBe('r1');

    // op2 should start only after op1 completes.
    await Promise.resolve();
    expect(events).toEqual(['op1-start', 'op2-start']);

    d2.resolve('r2');
    await expect(p2).resolves.toBe('r2');
  });

  test('processes queued operations when slot opens', async () => {
    const events = [];
    const d1 = deferred();
    const d2 = deferred();

    const p1 = withUserLimit('userA', 1, async () => {
      events.push('op1-start');
      return d1.promise;
    });

    const p2 = withUserLimit('userA', 1, async () => {
      events.push('op2-start');
      return d2.promise;
    });

    await Promise.resolve();
    expect(events).toEqual(['op1-start']);

    d1.resolve('done1');
    await expect(p1).resolves.toBe('done1');

    await Promise.resolve();
    expect(events).toEqual(['op1-start', 'op2-start']);

    d2.resolve('done2');
    await expect(p2).resolves.toBe('done2');
  });

  test('rejects with error after 30s queue timeout', async () => {
    jest.useFakeTimers();

    const d1 = deferred();

    const p1 = withUserLimit('userA', 1, async () => {
      return d1.promise;
    });

    const p2 = withUserLimit('userA', 1, async () => {
      return 'should-not-run';
    });

    // p2 is queued; after 30s it should fail.
    jest.advanceTimersByTime(30000);
    await expect(p2).rejects.toThrow('User concurrency limit reached, try again');

    // Callback should be removed from the queue after timeout.
    const midState = __getUserConcurrencyStateForTests('userA');
    expect(midState).toEqual({ active: 1, queueLength: 0 });

    // Cleanly finish op1; state should auto-cleanup.
    d1.resolve('ok');
    await expect(p1).resolves.toBe('ok');

    expect(__getUserConcurrencyStateForTests('userA')).toBeNull();
  });

  test('removes stale callback from queue on timeout', async () => {
    jest.useFakeTimers();

    const d1 = deferred();

    const p1 = withUserLimit('userA', 1, async () => d1.promise);
    const p2 = withUserLimit('userA', 1, async () => 'never');

    jest.advanceTimersByTime(30000);
    await expect(p2).rejects.toThrow();

    expect(__getUserConcurrencyStateForTests('userA')).toEqual({ active: 1, queueLength: 0 });

    d1.resolve('ok');
    await expect(p1).resolves.toBe('ok');
  });

  test('cleans up state when no active operations', async () => {
    await expect(withUserLimit('userA', 1, async () => 'ok')).resolves.toBe('ok');
    expect(__getUserConcurrencyStateForTests('userA')).toBeNull();
  });

  test('handles concurrent operations for different users independently', async () => {
    const events = [];
    const d1 = deferred();
    const d2 = deferred();

    const p1 = withUserLimit('userA', 1, async () => {
      events.push('userA-start');
      return d1.promise;
    });

    const p2 = withUserLimit('userB', 1, async () => {
      events.push('userB-start');
      return d2.promise;
    });

    await Promise.resolve();
    expect(events.sort()).toEqual(['userA-start', 'userB-start']);

    d1.resolve('a');
    d2.resolve('b');

    await expect(p1).resolves.toBe('a');
    await expect(p2).resolves.toBe('b');
  });

  test('properly decrements counter even when operation throws', async () => {
    const events = [];

    const p1 = withUserLimit('userA', 1, async () => {
      events.push('op1-start');
      throw new Error('fail-op1');
    });

    const p2 = withUserLimit('userA', 1, async () => {
      events.push('op2-start');
      return 'ok-op2';
    });

    await expect(p1).rejects.toThrow('fail-op1');
    await expect(p2).resolves.toBe('ok-op2');

    expect(events).toEqual(['op1-start', 'op2-start']);
    expect(__getUserConcurrencyStateForTests('userA')).toBeNull();
  });
});
