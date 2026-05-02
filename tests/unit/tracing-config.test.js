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
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
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
});
