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

  test('parses fingerprint env overrides when values are valid', () => {
    const { loadConfig } = require('../../dist/src/utils/config');

    const config = loadConfig({
      CAMOFOX_OS: 'windows,macos',
      CAMOFOX_ALLOW_WEBGL: 'true',
      CAMOFOX_HUMANIZE: 'false',
      CAMOFOX_SCREEN_WIDTH: '1920',
      CAMOFOX_SCREEN_HEIGHT: '1080',
    });

    expect(config.fingerprintDefaults).toEqual({
      os: ['windows', 'macos'],
      allowWebgl: true,
      humanize: false,
      screen: { width: 1920, height: 1080 },
    });
  });

  test('rejects malformed fingerprint boolean env values', () => {
    const { loadConfig } = require('../../dist/src/utils/config');

    expect(() =>
      loadConfig({
        CAMOFOX_ALLOW_WEBGL: 'sometimes',
      }),
    ).toThrow('Expected boolean value (true/false) but got: "sometimes"');
  });

  test('ignores incomplete screen size pairs', () => {
    const { loadConfig } = require('../../dist/src/utils/config');

    const config = loadConfig({
      CAMOFOX_SCREEN_WIDTH: '1920',
    });

    expect(config.fingerprintDefaults).toEqual({});
  });

  test('ignores incomplete screen size pair when only height is provided', () => {
    const { loadConfig } = require('../../dist/src/utils/config');

    const config = loadConfig({
      CAMOFOX_SCREEN_HEIGHT: '1080',
    });

    expect(config.fingerprintDefaults).toEqual({});
  });

  test('rejects malformed numeric screen values', () => {
    const { loadConfig } = require('../../dist/src/utils/config');

    expect(() =>
      loadConfig({
        CAMOFOX_SCREEN_WIDTH: '1920px',
        CAMOFOX_SCREEN_HEIGHT: '1080',
      }),
    ).toThrow('CAMOFOX_SCREEN_WIDTH must be a positive integer (got: "1920px")');

    expect(() =>
      loadConfig({
        CAMOFOX_SCREEN_WIDTH: '1920',
        CAMOFOX_SCREEN_HEIGHT: '10.5',
      }),
    ).toThrow('CAMOFOX_SCREEN_HEIGHT must be a positive integer (got: "10.5")');
  });

  test('rejects malformed and unsupported CAMOFOX_OS values', () => {
    const { loadConfig } = require('../../dist/src/utils/config');

    expect(() =>
      loadConfig({ CAMOFOX_OS: '' }),
    ).toThrow('CAMOFOX_OS must not be empty and must not contain empty tokens');

    expect(() =>
      loadConfig({ CAMOFOX_OS: 'windows,' }),
    ).toThrow('CAMOFOX_OS must not be empty and must not contain empty tokens');

    expect(() =>
      loadConfig({ CAMOFOX_OS: 'windows,,macos' }),
    ).toThrow('CAMOFOX_OS must not be empty and must not contain empty tokens');

    expect(() =>
      loadConfig({ CAMOFOX_OS: 'android' }),
    ).toThrow('CAMOFOX_OS contains unsupported value: "android"');
  });

  test('forwards fingerprint env vars through serverEnv', () => {
    const { loadConfig } = require('../../dist/src/utils/config');

    const config = loadConfig({
      CAMOFOX_OS: 'linux',
      CAMOFOX_ALLOW_WEBGL: 'true',
      CAMOFOX_SCREEN_WIDTH: '1280',
      CAMOFOX_SCREEN_HEIGHT: '720',
      CAMOFOX_HUMANIZE: 'true',
    });

    expect(config.serverEnv.CAMOFOX_OS).toBe('linux');
    expect(config.serverEnv.CAMOFOX_ALLOW_WEBGL).toBe('true');
    expect(config.serverEnv.CAMOFOX_SCREEN_WIDTH).toBe('1280');
    expect(config.serverEnv.CAMOFOX_SCREEN_HEIGHT).toBe('720');
    expect(config.serverEnv.CAMOFOX_HUMANIZE).toBe('true');
  });
});
