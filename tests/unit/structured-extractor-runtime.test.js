function createScope(node, baseUrl = 'https://shop.example/catalog') {
  return {
    async queryAll(selector) {
      const matches = node.children?.[selector] || [];
      return matches.map((child) => createScope(child, baseUrl));
    },
    async text() {
      return node.text ?? null;
    },
    async html() {
      return node.html ?? null;
    },
    async attr(name) {
      return node.attrs?.[name] ?? null;
    },
    getBaseUrl() {
      return baseUrl;
    },
  };
}

function createLocator(nodes) {
  return {
    locator(selector) {
      const matches = nodes.flatMap((node) => node.children?.[selector] || []);
      return createLocator(matches);
    },
    async count() {
      return nodes.length;
    },
    nth(index) {
      return createLocator([nodes[index]]);
    },
    async textContent() {
      return nodes[0]?.text ?? null;
    },
    async evaluate(fn) {
      return fn({ innerHTML: nodes[0]?.html ?? null });
    },
    async getAttribute(name) {
      return nodes[0]?.attrs?.[name] ?? null;
    },
  };
}

function createPage(rootNode, pageUrl = 'https://shop.example/catalog') {
  return {
    url() {
      return pageUrl;
    },
    locator(selector) {
      if (selector !== 'html') {
        throw new Error(`unexpected page locator selector: ${selector}`);
      }
      return createLocator([rootNode]);
    },
  };
}

