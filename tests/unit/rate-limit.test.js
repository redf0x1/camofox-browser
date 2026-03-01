const { checkRateLimit } = require('../../dist/src/middleware/rate-limit');

describe('checkRateLimit (unit)', () => {
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  test('first request is allowed', () => {
    const userId = `rate-first-${Date.now()}-${Math.random()}`;
    const result = checkRateLimit(userId, 3, 1000);
    expect(result.allowed).toBe(true);
    expect(result.retryAfterMs).toBeUndefined();
  });

  test('requests within limit are allowed', () => {
    const userId = `rate-within-${Date.now()}-${Math.random()}`;
    expect(checkRateLimit(userId, 3, 1000).allowed).toBe(true);
    expect(checkRateLimit(userId, 3, 1000).allowed).toBe(true);
  });

  test('request over the limit is blocked', () => {
    const userId = `rate-block-${Date.now()}-${Math.random()}`;
    expect(checkRateLimit(userId, 2, 1000).allowed).toBe(true);
    expect(checkRateLimit(userId, 2, 1000).allowed).toBe(true);

    const blocked = checkRateLimit(userId, 2, 1000);
    expect(blocked.allowed).toBe(false);
    expect(typeof blocked.retryAfterMs).toBe('number');
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  test('request after window expiry is allowed again', async () => {
    const userId = `rate-reset-${Date.now()}-${Math.random()}`;

    expect(checkRateLimit(userId, 1, 60).allowed).toBe(true);
    const blocked = checkRateLimit(userId, 1, 60);
    expect(blocked.allowed).toBe(false);

    await sleep(75);
    const allowedAfterReset = checkRateLimit(userId, 1, 500);
    expect(allowedAfterReset.allowed).toBe(true);
  });

  test('different userIds have independent limits', () => {
    const userA = `rate-user-a-${Date.now()}-${Math.random()}`;
    const userB = `rate-user-b-${Date.now()}-${Math.random()}`;

    expect(checkRateLimit(userA, 1, 1000).allowed).toBe(true);
    expect(checkRateLimit(userB, 1, 1000).allowed).toBe(true);

    expect(checkRateLimit(userA, 1, 1000).allowed).toBe(false);
    expect(checkRateLimit(userB, 1, 1000).allowed).toBe(false);
  });

  test('returns correct retryAfterMs', () => {
    const userId = `rate-retry-${Date.now()}-${Math.random()}`;
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockImplementation(() => 5000);

    expect(checkRateLimit(userId, 1, 2000).allowed).toBe(true);

    nowSpy.mockImplementation(() => 6200);
    const blocked = checkRateLimit(userId, 1, 2000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(800);
    nowSpy.mockRestore();
  });

  test('edge case at maxRequests boundary: exactly max is allowed, next is blocked', () => {
    const userId = `rate-boundary-${Date.now()}-${Math.random()}`;

    expect(checkRateLimit(userId, 2, 1000).allowed).toBe(true);
    expect(checkRateLimit(userId, 2, 1000).allowed).toBe(true);

    const blocked = checkRateLimit(userId, 2, 1000);
    expect(blocked.allowed).toBe(false);
  });
});
