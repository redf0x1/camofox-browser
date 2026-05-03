describe('ContextPool proxy-geo identity', () => {
  test('ensureContext reuses only identical profile signatures', async () => {
    const { ContextPool } = require('../../dist/src/services/context-pool');
    const pool = new ContextPool();
    const first = await pool.ensureContext(
      'user-1::alpha::sig-a',
      'user-1',
      { timezoneId: 'Asia/Tokyo' },
      { source: 'named-profile', server: 'http://proxy.alpha.test:8001', profileName: 'alpha' },
    );
    const second = await pool.ensureContext(
      'user-1::alpha::sig-a',
      'user-1',
      { timezoneId: 'Asia/Tokyo' },
      { source: 'named-profile', server: 'http://proxy.alpha.test:8001', profileName: 'alpha' },
    );
    const third = await pool.ensureContext(
      'user-1::beta::sig-b',
      'user-1',
      { timezoneId: 'Europe/Berlin' },
      { source: 'named-profile', server: 'http://proxy.beta.test:8002', profileName: 'beta' },
    );

    expect(second.context).toBe(first.context);
    expect(third.context).not.toBe(first.context);

    // Cleanup
    await pool.closeContext('user-1::alpha::sig-a');
    await pool.closeContext('user-1::beta::sig-b');
  });
});
