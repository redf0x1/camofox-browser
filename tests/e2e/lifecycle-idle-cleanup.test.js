const { startServer, stopServer, getServerUrl } = require('../helpers/startServer');
const { startTestSite, stopTestSite, getTestSiteUrl } = require('../helpers/testSite');

async function waitForPoolSize(serverUrl, expectedPoolSize, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;

  while (Date.now() < deadline) {
    const response = await fetch(`${serverUrl}/health`);
    const data = await response.json();
    last = data;
    if (response.status === 200 && data?.poolSize === expectedPoolSize) {
      return data;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for poolSize=${expectedPoolSize}. Last health payload: ${JSON.stringify(last)}`);
}

describe('Lifecycle idle cleanup (Stage 1)', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(async () => {
    await startTestSite();
    testSiteUrl = getTestSiteUrl();
  }, 120000);

  afterAll(async () => {
    await stopTestSite();
  }, 30000);

  afterEach(async () => {
    await stopServer();
  }, 30000);

  test('idle cleanup closes runtime state and next request relaunches cleanly', async () => {
    // Start server with short idle timeout
    await startServer(0, {
      CAMOFOX_IDLE_TIMEOUT_MS: '1000',
      CAMOFOX_IDLE_EXIT_TIMEOUT_MS: '10000',
      CAMOFOX_API_KEY: '',
    });
    serverUrl = getServerUrl();

    const userId = 'idle-test-user';
    const sessionKey = 'default';

    // Create a tab to establish runtime state
    const created = await fetch(`${serverUrl}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, sessionKey, url: `${testSiteUrl}/pageA` }),
    });
    expect(created.status).toBe(200);
    const createdData = await created.json();
    expect(createdData.tabId).toBeDefined();
    const tabId = createdData.tabId;

    // Verify pool size is 1
    const healthBefore = await fetch(`${serverUrl}/health`);
    const healthBeforeData = await healthBefore.json();
    expect(healthBeforeData.poolSize).toBe(1);

    // Close the tab to allow idle cleanup
    await fetch(`${serverUrl}/tabs/${encodeURIComponent(tabId)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });

    // Wait for idle cleanup to trigger and complete
    const cleanupDeadline = Date.now() + 10000;
    let cleanedUp = false;
    while (Date.now() < cleanupDeadline) {
      const healthRes = await fetch(`${serverUrl}/health`);
      const health = await healthRes.json();
      if (health.poolSize === 0) {
        cleanedUp = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(cleanedUp).toBe(true);

    // Create a new tab with different sessionKey to verify relaunch works
    const recreated = await fetch(`${serverUrl}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, sessionKey: 'reopen', url: `${testSiteUrl}/pageB` }),
    });
    expect(recreated.status).toBe(200);
    const recreatedData = await recreated.json();
    expect(recreatedData.tabId).toBeDefined();
    expect(recreatedData.url).toContain('/pageB');

    // Wait a bit for the context to fully launch
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Verify pool is back to 1
    const healthAfter = await fetch(`${serverUrl}/health`);
    const healthAfterData = await healthAfter.json();
    expect(healthAfterData.poolSize).toBe(1);

    // Wait another 1500ms to see if cleanup runs again
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const healthFinal = await fetch(`${serverUrl}/health`);
    const healthFinalData = await healthFinal.json();
  }, 30000);

  test('idle cleanup does not run while tabs exist', async () => {
    // Start server with short idle timeout
    await startServer(0, {
      CAMOFOX_IDLE_TIMEOUT_MS: '500',
      CAMOFOX_IDLE_EXIT_TIMEOUT_MS: '10000',
      CAMOFOX_API_KEY: '',
    });
    serverUrl = getServerUrl();

    const userId = 'keep-alive-user';
    const sessionKey = 'default';

    // Create a tab
    const created = await fetch(`${serverUrl}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, sessionKey, url: `${testSiteUrl}/pageA` }),
    });
    expect(created.status).toBe(200);
    const createdData = await created.json();
    const tabId = createdData.tabId;

    // Wait beyond idle timeout
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Pool should still be 1 because tab exists
    const health = await fetch(`${serverUrl}/health`);
    const healthData = await health.json();
    expect(healthData.poolSize).toBe(1);

    // Close the tab
    await fetch(`${serverUrl}/tabs/${encodeURIComponent(tabId)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });

    // Now idle cleanup should trigger
    await waitForPoolSize(serverUrl, 0, 5000);
  }, 30000);

  test('activity resets idle timer and prevents cleanup', async () => {
    // Start server with short idle timeout
    await startServer(0, {
      CAMOFOX_IDLE_TIMEOUT_MS: '1000',
      CAMOFOX_IDLE_EXIT_TIMEOUT_MS: '10000',
      CAMOFOX_API_KEY: '',
    });
    serverUrl = getServerUrl();

    const userId = 'activity-user';
    const sessionKey = 'default';

    // Create a tab
    const created = await fetch(`${serverUrl}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, sessionKey, url: `${testSiteUrl}/pageA` }),
    });
    expect(created.status).toBe(200);
    const createdData = await created.json();
    const tabId = createdData.tabId;

    // Close the tab to allow cleanup
    await fetch(`${serverUrl}/tabs/${encodeURIComponent(userId)}/${encodeURIComponent(sessionKey)}/${encodeURIComponent(tabId)}`, {
      method: 'DELETE',
    });

    // Periodically make requests to reset idle timer
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await fetch(`${serverUrl}/health`);
    }

    // Pool should still be 1 because activity kept resetting timer
    const health = await fetch(`${serverUrl}/health`);
    const healthData = await health.json();
    expect(healthData.poolSize).toBe(1);
  }, 30000);

  test('cleanup does not close reused contexts', async () => {
    await startServer(0, {
      CAMOFOX_IDLE_TIMEOUT_MS: '1000',
      CAMOFOX_IDLE_EXIT_TIMEOUT_MS: '10000',
      CAMOFOX_API_KEY: '',
    });
    serverUrl = getServerUrl();

    const userId = 'reuse-race-user';
    const sessionKey = 'default';

    // Step 1: Create a tab to initialize context
    const createTab1 = await fetch(`${serverUrl}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        sessionKey,
        url: 'https://example.com',
      }),
    });
    expect(createTab1.status).toBe(200);
    const { tabId: tabId1 } = await createTab1.json();

    // Step 2: Delete the tab immediately (session now has 0 tabs)
    const deleteTab1 = await fetch(`${serverUrl}/tabs/${tabId1}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, sessionKey }),
    });
    expect(deleteTab1.status).toBe(200);

    // Step 3: Wait for cleanup to be triggered (just past idle timeout)
    // Cleanup interval is 250ms, so wait 1100ms to ensure cleanup has started
    await new Promise((r) => setTimeout(r, 1100));

    // Step 4: Immediately create a new tab (will reuse the context)
    // This happens WHILE cleanup might still be processing
    const createTab2 = await fetch(`${serverUrl}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        sessionKey,
        url: 'https://example.com/page2',
      }),
    });
    expect(createTab2.status).toBe(200);
    const { tabId: tabId2 } = await createTab2.json();
    expect(tabId2).toBeTruthy();

    // Step 5: Verify the new tab's context is still functional
    // Try to navigate the tab - this will fail if context was closed
    const navigate = await fetch(`${serverUrl}/tabs/${tabId2}/navigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        sessionKey,
        url: 'https://example.com/working',
      }),
    });
    expect(navigate.status).toBe(200);

    // Step 6: Verify pool still has the context
    const health = await fetch(`${serverUrl}/health`);
    const healthData = await health.json();
    expect(healthData.poolSize).toBe(1);
  }, 30000);
});
