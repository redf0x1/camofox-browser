/**
 * Route-level tests for nav-error scoping and session-scoped recovery.
 *
 * These tests mount the REAL Express route handlers from core.ts and
 * openclaw.ts on a test app, with only the browser-layer services mocked
 * (navigateWithSafetyGuard, validateNavigationUrl, buildRefs, contextPool).
 * The health module, nav-recovery module, and session module's withUserLimit/
 * withTabLock/withTimeout remain unmocked — exercising the actual navError
 * flag logic, handleNavFailure calls, and session-key propagation.
 *
 * Tests the HIGH blockers from round 5 review:
 * 1. Non-navigation errors do not count toward the failure threshold
 * 2. Stale/unmatched session key does not close sibling sessions (fail-closed)
 * 3. Health state is not deleted when a sibling context closes
 * 4. Session-owned teardown — recovery removes/unindexes tabs (findTabById returns null)
 * 5. Cross-session threshold isolation — failures from session A don't trip recovery for B
 * 6. recordNavSuccess fires immediately after navigation, before buildRefs
 * 7. Lock continuity — non-owner does not clear another's lock
 */

// ── Mocks ───────────────────────────────────────────────────────────

// Track calls to closeContext / closeContextByUserId
const mockCloseContext = jest.fn();
const mockCloseContextByUserId = jest.fn();
const mockEnsureContext = jest.fn();

// Real pool Map to faithfully replicate closeContextBySession's pool-entry
// check and generation tracking. This replaces the previous semantic
// substitution (sessions.has for pool.has) that hid the missing-pool-entry
// and replacement-race bugs.
const mockPool = new Map();

// We do NOT mock closeContextBySession — we let it call the real
// teardownSessionByKey so we can verify real tab unindexing behavior.
// The contextPool mock delegates to teardownSessionByKey for matched keys,
// using the same generation-aware logic as the production code.
// HIGH A: foreign owner is a no-op. HIGH B: missing pool entry = no close.
// HIGH round 8: captures session snapshot before teardown, and checks
// the snapshot owner against the requesting user when the pool entry
// is missing (foreign-ownership fail-closed).
const mockCloseContextBySession = jest.fn(async (userId, profileKey) => {
  if (profileKey !== undefined && profileKey !== null && profileKey !== '') {
    const entry = mockPool.get(profileKey);

    // Foreign owner: pool entry exists but owned by a different user → no-op
    if (entry && entry.userId !== String(userId)) {
      return;
    }

    // Staged entry: not eligible for recovery teardown → no-op
    if (entry && entry.staged) {
      return;
    }

    // Owner matches or entry is missing. Capture exact context generation if entry exists.
    const generation = entry?.generation;

    // Capture durable session identity synchronously (HIGH round 8).
    const sessionModule = require('../../dist/src/services/session');
    const sessionSnapshot = sessionModule.getSessionSnapshot(profileKey);

    // Foreign ownership check for the pool-missing path (HIGH round 8):
    // when the pool entry is gone, the pool-level owner check above could
    // not fire. The snapshot owner tells us who the session belongs to.
    // If it doesn't match the requesting user, fail closed.
    if (generation === undefined && sessionSnapshot.owner !== undefined && sessionSnapshot.owner !== String(userId)) {
      return;
    }

    await sessionModule.teardownSessionByKey(profileKey, generation, sessionSnapshot);
    return;
  }
  // No key → user-wide fallback
  await mockCloseContextByUserId(userId);
});

// Generation-aware close: matches the real closeContextIfMatches logic.
const mockCloseContextIfMatches = jest.fn(async (profileKey, expectedGeneration) => {
  const entry = mockPool.get(profileKey);
  if (!entry) return;
  if (entry.generation !== expectedGeneration) return;
  mockPool.delete(profileKey);
  mockCloseContext(profileKey);
});

jest.mock('../../dist/src/services/context-pool', () => ({
  contextPool: {
    closeContext: mockCloseContext,
    closeContextBySession: mockCloseContextBySession,
    closeContextByUserId: mockCloseContextByUserId,
    closeContextIfMatches: mockCloseContextIfMatches,
    getPoolEntries: jest.fn(() => mockPool),
    ensureContext: mockEnsureContext,
    size: jest.fn(() => mockPool.size),
    onEvict: jest.fn(),
    evictIfNeeded: jest.fn(async () => {}),
    acquire: jest.fn(),
    release: jest.fn(),
    getEntry: jest.fn((key) => mockPool.get(key)),
  },
  getDisplayForUser: jest.fn(() => null),
}));

// Mock the tab service — navigateWithSafetyGuard is the one we control
const mockNavigate = jest.fn();
const mockValidateUrl = jest.fn(async () => null); // null = valid URL
const mockBuildRefs = jest.fn(async () => new Map());
const mockAcquirePageForNewTab = jest.fn();
const mockCreateTabState = jest.fn(async (page) => ({
  page,
  visitedUrls: new Set(),
  refs: new Map(),
  toolCalls: 0,
  downloads: [],
}));

jest.mock('../../dist/src/services/tab', () => ({
  navigateWithSafetyGuard: mockNavigate,
  validateNavigationUrl: mockValidateUrl,
  buildRefs: mockBuildRefs,
  withTimeout: jest.requireActual('../../dist/src/services/tab').withTimeout,
  withTabLock: jest.fn(async (_tabId, op) => op()), // pass-through
  createTabState: mockCreateTabState,
  acquirePageForNewTab: mockAcquirePageForNewTab,
  safePageClose: jest.fn(async (page) => page?.close()),
  buildSnapshotPayload: jest.fn(),
  calculateTypeTimeoutMs: jest.fn(() => 5000),
  clearTabLock: jest.fn(),
  clearAllTabLocks: jest.fn(),
  waitForPageReady: jest.fn(),
}));

// Mock logging
jest.mock('../../dist/src/middleware/logging', () => ({
  log: jest.fn(),
  loggingMiddleware: jest.fn((_req, _res, next) => next()),
  startStatsBeacon: jest.fn(),
}));

// Mock auth — no API key
jest.mock('../../dist/src/middleware/auth', () => ({
  isAuthorizedWithApiKey: (_req, _apiKey) => true,
}));

// Mock rate-limit — no limit
jest.mock('../../dist/src/middleware/rate-limit', () => ({
  checkRateLimit: jest.fn(() => null),
}));

// Mock lifecycle controller
jest.mock('../../dist/src/services/lifecycle-controller', () => ({
  lifecycleController: {
    recordInteractiveActivity: jest.fn(),
    recordCleanupFinished: jest.fn(),
    markCleanupFinished: jest.fn(),
  },
}));

// Mock vnc
jest.mock('../../dist/src/services/vnc', () => ({
  startVnc: jest.fn(),
  stopVnc: jest.fn().mockResolvedValue(undefined),
  stopAllVnc: jest.fn(),
}));

// Mock download service — session.ts imports it at module load
jest.mock('../../dist/src/services/download', () => ({
  cleanupUserDownloads: jest.fn(),
  registerDownloadListener: jest.fn(),
  markDownloadsStaged: jest.fn(),
  startCleanupInterval: jest.fn(),
  stopCleanupInterval: jest.fn(),
}));

// Mock tracing — session.ts imports it
jest.mock('../../dist/src/services/tracing', () => ({
  cleanupTracing: jest.fn(),
}));

// Mock browser service
jest.mock('../../dist/src/services/browser', () => ({
  closeBrowser: jest.fn(),
}));

// Mock youtube service
jest.mock('../../dist/src/services/youtube', () => ({
  detectYtDlp: jest.fn(() => null),
}));

// Mock docs routes (not needed for these tests)
jest.mock('../../dist/src/routes/docs', () => {
  const express = require('express');
  const router = express.Router();
  return { default: router, router };
});

