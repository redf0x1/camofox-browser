describe('structured-extractor schema validation (unit)', () => {
  /** @type {(schema:any) => any} */
  let validateStructuredExtractSchema;

  beforeEach(() => {
    jest.resetModules();
    ({ validateStructuredExtractSchema } = require('../../dist/src/services/structured-extractor'));
  });

  test('accepts a nested object/list schema with scoped selectors', () => {
    const compiled = validateStructuredExtractSchema({
      kind: 'object',
      fields: {
        title: { kind: 'text', selector: 'h1', required: true, trim: true },
        products: {
          kind: 'list',
          selector: '.product',
          item: {
            kind: 'object',
            fields: {
              name: { kind: 'text', selector: '.name', required: true, trim: true },
              price: { kind: 'number', selector: '.price', required: true, trim: true },
              href: { kind: 'url', selector: 'a.product-link', attr: 'href', required: true },
            },
          },
        },
      },
    });

    expect(compiled.kind).toBe('object');
    expect(compiled.fields.products.kind).toBe('list');
  });

  test('rejects attr fields without an attr property', () => {
    expect(() =>
      validateStructuredExtractSchema({
        kind: 'object',
        fields: {
          broken: { kind: 'attr', selector: 'img' },
        },
      }),
    ).toThrow('schema.fields.broken.attr is required for kind "attr"');
  });

  test('rejects unsupported selector engines and arbitrary transforms', () => {
    expect(() =>
      validateStructuredExtractSchema({
        kind: 'object',
        fields: {
          title: {
            kind: 'text',
            selector: '//h1',
            transform: 'custom-js',
          },
        },
      }),
    ).toThrow('schema.fields.title.selector must be a CSS selector');
  });

  test('rejects transform on otherwise valid schemas', () => {
    expect(() =>
      validateStructuredExtractSchema({
        kind: 'object',
        fields: {
          title: {
            kind: 'text',
            selector: 'h1',
            transform: 'custom-js',
          },
        },
      }),
    ).toThrow('schema.fields.title.transform is not supported');
  });

  test('rejects join on number fields', () => {
    expect(() =>
      validateStructuredExtractSchema({
        kind: 'object',
        fields: {
          total: {
            kind: 'number',
            selector: '.price',
            join: ', ',
          },
        },
      }),
    ).toThrow('schema.fields.total.join is only supported for text, attr, and url fields');
  });

  test('accepts CSS selectors with URL fragments and defaults url attr to href', () => {
    const compiled = validateStructuredExtractSchema({
      kind: 'object',
      fields: {
        canonical: {
          kind: 'url',
          selector: 'a[href^="https://example.com"]',
        },
      },
    });

    expect(compiled.fields.canonical.attr).toBe('href');
  });

  test('rejects unsupported schema properties', () => {
    expect(() =>
      validateStructuredExtractSchema({
        kind: 'object',
        fields: {
          title: {
            kind: 'text',
            selector: 'h1',
            explode: true,
          },
        },
      }),
    ).toThrow('schema.fields.title.explode is not supported');
  });

  test('rejects invalid runtime option types', () => {
    expect(() =>
      validateStructuredExtractSchema({
        kind: 'object',
        fields: {
          title: { kind: 'text', selector: 'h1', required: 'yes' },
        },
      }),
    ).toThrow('schema.fields.title.required must be a boolean');

    expect(() =>
      validateStructuredExtractSchema({
        kind: 'object',
        fields: {
          title: { kind: 'text', selector: 'h1', join: 42 },
        },
      }),
    ).toThrow('schema.fields.title.join must be a string');

    expect(() =>
      validateStructuredExtractSchema({
        kind: 'object',
        fields: {
          title: { kind: 'text', selector: 'h1', coerce: 'int' },
        },
      }),
    ).toThrow('schema.fields.title.coerce must be "number" or "url"');
  });

  test('rejects empty attr overrides on url fields', () => {
    expect(() =>
      validateStructuredExtractSchema({
        kind: 'object',
        fields: {
          canonical: {
            kind: 'url',
            selector: 'a.link',
            attr: '   ',
          },
        },
      }),
    ).toThrow('schema.fields.canonical.attr must be a non-empty string');
  });
});
