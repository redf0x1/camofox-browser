const { NetworkInterceptor } = require('../../dist/src/services/network-interception');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const target = 'https://example.test/data';
const mock = { action: 'fulfill', method: 'GET', url: target, status: 200, contentType: 'text/plain', body: 'fixture' };

function requestRoute({ navigation = false, resourceType = 'fetch' } = {}) {
  return {
    request: () => ({ isNavigationRequest: () => navigation, resourceType: () => resourceType, method: () => 'GET', url: () => target }),
    fallback: jest.fn(),
    fulfill: jest.fn(),
    abort: jest.fn(),
  };
}

test('interception falls through for documents and uses the newest rule set', async () => {
  const page = { route: jest.fn(async () => {}), unroute: jest.fn(async () => {}) };
  const interceptor = new NetworkInterceptor(page);
  expect(await interceptor.replace([mock])).toBe(true);
  const handle = page.route.mock.calls[0][1];

  const navigation = requestRoute({ navigation: true, resourceType: 'document' });
  await handle(navigation);
  expect(navigation.fallback).toHaveBeenCalledTimes(1);
  expect(navigation.fulfill).not.toHaveBeenCalled();

  await interceptor.replace([{ action: 'abort', method: 'GET', url: target }]);
  const fetch = requestRoute();
  await handle(fetch);
  expect(fetch.abort).toHaveBeenCalledWith('blockedbyclient');
  expect(fetch.fulfill).not.toHaveBeenCalled();

  interceptor.close();
  await Promise.resolve();
  expect(page.unroute).toHaveBeenCalledWith('**/*', handle);
});

test('stop fences an in-flight route registration and clears the exact handler', async () => {
  const install = deferred();
  const page = { route: jest.fn(() => install.promise), unroute: jest.fn(async () => {}) };
  const interceptor = new NetworkInterceptor(page);
  const pending = interceptor.replace([mock]);
  interceptor.close();
  install.resolve();
  expect(await pending).toBe(false);

  const handle = page.route.mock.calls[0][1];
  const fetch = requestRoute();
  await handle(fetch);
  expect(fetch.fallback).toHaveBeenCalledTimes(1);
  expect(fetch.fulfill).not.toHaveBeenCalled();
  expect(page.unroute).toHaveBeenCalledWith('**/*', handle);
});
