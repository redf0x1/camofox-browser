const path = require('path');
const crypto = require('crypto');

const { launchServer } = require('../../dist/src/utils/launcher');
const { loadConfig } = require('../../dist/src/utils/config');

let serverProcess = null;
let serverUrl = null;

async function startServerWithEnv(extraEnv = {}) {
  const cfg = loadConfig();
  const pluginDir = path.join(__dirname, '../..');

  const maxStartAttempts = 5;
  let lastErr = null;

  for (let attempt = 0; attempt < maxStartAttempts; attempt++) {
    const port = Math.floor(3100 + Math.random() * 900);

    serverProcess = launchServer({
      pluginDir,
      port,
      env: { ...cfg.serverEnv, DEBUG_RESPONSES: 'false', ...extraEnv },
      log: { info: () => {}, error: (msg) => console.error(msg) },
    });

    try {
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const res = await fetch(`http://localhost:${port}/health`);
          if (res.ok) {
            serverUrl = `http://localhost:${port}`;
            return;
          }
        } catch {}
      }
      throw new Error(`Server failed to start on port ${port}`);
    } catch (err) {
      lastErr = err;
      try {
        serverProcess.kill('SIGTERM');
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
      serverProcess = null;
      serverUrl = null;
    }
  }

  throw lastErr || new Error('Server failed to start');
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProcess) return resolve();
    const killTimer = setTimeout(() => {
      if (serverProcess) serverProcess.kill('SIGKILL');
    }, 5000);
    serverProcess.on('close', () => {
      clearTimeout(killTimer);
      serverProcess = null;
      serverUrl = null;
      resolve();
    });
    serverProcess.kill('SIGTERM');
  });
}

