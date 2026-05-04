const { startServer, stopServer, getServerUrl } = require('../helpers/startServer');
const { startTestSite, stopTestSite, getTestSiteUrl } = require('../helpers/testSite');
const { createClient } = require('../helpers/client');

describe('Structured extract route', () => {
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

  test('nested catalog extraction through the core API succeeds', async () => {
    const client = createClient(serverUrl);
    const schema = {
      kind: 'object',
      selector: '#catalog',
      fields: {
        heading: { kind: 'text', selector: 'h1', required: true, trim: true },
        products: {
          kind: 'list',
          selector: '.product',
          item: {
            kind: 'object',
            fields: {
              name: { kind: 'text', selector: '.name', required: true, trim: true },
              price: { kind: 'number', selector: '.price', required: true, trim: true },
              href: { kind: 'url', selector: 'a.product-link', attr: 'href', required: true },
              seller: {
                kind: 'object',
                selector: '.seller',
                required: true,
                fields: {
                  name: { kind: 'text', selector: '.seller-name', required: true, trim: true },
                },
              },
              badges: {
                kind: 'list',
                selector: '.badge',
                item: { kind: 'text', required: true, trim: true },
              },
            },
          },
        },
      },
    };

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/structured-products`);
      const result = await client.extractStructured(tabId, schema);

      expect(result).toEqual({
        ok: true,
        data: {
          heading: 'Catalog',
          products: [
            {
              name: 'Red Mug',
              price: 19.99,
              href: `${testSiteUrl}/products/red-mug`,
              seller: { name: 'North Shop' },
              badges: ['Hot', 'Ceramic'],
            },
            {
              name: 'Blue Plate',
              price: 24.5,
              href: `${testSiteUrl}/products/blue-plate`,
              seller: { name: 'South Shop' },
              badges: ['New'],
            },
          ],
        },
        metadata: {
          extractionTimeMs: expect.any(Number),
          matchedRoots: 1,
        },
      });
    } finally {
      await client.cleanup();
    }
  });

  test('missing required nested field fails the whole request with stable fieldPath', async () => {
    const client = createClient(serverUrl);
    const schema = {
      kind: 'object',
      selector: '#catalog',
      fields: {
        heading: { kind: 'text', selector: 'h1', required: true, trim: true },
        products: {
          kind: 'list',
          selector: '.product',
          item: {
            kind: 'object',
            fields: {
              name: { kind: 'text', selector: '.name', required: true, trim: true },
              price: { kind: 'number', selector: '.price', required: true, trim: true },
            },
          },
        },
      },
    };

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/structured-missing-price`);

      await expect(client.extractStructured(tabId, schema)).rejects.toMatchObject({
        status: 422,
        data: {
          ok: false,
          error: 'Structured extraction failed',
          fieldPath: 'data.products[1].price',
          reason: 'required',
        },
      });
    } finally {
      await client.cleanup();
    }
  });
});