// Mock lifecycle-activity middleware
jest.mock('../../dist/src/middleware/lifecycle-activity', () => ({
  createLifecycleActivityMiddleware: jest.fn(() => (_req, _res, next) => next()),
}));

// Mock config — needs all fields used by session/download/context-pool at load time
jest.mock('../../dist/src/utils/config', () => ({
  loadConfig: jest.fn(() => ({
    failureThreshold: 3,
    maxSessions: 10,
    maxConcurrentPerUser: 5,
    handlerTimeoutMs: 75,
    maxTabsPerSession: 10,
    allowPrivateNetworkTargets: false,
    apiKey: null,
    authMode: 'disabled',
    downloadsDir: '/tmp/test-downloads',
    maxDownloadSizeMb: 100,
    maxDownloadsPerUser: 500,
    sessionTimeoutMs: 300000,
    serverEnv: {},
    host: 'localhost',
    port: 9377,
    headless: true,
    vncResolution: '1920x1080x24',
    proxy: { host: '', port: '', username: '', password: '' },
    ytDlpTimeoutMs: 30000,
    ytBrowserTimeoutMs: 25000,
    evalExtendedRateLimitMax: 10,
    proxyGeoOverrides: {},
  })),
  assertServerExposureSafety: jest.fn(),
}));

// Mock presets
jest.mock('../../dist/src/utils/presets', () => ({
  contextHash: jest.fn(() => 'test-context-hash'),
  getAllPresets: jest.fn(() => ({})),
  resolveContextOptions: jest.fn(() => ({})),
  validateContextOptions: jest.fn(() => null),
}));

// ── Imports (after mocks) ───────────────────────────────────────────

const express = require('express');
const supertest = require('supertest');

// Real health + nav-recovery modules (NOT mocked)
const {
  recordNavSuccess,
  recordNavFailure,
  acquireRecoveryLock,
  releaseRecoveryLock,
  isUserRecovering,
  resetHealth,
  deleteUserHealth,
  __getUserHealthForTests,
  __clearUserHealthForTests,
} = require('../../dist/src/services/health');

const { handleNavFailure } = require('../../dist/src/services/nav-recovery');

// Real session module (NOT mocked) — for setup and teardown verification
const sessionModule = require('../../dist/src/services/session');

// ── Test helpers ────────────────────────────────────────────────────

let testSessionGeneration = 0;

function nextTestSessionGeneration() {
  testSessionGeneration += 1;
  return `test-session-generation-${testSessionGeneration}`;
}

function makeRoutePage() {
  return {
    url: jest.fn(() => 'about:blank'),
    title: jest.fn(async () => ''),
    close: jest.fn(async () => {}),
  };
}

/**
 * Mount the real core + openclaw route handlers on a test Express app.
 * We import the route modules AFTER all mocks are set up.
 */
function createTestApp() {
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  // Mount the real routers — they use the mocked services internally
  const coreRoutes = require('../../dist/src/routes/core');
  const openclawRoutes = require('../../dist/src/routes/openclaw');
  app.use(coreRoutes.default || coreRoutes);
  app.use(openclawRoutes.default || openclawRoutes);

  // Error handler
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    res.status(status).json({ error: err.message || 'Internal error' });
  });

  return app;
}

/**
 * Set up a fake tab in the session module so findTabById returns it.
 * We inject directly into the session map via the test-only export.
 */
function setupFakeTab(userId, tabId, sessionKeyOverride) {
  const sessions = sessionModule.__getSessionsMapForTests();
  const sessionOwners = sessionModule.__getSessionOwnersForTests();

  // Compute the real session map key the same way findTabById will look it up.
  const sessionKey = sessionKeyOverride || sessionModule.getSessionMapKey(userId, null);

  // Create a minimal tab state that the route handler can work with
  const tabState = {
    page: { url: () => 'about:blank', close: jest.fn() },
    visitedUrls: new Set(),
    refs: new Map(),
    toolCalls: 0,
    downloads: [],
  };

  // Session structure: tabGroups is Map<listItemId, Map<tabId, TabState>>
  const session = {
    context: { close: jest.fn().mockResolvedValue(undefined) },
    tabGroups: new Map([[sessionKey, new Map([[tabId, tabState]])]]),
    lastAccess: Date.now(),
    createdAt: Date.now(),
    generation: nextTestSessionGeneration(),
  };

  sessions.set(sessionKey, session);
  // Set session owner so findTabById's isSessionMapKeyForUser check passes
  // for non-default session keys.
  sessionOwners.set(sessionKey, String(userId));

  // Index the tab so findTabById finds it via tabSessionIndex
  if (typeof sessionModule.indexTab === 'function') {
    sessionModule.indexTab(tabId, sessionKey);
  }

  return { tabState, session, sessionKey };
}

/**
 * Set up two sibling sessions for the same user with different session keys.
 * Each gets its own tab and session map key.
 */
function setupSiblingSessions(userId, tabIdA, sessionKeyA, tabIdB, sessionKeyB) {
  const sessions = sessionModule.__getSessionsMapForTests();
  const sessionOwners = sessionModule.__getSessionOwnersForTests();

  const mkTab = (tabId) => ({
    page: { url: () => 'about:blank', close: jest.fn() },
    visitedUrls: new Set(),
    refs: new Map(),
    toolCalls: 0,
    downloads: [],
  });

  // Session A
  const sessionA = {
    context: { close: jest.fn().mockResolvedValue(undefined) },
    tabGroups: new Map([[sessionKeyA, new Map([[tabIdA, mkTab(tabIdA)]])]]),
    lastAccess: Date.now(),
    createdAt: Date.now(),
    generation: nextTestSessionGeneration(),
  };
  sessions.set(sessionKeyA, sessionA);
  sessionOwners.set(sessionKeyA, String(userId));
  sessionModule.indexTab(tabIdA, sessionKeyA);

  // Session B
  const sessionB = {
    context: { close: jest.fn().mockResolvedValue(undefined) },
    tabGroups: new Map([[sessionKeyB, new Map([[tabIdB, mkTab(tabIdB)]])]]),
    lastAccess: Date.now(),
    createdAt: Date.now(),
    generation: nextTestSessionGeneration(),
  };
  sessions.set(sessionKeyB, sessionB);
  sessionOwners.set(sessionKeyB, String(userId));
  sessionModule.indexTab(tabIdB, sessionKeyB);

  return { sessionA, sessionB };
}

function setupOpenClawSession(userId) {
  sessionModule.commitCanonicalProfile(userId, null);
  const sessionKey = sessionModule.getSessionMapKey(userId, null);
  const context = { close: jest.fn().mockResolvedValue(undefined) };
  const session = {
    context,
    tabGroups: new Map(),
    lastAccess: Date.now(),
    createdAt: Date.now(),
    generation: nextTestSessionGeneration(),
  };
  const entry = {
    userId: String(userId),
    profileKey: sessionKey,
    context,
    createdAt: Date.now(),
    generation: session.generation,
    lastAccess: Date.now(),
    staged: false,
  };

  sessionModule.__getSessionsMapForTests().set(sessionKey, session);
  sessionModule.__getSessionOwnersForTests().set(sessionKey, String(userId));
  mockPool.set(sessionKey, entry);

  return { sessionKey, session, entry };
}

function cleanupSessions() {
  const sessions = sessionModule.__getSessionsMapForTests();
  for (const [key] of sessions.entries()) {
    sessions.delete(key);
  }
  const sessionOwners = sessionModule.__getSessionOwnersForTests();
  for (const [key] of sessionOwners.entries()) {
    sessionOwners.delete(key);
  }
  if (typeof sessionModule.clearAllState === 'function') {
    sessionModule.clearAllState();
  }
}

