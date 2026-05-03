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
});
