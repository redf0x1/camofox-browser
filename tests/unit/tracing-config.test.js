const path = require('node:path');

const fallbackTracesDir = '/mock-home/.camofox/traces';

jest.mock('../../dist/src/utils/config', () => ({
  loadConfig: () => ({ traceMaxDurationMs: 30_000 }),
}));

jest.mock('node:os', () => ({
  homedir: () => '/mock-home',
}));

jest.mock('node:fs', () => ({
  mkdirSync: jest.fn(),
  readdirSync: jest.fn().mockReturnValue([]),
  statSync: jest.fn().mockReturnValue({ size: 123, mtimeMs: 123 }),
  unlinkSync: jest.fn(),
}));

describe('tracing.ts config safety', () => {
  let fakeTimersEnabled = false;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    fakeTimersEnabled = false;
  });

  afterEach(() => {
    if (fakeTimersEnabled) {
      jest.runOnlyPendingTimers();
    }
    jest.useRealTimers();
  });

  test('can be imported when mocked config omits tracesDir until trace artifacts are used', () => {
    expect(() => require('../../dist/src/services/tracing')).not.toThrow();

    const { getTracingState } = require('../../dist/src/services/tracing');
    expect(getTracingState('user-a')).toEqual({
      active: false,
      chunkActive: false,
      startedAt: null,
    });
  });

  test('stopTracing() falls back to the default traces dir when mocked config omits tracesDir', async () => {
    const { startTracing, stopTracing, getTracingState } = require('../../dist/src/services/tracing');
    const fs = require('node:fs');
    const context = {
      tracing: {
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn().mockResolvedValue(undefined),
      },
    };

    await startTracing('user-a', context);
    const result = await stopTracing('user-a', context);

    expect(fs.mkdirSync).toHaveBeenCalledWith(fallbackTracesDir, { recursive: true });
    expect(context.tracing.stop).toHaveBeenCalledWith({
      path: expect.stringMatching(new RegExp(`^${fallbackTracesDir}/.+-\\d+\\.zip$`)),
    });
    expect(path.dirname(result.path)).toBe(fallbackTracesDir);
    expect(getTracingState('user-a')).toEqual({
      active: false,
      chunkActive: false,
      startedAt: null,
    });
  });

  test('stopTracingChunk() falls back to the default traces dir when mocked config omits tracesDir', async () => {
    const { startTracing, startTracingChunk, stopTracingChunk, getTracingState } = require('../../dist/src/services/tracing');
    const fs = require('node:fs');
    const context = {
      tracing: {
        start: jest.fn().mockResolvedValue(undefined),
        startChunk: jest.fn().mockResolvedValue(undefined),
        stopChunk: jest.fn().mockResolvedValue(undefined),
      },
    };

    await startTracing('user-a', context);
    await startTracingChunk('user-a', context);
    const result = await stopTracingChunk('user-a', context);

    expect(fs.mkdirSync).toHaveBeenCalledWith(fallbackTracesDir, { recursive: true });
    expect(context.tracing.stopChunk).toHaveBeenCalledWith({
      path: expect.stringMatching(new RegExp(`^${fallbackTracesDir}/.+-\\d+\\.zip$`)),
    });
    expect(path.dirname(result.path)).toBe(fallbackTracesDir);
    expect(getTracingState('user-a')).toEqual({
      active: true,
      chunkActive: false,
      startedAt: expect.any(Number),
    });
  });

  test('stopTracing() preserves timeout cleanup when path validation fails', async () => {
    jest.useFakeTimers();
    fakeTimersEnabled = true;

    const { startTracing, stopTracing, getTracingState } = require('../../dist/src/services/tracing');
    const context = {
      tracing: {
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn().mockResolvedValue(undefined),
      },
    };

    await startTracing('user-a', context);

    await expect(stopTracing('user-a', context, '/outside-traces/trace.zip')).rejects.toThrow(
      'Invalid trace output path: must be within traces directory',
    );
    expect(getTracingState('user-a')).toEqual({
      active: true,
      chunkActive: false,
      startedAt: expect.any(Number),
    });

    await jest.advanceTimersByTimeAsync(30_000);

    expect(context.tracing.stop).toHaveBeenCalledTimes(1);
    expect(getTracingState('user-a')).toEqual({
      active: false,
      chunkActive: false,
      startedAt: null,
    });
  });

  test('stopTracing() preserves timeout cleanup when tracing.stop() fails unexpectedly', async () => {
    jest.useFakeTimers();
    fakeTimersEnabled = true;

    const { startTracing, stopTracing, getTracingState } = require('../../dist/src/services/tracing');
    const context = {
      tracing: {
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest
          .fn()
          .mockRejectedValueOnce(new Error('disk full'))
          .mockResolvedValueOnce(undefined),
      },
    };

    await startTracing('user-a', context);

    await expect(stopTracing('user-a', context)).rejects.toThrow('disk full');
    expect(getTracingState('user-a')).toEqual({
      active: true,
      chunkActive: false,
      startedAt: expect.any(Number),
    });

    await jest.advanceTimersByTimeAsync(30_000);

    expect(context.tracing.stop).toHaveBeenCalledTimes(2);
    expect(getTracingState('user-a')).toEqual({
      active: false,
      chunkActive: false,
      startedAt: null,
    });
  });

  test('stopTracing() does not race the timeout auto-stop while a manual stop is in progress', async () => {
    jest.useFakeTimers();
    fakeTimersEnabled = true;

    const { startTracing, stopTracing, getTracingState } = require('../../dist/src/services/tracing');
    let resolveStop;
    const stopGate = new Promise((resolve) => {
      resolveStop = resolve;
    });
    const context = {
      tracing: {
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn().mockImplementation(() => stopGate),
      },
    };

    await startTracing('user-a', context);

    const stopPromise = stopTracing('user-a', context);
    await Promise.resolve();

    expect(context.tracing.stop).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(30_000);

    expect(context.tracing.stop).toHaveBeenCalledTimes(1);

    resolveStop(undefined);
    await expect(stopPromise).resolves.toEqual({
      path: expect.stringMatching(new RegExp(`^${fallbackTracesDir}/.+-\\d+\\.zip$`)),
      size: 123,
    });
    expect(getTracingState('user-a')).toEqual({
      active: false,
      chunkActive: false,
      startedAt: null,
    });
  });

  test('stopTracingChunk() blocks timeout auto-stop until the chunk stop finishes', async () => {
    jest.useFakeTimers();
    fakeTimersEnabled = true;

    const { startTracing, startTracingChunk, stopTracingChunk, getTracingState } = require('../../dist/src/services/tracing');
    let resolveStopChunk;
    const stopChunkGate = new Promise((resolve) => {
      resolveStopChunk = resolve;
    });
    const context = {
      tracing: {
        start: jest.fn().mockResolvedValue(undefined),
        startChunk: jest.fn().mockResolvedValue(undefined),
        stopChunk: jest.fn().mockImplementation(() => stopChunkGate),
        stop: jest.fn().mockResolvedValue(undefined),
      },
    };

    await startTracing('user-a', context);
    await startTracingChunk('user-a', context);

    const stopChunkPromise = stopTracingChunk('user-a', context);
    await Promise.resolve();

    expect(context.tracing.stopChunk).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(30_000);

    expect(context.tracing.stop).not.toHaveBeenCalled();
    expect(getTracingState('user-a')).toEqual({
      active: true,
      chunkActive: true,
      startedAt: expect.any(Number),
    });

    resolveStopChunk(undefined);
    await expect(stopChunkPromise).resolves.toEqual({
      path: expect.stringMatching(new RegExp(`^${fallbackTracesDir}/.+-\\d+\\.zip$`)),
      size: 123,
    });
    await Promise.resolve();

    expect(context.tracing.stop).toHaveBeenCalledTimes(1);
    expect(getTracingState('user-a')).toEqual({
      active: false,
      chunkActive: false,
      startedAt: null,
    });
  });

  test('stopTracingChunk() coalesces concurrent stop requests onto one chunk stop operation', async () => {
    const { startTracing, startTracingChunk, stopTracingChunk, getTracingState } = require('../../dist/src/services/tracing');
    let resolveStopChunk;
    const stopChunkGate = new Promise((resolve) => {
      resolveStopChunk = resolve;
    });
    const context = {
      tracing: {
        start: jest.fn().mockResolvedValue(undefined),
        startChunk: jest.fn().mockResolvedValue(undefined),
        stopChunk: jest.fn().mockImplementation(() => stopChunkGate),
      },
    };

    await startTracing('user-a', context);
    await startTracingChunk('user-a', context);

    const firstStopPromise = stopTracingChunk('user-a', context);
    await Promise.resolve();
    const secondStopPromise = stopTracingChunk('user-a', context);

    expect(context.tracing.stopChunk).toHaveBeenCalledTimes(1);

    resolveStopChunk(undefined);
    await expect(Promise.all([firstStopPromise, secondStopPromise])).resolves.toEqual([
      {
        path: expect.stringMatching(new RegExp(`^${fallbackTracesDir}/.+-\\d+\\.zip$`)),
        size: 123,
      },
      {
        path: expect.stringMatching(new RegExp(`^${fallbackTracesDir}/.+-\\d+\\.zip$`)),
        size: 123,
      },
    ]);
    expect(getTracingState('user-a')).toEqual({
      active: true,
      chunkActive: false,
      startedAt: expect.any(Number),
    });
  });
});
