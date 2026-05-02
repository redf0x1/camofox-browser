const { startServer, stopServer, getServerUrl } = require('../helpers/startServer');
const { startTestSite, stopTestSite, getTestSiteUrl } = require('../helpers/testSite');
const { createClient } = require('../helpers/client');
const crypto = require('crypto');

describe('Images route', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(async () => {
    await startServer();
    serverUrl = getServerUrl();

    await startTestSite();
    testSiteUrl = getTestSiteUrl();
  }, 120000);

  afterAll(async () => {
    await stopTestSite();
    await stopServer();
  }, 30000);

  test('get images returns repository-native image-only payload', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/images`);

      const result = await client.getImages(tabId, {
        resolveBlobs: true,
        triggerLazyLoad: true,
      });

      expect(result.ok).toBe(true);
      expect(result.container).toEqual(expect.objectContaining({
        selector: 'body',
      }));
      expect(Array.isArray(result.images)).toBe(true);
      expect(result.totals).toEqual({
        images: 4,
        total: 4,
      });
      expect(result.metadata).toEqual(expect.objectContaining({
        extractionTimeMs: expect.any(Number),
        lazyLoadsTriggered: expect.any(Number),
        blobsResolved: 1,
      }));
      expect(result.images).toHaveLength(4);
      expect(result.images.map((image) => image.alt)).toEqual(
        expect.arrayContaining(['Hero image', 'Inline image', 'Blob image', 'Lazy image']),
      );
      const blobImage = result.images.find((image) => image.alt === 'Blob image');
      expect(blobImage).toEqual(expect.objectContaining({
        isBlob: false,
        isDataUri: true,
      }));
      expect(blobImage.url.startsWith('data:image/')).toBe(true);
      expect(result).not.toHaveProperty('resources');
    } finally {
      await client.cleanup();
    }
  });

  test('get images supports selector and extension filters', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/images`);

      const result = await client.getImages(tabId, {
        selector: '#gallery',
        extensions: ['png'],
      });

      expect(result.images).toHaveLength(2);
      expect(result.images.map((image) => image.filename).sort()).toEqual(['hero.png', 'lazy.png']);
      expect(result.totals).toEqual({
        images: 2,
        total: 2,
      });
    } finally {
      await client.cleanup();
    }
  });
});

describe('Images route auth', () => {
  let serverUrl;

  beforeAll(async () => {
    await startServer(0, {
      CAMOFOX_API_KEY: `test-images-key-${crypto.randomUUID()}`,
    });
    serverUrl = getServerUrl();
  }, 120000);

  afterAll(async () => {
    await stopServer();
  }, 30000);

  test('get images returns 403 without API key when server auth is enabled', async () => {
    const userId = `images-auth-${crypto.randomUUID()}`;
    const res = await fetch(`${serverUrl}/tabs/missing/images?userId=${encodeURIComponent(userId)}`);
    const data = await res.json();

    expect(res.status).toBe(403);
    expect(data.ok).toBe(false);
    expect(data.error).toBe('Forbidden');
  });
});
