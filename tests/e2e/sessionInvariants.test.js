const { execFile } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const { promisify } = require('util');

const { startServer, stopServer, getServerUrl } = require('../helpers/startServer');
const { startTestSite, stopTestSite, getTestSiteUrl } = require('../helpers/testSite');

const execFileAsync = promisify(execFile);

async function postJson(serverUrl, path, body) {
  const res = await fetch(`${serverUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.CAMOFOX_API_KEY ? { Authorization: `Bearer ${process.env.CAMOFOX_API_KEY}` } : {}),
    },
    body: JSON.stringify(body),
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  return { res, data };
}

async function getJson(serverUrl, path) {
  const res = await fetch(`${serverUrl}${path}`, {
    headers: process.env.CAMOFOX_API_KEY ? { Authorization: `Bearer ${process.env.CAMOFOX_API_KEY}` } : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  return { res, data };
}

async function waitForPoolSize(serverUrl, expectedPoolSize, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;

  while (Date.now() < deadline) {
    const response = await getJson(serverUrl, '/health');
    last = response.data;
    if (response.res.status === 200 && response.data?.poolSize === expectedPoolSize) {
      return response.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for poolSize=${expectedPoolSize}. Last health payload: ${JSON.stringify(last)}`);
}

async function deleteSession(serverUrl, userId) {
  const res = await fetch(`${serverUrl}/sessions/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: process.env.CAMOFOX_API_KEY ? { Authorization: `Bearer ${process.env.CAMOFOX_API_KEY}` } : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  return { res, data };
}

describe('Session invariants', () => {
  let serverUrl;
  let testSiteUrl;
  const cleanupUsers = new Set();

  function trackUser(prefix) {
    const userId = `${prefix}-${crypto.randomUUID()}`;
    cleanupUsers.add(userId);
    return userId;
  }

  beforeAll(async () => {
    await startServer(0, { CAMOFOX_MAX_SESSIONS: '1', CAMOFOX_API_KEY: '' });
    serverUrl = getServerUrl();
    await startTestSite();
    testSiteUrl = getTestSiteUrl();
  }, 120000);

  afterEach(async () => {
    for (const userId of cleanupUsers) {
      await deleteSession(serverUrl, userId).catch(() => {});
    }
    cleanupUsers.clear();
  });

  afterAll(async () => {
    await stopTestSite();
    await stopServer();
  }, 30000);

  test('reuses canonical profile when the request omits overrides', async () => {
    const userId = trackUser('reuse');

    const established = await postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'default',
      url: `${testSiteUrl}/pageA`,
      preset: 'us-east',
    });
    expect(established.res.status).toBe(200);

    const reused = await postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'secondary',
      url: `${testSiteUrl}/pageB`,
    });
    expect(reused.res.status).toBe(200);
    expect(reused.data.tabId).toBeDefined();
  });

  test('compares canonical equality using resolved overrides after preset expansion', async () => {
    const userId = trackUser('equivalent');

    const established = await postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'default',
      url: `${testSiteUrl}/pageA`,
      preset: 'us-east',
    });
    expect(established.res.status).toBe(200);

    const equivalent = await postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'equivalent',
      url: `${testSiteUrl}/pageB`,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      geolocation: { latitude: 40.7128, longitude: -74.006 },
    });
    expect(equivalent.res.status).toBe(200);

    const conflict = await postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'conflict',
      url: `${testSiteUrl}/pageA`,
      preset: 'germany',
    });
    expect(conflict.res.status).toBe(409);
    expect(conflict.data.error).toBe('Context override conflict');
  });

  test('passive eviction preserves the canonical profile and reuses stored overrides on rebuild', async () => {
    const scriptPath = path.join(__dirname, '../helpers/passiveSessionInvariantCheck.js');
    const result = await execFileAsync(process.execPath, [scriptPath], {
      cwd: path.join(__dirname, '../..'),
      env: process.env,
      timeout: 120000,
    });

    expect(result.stdout).toContain('PASS passive-session-invariant');
  }, 120000);

  test('openclaw first use requires an established canonical profile', async () => {
    const userId = trackUser('openclaw-first');

    const response = await postJson(serverUrl, '/tabs/open', {
      userId,
      url: `${testSiteUrl}/pageA`,
    });
    expect(response.res.status).toBe(409);
    expect(response.data.error).toBe('No canonical profile');
  });

  test('openclaw reuses an existing canonical profile', async () => {
    const userId = trackUser('openclaw-reuse');

    const established = await postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'default',
      url: `${testSiteUrl}/pageA`,
    });
    expect(established.res.status).toBe(200);

    const response = await postJson(serverUrl, '/tabs/open', {
      userId,
      url: `${testSiteUrl}/pageB`,
    });
    expect(response.res.status).toBe(200);
    expect(response.data.targetId || response.data.tabId).toBeDefined();
  });

  test('cookie import without tabId remains non-creating and returns 409 without a canonical profile', async () => {
    const userId = trackUser('cookies');

    const response = await postJson(serverUrl, `/sessions/${encodeURIComponent(userId)}/cookies`, {
      cookies: [{ name: 'session', value: '1', domain: '.example.com' }],
    });
    expect(response.res.status).toBe(409);
    expect(response.data.error).toBe('No canonical profile');
  });

  test('failed first tab create does not leave stale canonical profile', async () => {
    const userId = trackUser('fail-create');

    const failed = await postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'default',
      url: 'chrome://invalid-url',
      preset: 'us-east',
    });
    expect(failed.res.status).toBeGreaterThanOrEqual(400);

    const openclaw = await postJson(serverUrl, '/tabs/open', {
      userId,
      url: `${testSiteUrl}/pageA`,
    });
    expect(openclaw.res.status).toBe(409);
    expect(openclaw.data.error).toBe('No canonical profile');

    const cookie = await postJson(serverUrl, `/sessions/${encodeURIComponent(userId)}/cookies`, {
      cookies: [{ name: 'session', value: '1', domain: '.example.com' }],
    });
    expect(cookie.res.status).toBe(409);
    expect(cookie.data.error).toBe('No canonical profile');
  });

  test('runtime failure during first tab create rolls back canonical profile without leaking staged state', async () => {
    const userId = trackUser('rollback');
    const beforeHealth = await getJson(serverUrl, '/health');
    expect(beforeHealth.res.status).toBe(200);

    // Use a URL that passes validation (http scheme) but fails at navigation
    const failed = await postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'default',
      url: 'http://localhost:1/',
      preset: 'us-east',
    });
    expect(failed.res.status).toBe(500);

    const afterHealth = await getJson(serverUrl, '/health');
    expect(afterHealth.res.status).toBe(200);
    expect(afterHealth.data.poolSize).toBe(beforeHealth.data.poolSize);
    expect(afterHealth.data.activeUserIds).not.toContain(userId);

    const listedTabs = await getJson(serverUrl, `/tabs?userId=${encodeURIComponent(userId)}`);
    expect(listedTabs.res.status).toBe(200);
    expect(listedTabs.data.tabs).toEqual([]);

    // Canonical must have been rolled back
    const openclaw = await postJson(serverUrl, '/tabs/open', {
      userId,
      url: testSiteUrl + '/pageA',
    });
    expect(openclaw.res.status).toBe(409);
    expect(openclaw.data.error).toBe('No canonical profile');

    const cookie = await postJson(serverUrl, `/sessions/${encodeURIComponent(userId)}/cookies`, {
      cookies: [{ name: 'session', value: '1', domain: '.example.com' }],
    });
    expect(cookie.res.status).toBe(409);
    expect(cookie.data.error).toBe('No canonical profile');
  }, 30000);

  test('pre-generation failure releases mutex so next create succeeds', async () => {
    const blockingUser = trackUser('blocker');
    const testUser = trackUser('pre-gen-fail');

    const blocker = await postJson(serverUrl, '/tabs', {
      userId: blockingUser,
      sessionKey: 'block',
      url: `${testSiteUrl}/pageA`,
    });
    expect(blocker.res.status).toBe(200);

    const fail = await postJson(serverUrl, '/tabs', {
      userId: testUser,
      sessionKey: 'attempt1',
      url: `${testSiteUrl}/pageA`,
    });
    expect(fail.res.status).toBe(500);

    const deleted = await deleteSession(serverUrl, blockingUser);
    expect(deleted.res.status).toBe(200);
    await waitForPoolSize(serverUrl, 0);

    const retry = await postJson(serverUrl, '/tabs', {
      userId: testUser,
      sessionKey: 'attempt2',
      url: `${testSiteUrl}/pageA`,
      preset: 'us-east',
    });
    expect(retry.res.status).toBe(200);
    expect(retry.data.tabId).toBeDefined();

    const snap = await getJson(serverUrl, `/tabs/${retry.data.tabId}/snapshot?userId=${encodeURIComponent(testUser)}`);
    expect(snap.res.status).toBe(200);
  }, 30000);

  test('concurrent first-create: failed staged request cannot leak a mismatched context into the committed canonical session', async () => {
    const userId = trackUser('concurrent');

    const responseA = postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'a',
      url: 'http://localhost:1/',
      preset: 'us-east',
    });

    await new Promise(r => setTimeout(r, 50));
    const responseB = postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'b',
      url: `${testSiteUrl}/pageA`,
      preset: 'germany',
    });

    const [a, b] = await Promise.all([responseA, responseB]);

    expect(a.res.status).toBe(500);
    expect(b.res.status).toBe(200);
    expect(b.data.tabId).toBeDefined();

    const reuse = await postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'c',
      url: `${testSiteUrl}/pageB`,
    });
    expect(reuse.res.status).toBe(200);
    expect(reuse.data.tabId).toBeDefined();

    const conflict = await postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'conflict',
      url: `${testSiteUrl}/pageA`,
      preset: 'us-east',
    });
    expect(conflict.res.status).toBe(409);
    expect(conflict.data.error).toBe('Context override conflict');

    const evaluated = await postJson(serverUrl, `/tabs/${b.data.tabId}/evaluate`, {
      userId,
      expression: '({ language: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })',
    });
    expect(evaluated.res.status).toBe(200);
    expect(evaluated.data.ok).toBe(true);
    expect(evaluated.data.result.language).toBe('de-DE');
    expect(evaluated.data.result.timezone).toBe('Europe/Berlin');
  }, 60000);

  test('explicit DELETE during staged first-use disposes context', async () => {
    const userId = trackUser('staged-delete');

    const stagedCreate = postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'slow',
      url: `${testSiteUrl}/slow?delay=5000`,
      preset: 'us-east',
    });

    const stagedHealth = await waitForPoolSize(serverUrl, 1, 10000);
    expect(stagedHealth.activeUserIds).not.toContain(userId);

    const closed = await deleteSession(serverUrl, userId);
    expect(closed.res.status).toBe(200);

    const stagedResult = await stagedCreate;
    expect([409, 500]).toContain(stagedResult.res.status);

    const afterHealth = await waitForPoolSize(serverUrl, 0, 10000);
    expect(afterHealth.activeUserIds).toEqual([]);

    const openclaw = await postJson(serverUrl, '/tabs/open', {
      userId,
      url: `${testSiteUrl}/pageA`,
    });
    expect(openclaw.res.status).toBe(409);
    expect(openclaw.data.error).toBe('No canonical profile');
  }, 30000);

  test('stale creator from deleted generation cannot commit or rollback replacement generation', async () => {
    const userId = trackUser('aba-race');

    const createA = postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'gen-a',
      url: `${testSiteUrl}/slow?delay=5000`,
      preset: 'us-east',
    });

    await waitForPoolSize(serverUrl, 1, 10000);

    const closed = await deleteSession(serverUrl, userId);
    expect(closed.res.status).toBe(200);

    const resultA = await createA;
    expect([409, 500]).toContain(resultA.res.status);

    const createB = await postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'gen-b',
      url: `${testSiteUrl}/pageA`,
      preset: 'germany',
    });
    expect(createB.res.status).toBe(200);
    expect(createB.data.tabId).toBeDefined();

    const tabId = createB.data.tabId;
    const evaluated = await postJson(serverUrl, `/tabs/${tabId}/evaluate`, {
      userId,
      expression: '({ lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone })',
    });
    expect(evaluated.res.status).toBe(200);
    expect(evaluated.data.result.lang).toBe('de-DE');
    expect(evaluated.data.result.tz).toBe('Europe/Berlin');

    const health = await getJson(serverUrl, '/health');
    expect(health.data.activeUserIds).toContain(userId);
  }, 30000);

  test('stale rollback after replacement commits cannot corrupt replacement state', async () => {
    const userId = trackUser('aba-overlap');

    const createA = postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'gen-a',
      url: `${testSiteUrl}/slow?delay=10000`,
      preset: 'us-east',
    });

    await waitForPoolSize(serverUrl, 1, 10000);

    const closed = await deleteSession(serverUrl, userId);
    expect(closed.res.status).toBe(200);

    const resultB = await postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'gen-b',
      url: `${testSiteUrl}/pageA`,
      preset: 'germany',
    });
    expect(resultB.res.status).toBe(200);
    expect(resultB.data.tabId).toBeDefined();
    const tabIdB = resultB.data.tabId;

    const resultA = await createA;
    expect([409, 500]).toContain(resultA.res.status);

    const snap = await getJson(serverUrl, `/tabs/${tabIdB}/snapshot?userId=${encodeURIComponent(userId)}`);
    expect(snap.res.status).toBe(200);

    const evaluated = await postJson(serverUrl, `/tabs/${tabIdB}/evaluate`, {
      userId,
      expression: '({ lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone })',
    });
    expect(evaluated.res.status).toBe(200);
    expect(evaluated.data.ok).toBe(true);
    expect(evaluated.data.result.lang).toBe('de-DE');
    expect(evaluated.data.result.tz).toBe('Europe/Berlin');

    const health = await getJson(serverUrl, '/health');
    expect(health.res.status).toBe(200);
    expect(health.data.activeUserIds).toContain(userId);
  }, 60000);

  test('staged downloads stay hidden from user download listings', async () => {
    const userId = trackUser('staged-downloads');

    const stagedCreate = postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'slow',
      url: `${testSiteUrl}/slow?delay=5000`,
      preset: 'us-east',
    });

    const stagedHealth = await waitForPoolSize(serverUrl, 1, 10000);
    expect(stagedHealth.activeUserIds).not.toContain(userId);

    const duringDownloads = await getJson(serverUrl, `/users/${encodeURIComponent(userId)}/downloads`);
    expect(duringDownloads.res.status).toBe(200);
    expect(duringDownloads.data.downloads).toEqual([]);

    const closed = await deleteSession(serverUrl, userId);
    expect(closed.res.status).toBe(200);

    const stagedResult = await stagedCreate;
    expect([409, 500]).toContain(stagedResult.res.status);

    const afterDownloads = await getJson(serverUrl, `/users/${encodeURIComponent(userId)}/downloads`);
    expect(afterDownloads.res.status).toBe(200);
    expect(afterDownloads.data.downloads).toEqual([]);
  }, 30000);

  test('staged user stays hidden from /health activeUserIds until commit', async () => {
    const userId = trackUser('staged-health');

    const stagedCreate = postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'slow',
      url: `${testSiteUrl}/slow?delay=2000`,
      preset: 'us-east',
    });

    const stagedHealth = await waitForPoolSize(serverUrl, 1, 10000);
    expect(stagedHealth.activeUserIds).not.toContain(userId);

    const stagedResult = await stagedCreate;
    expect(stagedResult.res.status).toBe(200);
    expect(stagedResult.data.tabId).toBeDefined();

    const committedHealth = await getJson(serverUrl, '/health');
    expect(committedHealth.res.status).toBe(200);
    expect(committedHealth.data.poolSize).toBe(1);
    expect(committedHealth.data.activeUserIds).toContain(userId);
  }, 30000);

  test('staged first-create counts toward session capacity before commit while staying hidden from activeUserIds', async () => {
    const stagedUserId = trackUser('staged-capacity-a');
    const blockedUserId = trackUser('staged-capacity-b');

    const stagedCreate = postJson(serverUrl, '/tabs', {
      userId: stagedUserId,
      sessionKey: 'slow',
      url: `${testSiteUrl}/slow?delay=2000`,
      preset: 'us-east',
    });

    const stagedHealth = await waitForPoolSize(serverUrl, 1, 10000);
    expect(stagedHealth.activeUserIds).not.toContain(stagedUserId);

    const blocked = await postJson(serverUrl, '/tabs', {
      userId: blockedUserId,
      sessionKey: 'blocked',
      url: `${testSiteUrl}/pageA`,
      preset: 'germany',
    });
    expect(blocked.res.status).toBe(500);
    expect(blocked.data.error).toMatch(/maximum concurrent sessions reached/i);

    const stagedResult = await stagedCreate;
    expect(stagedResult.res.status).toBe(200);
    expect(stagedResult.data.tabId).toBeDefined();
  }, 30000);

  test('enforces per-user tab cap under canonical profile contract', async () => {
    const userId = trackUser('tab-cap');

    const first = await postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'default',
      url: `${testSiteUrl}/pageA`,
    });
    expect(first.res.status).toBe(200);

    let lastStatus = 200;
    let tabCount = 1;
    const tabIds = [first.data.tabId];
    while (lastStatus === 200 && tabCount < 100) {
      const resp = await postJson(serverUrl, '/tabs', {
        userId,
        sessionKey: `cap-${tabCount}`,
        url: `${testSiteUrl}/pageA`,
      });
      lastStatus = resp.res.status;
      if (lastStatus === 200) {
        tabCount++;
        tabIds.push(resp.data.tabId);
      } else {
        expect(lastStatus).toBe(429);
        expect(resp.data.error).toMatch(/maximum tabs/i);
      }
    }

    expect(lastStatus).toBe(429);
    expect(tabCount).toBeGreaterThanOrEqual(2);
    expect(tabIds.length).toBe(tabCount);
  });

  test('explicit session close clears the canonical profile', async () => {
    const userId = trackUser('close');

    const established = await postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'default',
      url: `${testSiteUrl}/pageA`,
    });
    expect(established.res.status).toBe(200);

    const closed = await deleteSession(serverUrl, userId);
    expect(closed.res.status).toBe(200);

    const openclawResponse = await postJson(serverUrl, '/tabs/open', {
      userId,
      url: `${testSiteUrl}/pageA`,
    });
    expect(openclawResponse.res.status).toBe(409);
    expect(openclawResponse.data.error).toBe('No canonical profile');

    const cookieResponse = await postJson(serverUrl, `/sessions/${encodeURIComponent(userId)}/cookies`, {
      cookies: [{ name: 'session', value: '1', domain: '.example.com' }],
    });
    expect(cookieResponse.res.status).toBe(409);
    expect(cookieResponse.data.error).toBe('No canonical profile');
  });

  test('openclaw /tabs/open captures native downloads triggered on initial navigation', async () => {
    const userId = trackUser('oc-download');

    // Step 1: Establish canonical profile via core
    const canonical = await postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'default',
      url: `${testSiteUrl}/pageA`,
    });
    expect(canonical.res.status).toBe(200);

    // Step 2: Open tab via OpenClaw pointing to download fixture.
    // Playwright may throw "Download is starting" on direct-attachment
    // navigation, but the download listener fires regardless.
    await postJson(serverUrl, '/tabs/open', {
      userId,
      url: `${testSiteUrl}/download-file`,
    }).catch(() => {});

    // Step 3: Poll user-level downloads endpoint (avoids depending on tab state)
    let downloads = [];
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const dlRes = await getJson(serverUrl, `/users/${encodeURIComponent(userId)}/downloads`);
      if (dlRes.res.status === 200 && dlRes.data?.downloads?.length > 0) {
        downloads = dlRes.data.downloads;
        if (downloads.some(d => d.status === 'completed')) break;
      }
      await new Promise(r => setTimeout(r, 200));
    }

    // Step 4: Assert download was captured
    expect(downloads.length).toBeGreaterThanOrEqual(1);
    const dl = downloads.find(d => d.status === 'completed');
    expect(dl).toBeDefined();
    expect(dl.suggestedFilename).toBe('test-download.bin');
  }, 30000);
});