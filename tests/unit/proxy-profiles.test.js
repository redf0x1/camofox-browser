describe('proxy profile resolution', () => {
  test('explicit-wins keeps explicit geo over named proxy profile defaults', () => {
    const { resolveSessionProfileInput } = require('../../dist/src/utils/proxy-profiles');

    const result = resolveSessionProfileInput({
      proxyProfile: 'tokyo-exit',
      geoMode: 'explicit-wins',
      timezoneId: 'Europe/Berlin',
      geolocation: { latitude: 52.52, longitude: 13.405 },
    }, {
      serverProxy: null,
      proxyProfiles: {
        'tokyo-exit': {
          server: 'http://proxy.tokyo.test:8080',
          locale: 'ja-JP',
          timezoneId: 'Asia/Tokyo',
          geolocation: { latitude: 35.6895, longitude: 139.6917 },
        },
      },
    });

    expect(result.proxy.source).toBe('named-profile');
    expect(result.timezoneId).toBe('Europe/Berlin');
    expect(result.geolocation).toEqual({ latitude: 52.52, longitude: 13.405 });
  });

  test('proxy-locked rejects explicit geo overrides', () => {
    const { resolveSessionProfileInput } = require('../../dist/src/utils/proxy-profiles');

    expect(() => resolveSessionProfileInput({
      proxyProfile: 'tokyo-exit',
      geoMode: 'proxy-locked',
      timezoneId: 'Europe/Berlin',
    }, {
      serverProxy: null,
      proxyProfiles: {
        'tokyo-exit': {
          server: 'http://proxy.tokyo.test:8080',
          locale: 'ja-JP',
          timezoneId: 'Asia/Tokyo',
          geolocation: { latitude: 35.6895, longitude: 139.6917 },
        },
      },
    })).toThrow('proxy-locked does not allow explicit timezoneId overrides');
  });

  test('raw proxy override is normalized into the same internal shape', () => {
    const { resolveSessionProfileInput } = require('../../dist/src/utils/proxy-profiles');

    const result = resolveSessionProfileInput({
      proxy: {
        host: 'proxy.raw.test',
        port: '8081',
        username: 'alice',
        password: 'secret',
      },
    }, {
      serverProxy: null,
      proxyProfiles: {},
    });

    expect(result.proxy).toMatchObject({
      source: 'raw-override',
      server: 'http://proxy.raw.test:8081',
      username: 'alice',
      password: 'secret',
    });
  });

  test('unknown proxy profile throws error with available profiles list', () => {
    const { resolveSessionProfileInput } = require('../../dist/src/utils/proxy-profiles');

    expect(() => resolveSessionProfileInput({
      proxyProfile: 'nonexistent',
    }, {
      serverProxy: null,
      proxyProfiles: {
        'tokyo-exit': {
          server: 'http://proxy.tokyo.test:8080',
        },
        'london-exit': {
          server: 'http://proxy.london.test:8080',
        },
      },
    })).toThrow(/Unknown proxy profile: "nonexistent".*Available profiles: tokyo-exit, london-exit/);
  });

  test('unknown proxy profile with no available profiles omits list', () => {
    const { resolveSessionProfileInput } = require('../../dist/src/utils/proxy-profiles');

    expect(() => resolveSessionProfileInput({
      proxyProfile: 'nonexistent',
    }, {
      serverProxy: null,
      proxyProfiles: {},
    })).toThrow('Unknown proxy profile: "nonexistent".');
  });
});

describe('proxy profile loading and validation', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');

  test('loadProxyProfiles validates profile structure', () => {
    const { loadProxyProfiles } = require('../../dist/src/utils/proxy-profiles');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-test-'));
    const filePath = path.join(tmpDir, 'invalid-profiles.json');

    try {
      // Missing required 'server' field
      fs.writeFileSync(filePath, JSON.stringify({
        'broken-profile': {
          locale: 'en-US',
        },
      }));

      const profiles = loadProxyProfiles(filePath);
      // Should return empty object and log warning instead of crashing
      expect(profiles).toEqual({});
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('loadProxyProfiles validates geolocation bounds', () => {
    const { loadProxyProfiles } = require('../../dist/src/utils/proxy-profiles');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-test-'));
    const filePath = path.join(tmpDir, 'invalid-geo.json');

    try {
      // Invalid latitude
      fs.writeFileSync(filePath, JSON.stringify({
        'bad-geo': {
          server: 'http://proxy.test:8080',
          geolocation: { latitude: 999, longitude: 0 },
        },
      }));

      const profiles = loadProxyProfiles(filePath);
      expect(profiles).toEqual({});
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('loadProxyProfiles successfully loads valid profiles', () => {
    const { loadProxyProfiles } = require('../../dist/src/utils/proxy-profiles');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-test-'));
    const filePath = path.join(tmpDir, 'valid-profiles.json');

    try {
      fs.writeFileSync(filePath, JSON.stringify({
        'tokyo-exit': {
          server: 'http://proxy.tokyo.test:8080',
          locale: 'ja-JP',
          timezoneId: 'Asia/Tokyo',
          geolocation: { latitude: 35.6895, longitude: 139.6917 },
        },
        'US-West': {
          server: 'http://proxy.us.test:8080',
        },
      }));

      const profiles = loadProxyProfiles(filePath);
      // Names should be lowercased
      expect(profiles['tokyo-exit']).toBeDefined();
      expect(profiles['us-west']).toBeDefined();
      expect(profiles['tokyo-exit'].server).toBe('http://proxy.tokyo.test:8080');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
