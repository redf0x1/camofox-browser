const { normalizeServerBaseUrl } = require('../../dist/src/utils/config');

describe('OpenClaw plugin server URL normalization', () => {
  test('keeps a URL without a trailing slash unchanged', () => {
    expect(normalizeServerBaseUrl('http://localhost:9377'))
      .toBe('http://localhost:9377');
  });

  test('removes trailing slashes before endpoint paths are appended', () => {
    const baseUrl = normalizeServerBaseUrl('http://localhost:9377///');

    expect(`${baseUrl}/health`).toBe('http://localhost:9377/health');
  });

  test('preserves a configured path prefix', () => {
    expect(normalizeServerBaseUrl('https://browser.example/camofox/'))
      .toBe('https://browser.example/camofox');
  });

  test('rejects a blank configured URL', () => {
    expect(() => normalizeServerBaseUrl('   '))
      .toThrow('CamoFox server URL must be a non-empty string');
  });
});
