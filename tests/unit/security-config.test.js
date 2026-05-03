jest.mock('node:os', () => ({
  homedir: () => '/mock-home',
}));

jest.mock('node:fs', () => ({
  mkdirSync: jest.fn(),
}));

describe('server exposure config safety', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('defaults to loopback host and local private-network access', () => {
    const { loadConfig, assertServerExposureSafety } = require('../../dist/src/utils/config');

    const config = loadConfig({});

    expect(config.host).toBe('127.0.0.1');
    expect(config.allowPrivateNetworkTargets).toBe(true);
    expect(() => assertServerExposureSafety(config)).not.toThrow();
  });

  test('rejects non-loopback bind without an API key', () => {
    const { loadConfig, assertServerExposureSafety } = require('../../dist/src/utils/config');

    const config = loadConfig({
      CAMOFOX_HOST: '0.0.0.0',
    });

    expect(config.allowPrivateNetworkTargets).toBe(false);
    expect(() => assertServerExposureSafety(config)).toThrow(
      'CAMOFOX_API_KEY is required when CAMOFOX_HOST exposes the server beyond loopback',
    );
  });

  test('allows non-loopback bind when an API key is configured', () => {
    const { loadConfig, assertServerExposureSafety } = require('../../dist/src/utils/config');

    const config = loadConfig({
      CAMOFOX_HOST: '0.0.0.0',
      CAMOFOX_API_KEY: 'super-secret',
    });

    expect(config.host).toBe('0.0.0.0');
    expect(config.allowPrivateNetworkTargets).toBe(false);
    expect(() => assertServerExposureSafety(config)).not.toThrow();
  });

  test('treats the full 127.0.0.0/8 range as loopback', () => {
    const { loadConfig, assertServerExposureSafety } = require('../../dist/src/utils/config');

    const config = loadConfig({
      CAMOFOX_HOST: '127.0.0.2',
    });

    expect(config.allowPrivateNetworkTargets).toBe(true);
    expect(() => assertServerExposureSafety(config)).not.toThrow();
  });

  test('allows explicit private-network override for trusted deployments', () => {
    const { loadConfig } = require('../../dist/src/utils/config');

    const config = loadConfig({
      CAMOFOX_HOST: '0.0.0.0',
      CAMOFOX_API_KEY: 'super-secret',
      CAMOFOX_ALLOW_PRIVATE_NETWORK: 'true',
    });

    expect(config.allowPrivateNetworkTargets).toBe(true);
  });

  test('rejects proxy-enabled exposed binds when private-network blocking is active', () => {
    const { loadConfig, assertServerExposureSafety } = require('../../dist/src/utils/config');

    const config = loadConfig({
      CAMOFOX_HOST: '0.0.0.0',
      CAMOFOX_API_KEY: 'super-secret',
      PROXY_HOST: 'proxy.example.test',
      PROXY_PORT: '8080',
    });

    expect(config.allowPrivateNetworkTargets).toBe(false);
    expect(() => assertServerExposureSafety(config)).toThrow(
      'Proxy-enabled non-loopback deployments must set CAMOFOX_ALLOW_PRIVATE_NETWORK=true until proxy-side private-target validation is supported',
    );
  });

  test('allows proxy-enabled exposed binds when private-network access is explicitly allowed', () => {
    const { loadConfig, assertServerExposureSafety } = require('../../dist/src/utils/config');

    const config = loadConfig({
      CAMOFOX_HOST: '0.0.0.0',
      CAMOFOX_API_KEY: 'super-secret',
      CAMOFOX_ALLOW_PRIVATE_NETWORK: 'true',
      PROXY_HOST: 'proxy.example.test',
      PROXY_PORT: '8080',
    });

    expect(config.allowPrivateNetworkTargets).toBe(true);
    expect(() => assertServerExposureSafety(config)).not.toThrow();
  });
});
