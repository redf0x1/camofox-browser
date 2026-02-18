const { withTimeout, safePageClose } = require('../../dist/src/services/tab');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('tab.ts utilities (unit)', () => {
  describe('withTimeout()', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      // Ensure no timers leak between tests.
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    });

    test('resolves when promise resolves before timeout', async () => {
      const resultPromise = withTimeout(Promise.resolve('ok'), 1000, 'test-op');
      await expect(resultPromise).resolves.toBe('ok');
      expect(jest.getTimerCount()).toBe(0);
    });

    test('rejects with timeout error when promise takes too long', async () => {
      const never = new Promise(() => {});
      const resultPromise = withTimeout(never, 1000, 'slow-op');

      jest.advanceTimersByTime(1000);
      await expect(resultPromise).rejects.toThrow('slow-op timed out after 1000ms');
      expect(jest.getTimerCount()).toBe(0);
    });

    test('includes label in timeout error message', async () => {
      const never = new Promise(() => {});
      const resultPromise = withTimeout(never, 250, 'label-xyz');

      jest.advanceTimersByTime(250);
      await expect(resultPromise).rejects.toThrow('label-xyz timed out after 250ms');
    });

    test('timer is properly cleaned up on success (no dangling timers)', async () => {
      const d = deferred();
      const resultPromise = withTimeout(d.promise, 5000, 'cleanup');

      // A timer should be set while the operation is in flight.
      expect(jest.getTimerCount()).toBe(1);

      d.resolve(123);
      await expect(resultPromise).resolves.toBe(123);
      expect(jest.getTimerCount()).toBe(0);
    });

    test('works with different types (generic)', async () => {
      const obj = { a: 1, b: 'two' };
      await expect(withTimeout(Promise.resolve(obj), 1000, 'generic')).resolves.toBe(obj);

      await expect(withTimeout(Promise.resolve(42), 1000, 'generic-number')).resolves.toBe(42);
    });

    test('rejects with original error when promise rejects before timeout', async () => {
      const err = new Error('boom');
      await expect(withTimeout(Promise.reject(err), 1000, 'reject-op')).rejects.toBe(err);
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('safePageClose()', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    test('calls page.close() and completes', async () => {
      const page = { close: jest.fn().mockResolvedValue(undefined) };

      const resultPromise = safePageClose(page);
      await expect(resultPromise).resolves.toBeUndefined();

      expect(page.close).toHaveBeenCalledTimes(1);

      // safePageClose() schedules a 5s timer; flush it so it doesn't leak.
      jest.advanceTimersByTime(5000);
    });

    test('returns void even if page.close() throws', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const page = { close: jest.fn().mockRejectedValue(new Error('close failed')) };

      await expect(safePageClose(page)).resolves.toBeUndefined();

      expect(page.close).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('[camofox] page close failed:');

      jest.advanceTimersByTime(5000);
    });

    test('returns void if page.close() hangs (triggers 5s timeout)', async () => {
      const page = { close: jest.fn().mockImplementation(() => new Promise(() => {})) };

      const p = safePageClose(page);

      jest.advanceTimersByTime(4999);
      let settled = false;
      void p.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      jest.advanceTimersByTime(1);
      await expect(p).resolves.toBeUndefined();
      expect(page.close).toHaveBeenCalledTimes(1);
    });

    test('logs warning when page.close() fails', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const page = { close: jest.fn().mockRejectedValue(new Error('kaboom')) };

      await safePageClose(page);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('page close failed');

      jest.advanceTimersByTime(5000);
    });
  });
});
