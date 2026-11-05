const { createServer } = require('node:http');
const { once } = require('node:events');
const { gzipSync } = require('node:zlib');
const { startServer, stopServer, getServerUrl, getServerLogs } = require('../helpers/startServer');

const userId = 'capture-owner';
const apiKey = 'network-fixture-api-key';
const secret = 'capture-fixture-secret';
let fixture;
let base;
let guardHits = 0;

async function request(path, { key, body, method = body ? 'POST' : 'GET', bearer = apiKey } = {}) {
  const response = await fetch(getServerUrl() + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: 'Bearer ' + bearer } : {}),
      ...(key ? { 'x-camofox-network-key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, data: await response.json() };
}

async function open(path, options = {}, key) {
  return request('/tabs', { key, body: {
    userId, sessionKey: 'network-session', url: base + path, ...options,
  } });
}

async function list(key, extra = '') {
  return request('/network/requests?userId=' + userId + extra, { key });
}

beforeAll(async () => {
  fixture = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/guard') guardHits++;
    if (path === '/redirect') {
      res.writeHead(302, { Location: '/page?auth=' + secret, 'Set-Cookie': 'sid=' + secret });
      res.end();
    } else if (path === '/page') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<script>fetch("/missing?auth=' + secret + '",{headers:{Authorization:"Bearer ' + secret + '"}}).catch(()=>{});fetch("/disconnect").catch(()=>{});</script><iframe src="/frame"></iframe>');
    } else if (path === '/body-page') {
      res.end('<script>Promise.all(["json","compressed","large","chunked"].map(path=>fetch("/body-"+path)));</script>');
    } else if (path.startsWith('/body-')) {
      const payload = path === '/body-large' ? 'z'.repeat(20000) : JSON.stringify({ secret });
      const body = path === '/body-compressed' ? gzipSync(payload) : Buffer.from(payload);
      res.setHeader('Content-Type', 'application/json');
      if (path === '/body-compressed') res.setHeader('Content-Encoding', 'gzip');
      if (path === '/body-chunked') {
        res.write(body);
        res.end();
      } else {
        res.setHeader('Content-Length', body.length);
        res.end(body);
      }
    } else if (path === '/disconnect') {
      req.socket.destroy();
    } else if (path === '/missing') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(secret);
    } else {
      res.end('fixture');
    }
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  base = 'http://127.0.0.1:' + fixture.address().port;
  await startServer(0, { CAMOFOX_API_KEY: apiKey, CAMOFOX_ALLOW_PRIVATE_NETWORK: 'true', CAMOFOX_NETWORK_INTERCEPTION: 'true', CAMOFOX_NETWORK_BODY_CAPTURE: 'true' });
}, 120_000);

afterAll(async () => {
  await stopServer();
  if (fixture?.listening) await new Promise((resolve) => fixture.close(resolve));
});

