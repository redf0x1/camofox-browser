/**
 * Behavior-level tests for userId validation on evaluate and delete-tab endpoints.
 *
 * Replaces the source-text inspection tests with actual route invocations
 * that verify the 400 response, tenant isolation, and side effects.
 *
 * These tests start a real server (with browser) and use the HTTP client
 * to exercise the validation paths. The 400 validation tests reject before
 * any browser interaction, so they're fast. The valid-request and wrong-
 * tenant tests create a tab first to verify the full lifecycle.
 *
 * Auth-aware: direct fetch calls use authedFetch() which attaches the
 * Authorization header when CAMOFOX_API_KEY is set, matching the behavior
 * of the BrowserClient. This ensures the tests exercise the asserted
 * 400/404/200 behavior regardless of whether API-key auth is enabled.
 */

const { startServer, stopServer, getServerUrl } = require('../helpers/startServer');
const { startTestSite, stopTestSite, getTestSiteUrl } = require('../helpers/testSite');
const { createClient } = require('../helpers/client');

/**
 * Fetch wrapper that attaches the Authorization header when
 * CAMOFOX_API_KEY is set, matching the BrowserClient behavior.
 * Direct fetch() calls in this test bypass BrowserClient, so they
 * must handle auth themselves to avoid 403 when API key is configured.
 */
function authedFetch(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (process.env.CAMOFOX_API_KEY && !headers.Authorization) {
    headers.Authorization = `Bearer ${process.env.CAMOFOX_API_KEY}`;
  }
  return fetch(url, { ...options, headers });
}

describe('userId validation on evaluate and delete-tab endpoints', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(async () => {
    const port = await startServer();
    serverUrl = getServerUrl();
    const testPort = await startTestSite();
    testSiteUrl = getTestSiteUrl();
  }, 120000);

  afterAll(async () => {
    await stopTestSite();
    await stopServer();
  }, 30000);

  // ── Evaluate endpoint: POST /tabs/:tabId/evaluate ───────────────

  describe('POST /tabs/:tabId/evaluate', () => {
    test('returns 400 with exact body when userId is missing from body', async () => {
      const response = await authedFetch(`${serverUrl}/tabs/fake-tab-id/evaluate`, {
        method: 'POST',
        body: JSON.stringify({ expression: 'document.title' }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toEqual({ error: 'userId is required' });
    });

    test('returns 400 when userId is passed as query param instead of body', async () => {
      const response = await authedFetch(
        `${serverUrl}/tabs/fake-tab-id/evaluate?userId=agent1`,
        {
          method: 'POST',
          body: JSON.stringify({ expression: 'document.title' }),
        },
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toEqual({ error: 'userId is required' });
    });

    test('returns 404 when userId is valid but tab belongs to a different user (wrong tenant)', async () => {
      // Create a tab as user A
      const clientA = createClient(serverUrl);
      const tab = await clientA.createTab(`${testSiteUrl}/pageA`);

      try {
        // Try to evaluate as user B (different userId)
        const response = await authedFetch(`${serverUrl}/tabs/${tab.tabId}/evaluate`, {
          method: 'POST',
          body: JSON.stringify({ userId: 'wrong-tenant-user', expression: 'document.title' }),
        });

        expect(response.status).toBe(404);
        const body = await response.json();
        expect(body).toEqual({ error: 'Tab not found' });
      } finally {
        await clientA.cleanup();
      }
    });

    test('returns 200 with result on valid request', async () => {
      const client = createClient(serverUrl);
      const tab = await client.createTab(`${testSiteUrl}/pageA`);

      try {
        const response = await authedFetch(`${serverUrl}/tabs/${tab.tabId}/evaluate`, {
          method: 'POST',
          body: JSON.stringify({ userId: client.userId, expression: 'document.title' }),
        });

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.ok).toBe(true);
        expect(body.result).toBe('Page A');
      } finally {
        await client.cleanup();
      }
    });
  });

  // ── Delete endpoint: DELETE /tabs/:tabId ────────────────────────

  describe('DELETE /tabs/:tabId', () => {
    test('returns 400 with exact body when userId is missing from body', async () => {
      const response = await authedFetch(`${serverUrl}/tabs/fake-tab-id`, {
        method: 'DELETE',
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toEqual({ error: 'userId is required' });
    });

    test('returns 400 when userId is passed as query param instead of body', async () => {
      const response = await authedFetch(
        `${serverUrl}/tabs/fake-tab-id?userId=agent1`,
        {
          method: 'DELETE',
          body: JSON.stringify({}),
        },
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toEqual({ error: 'userId is required' });
    });

    test('returns 200 (idempotent) when userId is valid but tab belongs to a different user', async () => {
      // Create a tab as user A
      const clientA = createClient(serverUrl);
      const tab = await clientA.createTab(`${testSiteUrl}/pageA`);

      try {
        // Try to delete as user B (different userId)
        const response = await authedFetch(`${serverUrl}/tabs/${tab.tabId}`, {
          method: 'DELETE',
          body: JSON.stringify({ userId: 'wrong-tenant-user' }),
        });

        // DELETE /tabs/:tabId is idempotent — when the tab is not found
        // under the given userId scope, the route returns 200 { ok: true }
        // without closing anything. This is intentional: the caller asked
        // to close a tab and from their perspective it is already gone.
        // (findTabById returns null for wrong userId, the if-block is
        // skipped, and the route falls through to res.json({ ok: true }).)
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({ ok: true });

        // Verify the tab was NOT closed — it still belongs to user A
        const snapshot = await clientA.getSnapshot(tab.tabId);
        expect(snapshot).toBeDefined();
      } finally {
        await clientA.cleanup();
      }
    });

    test('returns 200 and closes the tab on valid request', async () => {
      const client = createClient(serverUrl);
      const tab = await client.createTab(`${testSiteUrl}/pageA`);

      // Delete the tab with the correct userId
      const response = await authedFetch(`${serverUrl}/tabs/${tab.tabId}`, {
        method: 'DELETE',
        body: JSON.stringify({ userId: client.userId }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ ok: true });

      // Verify the tab is gone — snapshot should 404
      const snapshotResponse = await authedFetch(
        `${serverUrl}/tabs/${tab.tabId}/snapshot?userId=${client.userId}`,
      );
      expect(snapshotResponse.status).toBe(404);

      // Prevent cleanup from trying to close the already-closed tab
      client.tabs = client.tabs.filter((t) => t !== tab.tabId);
      await client.closeSession();
    });

    test('safePageClose is not called when validation fails (no side effects)', async () => {
      // Create a tab as user A
      const clientA = createClient(serverUrl);
      const tab = await clientA.createTab(`${testSiteUrl}/pageA`);

      try {
        // Attempt delete with missing userId — should 400, not close the tab
        const response = await authedFetch(`${serverUrl}/tabs/${tab.tabId}`, {
          method: 'DELETE',
          body: JSON.stringify({}),
        });

        expect(response.status).toBe(400);

        // Verify the tab is still alive — snapshot should work
        const snapshot = await clientA.getSnapshot(tab.tabId);
        expect(snapshot).toBeDefined();
        expect(snapshot.snapshot).toContain('Page A');
      } finally {
        await clientA.cleanup();
      }
    });
  });
});