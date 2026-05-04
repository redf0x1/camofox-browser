const { startServer, stopServer, getServerUrl } = require('../helpers/startServer');

describe('fingerprint env controls', () => {
  afterEach(async () => {
    await stopServer();
  });

  test('valid fingerprint env overrides do not break tab creation', async () => {
    const port = await startServer(0, {
      CAMOFOX_OS: 'windows,macos',
      CAMOFOX_ALLOW_WEBGL: 'true',
      CAMOFOX_HUMANIZE: 'false',
      CAMOFOX_SCREEN_WIDTH: '1920',
      CAMOFOX_SCREEN_HEIGHT: '1080',
    });

    const baseUrl = `http://localhost:${port}`;
    const createRes = await fetch(`${baseUrl}/tabs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.CAMOFOX_API_KEY ? { Authorization: `Bearer ${process.env.CAMOFOX_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        userId: 'fingerprint-env-user',
        sessionKey: 'fingerprint-env-session',
        url: 'https://example.com',
      }),
    });

    const payload = await createRes.json();
    expect(createRes.ok).toBe(true);
    expect(payload.ok ?? true).toBeTruthy();
    expect(payload.tabId).toBeTruthy();
  });

  test('incomplete screen pairs are ignored without blocking startup', async () => {
    const port = await startServer(0, {
      CAMOFOX_SCREEN_WIDTH: '1920',
    });

    const healthRes = await fetch(`${getServerUrl()}/health`);
    const payload = await healthRes.json();
    expect(healthRes.ok).toBe(true);
    expect(payload.ok).toBe(true);
  });
});