describe('structured-extractor runtime (unit)', () => {
  /** @type {(scope:any, schema:any, path?:string) => Promise<any>} */
  let extractStructuredFromScope;
  /** @type {(page:any, schema:any) => Promise<any>} */
  let extractStructuredData;
  /** @type {any} */
  let StructuredExtractRuntimeError;

  beforeEach(() => {
    jest.resetModules();
    ({
      extractStructuredFromScope,
      extractStructuredData,
      StructuredExtractRuntimeError,
    } = require('../../dist/src/services/structured-extractor'));
  });

  test('extracts nested object/list fields relative to each scoped root', async () => {
    const scope = createScope({
      children: {
        h1: [{ text: '  Catalog  ' }],
        '.product': [
          {
            children: {
              '.name': [{ text: '  Red Mug  ' }],
              '.price': [{ text: '19.99' }],
              'a.product-link': [{ attrs: { href: '/products/red-mug' } }],
              '.seller': [
                {
                  children: {
                    '.seller-name': [{ text: 'North Shop' }],
                  },
                },
              ],
              '.badge': [{ text: ' Hot ' }, { text: ' Ceramic ' }],
            },
          },
          {
            children: {
              '.name': [{ text: 'Blue Plate' }],
              '.price': [{ text: '24.5' }],
              'a.product-link': [{ attrs: { href: 'https://cdn.example/items/blue-plate' } }],
              '.seller': [
                {
                  children: {
                    '.seller-name': [{ text: 'South Shop' }],
                  },
                },
              ],
              '.badge': [{ text: 'New' }],
            },
          },
        ],
        '.name': [{ text: 'wrong global name' }],
      },
    });

    const data = await extractStructuredFromScope(scope, {
      kind: 'object',
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
    });

    expect(data).toEqual({
      heading: 'Catalog',
      products: [
        {
          name: 'Red Mug',
          price: 19.99,
          href: 'https://shop.example/products/red-mug',
          seller: { name: 'North Shop' },
          badges: ['Hot', 'Ceramic'],
        },
        {
          name: 'Blue Plate',
          price: 24.5,
          href: 'https://cdn.example/items/blue-plate',
          seller: { name: 'South Shop' },
          badges: ['New'],
        },
      ],
    });
  });

  test('normalizes optional misses to null and empty lists', async () => {
    const scope = createScope({
      children: {
        h1: [{ text: 'Catalog' }],
      },
    });

    const data = await extractStructuredFromScope(scope, {
      kind: 'object',
      fields: {
        heading: { kind: 'text', selector: 'h1', required: true, trim: true },
        subtitle: { kind: 'text', selector: '.subtitle', trim: true },
        promo: {
          kind: 'object',
          selector: '.promo',
          fields: {
            label: { kind: 'text', selector: '.label', required: true, trim: true },
          },
        },
        tags: {
          kind: 'list',
          selector: '.tag',
          item: { kind: 'text', required: true, trim: true },
        },
      },
    });

    expect(data).toEqual({
      heading: 'Catalog',
      subtitle: null,
      promo: null,
      tags: [],
    });
  });

  test('applies join before number coercion for scalar fields', async () => {
    const scope = createScope({
      children: {
        '.price-part': [{ text: '19' }, { text: '.99' }],
      },
    });

    const data = await extractStructuredFromScope(scope, {
      kind: 'object',
      fields: {
        price: {
          kind: 'text',
          selector: '.price-part',
          join: '',
          coerce: 'number',
          required: true,
          trim: true,
        },
      },
    });

    expect(data).toEqual({ price: 19.99 });
  });

  test('extractStructuredData uses first matched root, reports matchedRoots, and normalizes urls from page url', async () => {
    const page = createPage(
      {
        children: {
          '.card': [
            {
              children: {
                '.title': [{ text: 'First card' }],
                'a.details': [{ attrs: { href: '/items/first-card' } }],
              },
            },
            {
              children: {
                '.title': [{ text: 'Second card' }],
                'a.details': [{ attrs: { href: '/items/second-card' } }],
              },
            },
          ],
        },
      },
      'https://shop.example/catalog?page=2',
    );

    const result = await extractStructuredData(page, {
      kind: 'object',
      selector: '.card',
      fields: {
        title: { kind: 'text', selector: '.title', required: true, trim: true },
        href: { kind: 'url', selector: 'a.details', attr: 'href', required: true },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      title: 'First card',
      href: 'https://shop.example/items/first-card',
    });
    expect(result.metadata.matchedRoots).toBe(2);
    expect(result.metadata.extractionTimeMs).toEqual(expect.any(Number));
  });

  test('validates raw schemas passed to extractStructuredFromScope even when a path key is present', async () => {
    const scope = createScope({ children: {} });
    const { StructuredExtractSchemaError } = require('../../dist/src/services/structured-extractor');

    await expect(
      extractStructuredFromScope(scope, {
        kind: 'object',
        path: 'data',
        fields: {
          title: { kind: 'text', selector: '//h1' },
        },
      }),
    ).rejects.toMatchObject({
      name: 'StructuredExtractSchemaError',
      statusCode: 400,
      message: 'schema.path is not supported',
    });

    await expect(
      extractStructuredFromScope(scope, {
        kind: 'object',
        path: 'data',
        fields: {
          title: { kind: 'text', selector: '//h1' },
        },
      }),
    ).rejects.toBeInstanceOf(StructuredExtractSchemaError);
  });

  test('extractStructuredData propagates required failures with stable runtime metadata', async () => {
    const page = createPage({
      children: {
        '.card': [
          {
            children: {
              '.title': [{ text: 'Only card' }],
            },
          },
        ],
      },
    });

    await expect(
      extractStructuredData(page, {
        kind: 'object',
        selector: '.card',
        fields: {
          title: { kind: 'text', selector: '.title', required: true, trim: true },
          missing: { kind: 'text', selector: '.missing', required: true, trim: true },
        },
      }),
    ).rejects.toMatchObject({
      name: 'StructuredExtractRuntimeError',
      statusCode: 422,
      fieldPath: 'data.missing',
      reason: 'required',
    });

    await expect(
      extractStructuredData(page, {
        kind: 'object',
        selector: '.card',
        fields: {
          title: { kind: 'text', selector: '.title', required: true, trim: true },
          missing: { kind: 'text', selector: '.missing', required: true, trim: true },
        },
      }),
    ).rejects.toBeInstanceOf(StructuredExtractRuntimeError);
  });

  test('throws stable runtime errors for missing required nested fields', async () => {
    const scope = createScope({
      children: {
        '.product': [
          {
            children: {
              '.name': [{ text: 'Red Mug' }],
              '.price': [{ text: '19.99' }],
            },
          },
          {
            children: {
              '.name': [{ text: 'Blue Plate' }],
            },
          },
        ],
      },
    });

    await expect(
      extractStructuredFromScope(scope, {
        kind: 'object',
        fields: {
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
      }),
    ).rejects.toMatchObject({
      name: 'StructuredExtractRuntimeError',
      statusCode: 422,
      fieldPath: 'data.products[1].price',
      reason: 'required',
    });

    try {
      await extractStructuredFromScope(scope, {
        kind: 'object',
        fields: {
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
      });
      throw new Error('expected runtime extraction to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredExtractRuntimeError);
      expect(error.message).toBe('Missing required field at data.products[1].price');
    }
  });
});