test('captures the initial navigation, redirects, XHR, frames and failures while protecting records', async () => {
  const tab = await open('/redirect?secret=' + secret, { networkCapture: { scope: 'session' } });
  expect(tab.status).toBe(200);
  const { networkKey: key, tabId } = tab.data;
  expect(tab.headers.get('cache-control')).toBe('no-store');
  expect(key).toMatch(/^[a-zA-Z0-9_-]{43}$/);

  let recorded;
  for (let attempt = 0; attempt < 80; attempt++) {
    recorded = (await list(key)).data.requests;
    if (recorded.some((item) => item.url.endsWith('/disconnect') && item.state === 'failed')
      && recorded.some((item) => item.url.endsWith('/missing') && item.state === 'finished')
      && recorded.some((item) => item.url.endsWith('/frame'))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const initial = recorded.find((item) => item.url === base + '/redirect');
  expect(initial).toMatchObject({ tabId, status: 302, state: 'finished' });
  expect(recorded).toEqual(expect.arrayContaining([
    expect.objectContaining({ url: base + '/page', redirectedFrom: initial.id, status: 200 }),
    expect.objectContaining({ url: base + '/missing', state: 'finished', status: 404 }),
    expect.objectContaining({ url: base + '/frame' }),
    expect.objectContaining({ url: base + '/disconnect', state: 'failed' }),
  ]));

  expect((await request('/network/requests?userId=other-user', { key })).status).toBe(404);
  expect((await request('/network/requests?userId=' + userId, { key, bearer: null })).status).toBe(403);
  expect((await list(undefined)).status).toBe(404);
  expect((await list(key, '&limit=51')).status).toBe(400);
  const first = (await list(key, '&limit=1')).data;
  expect(first.nextCursor).toBe(first.requests[0].id);
  expect((await request('/network/requests/' + first.nextCursor + '?userId=' + userId, { key })).data).toEqual(first.requests[0]);

  const nonMember = await open('/excluded');
  expect(nonMember.status).toBe(200);
  const sibling = await open('/wrong-group', { sessionKey: 'other-group', networkCapture: { scope: 'session', join: true } }, key);
  expect(sibling.status).toBe(404);
  const member = await open('/included', { networkCapture: { scope: 'session', join: true } }, key);
  expect(member.status).toBe(200);
  const stopped = await request('/network/capture/stop?userId=' + userId, { method: 'POST', key });
  expect(stopped.data).toEqual({ state: 'stopped' });

  const har = await request('/network/har?userId=' + userId, { key });
  expect(har.headers.get('content-disposition')).toContain('.har');
  expect(har.data.log.version).toBe('1.2');
  const urls = har.data.log.entries.map((entry) => entry.request.url);
  expect(urls).toContain(base + '/included');
  expect(urls).not.toContain(base + '/excluded');
  expect(urls).not.toContain(base + '/wrong-group');
  expect(JSON.stringify(har.data)).not.toContain(secret);
  expect(JSON.stringify((await list(key)).data)).not.toContain(secret);
  expect(getServerLogs().join('\n')).not.toContain(key);
  expect(getServerLogs().join('\n')).not.toContain(secret);
  expect((await request('/sessions/' + userId, { method: 'DELETE' })).status).toBe(200);
  expect((await list(key)).status).toBe(404);
});

test('OpenClaw can record from initial navigation and closes the capture with the tab', async () => {
  expect((await open('/warmup', { userId: 'openclaw-network' })).status).toBe(200);
  const opened = await request('/tabs/open', { body: {
    userId: 'openclaw-network', url: base + '/openclaw-start', networkCapture: {},
  } });
  expect(opened.status).toBe(200);
  const { networkKey: key, tabId } = opened.data;
  const path = '/network/requests?userId=openclaw-network';
  expect((await request(path, { key })).data.requests).toEqual(expect.arrayContaining([
    expect.objectContaining({ tabId, url: base + '/openclaw-start' }),
  ]));
  expect((await request('/tabs/' + tabId, { method: 'DELETE', body: { userId: 'openclaw-network' } })).status).toBe(200);
  expect((await request(path, { key })).status).toBe(404);
});

test('mocks and aborts only matching fetch requests on the opted-in tab', async () => {
  const captured = await open('/interception-page', { networkCapture: {} });
  expect(captured.status).toBe(200);
  const sibling = await open('/interception-sibling');
  expect(sibling.status).toBe(200);
  const { networkKey: key, tabId } = captured.data;
  const intercept = '/network/intercept?userId=' + userId;
  const rules = [
    { action: 'fulfill', method: 'GET', url: base + '/mock', status: 201, contentType: 'application/json', body: '{"mock":true}' },
    { action: 'abort', method: 'GET', url: base + '/abort' },
  ];
  expect((await request(intercept, { method: 'PUT', key, body: { rules }, bearer: null })).status).toBe(403);
  expect((await request(intercept, { method: 'PUT', key, body: { rules: [...rules, rules[0]] } })).status).toBe(400);
  expect((await request(intercept, { method: 'PUT', key, body: { rules } })).data).toEqual({ ruleCount: 2 });
  const evaluate = (id, path) => request('/tabs/' + id + '/evaluate-extended', { body: {
    userId, expression: `fetch("${path}").then(async r => ({status: r.status, text: await r.text()})).catch(() => "blocked")`,
  } });
  expect((await evaluate(tabId, '/mock')).data.result).toEqual({ status: 201, text: '{"mock":true}' });
  expect((await evaluate(tabId, '/abort')).data.result).toBe('blocked');
  expect((await evaluate(sibling.data.tabId, '/mock')).data.result).toEqual({ status: 200, text: 'fixture' });
  expect((await evaluate(tabId, '/mock?other=1')).data.result).toEqual({ status: 200, text: 'fixture' });
  await request('/network/capture/stop?userId=' + userId, { method: 'POST', key });
  expect((await evaluate(tabId, '/abort')).data.result).toEqual({ status: 200, text: 'fixture' });
  expect((await request(intercept, { method: 'PUT', key, body: { rules } })).status).toBe(409);
  await request('/sessions/' + userId, { method: 'DELETE' });
});

test('only explicitly requested small unencoded text bodies are available through detail', async () => {
  const tab = await open('/body-page', { networkCapture: { captureBodies: true } });
  expect(tab.status).toBe(200);
  const { networkKey: key } = tab.data;
  let entries;
  for (let i = 0; i < 80; i++) {
    entries = (await list(key)).data.requests;
    const finished = entries.filter((entry) => /body-(json|compressed|large|chunked)$/.test(entry.url) && entry.state === 'finished');
    if (finished.length === 4 && finished.every((entry) => entry.bodyState !== 'pending')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const json = entries.find((entry) => entry.url === base + '/body-json');
  expect(json.bodyState).toBe('available');
  expect(JSON.stringify(entries)).not.toContain(secret);
  for (const name of ['compressed', 'large', 'chunked']) {
    const skipped = entries.find((entry) => entry.url === base + '/body-' + name);
    expect(skipped.bodyState).toBe('skipped');
  }
  const details = '/network/requests/' + json.id + '?userId=' + userId;
  expect((await request(details, { key })).data).not.toHaveProperty('body');
  expect(JSON.parse((await request(details + '&includeBody=true', { key })).data.body)).toEqual({ secret });
  expect(JSON.stringify((await request('/network/har?userId=' + userId, { key })).data)).not.toContain(secret);
  await request('/sessions/' + userId, { method: 'DELETE' });
});

test('interception leaves blocked top-level navigations with the context guard', async () => {
  await stopServer();
  await startServer(0, {
    CAMOFOX_API_KEY: apiKey, CAMOFOX_ALLOW_PRIVATE_NETWORK: 'false', CAMOFOX_NETWORK_INTERCEPTION: 'true',
  });
  const opened = await request('/tabs', { body: { userId, sessionKey: 'guard', networkCapture: {} } });
  expect(opened.status).toBe(200);
  const { tabId, networkKey: key } = opened.data;
  const target = base + '/guard';
  const installed = await request('/network/intercept?userId=' + userId, { key, method: 'PUT', body: {
    rules: [{ action: 'fulfill', method: 'GET', url: target, status: 200, contentType: 'text/plain', body: 'must not navigate' }],
  } });
  expect(installed.status).toBe(200);
  const evaluated = await request('/tabs/' + tabId + '/evaluate', { body: {
    userId, expression: `setTimeout(() => { location.href = "${target}"; }, 700); "started"`,
  } });
  expect([200, 400]).toContain(evaluated.status);
  let attempted;
  for (let i = 0; i < 50; i++) {
    attempted = (await list(key)).data.requests.find((entry) => entry.url === target);
    if (attempted && attempted.state !== 'pending') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(attempted).toMatchObject({ resourceType: 'document', state: 'failed' });
  expect(guardHits).toBe(0);
});