function makeHeaders(apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function createTab(userId, sessionKey) {
  const res = await fetch(`${serverUrl}/tabs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, sessionKey }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`createTab failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data.tabId;
}

async function evaluateExtended(tabId, body, apiKey) {
  const res = await fetch(`${serverUrl}/tabs/${tabId}/evaluate-extended`, {
    method: 'POST',
    headers: makeHeaders(apiKey),
    body: JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  return { res, data };
}

describe('POST /tabs/:tabId/evaluate-extended without CAMOFOX_API_KEY', () => {
  beforeAll(async () => {
    await startServerWithEnv({ CAMOFOX_API_KEY: '' });
  }, 120000);

  afterAll(async () => {
    await stopServer();
  }, 30000);

  test('allows request without auth header when CAMOFOX_API_KEY is not set', async () => {
    const { res, data } = await evaluateExtended('missing-tab', {
      userId: 'user-no-key',
      expression: '1 + 1',
    });

    expect(res.status).toBe(404);
    expect(data.ok).toBe(false);
    expect(data.error).toBe('Tab not found');
  });
});

describe('POST /tabs/:tabId/evaluate-extended with CAMOFOX_API_KEY', () => {
  const API_KEY = `test-eval-key-${crypto.randomUUID()}`;

  beforeAll(async () => {
    await startServerWithEnv({
      CAMOFOX_API_KEY: API_KEY,
      CAMOFOX_EVAL_EXTENDED_RATE_LIMIT_MAX: '3',
      CAMOFOX_EVAL_EXTENDED_RATE_LIMIT_WINDOW_MS: '60000',
    });
  }, 120000);

  afterAll(async () => {
    await stopServer();
  }, 30000);

  test('returns 403 with wrong API key', async () => {
    const { res, data } = await evaluateExtended('missing-tab', {
      userId: 'user-wrong-key',
      expression: '1 + 1',
    }, 'wrong-key');

    expect(res.status).toBe(403);
    expect(data.ok).toBe(false);
    expect(data.error).toBe('Forbidden');
  });

  test('returns 403 with no API key header', async () => {
    const { res, data } = await evaluateExtended('missing-tab', {
      userId: 'user-no-header',
      expression: '1 + 1',
    });

    expect(res.status).toBe(403);
    expect(data.ok).toBe(false);
    expect(data.error).toBe('Forbidden');
  });

  test('returns 400 when expression is missing', async () => {
    const { res, data } = await evaluateExtended('missing-tab', {
      userId: `user-missing-${crypto.randomUUID()}`,
    }, API_KEY);

    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.error).toContain('expression is required');
  });

  test('returns 400 when expression is not a string', async () => {
    const { res, data } = await evaluateExtended('missing-tab', {
      userId: `user-non-string-${crypto.randomUUID()}`,
      expression: { bad: true },
    }, API_KEY);

    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.error).toContain('must be a string');
  });

  test('returns 200 with valid simple expression', async () => {
    const userId = `eval-simple-${crypto.randomUUID()}`;
    const tabId = await createTab(userId, `session-${crypto.randomUUID()}`);

    const { res, data } = await evaluateExtended(tabId, {
      userId,
      expression: '1 + 1',
    }, API_KEY);

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.result).toBe(2);
    expect(data.resultType).toBe('number');
  });

  test('returns correct resultType for string, number, and object', async () => {
    const userId = `eval-types-${crypto.randomUUID()}`;
    const tabId = await createTab(userId, `session-${crypto.randomUUID()}`);

    const stringResult = await evaluateExtended(tabId, {
      userId,
      expression: '"hello"',
    }, API_KEY);
    expect(stringResult.res.status).toBe(200);
    expect(stringResult.data.resultType).toBe('string');

    const numberResult = await evaluateExtended(tabId, {
      userId,
      expression: '123',
    }, API_KEY);
    expect(numberResult.res.status).toBe(200);
    expect(numberResult.data.resultType).toBe('number');

    const objectUserId = `eval-types-obj-${crypto.randomUUID()}`;
    const objectTabId = await createTab(objectUserId, `session-${crypto.randomUUID()}`);
    const objectResult = await evaluateExtended(objectTabId, {
      userId: objectUserId,
      expression: '({ a: 1, b: "two" })',
    }, API_KEY);
    expect(objectResult.res.status).toBe(200);
    expect(objectResult.data.resultType).toBe('object');
  });

  test('returns 408 on timeout', async () => {
    const userId = `eval-timeout-${crypto.randomUUID()}`;
    const tabId = await createTab(userId, `session-${crypto.randomUUID()}`);

    const { res, data } = await evaluateExtended(tabId, {
      userId,
      expression: '(async () => { await new Promise(r => setTimeout(r, 5000)); return "done"; })()',
      timeout: 100,
    }, API_KEY);

    expect(res.status).toBe(408);
    expect(data.ok).toBe(false);
    expect(data.errorType).toBe('timeout');
  });

  test('returns truncated=true for large results', async () => {
    const userId = `eval-truncate-${crypto.randomUUID()}`;
    const tabId = await createTab(userId, `session-${crypto.randomUUID()}`);

    const { res, data } = await evaluateExtended(tabId, {
      userId,
      expression: '"x".repeat(1200000)',
    }, API_KEY);

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.truncated).toBe(true);
    expect(data.resultType).toBe('string');
  });

  test('rate limit: returns 429 after exceeding limit', async () => {
    const userId = `eval-rate-${crypto.randomUUID()}`;

    const req1 = await evaluateExtended('missing-tab', { userId, expression: '1 + 1' }, API_KEY);
    const req2 = await evaluateExtended('missing-tab', { userId, expression: '1 + 1' }, API_KEY);
    const req3 = await evaluateExtended('missing-tab', { userId, expression: '1 + 1' }, API_KEY);
    const req4 = await evaluateExtended('missing-tab', { userId, expression: '1 + 1' }, API_KEY);

    expect(req1.res.status).toBe(404);
    expect(req2.res.status).toBe(404);
    expect(req3.res.status).toBe(404);

    expect(req4.res.status).toBe(429);
    expect(req4.data.ok).toBe(false);
    expect(req4.data.error).toContain('Rate limit exceeded');
    expect(typeof req4.data.retryAfterMs).toBe('number');
    expect(req4.res.headers.get('retry-after')).toBeTruthy();
  });

  test('existing /evaluate endpoint still works (regression)', async () => {
    const userId = `eval-regression-${crypto.randomUUID()}`;
    const tabId = await createTab(userId, `session-${crypto.randomUUID()}`);

    const res = await fetch(`${serverUrl}/tabs/${tabId}/evaluate`, {
      method: 'POST',
      headers: makeHeaders(API_KEY),
      body: JSON.stringify({ userId, expression: '1 + 2' }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.result).toBe(3);
    expect(data.resultType).toBe('number');
  });
});
