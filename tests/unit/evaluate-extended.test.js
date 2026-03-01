const { evaluateTabExtended, clearAllTabLocks } = require('../../dist/src/services/tab');

describe('evaluateTabExtended (unit)', () => {
  afterEach(() => {
    clearAllTabLocks();
  });

  function makeTabState(evaluateImpl) {
    return {
      page: {
        evaluate: evaluateImpl,
      },
    };
  }

  test('returns ok result for number expression', async () => {
    const tabState = makeTabState(async () => 2);

    const result = await evaluateTabExtended('tab-eval-1', tabState, {
      expression: '1 + 1',
      timeout: 1000,
    });

    expect(result).toEqual({
      ok: true,
      result: 2,
      resultType: 'number',
      truncated: false,
    });
  });

  test('returns timeout error when evaluation exceeds timeout', async () => {
    const tabState = makeTabState(() => new Promise(() => {}));

    const result = await evaluateTabExtended('tab-eval-2', tabState, {
      expression: 'await never',
      timeout: 100,
    });

    expect(result.ok).toBe(false);
    expect(result.errorType).toBe('timeout');
    expect(result.error).toContain('timed out after 100ms');
  });

  test('marks oversized result as truncated', async () => {
    const tabState = makeTabState(async () => 'x'.repeat(1_200_000));

    const result = await evaluateTabExtended('tab-eval-3', tabState, {
      expression: '"x".repeat(1200000)',
      timeout: 1000,
    });

    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.resultType).toBe('string');
    expect(String(result.result)).toContain('[Truncated: result was');
  });

  test('returns correct resultType for object payload', async () => {
    const value = { hello: 'world', n: 1 };
    const tabState = makeTabState(async () => value);

    const result = await evaluateTabExtended('tab-eval-4', tabState, {
      expression: '({ hello: "world", n: 1 })',
      timeout: 1000,
    });

    expect(result.ok).toBe(true);
    expect(result.resultType).toBe('object');
    expect(result.truncated).toBe(false);
    expect(result.result).toEqual(value);
  });
});
