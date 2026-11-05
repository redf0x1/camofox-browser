const { EventEmitter } = require('node:events');
const { attachNetworkCapture, findNetworkCapture, parseNetworkOptions } = require('../../dist/src/services/network-capture');

function request(url, from = null) {
  return {
    url: () => url,
    method: () => 'GET',
    headers: () => ({ authorization: 'request-header-secret', 'content-type': 'application/json' }),
    timing: () => ({ startTime: Date.now(), responseEnd: 10 }),
    redirectedFrom: () => from,
    resourceType: () => 'document',
    sizes: async () => ({ responseBodySize: 12 }),
  };
}

describe('network capture recorder', () => {
  const userId = 'network-test';
  const options = parseNetworkOptions({}, userId);
  const bindings = [];
  const attach = (...args) => {
    const binding = attachNetworkCapture(...args);
    bindings.push(binding);
    return binding;
  };

  afterEach(() => {
    while (bindings.length) bindings.pop().rollback();
    jest.useRealTimers();
  });

  test('validates opt-in options and rejects unknown settings', () => {
    expect(parseNetworkOptions(undefined, undefined)).toBeUndefined();
    expect(() => parseNetworkOptions({ scope: 'context' }, userId)).toThrow('Invalid');
    expect(() => parseNetworkOptions({ captureBodies: true }, userId)).toThrow('disabled');
    expect(() => parseNetworkOptions({ join: true }, userId)).toThrow('Invalid');
  });

  test('redacts URL credentials, queries, fragments, and response headers in records and HAR', async () => {
    const page = new EventEmitter();
    const { key } = attach(options, userId, {}, 'tab1', page);
    const capture = findNetworkCapture(key, userId);
    const first = request('https://alice:password@example.test/one?token=query-secret#fragment-secret');
    const second = request('https://example.test/two', first);
    page.emit('request', first);
    page.emit('response', {
      request: () => first,
      status: () => 302,
      url: () => first.url(),
      headers: () => ({ 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'cookie-secret', location: '/two?token=query-secret' }),
    });
    page.emit('requestfinished', first);
    page.emit('request', second);
    await Promise.resolve();

    expect(capture.get(1)).toMatchObject({ url: 'https://example.test/one', status: 302, responseSize: 12, mimeType: 'text/html' });
    expect(capture.get(2).redirectedFrom).toBe(1);
    expect(capture.get(1).requestHeaders).toEqual([{ name: 'content-type', value: 'application/json' }]);
    expect(JSON.stringify(capture.har())).not.toMatch(/password|query-secret|fragment-secret|cookie-secret|request-header-secret/);
    expect(capture.har().log.version).toBe('1.2');
    expect(capture.har().log.entries[0].response.redirectURL).toBe('https://example.test/two');
    expect(() => findNetworkCapture(key, 'another-user')).toThrow('not found');
  });

  test('does not capture before start, stops listeners, and expires the stopped capture', () => {
    jest.useFakeTimers();
    const page = new EventEmitter();
    const { key } = attach({ ...options, start: false }, userId, {}, 'tab1', page);
    const capture = findNetworkCapture(key, userId);
    page.emit('request', request('https://example.test/before'));
    expect(capture.list(0, 25).requests).toHaveLength(0);
    expect(capture.start()).toBe('recording');
    page.emit('request', request('https://example.test/during'));
    expect(capture.stop()).toBe('stopped');
    expect(page.listenerCount('request')).toBe(0);
    page.emit('request', request('https://example.test/after'));
    expect(capture.list(0, 25).requests).toHaveLength(1);
    expect(() => capture.start()).toThrow('has stopped');
    jest.advanceTimersByTime(5 * 60_000);
    expect(() => findNetworkCapture(key, userId)).toThrow('not found');
    expect(page.listenerCount('close')).toBe(0);
  });

  test('reads response bodies only after length, encoding and media type checks pass', async () => {
    const page = new EventEmitter();
    const { key } = attach({ ...options, captureBodies: true }, userId, {}, 'tab1', page);
    const capture = findNetworkCapture(key, userId);
    const eligible = [
      { type: 'application/json', length: '3', observed: 3, expected: 'available' },
      { type: 'text/plain', length: '3', observed: 512, expected: 'skipped' },
      { type: 'text/plain', length: '3', observed: 3, encoding: 'gzip', expected: 'skipped' },
      { type: 'application/octet-stream', length: '3', observed: 3, expected: 'skipped' },
      { type: 'text/plain', length: '16385', observed: 16385, expected: 'skipped' },
      { type: 'text/plain', observed: 3, expected: 'skipped' },
    ];
    for (const [index, testCase] of eligible.entries()) {
      const req = request('https://example.test/' + index);
      const body = jest.fn(async () => Buffer.from('123'));
      const response = {
        request: () => req,
        status: () => 200,
        headers: () => ({
          'content-type': testCase.type,
          'content-length': testCase.length,
          'content-encoding': testCase.encoding,
        }),
        fromServiceWorker: () => false,
        body,
      };
      req.response = async () => response;
      req.sizes = async () => ({ responseBodySize: testCase.observed });
      page.emit('request', req);
      page.emit('response', response);
      page.emit('requestfinished', req);
      await new Promise((resolve) => setImmediate(resolve));
      expect(capture.get(index + 1).bodyState).toBe(testCase.expected);
      expect(capture.get(index + 1)).not.toHaveProperty('body');
      if (testCase.expected === 'available') {
        expect(body).toHaveBeenCalledTimes(1);
        expect(capture.get(index + 1, true).body).toBe('123');
      } else {
        expect(body).not.toHaveBeenCalled();
        expect(capture.get(index + 1, true)).not.toHaveProperty('body');
      }
    }
    expect(JSON.stringify(capture.har())).not.toContain('"text":"123"');
  });

  test('late body completion cannot change a stopped capture', async () => {
    const page = new EventEmitter();
    const { key } = attach({ ...options, captureBodies: true }, userId, {}, 'tab1', page);
    const capture = findNetworkCapture(key, userId);
    const req = request('https://example.test/body');
    const size = new Promise((resolve) => { req.finishSize = resolve; });
    req.sizes = () => size;
    req.response = jest.fn();
    page.emit('request', req);
    page.emit('response', {
      request: () => req, status: () => 200, fromServiceWorker: () => false,
      headers: () => ({ 'content-type': 'text/plain', 'content-length': '2' }),
    });
    page.emit('requestfinished', req);
    capture.stop();
    req.finishSize({ responseBodySize: 2 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(req.response).not.toHaveBeenCalled();
    expect(capture.get(1, true)).toMatchObject({ bodyState: 'unavailable' });
    expect(capture.get(1, true)).not.toHaveProperty('body');
  });

  test('reports eviction and paginates by monotonic request ID', () => {
    const page = new EventEmitter();
    const { key } = attach(options, userId, {}, 'tab1', page);
    const capture = findNetworkCapture(key, userId);
    for (let i = 0; i < 300; i++) page.emit('request', request('https://example.test'));
    const first = capture.list(0, 25);
    expect(first.dropped).toBe(44);
    expect(first.requests[0].id).toBe(45);
    expect(first.nextCursor).toBe(69);
    expect(capture.list(69, 25).requests[0].id).toBe(70);
    expect(() => capture.get(44)).toThrow('not found');
  });

  test('enrolls only the exact session group and cleans up when its last tab closes', () => {
    const group = {};
    const first = new EventEmitter();
    const second = new EventEmitter();
    const { key } = attach({ ...options, scope: 'session' }, userId, group, 'tab1', first);
    const join = { ...options, scope: 'session', join: true };
    expect(() => attach(join, userId, {}, 'tab2', second, key)).toThrow('not found');
    const binding = attach(join, userId, group, 'tab2', second, key);
    second.emit('request', request('https://example.test/second'));
    const capture = findNetworkCapture(key, userId);
    expect(capture.get(1).tabId).toBe('tab2');
    binding.rollback();
    expect(capture.list(0, 25).requests).toHaveLength(0);
    first.emit('close');
    expect(() => findNetworkCapture(key, userId)).toThrow('not found');
  });
});
