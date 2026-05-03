/**
 * Unit test for context pool profileKey-based identity.
 * Verifies that ensureContext reuses contexts only when profileKey matches.
 */

// Mock camoufox-js to avoid ESM import issues in Jest
jest.mock('camoufox-js', () => ({
  launchOptions: jest.fn(() => Promise.resolve({})),
}));

jest.mock('camoufox-js/dist/fingerprints.js', () => ({
  generateFingerprint: jest.fn(() => ({})),
}));

jest.mock('camoufox-js/dist/pkgman.js', () => ({
  installedVerStr: jest.fn(() => '1.0.0'),
}));

// Mock playwright-core to avoid heavy browser dependencies
jest.mock('playwright-core', () => ({
  firefox: {
    launchPersistentContext: jest.fn(async () => {
      const mockContext = {
        pages: jest.fn(() => []),
        newPage: jest.fn(async () => ({})),
        close: jest.fn(async () => {}),
        on: jest.fn(),
      };
      return mockContext;
    }),
  },
}));

// Mock the sidecar and logging
jest.mock('../../dist/src/utils/sidecar-version', () => ({
  readVersionedSidecar: jest.fn(() => null),
  writeVersionedSidecar: jest.fn(),
}));

jest.mock('../../dist/src/middleware/logging', () => ({
  log: jest.fn(),
}));

describe('ContextPool proxy-geo identity', () => {
  let ContextPool;
  
  beforeAll(() => {
    // Import after mocks are set up
    ContextPool = require('../../dist/src/services/context-pool').ContextPool;
  });

  test('ensureContext reuses only identical profile signatures', async () => {
    const pool = new ContextPool();
    
    // First call with profileKey 'user-1::alpha::sig-a'
    const first = await pool.ensureContext(
      'user-1::alpha::sig-a',
      'user-1',
      { timezoneId: 'Asia/Tokyo' },
      { source: 'named-profile', server: 'http://proxy.alpha.test:8001', profileName: 'alpha' },
    );
    
    // Second call with same profileKey should reuse the context
    const second = await pool.ensureContext(
      'user-1::alpha::sig-a',
      'user-1',
      { timezoneId: 'Asia/Tokyo' },
      { source: 'named-profile', server: 'http://proxy.alpha.test:8001', profileName: 'alpha' },
    );
    
    // Third call with different profileKey should create new context
    const third = await pool.ensureContext(
      'user-1::beta::sig-b',
      'user-1',
      { timezoneId: 'Europe/Berlin' },
      { source: 'named-profile', server: 'http://proxy.beta.test:8002', profileName: 'beta' },
    );

    // Verify reuse behavior
    expect(second.context).toBe(first.context);
    expect(third.context).not.toBe(first.context);
    expect(second.profileKey).toBe('user-1::alpha::sig-a');
    expect(third.profileKey).toBe('user-1::beta::sig-b');

    // Cleanup
    await pool.closeContext('user-1::alpha::sig-a');
    await pool.closeContext('user-1::beta::sig-b');
  });

  test('pool tracks contexts by profileKey not just userId', async () => {
    const pool = new ContextPool();
    
    const alpha = await pool.ensureContext(
      'user-2::session-a::sig-x',
      'user-2',
      { timezoneId: 'America/New_York' },
    );
    
    const beta = await pool.ensureContext(
      'user-2::session-b::sig-y',
      'user-2',
      { timezoneId: 'Europe/London' },
    );

    // Both should exist with different profileKeys
    expect(alpha.profileKey).toBe('user-2::session-a::sig-x');
    expect(beta.profileKey).toBe('user-2::session-b::sig-y');
    expect(alpha.userId).toBe('user-2');
    expect(beta.userId).toBe('user-2');
    expect(alpha.context).not.toBe(beta.context);

    // Close one shouldn't affect the other
    await pool.closeContext('user-2::session-a::sig-x');
    
    const alphaEntry = pool.getEntry('user-2::session-a::sig-x');
    const betaEntry = pool.getEntry('user-2::session-b::sig-y');
    
    expect(alphaEntry).toBeUndefined();
    expect(betaEntry).toBeDefined();

    // Cleanup
    await pool.closeContext('user-2::session-b::sig-y');
  });
});
