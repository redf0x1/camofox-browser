const crypto = require('crypto');

const { startServer, stopServer, getServerUrl } = require('../helpers/startServer');
const { startTestSite, stopTestSite, getTestSiteUrl } = require('../helpers/testSite');

async function postJson(serverUrl, routePath, body) {
  const res = await fetch(`${serverUrl}${routePath}`, {
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

  try {
    await res.json();
  } catch {
    // best-effort cleanup
  }
}

describe('structured extract OpenClaw adapter', () => {
  let serverUrl;
  let testSiteUrl;
  const cleanupUsers = new Set();

  function trackUser(prefix) {
    const userId = `${prefix}-${crypto.randomUUID()}`;
    cleanupUsers.add(userId);
    return userId;
  }

  beforeAll(async () => {
    await startServer(0, { CAMOFOX_API_KEY: '' });
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

  test('OpenClaw /act proxies structured extraction', async () => {
    const userId = trackUser('openclaw-structured-user');
    const open = await postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'default',
      url: `${testSiteUrl}/structured-products`,
    });
    expect(open.res.status).toBe(200);

    const extract = await postJson(serverUrl, '/act', {
      kind: 'extractStructured',
      targetId: open.data.tabId,
      userId,
      schema: {
        kind: 'object',
        fields: {
          title: { kind: 'text', selector: 'h1', required: true, trim: true },
        },
      },
    });

    expect(extract.res.status).toBe(200);
    expect(extract.data).toEqual({
      ok: true,
      targetId: open.data.tabId,
      data: { title: 'Catalog' },
      metadata: expect.any(Object),
    });
  }, 60000);

  test('OpenClaw /act returns a 400 schema error payload for invalid schema', async () => {
    const userId = trackUser('openclaw-structured-invalid-schema');
    const open = await postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'default',
      url: `${testSiteUrl}/structured-products`,
    });
    expect(open.res.status).toBe(200);

    const extract = await postJson(serverUrl, '/act', {
      kind: 'extractStructured',
      targetId: open.data.tabId,
      userId,
      schema: {
        kind: 'object',
        fields: {
          title: { kind: 'text', selector: '//h1' },
        },
      },
    });

    expect(extract.res.status).toBe(400);
    expect(extract.data).toEqual({
      error: 'schema.fields.title.selector must be a CSS selector',
    });
  }, 60000);

  test('OpenClaw /act returns a 422 runtime error payload for missing required data', async () => {
    const userId = trackUser('openclaw-structured-runtime-error');
    const open = await postJson(serverUrl, '/tabs', {
      userId,
      sessionKey: 'default',
      url: `${testSiteUrl}/structured-missing-price`,
    });
    expect(open.res.status).toBe(200);

    const extract = await postJson(serverUrl, '/act', {
      kind: 'extractStructured',
      targetId: open.data.tabId,
      userId,
      schema: {
        kind: 'object',
        selector: '#catalog',
        fields: {
          products: {
            kind: 'list',
            selector: '.product',
            item: {
              kind: 'object',
              fields: {
                name: { kind: 'text', selector: '.name', required: true, trim: true },
                price: { kind: 'number', selector: '.price', required: true, trim: true },
              },
            },
          },
        },
      },
    });

    expect(extract.res.status).toBe(422);
    expect(extract.data).toEqual({
      error: 'Structured extraction failed',
      fieldPath: 'data.products[1].price',
      reason: 'required',
    });
  }, 60000);
});