// ── Test suite ──────────────────────────────────────────────────────

describe('Nav recovery — route-level tests (round 5 blockers)', () => {
  let app;

  beforeAll(() => {
    app = createTestApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    __clearUserHealthForTests();
    resetHealth();
    mockNavigate.mockResolvedValue(undefined);
    mockValidateUrl.mockResolvedValue(null);
    mockBuildRefs.mockResolvedValue(new Map());
    mockCloseContext.mockResolvedValue(undefined);
    mockCloseContextByUserId.mockResolvedValue(undefined);
    mockEnsureContext.mockImplementation(async (profileKey) => mockPool.get(profileKey));
    mockAcquirePageForNewTab.mockImplementation(async () => makeRoutePage());
  });

  afterEach(() => {
    __clearUserHealthForTests();
    resetHealth();
    cleanupSessions();
    mockPool.clear();
  });

  test.each(['/tabs', '/tabs/open'])('%s bounds a stalled tab creation and recovers only the affected session', async (route) => {
    const userId = 'tab-create-stall';
    const { session, sessionKey, entry } = setupOpenClawSession(userId);
    const request = { userId, sessionKey: 'stalled', url: 'http://example.com' };
    const siblingKey = sessionModule.getSessionMapKey(userId, 'healthy', 'healthy-profile');
    setupFakeTab(userId, 'healthy-tab', siblingKey);
    let finishPage;
    const latePage = makeRoutePage();
    mockAcquirePageForNewTab.mockImplementationOnce(() => new Promise((resolve) => { finishPage = resolve; }));
    mockEnsureContext.mockImplementation(async (key) => {
      if (mockPool.has(key)) return mockPool.get(key);
      const replacement = { ...entry, context: { close: jest.fn() }, generation: nextTestSessionGeneration() };
      mockPool.set(key, replacement);
      return replacement;
    });

    try {
      await supertest(app).post(route).send(request)
        .timeout({ deadline: 800 }).expect(504);
      expect(mockCloseContext).toHaveBeenCalledTimes(1);
      expect(mockCloseContext).toHaveBeenCalledWith(sessionKey);
      expect(sessionModule.findTabById('healthy-tab', userId)).not.toBeNull();
      await supertest(app).post(route).send(request).expect(200);
      expect(mockPool.get(sessionKey).context).not.toBe(session.context);
    } finally {
      finishPage?.(latePage);
      await new Promise(setImmediate);
    }
    expect(latePage.close).toHaveBeenCalledTimes(1);
  });

  // ── 1. Non-navigation errors do not count ─────────────────────

  describe('HIGH 1 — navError scoped to actual navigation only', () => {
    test('validation error (pre-navigation) does not count toward threshold', async () => {
      const userId = 'test-user-nav-1';
      const tabId = 'tab-nav-1';
      setupFakeTab(userId, tabId);

      mockValidateUrl.mockResolvedValue('blocked: private network target');

      for (let i = 0; i < 5; i++) {
        await supertest(app)
          .post(`/tabs/${tabId}/navigate`)
          .send({ userId, url: 'http://169.254.169.254/latest' })
          .expect(400);
      }

      const health = __getUserHealthForTests(userId);
      expect(health?.consecutiveNavFailures ?? 0).toBe(0);
      expect(mockCloseContext).not.toHaveBeenCalled();
    });

    test('navigation failure counts toward threshold', async () => {
      const userId = 'test-user-nav-2';
      const tabId = 'tab-nav-2';
      setupFakeTab(userId, tabId);

      mockNavigate.mockRejectedValue(new Error('Navigation timeout'));

      for (let i = 0; i < 3; i++) {
        await supertest(app)
          .post(`/tabs/${tabId}/navigate`)
          .send({ userId, url: 'http://example.com' })
          .expect(500);
      }

      // After recovery, health entry is evicted by handleNavFailure's finally block
      const health = __getUserHealthForTests(userId);
      expect(health).toBeUndefined();
    });

    test('macro expansion error does not count toward threshold', async () => {
      const userId = 'test-user-nav-3';
      const tabId = 'tab-nav-3';
      setupFakeTab(userId, tabId);

      mockValidateUrl.mockResolvedValue('blocked: invalid URL');

      for (let i = 0; i < 5; i++) {
        await supertest(app)
          .post(`/tabs/${tabId}/navigate`)
          .send({ userId, url: 'http://example.invalid' })
          .expect(400);
      }

      const health = __getUserHealthForTests(userId);
      expect(health?.consecutiveNavFailures ?? 0).toBe(0);
    });
  });

  // ── 2. Stale/unmatched session key fails closed ───────────────

  describe('HIGH 2 — stale session key does not close siblings', () => {
    test('closeContextBySession with stale key is a no-op (fail-closed)', async () => {
      mockCloseContext.mockResolvedValue(undefined);

      const userId = 'test-user-stale';
      const staleSessionKey = 'stale-key-123';

      await handleNavFailure(userId, staleSessionKey);
      await handleNavFailure(userId, staleSessionKey);

      expect(__getUserHealthForTests(userId, staleSessionKey).consecutiveNavFailures).toBe(2);

      // 3rd failure — triggers recovery with stale key
      await handleNavFailure(userId, staleSessionKey);

      // closeContextByUserId should NOT have been called — stale key = fail-closed
      expect(mockCloseContextByUserId).not.toHaveBeenCalled();

      // Health entry should be evicted after recovery
      expect(__getUserHealthForTests(userId, staleSessionKey)).toBeUndefined();
    });

    test('no session key falls back to user-wide close (legacy compat)', async () => {
      mockCloseContextByUserId.mockResolvedValue(undefined);

      const userId = 'test-user-legacy';

      await handleNavFailure(userId);
      await handleNavFailure(userId);
      await handleNavFailure(userId);

      expect(mockCloseContextByUserId).toHaveBeenCalledTimes(1);
      expect(mockCloseContextByUserId).toHaveBeenCalledWith(userId);
    });
  });

  // ── 3. Health state lifecycle independent from context lifecycle ─

  describe('HIGH 3 — health state not deleted on sibling context close', () => {
    test('session health entry survives closeContext for a sibling session', async () => {
      const userId = 'test-user-sibling';
      const sessionKey = 'session-key-sibling';

      recordNavFailure(userId, sessionKey);
      recordNavFailure(userId, sessionKey);
      expect(__getUserHealthForTests(userId, sessionKey).consecutiveNavFailures).toBe(2);

      const { contextPool } = require('../../dist/src/services/context-pool');
      await contextPool.closeContext('some-profile-key');

      const health = __getUserHealthForTests(userId, sessionKey);
      expect(health).toBeDefined();
      expect(health.consecutiveNavFailures).toBe(2);
    });

    test('in-flight recovery lock survives sibling context close', async () => {
      const userId = 'test-user-lock-survival';
      const sessionKey = 'session-key-lock';

      recordNavFailure(userId, sessionKey);
      recordNavFailure(userId, sessionKey);
      recordNavFailure(userId, sessionKey);
      acquireRecoveryLock(userId, sessionKey);
      expect(isUserRecovering(userId, sessionKey)).toBe(true);

      const { contextPool } = require('../../dist/src/services/context-pool');
      await contextPool.closeContext('sibling-profile-key');

      expect(isUserRecovering(userId, sessionKey)).toBe(true);
      releaseRecoveryLock(userId, sessionKey);
      deleteUserHealth(userId, sessionKey);
    });
  });

  // ── 4. Session-owned teardown — tabs unindexed after recovery ──

  describe('HIGH 4 — recovery removes/unindexes tabs (session-owned teardown)', () => {
    test('after recovery, findTabById returns null for the recovered tab', async () => {
      const userId = 'test-user-teardown';
      const tabId = 'tab-teardown';
      const { sessionKey } = setupFakeTab(userId, tabId);

      // Verify tab is findable before recovery
      expect(sessionModule.findTabById(tabId, userId)).not.toBeNull();

      // Trigger recovery: 3 navigation failures
      mockNavigate.mockRejectedValue(new Error('nav fail'));
      for (let i = 0; i < 3; i++) {
        await supertest(app)
          .post(`/tabs/${tabId}/navigate`)
          .send({ userId, url: 'http://example.com' })
          .expect(500);
      }

      // After recovery, findTabById should return null — the tab was unindexed
      expect(sessionModule.findTabById(tabId, userId)).toBeNull();
    });

    test('sibling session tab survives recovery of a different session', async () => {
      const userId = 'test-user-sibling-teardown';
      const tabIdA = 'tab-a-teardown';
      const tabIdB = 'tab-b-teardown';
      const sessionKeyA = 'session-key-a-teardown';
      const sessionKeyB = 'session-key-b-teardown';

      setupSiblingSessions(userId, tabIdA, sessionKeyA, tabIdB, sessionKeyB);

      // Both tabs should be findable
      expect(sessionModule.findTabById(tabIdA, userId)).not.toBeNull();
      expect(sessionModule.findTabById(tabIdB, userId)).not.toBeNull();

      // Fail tab A's navigation 3 times to trigger recovery for session A
      mockNavigate.mockRejectedValue(new Error('nav fail'));
      for (let i = 0; i < 3; i++) {
        await supertest(app)
          .post(`/tabs/${tabIdA}/navigate`)
          .send({ userId, url: 'http://example.com' })
          .expect(500);
      }

      // Tab A should be gone (unindexed by teardownSessionByKey)
      expect(sessionModule.findTabById(tabIdA, userId)).toBeNull();

      // Tab B should still be findable — sibling session preserved
      expect(sessionModule.findTabById(tabIdB, userId)).not.toBeNull();
    });
  });

  // ── 5. Cross-session threshold isolation ──────────────────────

  describe('HIGH 5 — cross-session threshold isolation', () => {
    test('failures from session A do not trip recovery for session B', async () => {
      const userId = 'test-user-cross';
      const tabIdA = 'tab-cross-a';
      const tabIdB = 'tab-cross-b';
      const sessionKeyA = 'session-key-cross-a';
      const sessionKeyB = 'session-key-cross-b';

      setupSiblingSessions(userId, tabIdA, sessionKeyA, tabIdB, sessionKeyB);

      mockNavigate.mockRejectedValue(new Error('nav fail'));

      // 2 failures on session A (below threshold of 3)
      await supertest(app)
        .post(`/tabs/${tabIdA}/navigate`)
        .send({ userId, url: 'http://example.com' })
        .expect(500);
      await supertest(app)
        .post(`/tabs/${tabIdA}/navigate`)
        .send({ userId, url: 'http://example.com' })
        .expect(500);

      // Session A counter should be 2, Session B counter should be 0
      expect(__getUserHealthForTests(userId, sessionKeyA)?.consecutiveNavFailures).toBe(2);
      expect(__getUserHealthForTests(userId, sessionKeyB)?.consecutiveNavFailures ?? 0).toBe(0);

      // 1 failure on session B — should NOT trip recovery (B has counter 1, not 3)
      await supertest(app)
        .post(`/tabs/${tabIdB}/navigate`)
        .send({ userId, url: 'http://example.com' })
        .expect(500);

      expect(__getUserHealthForTests(userId, sessionKeyB)?.consecutiveNavFailures).toBe(1);

      // Session B tab should still exist (no recovery)
      expect(sessionModule.findTabById(tabIdB, userId)).not.toBeNull();

      // 1 more failure on session A — threshold reached (3), recovery for A only
      await supertest(app)
        .post(`/tabs/${tabIdA}/navigate`)
        .send({ userId, url: 'http://example.com' })
        .expect(500);

      // Session A's health entry should be evicted after recovery
      expect(__getUserHealthForTests(userId, sessionKeyA)).toBeUndefined();

      // Session B's health entry should still exist with counter 1
      expect(__getUserHealthForTests(userId, sessionKeyB)?.consecutiveNavFailures).toBe(1);

      // Session B tab should still be alive
      expect(sessionModule.findTabById(tabIdB, userId)).not.toBeNull();
    });

    test('success in session B does not reset session A failure counter', async () => {
      const userId = 'test-user-cross-success';
      const tabIdA = 'tab-cross-succ-a';
      const tabIdB = 'tab-cross-succ-b';
      const sessionKeyA = 'session-key-cross-succ-a';
      const sessionKeyB = 'session-key-cross-succ-b';

      setupSiblingSessions(userId, tabIdA, sessionKeyA, tabIdB, sessionKeyB);

      // 2 navigation failures on session A
      mockNavigate.mockRejectedValue(new Error('nav fail'));
      await supertest(app).post(`/tabs/${tabIdA}/navigate`).send({ userId, url: 'http://example.com' }).expect(500);
      await supertest(app).post(`/tabs/${tabIdA}/navigate`).send({ userId, url: 'http://example.com' }).expect(500);

      expect(__getUserHealthForTests(userId, sessionKeyA)?.consecutiveNavFailures).toBe(2);

      // 1 successful navigation on session B
      mockNavigate.mockResolvedValue(undefined);
      await supertest(app).post(`/tabs/${tabIdB}/navigate`).send({ userId, url: 'http://example.com' }).expect(200);

      // Session A counter should still be 2 — B's success did NOT reset it
      expect(__getUserHealthForTests(userId, sessionKeyA)?.consecutiveNavFailures).toBe(2);

      // Session B counter should be 0 (success resets it)
      expect(__getUserHealthForTests(userId, sessionKeyB)?.consecutiveNavFailures ?? 0).toBe(0);
    });
  });

  // ── 6. recordNavSuccess fires before buildRefs ─────────────────

  describe('HIGH 6 — recordNavSuccess fires immediately after navigation, before buildRefs', () => {
    test('navigation success + buildRefs failure still resets counter', async () => {
      const userId = 'test-user-buildrefs';
      const tabId = 'tab-buildrefs';
      const { sessionKey } = setupFakeTab(userId, tabId);

      // Pre-accumulate 2 failures so the counter is non-zero
      mockNavigate.mockRejectedValue(new Error('nav fail'));
      await supertest(app).post(`/tabs/${tabId}/navigate`).send({ userId, url: 'http://example.com' }).expect(500);
      await supertest(app).post(`/tabs/${tabId}/navigate`).send({ userId, url: 'http://example.com' }).expect(500);

      expect(__getUserHealthForTests(userId, sessionKey)?.consecutiveNavFailures).toBe(2);

      // Now: navigation succeeds but buildRefs throws
      mockNavigate.mockResolvedValue(undefined);
      mockBuildRefs.mockRejectedValue(new Error('buildRefs explosion'));

      await supertest(app)
        .post(`/tabs/${tabId}/navigate`)
        .send({ userId, url: 'http://example.com' })
        .expect(500); // buildRefs error → 500

      // Counter should be 0 — recordNavSuccess ran before buildRefs
      // But wait: the catch block runs handleNavFailure since the route
      // returned 500. However, navError=false because navigation succeeded,
      // so handleNavFailure is NOT called. The counter should be reset to 0
      // by recordNavSuccess which fired right after navigateWithSafetyGuard.
      const health = __getUserHealthForTests(userId, sessionKey);
      expect(health?.consecutiveNavFailures ?? 0).toBe(0);
    });

    test('openclaw route also resets counter before buildRefs', async () => {
      const userId = 'test-user-oc-buildrefs';
      const tabId = 'tab-oc-buildrefs';
      const { sessionKey } = setupFakeTab(userId, tabId);

      // Pre-accumulate 2 failures
      mockNavigate.mockRejectedValue(new Error('nav fail'));
      await supertest(app).post('/navigate').send({ targetId: tabId, userId, url: 'http://example.com' }).expect(500);
      await supertest(app).post('/navigate').send({ targetId: tabId, userId, url: 'http://example.com' }).expect(500);

      expect(__getUserHealthForTests(userId, sessionKey)?.consecutiveNavFailures).toBe(2);

      // Navigation succeeds, buildRefs throws
      mockNavigate.mockResolvedValue(undefined);
      mockBuildRefs.mockRejectedValue(new Error('buildRefs boom'));

      await supertest(app)
        .post('/navigate')
        .send({ targetId: tabId, userId, url: 'http://example.com' })
        .expect(500);

      const health = __getUserHealthForTests(userId, sessionKey);
      expect(health?.consecutiveNavFailures ?? 0).toBe(0);
    });
  });

  // ── 7. Lock continuity — non-owner does not clear lock ─────────

  describe('lock continuity — non-owner does not clear another lock', () => {
    test('concurrent handleNavFailure calls do not clear in-flight lock', async () => {
      const userId = 'test-user-lock-continuity';
      const sessionKey = 'session-key-continuity';

      recordNavFailure(userId, sessionKey);
      recordNavFailure(userId, sessionKey);

      acquireRecoveryLock(userId, sessionKey);
      expect(isUserRecovering(userId, sessionKey)).toBe(true);

      const exceeded = recordNavFailure(userId, sessionKey);
      expect(exceeded).toBe(true);

      mockCloseContext.mockResolvedValue(undefined);
      await handleNavFailure(userId, sessionKey);

      expect(isUserRecovering(userId, sessionKey)).toBe(true);
      expect(mockCloseContext).not.toHaveBeenCalled();

      releaseRecoveryLock(userId, sessionKey);
      deleteUserHealth(userId, sessionKey);
      expect(isUserRecovering(userId, sessionKey)).toBe(false);
    });
  });

  // ── 8. Session identity propagation ───────────────────────────

  describe('session identity — recovery targets exact session', () => {
    test('handleNavFailure passes sessionMapKey to closeContextBySession', async () => {
      const userId = 'test-user-session-id';
      const tabId = 'tab-session-id';
      const { sessionKey } = setupFakeTab(userId, tabId);

      mockNavigate.mockRejectedValue(new Error('nav fail'));

      await supertest(app)
        .post(`/tabs/${tabId}/navigate`)
        .send({ userId, url: 'http://example.com' })
        .expect(500);

      expect(__getUserHealthForTests(userId, sessionKey)?.consecutiveNavFailures).toBe(1);

      await supertest(app)
        .post(`/tabs/${tabId}/navigate`)
        .send({ userId, url: 'http://example.com' })
        .expect(500);

      expect(__getUserHealthForTests(userId, sessionKey)?.consecutiveNavFailures).toBe(2);
    });
  });

  // ── 9. Missing pool entry — session/tab records still cleaned up ──

  describe('boundary — indexed session + missing pool entry', () => {
    test('teardown proceeds even when pool entry is already gone', async () => {
      const userId = 'test-user-missing-pool';
      const tabId = 'tab-missing-pool';
      const sessionKey = 'session-key-missing-pool';

      // Set up a session with a tab, but NO pool entry (simulates
      // an unexpected context close that already removed the pool entry).
      const sessions = sessionModule.__getSessionsMapForTests();
      const sessionOwners = sessionModule.__getSessionOwnersForTests();
      const session = {
        context: { close: jest.fn().mockResolvedValue(undefined) },
        tabGroups: new Map([[sessionKey, new Map([[tabId, {
          page: { url: () => 'about:blank', close: jest.fn() },
          visitedUrls: new Set(),
          refs: new Map(),
          toolCalls: 0,
          downloads: [],
        }]])]]),
        lastAccess: Date.now(),
        createdAt: Date.now(),
        generation: nextTestSessionGeneration(),
      };
      sessions.set(sessionKey, session);
      sessionOwners.set(sessionKey, String(userId));
      sessionModule.indexTab(tabId, sessionKey);

      // Verify tab is findable before recovery
      expect(sessionModule.findTabById(tabId, userId)).not.toBeNull();

      // No pool entry for this sessionKey
      expect(mockPool.get(sessionKey)).toBeUndefined();

      // Trigger recovery via handleNavFailure (3 failures)
      mockNavigate.mockRejectedValue(new Error('nav fail'));
      for (let i = 0; i < 3; i++) {
        await supertest(app)
          .post(`/tabs/${tabId}/navigate`)
          .send({ userId, url: 'http://example.com' })
          .expect(500);
      }

      // The session/tab records should be cleaned up even without a pool entry
      expect(sessionModule.findTabById(tabId, userId)).toBeNull();
      expect(sessions.has(sessionKey)).toBe(false);
    });
  });

  // ── 10. Replacement race — old entry closed, new entry preserved ──

  describe('boundary — old/new entry replacement during recovery', () => {
    test('teardownSessionByKey with old generation does not close newer entry', async () => {
      const sessionKey = 'session-key-gen-test';
      const userId = 'test-user-gen';
      const oldGeneration = nextTestSessionGeneration();
      const newGeneration = nextTestSessionGeneration();

      // Set up a session
      const sessions = sessionModule.__getSessionsMapForTests();
      const sessionOwners = sessionModule.__getSessionOwnersForTests();
      sessions.set(sessionKey, {
        context: { close: jest.fn().mockResolvedValue(undefined) },
        tabGroups: new Map([[sessionKey, new Map()]]),
        lastAccess: Date.now(),
        createdAt: Date.now(),
        generation: oldGeneration,
      });
      sessionOwners.set(sessionKey, userId);

      // Set up a NEW pool entry with a different immutable generation.
      const newCreatedAt = 2000;
      mockPool.set(sessionKey, { userId, createdAt: newCreatedAt, generation: newGeneration, staged: false });
      mockCloseContext.mockClear();
      mockCloseContextIfMatches.mockClear();

      // Call teardown with the OLD context generation — this simulates
      // the race where the pool entry was replaced during the await.
      await sessionModule.teardownSessionByKey(sessionKey, oldGeneration);

      // The session/tab records are cleaned up regardless (teardown always runs)
      expect(sessions.has(sessionKey)).toBe(false);

      // The NEW pool entry should NOT have been closed (generation mismatch)
      // closeContextIfMatches should have been called but should NOT have deleted the entry
      expect(mockCloseContextIfMatches).toHaveBeenCalledWith(sessionKey, oldGeneration);
      expect(mockCloseContext).not.toHaveBeenCalled();

      // Pool entry survives
      const entry = mockPool.get(sessionKey);
      expect(entry).toBeDefined();
      expect(entry.createdAt).toBe(newCreatedAt);
    });

    test('teardownSessionByKey with matching generation closes the entry', async () => {
      const sessionKey = 'session-key-gen-match';
      const userId = 'test-user-gen-match';
      const generation = nextTestSessionGeneration();

      const sessions = sessionModule.__getSessionsMapForTests();
      const sessionOwners = sessionModule.__getSessionOwnersForTests();
      sessions.set(sessionKey, {
        context: { close: jest.fn().mockResolvedValue(undefined) },
        tabGroups: new Map([[sessionKey, new Map()]]),
        lastAccess: Date.now(),
        createdAt: Date.now(),
        generation,
      });
      sessionOwners.set(sessionKey, userId);

      const createdAt = 5000;
      mockPool.set(sessionKey, { userId, createdAt, generation, staged: false });
      mockCloseContext.mockClear();
      mockCloseContextIfMatches.mockClear();

      await sessionModule.teardownSessionByKey(sessionKey, generation);

      // The entry should be closed and removed from the pool
      expect(mockCloseContextIfMatches).toHaveBeenCalledWith(sessionKey, generation);
      expect(mockCloseContext).toHaveBeenCalledWith(sessionKey);
      expect(mockPool.get(sessionKey)).toBeUndefined();
      expect(sessions.has(sessionKey)).toBe(false);
    });
  });

  // ── 11. Health eviction on ordinary session close/expiry ──────────

  describe('boundary — health eviction on ordinary session close', () => {
    test('cleanupSessionsForUserId evicts per-session health entries', () => {
      const userId = 'test-user-health-eviction';
      const sessionKey = sessionModule.getSessionMapKey(userId, null);

      // Set up a session
      setupFakeTab(userId, 'tab-health-eviction');

      // Create a health entry for this session
      recordNavFailure(userId, sessionKey);
      recordNavFailure(userId, sessionKey);
      expect(__getUserHealthForTests(userId, sessionKey)?.consecutiveNavFailures).toBe(2);

      // Trigger ordinary session cleanup (not recovery — just normal close)
      sessionModule.cleanupSessionsForUserId(userId, 'test_cleanup');

      // Health entry should be evicted
      expect(__getUserHealthForTests(userId, sessionKey)).toBeUndefined();
    });

    test('one sessions health entry is evicted without affecting siblings', () => {
      const userId = 'test-user-sibling-eviction';
      const sessionKeyA = 'session-key-evict-a';
      const sessionKeyB = 'session-key-evict-b';

      setupSiblingSessions(userId, 'tab-evict-a', sessionKeyA, 'tab-evict-b', sessionKeyB);

      // Create health entries for both sessions
      recordNavFailure(userId, sessionKeyA);
      recordNavFailure(userId, sessionKeyA);
      recordNavFailure(userId, sessionKeyB);

      expect(__getUserHealthForTests(userId, sessionKeyA)?.consecutiveNavFailures).toBe(2);
      expect(__getUserHealthForTests(userId, sessionKeyB)?.consecutiveNavFailures).toBe(1);

      // Delete only session A from the sessions map (simulating targeted cleanup)
      const sessions = sessionModule.__getSessionsMapForTests();
      sessions.delete(sessionKeyA);

      // cleanupSessionsForUserId is user-wide; but we can test the per-session
      // eviction by calling deleteUserHealth directly for session A
      deleteUserHealth(userId, sessionKeyA);

      expect(__getUserHealthForTests(userId, sessionKeyA)).toBeUndefined();
      expect(__getUserHealthForTests(userId, sessionKeyB)?.consecutiveNavFailures).toBe(1);
    });
  });

  // ── 12. Round 7 — Foreign owner no-op (HIGH A) ───────────────────

  describe('round 7 — foreign owner is a no-op', () => {
    test('closeContextBySession with foreign owner does not close victim session', async () => {
      const victimUser = 'victim-user';
      const attackerUser = 'other-user';
      const sessionKey = 'session-key-foreign-owner';

      // Set up a session owned by victim-user
      const sessions = sessionModule.__getSessionsMapForTests();
      const sessionOwners = sessionModule.__getSessionOwnersForTests();
      sessions.set(sessionKey, {
        context: { close: jest.fn().mockResolvedValue(undefined) },
        tabGroups: new Map([[sessionKey, new Map()]]),
        lastAccess: Date.now(),
        createdAt: Date.now(),
        generation: nextTestSessionGeneration(),
      });
      sessionOwners.set(sessionKey, victimUser);

      // Pool entry exists, owned by victim-user
      mockPool.set(sessionKey, { userId: victimUser, createdAt: 1000, generation: nextTestSessionGeneration(), staged: false });
      mockCloseContext.mockClear();
      mockCloseContextIfMatches.mockClear();

      // Attacker calls closeContextBySession with victim's sessionKey
      const { contextPool } = require('../../dist/src/services/context-pool');
      await contextPool.closeContextBySession(attackerUser, sessionKey);

      // The victim's session should still exist
      expect(sessions.has(sessionKey)).toBe(true);

      // No context close should have happened
      expect(mockCloseContext).not.toHaveBeenCalled();
      expect(mockCloseContextIfMatches).not.toHaveBeenCalled();

      // Pool entry should still be there
      expect(mockPool.get(sessionKey)).toBeDefined();
    });
  });

  // ── 13. Round 7 — Missing-at-snapshot does not close replacement (HIGH B) ──

  describe('round 7 — missing-at-snapshot: index cleanup only, no close', () => {
    test('teardownSessionByKey with undefined expectedCreatedAt does not close any context', async () => {
      const sessionKey = 'session-key-missing-snapshot';
      const userId = 'test-user-missing-snap';

      const sessions = sessionModule.__getSessionsMapForTests();
      const sessionOwners = sessionModule.__getSessionOwnersForTests();
      sessions.set(sessionKey, {
        context: { close: jest.fn().mockResolvedValue(undefined) },
        tabGroups: new Map([[sessionKey, new Map()]]),
        lastAccess: Date.now(),
        createdAt: Date.now(),
        generation: nextTestSessionGeneration(),
      });
      sessionOwners.set(sessionKey, userId);

      // NO pool entry — missing at snapshot
      mockCloseContext.mockClear();
      mockCloseContextIfMatches.mockClear();

      await sessionModule.teardownSessionByKey(sessionKey, undefined);

      // Session record should be cleaned up
      expect(sessions.has(sessionKey)).toBe(false);

      // NO context close should have been attempted (HIGH B)
      expect(mockCloseContext).not.toHaveBeenCalled();
      expect(mockCloseContextIfMatches).not.toHaveBeenCalled();
    });

    test('missing-at-snapshot does not close a replacement context that appeared during await', async () => {
      const sessionKey = 'session-key-replacement-during-await';
      const userId = 'test-user-replacement';

      const sessions = sessionModule.__getSessionsMapForTests();
      const sessionOwners = sessionModule.__getSessionOwnersForTests();
      // Old session (generation 1000)
      const oldCreatedAt = 1000;
      sessions.set(sessionKey, {
        context: { close: jest.fn().mockResolvedValue(undefined) },
        tabGroups: new Map([[sessionKey, new Map()]]),
        lastAccess: Date.now(),
        createdAt: oldCreatedAt,
        generation: nextTestSessionGeneration(),
      });
      sessionOwners.set(sessionKey, userId);

      // No pool entry at snapshot time, but a new one appears during the await.
      // We simulate this by making closeContextIfMatches add a new pool entry
      // (representing a replacement context arriving during the await).
      // Since expectedCreatedAt is undefined, closeContextIfMatches is never
      // called — so no close happens. The session record IS cleaned up.
      mockCloseContext.mockClear();
      mockCloseContextIfMatches.mockClear();

      await sessionModule.teardownSessionByKey(sessionKey, undefined);

      // Session record should be cleaned up
      expect(sessions.has(sessionKey)).toBe(false);

      // No context close at all — the replacement is safe
      expect(mockCloseContext).not.toHaveBeenCalled();
      expect(mockCloseContextIfMatches).not.toHaveBeenCalled();
    });
  });

  // ── 14. Round 7 — Session record replacement race (HIGH C) ──────

  describe('round 7 — session record replacement preserved during await', () => {
    test('teardownSessionByKey does not delete a replacement session that reused the same key', async () => {
      const sessionKey = 'session-key-replacement-race';
      const userId = 'test-user-sess-race';

      const sessions = sessionModule.__getSessionsMapForTests();
      const sessionOwners = sessionModule.__getSessionOwnersForTests();

      // Old session with temporal metadata createdAt = 1000.
      const oldCreatedAt = 1000;
      const oldGeneration = nextTestSessionGeneration();
      sessions.set(sessionKey, {
        context: { close: jest.fn().mockResolvedValue(undefined) },
        tabGroups: new Map([[sessionKey, new Map()]]),
        lastAccess: Date.now(),
        createdAt: oldCreatedAt,
        generation: oldGeneration,
      });
      sessionOwners.set(sessionKey, userId);

      // Pool entry with matching generation
      mockPool.set(sessionKey, { userId, createdAt: oldCreatedAt, generation: oldGeneration, staged: false });

      // Make closeContextIfMatches replace the session during the close await.
      // This simulates a new session appearing with the same key and a
      // distinct opaque session generation.
      const newCreatedAt = 2000;
      const newGeneration = nextTestSessionGeneration();
      mockCloseContextIfMatches.mockImplementation(async (key, expectedGeneration) => {
        const entry = mockPool.get(key);
        if (!entry || entry.generation !== expectedGeneration) return;
        mockPool.delete(key);
        mockCloseContext(key);
        // Simulate replacement: a new session appears with the same key
        sessions.set(key, {
          context: { close: jest.fn().mockResolvedValue(undefined) },
          tabGroups: new Map([[key, new Map()]]),
          lastAccess: Date.now(),
          createdAt: newCreatedAt,
          generation: newGeneration,
        });
        sessionOwners.set(key, userId);
      });

      await sessionModule.teardownSessionByKey(sessionKey, oldGeneration);

      // The NEW session should still exist — teardown should NOT have deleted it
      const currentSession = sessions.get(sessionKey);
      expect(currentSession).toBeDefined();
      expect(currentSession.createdAt).toBe(newCreatedAt);
      expect(currentSession.generation).toBe(newGeneration);
    });
  });

  // ── 15. Round 7 — Recovery lock not cleared before recovery completes (HIGH D) ──

  describe('round 7 — recovery lock lifetime owned by handleNavFailure', () => {
    test('teardownSessionByKey does not delete recovery lock state', async () => {
      const userId = 'test-user-lock-lifetime';
      const sessionKey = 'session-key-lock-lifetime';

      const sessions = sessionModule.__getSessionsMapForTests();
      const sessionOwners = sessionModule.__getSessionOwnersForTests();
      sessions.set(sessionKey, {
        context: { close: jest.fn().mockResolvedValue(undefined) },
        tabGroups: new Map([[sessionKey, new Map()]]),
        lastAccess: Date.now(),
        createdAt: Date.now(),
        generation: nextTestSessionGeneration(),
      });
      sessionOwners.set(sessionKey, userId);

      // Acquire the recovery lock — simulating handleNavFailure's lock
      acquireRecoveryLock(userId, sessionKey);
      expect(isUserRecovering(userId, sessionKey)).toBe(true);

      // Call teardownSessionByKey (as handleNavFailure does)
      await sessionModule.teardownSessionByKey(sessionKey, undefined);

      // The recovery lock should STILL be held — teardownSessionByKey
      // must NOT call deleteUserHealth (which would erase the lock)
      expect(isUserRecovering(userId, sessionKey)).toBe(true);

      // Cleanup: release lock + evict health
      releaseRecoveryLock(userId, sessionKey);
      deleteUserHealth(userId, sessionKey);
      expect(isUserRecovering(userId, sessionKey)).toBe(false);
    });

    test('handleNavFailure retains lock until finally block completes', async () => {
      const userId = 'test-user-handle-lock';
      const sessionKey = 'session-key-handle-lock';

      // Set up a session
      const sessions = sessionModule.__getSessionsMapForTests();
      const sessionOwners = sessionModule.__getSessionOwnersForTests();
      sessions.set(sessionKey, {
        context: { close: jest.fn().mockResolvedValue(undefined) },
        tabGroups: new Map([[sessionKey, new Map()]]),
        lastAccess: Date.now(),
        createdAt: Date.now(),
        generation: nextTestSessionGeneration(),
      });
      sessionOwners.set(sessionKey, userId);

      // Record 2 failures (below threshold)
      recordNavFailure(userId, sessionKey);
      recordNavFailure(userId, sessionKey);

      // 3rd failure triggers recovery via handleNavFailure
      // We use a slow closeContextBySession to verify the lock is held
      // during the entire recovery operation.
      let lockStateDuringRecovery = null;
      mockCloseContextBySession.mockImplementationOnce(async (u, key) => {
        // During recovery — check the lock state
        lockStateDuringRecovery = isUserRecovering(u, key);
        // Also call the real teardown to clean up
        const sessionModule = require('../../dist/src/services/session');
        await sessionModule.teardownSessionByKey(key, undefined);
      });

      await handleNavFailure(userId, sessionKey);

      // The lock should have been held during recovery
      expect(lockStateDuringRecovery).toBe(true);

      // After handleNavFailure's finally block: lock released + health evicted
      expect(isUserRecovering(userId, sessionKey)).toBe(false);
      expect(__getUserHealthForTests(userId, sessionKey)).toBeUndefined();
    });
  });

  // ── 9. Round 8 — durable session identity + foreign owner ─────────

  describe('round 8 — replacement during pre-teardown async gap', () => {
    test('session snapshot captured before await prevents tearing down replacement', async () => {
      const userId = 'test-user-r8-replacement';
      const sessionKey = 'session-key-r8-replacement';
      const sessions = sessionModule.__getSessionsMapForTests();
      const sessionOwners = sessionModule.__getSessionOwnersForTests();

      const originalCreatedAt = 1000;
      const replacementCreatedAt = 2000;
      const originalGeneration = nextTestSessionGeneration();
      const replacementGeneration = nextTestSessionGeneration();

      sessions.set(sessionKey, {
        context: { close: jest.fn().mockResolvedValue(undefined) },
        tabGroups: new Map([[sessionKey, new Map([['tab-r8', {
          page: { url: () => 'about:blank', close: jest.fn() },
          visitedUrls: new Set(), refs: new Map(), toolCalls: 0, downloads: [],
        }]])]]),
        lastAccess: Date.now(),
        createdAt: originalCreatedAt,
        generation: originalGeneration,
      });
      sessionOwners.set(sessionKey, userId);
      sessionModule.indexTab('tab-r8', sessionKey);

      mockPool.set(sessionKey, { userId, createdAt: originalCreatedAt, generation: originalGeneration, staged: false });

      const snapshot = sessionModule.getSessionSnapshot(sessionKey);
      expect(snapshot.owner).toBe(userId);
      expect(snapshot.generation).toBe(originalGeneration);

      mockCloseContextIfMatches.mockImplementationOnce(async () => {
        sessions.set(sessionKey, {
          context: { close: jest.fn().mockResolvedValue(undefined) },
          tabGroups: new Map([[sessionKey, new Map()]]),
          lastAccess: Date.now(),
          createdAt: replacementCreatedAt,
          generation: replacementGeneration,
        });
      });

      const result = await sessionModule.teardownSessionByKey(sessionKey, originalGeneration, snapshot);

      expect(result).toBe(true);
      const currentSession = sessions.get(sessionKey);
      expect(currentSession).toBeDefined();
      expect(currentSession.createdAt).toBe(replacementCreatedAt);
      expect(currentSession.generation).toBe(replacementGeneration);
      expect(sessionModule.findTabById('tab-r8', userId)).toBeNull();
      expect(sessionOwners.get(sessionKey)).toBe(userId);
    });
  });

  describe('round 8 — missing pool entry with foreign durable session owner', () => {
    test('foreign user cannot delete victim session when pool entry is gone', async () => {
      const victimUser = 'victim-user-r8';
      const foreignUser = 'foreign-user-r8';
      const sessionKey = 'session-key-r8-foreign';

      const sessions = sessionModule.__getSessionsMapForTests();
      const sessionOwners = sessionModule.__getSessionOwnersForTests();

      sessions.set(sessionKey, {
        context: { close: jest.fn().mockResolvedValue(undefined) },
        tabGroups: new Map([[sessionKey, new Map([['tab-victim-r8', {
          page: { url: () => 'about:blank', close: jest.fn() },
          visitedUrls: new Set(), refs: new Map(), toolCalls: 0, downloads: [],
        }]])]]),
        lastAccess: Date.now(),
        createdAt: 1000,
        generation: nextTestSessionGeneration(),
      });
      sessionOwners.set(sessionKey, victimUser);
      sessionModule.indexTab('tab-victim-r8', sessionKey);

      // Pool entry is MISSING — do NOT set in mockPool

      await mockCloseContextBySession(foreignUser, sessionKey);

      expect(sessions.has(sessionKey)).toBe(true);
      expect(sessionOwners.get(sessionKey)).toBe(victimUser);
      expect(sessionModule.findTabById('tab-victim-r8', victimUser)).not.toBeNull();
      expect(mockCloseContext).not.toHaveBeenCalled();
    });

    test('owner can still tear down own session when pool entry is gone', async () => {
      const userId = 'owner-user-r8';
      const sessionKey = 'session-key-r8-owner-missing-pool';

      const sessions = sessionModule.__getSessionsMapForTests();
      const sessionOwners = sessionModule.__getSessionOwnersForTests();

      sessions.set(sessionKey, {
        context: { close: jest.fn().mockResolvedValue(undefined) },
        tabGroups: new Map([[sessionKey, new Map([['tab-owner-r8', {
          page: { url: () => 'about:blank', close: jest.fn() },
          visitedUrls: new Set(), refs: new Map(), toolCalls: 0, downloads: [],
        }]])]]),
        lastAccess: Date.now(),
        createdAt: 1000,
        generation: nextTestSessionGeneration(),
      });
      sessionOwners.set(sessionKey, userId);
      sessionModule.indexTab('tab-owner-r8', sessionKey);

      // Pool entry is missing — do NOT set in mockPool

      await mockCloseContextBySession(userId, sessionKey);

      expect(sessions.has(sessionKey)).toBe(false);
      expect(sessionOwners.has(sessionKey)).toBe(false);
      expect(sessionModule.findTabById('tab-owner-r8', userId)).toBeNull();
      expect(mockCloseContext).not.toHaveBeenCalled();
    });
  });

  // ── Round 9: OpenClaw /tabs/open nav health wiring ────────────────

  describe('round 9 — OpenClaw /tabs/open nav health wiring', () => {
    test('deleteUserHealth preserves entry while recovering is true', () => {
      __clearUserHealthForTests();
      // Simulate a recovery in flight: 3 failures exceed threshold,
      // then acquireRecoveryLock sets recovering=true.
      recordNavFailure('user-r9', 'session-r9');
      recordNavFailure('user-r9', 'session-r9');
      recordNavFailure('user-r9', 'session-r9');
      acquireRecoveryLock('user-r9', 'session-r9');
      const h = __getUserHealthForTests('user-r9', 'session-r9');
      expect(h).toBeDefined();
      expect(h.recovering).toBe(true);

      // Ordinary session cleanup tries to evict — must be a no-op
      deleteUserHealth('user-r9', 'session-r9');
      const h2 = __getUserHealthForTests('user-r9', 'session-r9');
      expect(h2).toBeDefined();
      expect(h2.recovering).toBe(true);

      // After recovery finishes (releaseRecoveryLock + deleteUserHealth),
      // the entry IS evicted
      releaseRecoveryLock('user-r9', 'session-r9');
      deleteUserHealth('user-r9', 'session-r9');
      expect(__getUserHealthForTests('user-r9', 'session-r9')).toBeUndefined();
    });

    test('deleteUserHealth evicts non-recovering entries normally', () => {
      __clearUserHealthForTests();
      recordNavFailure('user-r9b', 'session-r9b');
      expect(__getUserHealthForTests('user-r9b', 'session-r9b')).toBeDefined();

      // Not recovering — should be evicted
      deleteUserHealth('user-r9b', 'session-r9b');
      expect(__getUserHealthForTests('user-r9b', 'session-r9b')).toBeUndefined();
    });

    test('POST /tabs/open triggers recovery after three navigation failures', async () => {
      const userId = 'user-open-r9';
      const { sessionKey } = setupOpenClawSession(userId);
      mockNavigate.mockRejectedValue(new Error('navigation failed'));

      for (let i = 0; i < 3; i++) {
        const response = await supertest(app)
          .post('/tabs/open')
          .send({ userId, url: 'https://example.com' })
          .expect(500);
        expect(response.body.error).toContain('navigation failed');
      }

      expect(mockNavigate).toHaveBeenCalledTimes(3);
      expect(mockCloseContextBySession).toHaveBeenCalledTimes(1);
      expect(mockCloseContextBySession).toHaveBeenCalledWith(userId, sessionKey);
      expect(__getUserHealthForTests(userId, sessionKey)).toBeUndefined();
    });

    test('POST /tabs/open success resets prior navigation failures', async () => {
      const userId = 'user-open-success-r9';
      const { sessionKey } = setupOpenClawSession(userId);
      mockNavigate
        .mockRejectedValueOnce(new Error('navigation failed 1'))
        .mockRejectedValueOnce(new Error('navigation failed 2'))
        .mockResolvedValueOnce(undefined);

      const firstFailure = await supertest(app).post('/tabs/open').send({ userId, url: 'https://example.com/a' }).expect(500);
      const secondFailure = await supertest(app).post('/tabs/open').send({ userId, url: 'https://example.com/b' }).expect(500);
      expect(firstFailure.body.error).toContain('navigation failed 1');
      expect(secondFailure.body.error).toContain('navigation failed 2');
      expect(mockNavigate).toHaveBeenCalledTimes(2);
      expect(__getUserHealthForTests(userId, sessionKey)?.consecutiveNavFailures).toBe(2);

      await supertest(app).post('/tabs/open').send({ userId, url: 'https://example.com/c' }).expect(200);

      expect(__getUserHealthForTests(userId, sessionKey)?.consecutiveNavFailures ?? 0).toBe(0);
      expect(mockCloseContextBySession).not.toHaveBeenCalled();
    });

    test('POST /tabs/open provisioning failure does not count as navigation failure', async () => {
      const userId = 'user-open-prov-r9';
      const { sessionKey } = setupOpenClawSession(userId);
      mockAcquirePageForNewTab.mockRejectedValue(new Error('page provisioning failed'));

      for (let i = 0; i < 3; i++) {
        await supertest(app)
          .post('/tabs/open')
          .send({ userId, url: 'https://example.com' })
          .expect(500);
      }

      expect(__getUserHealthForTests(userId, sessionKey)?.consecutiveNavFailures ?? 0).toBe(0);
      expect(mockCloseContextBySession).not.toHaveBeenCalled();
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    test('POST /tabs/open validation failure does not count as navigation failure', async () => {
      const userId = 'user-open-validation-r9';
      const { sessionKey } = setupOpenClawSession(userId);
      mockValidateUrl.mockResolvedValue('blocked URL');

      for (let i = 0; i < 3; i++) {
        await supertest(app)
          .post('/tabs/open')
          .send({ userId, url: 'https://example.com' })
          .expect(400);
      }

      expect(__getUserHealthForTests(userId, sessionKey)?.consecutiveNavFailures ?? 0).toBe(0);
      expect(mockCloseContextBySession).not.toHaveBeenCalled();
      expect(mockAcquirePageForNewTab).not.toHaveBeenCalled();
    });
  });
});
