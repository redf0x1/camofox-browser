/**
 * Regression test for Wave 2B Task 3 correctness bug:
 * runLifecycleIdleCleanup should NOT cleanup session data when context is reused after snapshot.
 */

// Mock config FIRST
jest.mock('../../dist/src/utils/config', () => ({
  loadConfig: jest.fn(() => ({
    maxSessions: 10,
    userDataDir: '/tmp/camofox-test',
    profilesDir: '/tmp/camofox-test/profiles',
    downloadsDir: '/tmp/camofox-test/downloads',
    port: 3000,
    proxy: { host: '', port: '', username: '', password: '' },
    sessionTimeoutMs: 600000,
    maxTabsPerSession: 50,
  })),
}));

// Mock camoufox-js
jest.mock('camoufox-js', () => ({
  launchOptions: jest.fn(() => Promise.resolve({})),
}));
jest.mock('camoufox-js/dist/fingerprints.js', () => ({
  generateFingerprint: jest.fn(() => ({})),
}));
jest.mock('camoufox-js/dist/pkgman.js', () => ({
  installedVerStr: jest.fn(() => '1.0.0'),
}));

// Mock playwright-core
jest.mock('playwright-core', () => ({
  firefox: {
    launchPersistentContext: jest.fn(async () => {
      const mockContext = {
        pages: jest.fn(() => []),
        newPage: jest.fn(async () => ({
          close: jest.fn(async () => {}),
        })),
        close: jest.fn(async () => {}),
        on: jest.fn(),
      };
      return mockContext;
    }),
  },
}));

// Mock sidecar and logging
jest.mock('../../dist/src/utils/sidecar-version', () => ({
  readVersionedSidecar: jest.fn(() => null),
  writeVersionedSidecar: jest.fn(),
}));
jest.mock('../../dist/src/middleware/logging', () => ({
  log: jest.fn(),
}));

const {
  runLifecycleIdleCleanup,
  clearAllState,
  __getSessionsMapForTests,
} = require('../../dist/src/services/session');
const { contextPool } = require('../../dist/src/services/context-pool');

describe('runLifecycleIdleCleanup - reuse race bug', () => {
  beforeEach(async () => {
    clearAllState();
  });

  afterEach(async () => {
    clearAllState();
  });

  it('should NOT cleanup session data when context is reused after snapshot', async () => {
    const userId = 'reuse-race-user';
    
    // Manually inject session and context state to simulate the bug scenario
    const sessions = __getSessionsMapForTests();
    
    // Create a mock context
    const mockContext = {
      pages: () => [],
      newPage: async () => ({ close: async () => {} }),
      close: async () => {},
      on: () => {},
    };
    
    // Add session with NO tabs (eligible for cleanup)
    sessions.set(userId, {
      context: mockContext,
      tabGroups: new Map(), // No tabs!
      lastAccess: Date.now() - 10000,
    });
    
    // Add context to pool
    const initialLastAccess = Date.now() - 10000;
    contextPool.pool.set(userId, {
      userId,
      context: mockContext,
      createdAt: Date.now() - 20000,
      lastAccess: initialLastAccess,
      staged: false,
      launching: false,
    });
    
    // Take snapshots (session has 0 tabs, so it's eligible for cleanup)
    const cleanupStartedMs = Date.now();
    const sessionSnapshot = new Map();
    const contextSnapshot = new Map();
    
    for (const [key, session] of sessions) {
      sessionSnapshot.set(key, {
        context: session.context,
        tabGroups: new Map(session.tabGroups),
        lastAccess: session.lastAccess,
      });
    }
    
    for (const [key, entry] of contextPool.pool) {
      contextSnapshot.set(key, { ...entry });
    }
    
    // SIMULATE CONCURRENT REUSE: Update pool's lastAccess AFTER snapshot
    // This simulates a concurrent POST /tabs that reuses the context
    const poolEntry = contextPool.pool.get(userId);
    if (poolEntry) {
      poolEntry.lastAccess = Date.now(); // Changed! Context was reused
    }
    
    // Add a tab to the runtime session (simulating POST /tabs succeeded)
    sessions.get(userId).tabGroups.set('default', new Map([
      ['new-tab-id', {
        tabId: 'new-tab-id',
        page: await mockContext.newPage(),
        url: 'https://example.com/reused',
        createdAt: Date.now(),
      }]
    ]));
    
    // Run cleanup with old snapshots
    // closeContextIfMatches should detect lastAccess changed and NOT close
    // BUT BUG: cleanupSessionsForUserId runs unconditionally for all usersToCleanup
    await runLifecycleIdleCleanup(sessionSnapshot, contextSnapshot, cleanupStartedMs);
    
    // VERIFY BUG: Session data was deleted even though context wasn't closed
    const sessionAfter = sessions.get(userId);
    
    // This test WILL FAIL on current buggy code because session data gets deleted
    expect(sessionAfter).toBeDefined();
    expect(sessionAfter.tabGroups.size).toBeGreaterThan(0);
    
    // Context should still be in pool (this currently works correctly)
    const poolAfter = contextPool.pool.get(userId);
    expect(poolAfter).toBeDefined();
  }, 30000);
});
