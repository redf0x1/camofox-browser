const path = require('node:path');
const { once } = require('node:events');

const { launchServer } = require('../../dist/src/utils/launcher');
const { loadConfig } = require('../../dist/src/utils/config');
const { startServer, stopServer, getServerUrl } = require('../helpers/startServer');
const { startTestSite, stopTestSite, getTestSiteUrl } = require('../helpers/testSite');

describe('security hardening', () => {
  afterEach(async () => {
    await stopServer();
  });

  afterAll(async () => {
    await stopTestSite();
  });

  test('loopback-only default keeps local protected routes usable without an API key', async () => {
    await startServer(3948, { CAMOFOX_API_KEY: '' });

    const response = await fetch(`${getServerUrl()}/sessions/local-user/traces`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.traces)).toBe(true);
  }, 60000);

  test('protected routes still require a bearer token when CAMOFOX_API_KEY is configured', async () => {
    await startServer(3949, { CAMOFOX_API_KEY: 'top-secret' });

    const unauthorized = await fetch(`${getServerUrl()}/sessions/local-user/traces`);
    expect(unauthorized.status).toBe(403);

    const authorized = await fetch(`${getServerUrl()}/sessions/local-user/traces`, {
      headers: { Authorization: 'Bearer top-secret' },
    });
    expect(authorized.status).toBe(200);
  }, 60000);

  test('server exits early when network-wide bind is requested without an API key', async () => {
    const pluginDir = path.join(__dirname, '../..');
    const baseConfig = loadConfig();
    const logs = [];
    const proc = launchServer({
      pluginDir,
      port: 3950,
      env: {
        ...baseConfig.serverEnv,
        CAMOFOX_HOST: '0.0.0.0',
        CAMOFOX_API_KEY: '',
      },
      log: {
        info: (msg) => logs.push(msg),
        error: (msg) => logs.push(msg),
      },
    });

    try {
      const closeEvent = once(proc, 'close');
      let rejectTimeout;
      const timeoutPromise = new Promise((_, reject) => {
        rejectTimeout = reject;
      });
      const timeoutId = setTimeout(() => rejectTimeout(new Error('server stayed alive')), 5000);
      const result = await Promise.race([
        closeEvent,
        timeoutPromise,
      ]);
      clearTimeout(timeoutId);

      expect(result[0]).not.toBe(0);
      expect(logs.join('\n')).toContain('CAMOFOX_API_KEY');
    } finally {
      if (proc.exitCode === null && !proc.killed) {
        proc.kill('SIGTERM');
        await once(proc, 'close').catch(() => {});
      }
    }
  }, 15000);

  test('server exits early when exposed proxy mode keeps private-network blocking enabled', async () => {
    const pluginDir = path.join(__dirname, '../..');
    const baseConfig = loadConfig();
    const logs = [];
    const proc = launchServer({
      pluginDir,
      port: 3953,
      env: {
        ...baseConfig.serverEnv,
        CAMOFOX_HOST: '0.0.0.0',
        CAMOFOX_API_KEY: 'top-secret',
        PROXY_HOST: 'proxy.example.test',
        PROXY_PORT: '8080',
      },
      log: {
        info: (msg) => logs.push(msg),
        error: (msg) => logs.push(msg),
      },
    });

    try {
      const closeEvent = once(proc, 'close');
      let rejectTimeout;
      const timeoutPromise = new Promise((_, reject) => {
        rejectTimeout = reject;
      });
      const timeoutId = setTimeout(() => rejectTimeout(new Error('server stayed alive')), 5000);
      const result = await Promise.race([
        closeEvent,
        timeoutPromise,
      ]);
      clearTimeout(timeoutId);

      expect(result[0]).not.toBe(0);
      expect(logs.join('\n')).toContain('CAMOFOX_ALLOW_PRIVATE_NETWORK');
    } finally {
      if (proc.exitCode === null && !proc.killed) {
        proc.kill('SIGTERM');
        await once(proc, 'close').catch(() => {});
      }
    }
  }, 15000);

  test('openclaw select actions surface blocked private-network navigations as 400 errors', async () => {
    await startServer(3951, {
      CAMOFOX_HOST: '0.0.0.0',
      CAMOFOX_API_KEY: 'top-secret',
    });
    const userId = `openclaw-user-${Date.now()}`;
    const listItemId = `security-hardening-${Date.now()}`;
    const authHeaders = {
      'content-type': 'application/json',
      Authorization: 'Bearer top-secret',
    };

    const openResponse = await fetch(`${getServerUrl()}/tabs`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        userId,
        sessionKey: listItemId,
      }),
    });
    const opened = await openResponse.json();
    expect(openResponse.status).toBe(200);
    expect(opened.tabId).toBeTruthy();

    const setupResponse = await fetch(`${getServerUrl()}/tabs/${opened.tabId}/evaluate`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        userId,
        expression: `(() => {
          document.body.innerHTML = '<select id="target-select"><option value="">Choose</option><option value="http://169.254.169.254/latest/meta-data">Metadata</option></select>';
          document.getElementById('target-select').addEventListener('change', (event) => {
            if (event.target.value) {
              window.location.href = event.target.value;
            }
          });
          return true;
        })()`,
      }),
    });
    const setupBody = await setupResponse.json();
    expect(setupResponse.status).toBe(200);
    expect(setupBody.ok).toBe(true);

    const actResponse = await fetch(`${getServerUrl()}/act`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        userId,
        targetId: opened.tabId,
        kind: 'select',
        selector: '#target-select',
        value: 'http://169.254.169.254/latest/meta-data',
      }),
    });
    const actBody = await actResponse.json();

    expect(actResponse.status).toBe(400);
    expect(actBody.error).toContain('Blocked private network target');
  }, 120000);

  test('evaluate surfaces delayed blocked private-network navigations as 400 errors immediately', async () => {
    await startServer(3952, {
      CAMOFOX_HOST: '0.0.0.0',
      CAMOFOX_API_KEY: 'top-secret',
    });
    const authHeaders = {
      'content-type': 'application/json',
      Authorization: 'Bearer top-secret',
    };
    const createBlockedTab = async (userId) => {
      const openResponse = await fetch(`${getServerUrl()}/tabs`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ userId, sessionKey: `snapshot-${userId}` }),
      });
      const opened = await openResponse.json();
      expect(openResponse.status).toBe(200);
      return opened.tabId;
    };

    const userId = `snapshot-core-${Date.now()}`;
    const tabId = await createBlockedTab(userId);
    const evaluateResponse = await fetch(`${getServerUrl()}/tabs/${tabId}/evaluate`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        userId,
        expression: `(() => {
          setTimeout(() => {
            window.location.href = 'http://169.254.169.254/latest/meta-data';
          }, 700);
          return true;
        })()`,
      }),
    });
    const evaluateBody = await evaluateResponse.json();
    expect(evaluateResponse.status).toBe(400);
    expect(evaluateBody.error).toContain('Blocked private network target');
  }, 120000);
});
