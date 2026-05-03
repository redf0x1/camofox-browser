const crypto = require('crypto');
const { createClient } = require('../helpers/client');

const { startServer, stopServer, getServerUrl } = require('../helpers/startServer');
const { startTestSite, stopTestSite, getTestSiteUrl } = require('../helpers/testSite');

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

describe('OpenClaw proxy and geo contract', () => {
  let serverUrl;
  let testSiteUrl;
  const cleanupUsers = new Set();

  function trackUser(prefix) {
    const userId = `${prefix}-${crypto.randomUUID()}`;
    cleanupUsers.add(userId);
    return userId;
  }

  beforeAll(async () => {
    await startServer(0, {
      CAMOFOX_MAX_SESSIONS: '2',
      CAMOFOX_API_KEY: '',
      CAMOFOX_PROXY_PROFILES_FILE: require('path').join(__dirname, '../../proxy-profiles.test.json'),
    });
    serverUrl = getServerUrl();
    await startTestSite();
    testSiteUrl = getTestSiteUrl();
  }, 120000);

  afterEach(async () => {
    for (const userId of cleanupUsers) {
      await deleteSession(serverUrl, userId).catch(() => {});
    }
    cleanupUsers.clear();
  }, 30000);

  afterAll(async () => {
    await stopTestSite();
    await stopServer();
  }, 30000);

  test('OpenClaw /tabs/open accepts proxy fields when they match canonical profile', async () => {
    const userId = trackUser('openclaw-match');
    
    // Establish canonical with proxy profile
    const establish = await postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'default',
      url: `${testSiteUrl}/pageA`,
      proxyProfile: 'tokyo-exit',
    });
    expect(establish.res.status).toBe(200);
    
    // OpenClaw open should accept matching proxy fields
    const openclaw = await postJson(serverUrl, '/tabs/open', {
      userId,
      listItemId: 'default',
      url: `${testSiteUrl}/pageB`,
      proxyProfile: 'tokyo-exit',
    });
    
    expect(openclaw.res.status).toBe(200);
    expect(openclaw.data.ok).toBe(true);
  }, 60000);

  test('OpenClaw /tabs/open rejects invalid proxyProfile', async () => {
    const userId = trackUser('openclaw-invalid');
    
    // Establish canonical first
    const establish = await postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'default',
      url: `${testSiteUrl}/pageA`,
    });
    expect(establish.res.status).toBe(200);
    
    // OpenClaw open with invalid proxy profile should reject
    const openclaw = await postJson(serverUrl, '/tabs/open', {
      userId,
      listItemId: 'default',
      url: `${testSiteUrl}/pageB`,
      proxyProfile: 'nonexistent-profile',
    });
    
    expect(openclaw.res.status).toBe(400);
    expect(openclaw.data.error).toContain('Unknown proxy profile');
  }, 60000);

  test('OpenClaw /tabs/open works without proxy fields (uses canonical)', async () => {
    const userId = trackUser('openclaw-no-fields');
    
    // Establish canonical with proxy profile
    const establish = await postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'default',
      url: `${testSiteUrl}/pageA`,
      proxyProfile: 'tokyo-exit',
    });
    expect(establish.res.status).toBe(200);
    
    // OpenClaw open without proxy fields should work
    const openclaw = await postJson(serverUrl, '/tabs/open', {
      userId,
      listItemId: 'default',
      url: `${testSiteUrl}/pageB`,
    });
    
    expect(openclaw.res.status).toBe(200);
    expect(openclaw.data.ok).toBe(true);
  }, 60000);

  test('client helper can pass proxy fields through createTab', async () => {
    const client = createClient(serverUrl);
    client.userId = trackUser('helper-proxy');
    
    // Should be able to create tab with proxy fields via helper
    const result = await client.createTab(`${testSiteUrl}/pageA`, {
      proxyProfile: 'tokyo-exit',
      geoMode: 'explicit-wins',
    });
    
    expect(result.tabId).toBeDefined();
    
    await client.cleanup();
  }, 60000);

  test('client helper can pass raw proxy fields through createTab', async () => {
    const client = createClient(serverUrl);
    client.userId = trackUser('helper-raw-proxy');
    
    // Should be able to create tab with raw proxy fields via helper
    const result = await client.createTab(`${testSiteUrl}/pageA`, {
      proxy: {
        host: 'proxy.example.com',
        port: 8080,
        username: 'user',
        password: 'pass',
      },
      geoMode: 'explicit-wins',
    });
    
    expect(result.tabId).toBeDefined();
    
    await client.cleanup();
  }, 60000);
});
