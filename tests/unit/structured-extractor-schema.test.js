describe('structured-extractor schema validation (unit)', () => {
  /** @type {(schema:any) => any} */
  let validateStructuredExtractSchema;
  /** @type {any} */
  let StructuredExtractSchemaError;

  beforeEach(() => {
    jest.resetModules();
    ({ validateStructuredExtractSchema, StructuredExtractSchemaError } = require('../../dist/src/services/structured-extractor'));
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

  test('accepts a root list schema', () => {
    const compiled = validateStructuredExtractSchema({
      kind: 'list',
      selector: '.product',
      item: {
        kind: 'object',
        fields: {
          name: { kind: 'text', selector: '.name', required: true },
        },
      },
    });

    expect(compiled.kind).toBe('list');
    expect(compiled.item.kind).toBe('object');
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

    try {
      validateStructuredExtractSchema({
        kind: 'object',
        fields: {
          broken: { kind: 'attr', selector: 'img' },
        },
      });
      throw new Error('expected schema validation to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredExtractSchemaError);
      expect(error.statusCode).toBe(400);
    }
  });

  test('rejects whitespace-only attr fields', () => {
    expect(() =>
      validateStructuredExtractSchema({
        kind: 'object',
        fields: {
          broken: { kind: 'attr', selector: 'img', attr: '   ' },
        },
      }),
    ).toThrow('schema.fields.broken.attr must be a non-empty string');
  });

  test('rejects scalar root schemas with a 400 structured schema error', () => {
    try {
      validateStructuredExtractSchema({
        kind: 'text',
        selector: 'h1',
      });
      throw new Error('expected root schema validation to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredExtractSchemaError);
      expect(error.statusCode).toBe(400);
      expect(error.message).toBe('schema.kind must be "object" or "list" at the root');
    }
  });

  test('rejects scalar root schemas even when a custom path is passed', () => {
    try {
      validateStructuredExtractSchema(
        {
          kind: 'text',
          selector: 'h1',
        },
        'root',
      );
      throw new Error('expected root schema validation to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredExtractSchemaError);
      expect(error.statusCode).toBe(400);
      expect(error.message).toBe('schema.kind must be "object" or "list" at the root');
    }
  });

  test('rejects null and undefined root schemas with a 400 structured schema error', () => {
    try {
      validateStructuredExtractSchema(null);
      throw new Error('expected root schema validation to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredExtractSchemaError);
      expect(error.statusCode).toBe(400);
      expect(error.message).toBe('schema must be an object');
    }

    try {
      validateStructuredExtractSchema(undefined);
      throw new Error('expected root schema validation to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredExtractSchemaError);
      expect(error.statusCode).toBe(400);
      expect(error.message).toBe('schema must be an object');
    }
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

  test('rejects malformed CSS selectors', () => {
    expect(() =>
      validateStructuredExtractSchema({
        kind: 'object',
        fields: {
          title: {
            kind: 'text',
            selector: 'a[',
          },
        },
      }),
    ).toThrow('schema.fields.title.selector must be a CSS selector');
  });

  test('rejects Playwright-only selector syntax', () => {
    expect(() =>
      validateStructuredExtractSchema({
        kind: 'object',
        fields: {
          title: {
            kind: 'text',
            selector: '::-p-text(Hello)',
          },
        },
      }),
    ).toThrow('schema.fields.title.selector must be a CSS selector');
  });

  test('rejects additional non-CSS selector syntax with structured schema errors', () => {
    const invalidSelectors = [
      'internal:role=button',
      ':has-text("Buy")',
      'h1 >> text=Hello',
      'div>',
      '1abc',
      'div:unknown-pseudo',
    ];

    for (const selector of invalidSelectors) {
      try {
        validateStructuredExtractSchema({
          kind: 'object',
          fields: {
            title: {
              kind: 'text',
              selector,
            },
          },
        });
        throw new Error(`expected selector ${selector} to fail validation`);
      } catch (error) {
        expect(error).toBeInstanceOf(StructuredExtractSchemaError);
        expect(error.statusCode).toBe(400);
        expect(error.message).toBe('schema.fields.title.selector must be a CSS selector');
      }
    }
  });

  test('rejects attr on unsupported scalar kinds with structured schema errors', () => {
    const invalidFields = [
      { kind: 'text', selector: 'h1', attr: 'href' },
      { kind: 'number', selector: '.price', attr: 'data-price' },
    ];

    for (const field of invalidFields) {
      try {
        validateStructuredExtractSchema({
          kind: 'object',
          fields: {
            a: field,
          },
        });
        throw new Error(`expected attr to be rejected for kind ${field.kind}`);
      } catch (error) {
        expect(error).toBeInstanceOf(StructuredExtractSchemaError);
        expect(error.statusCode).toBe(400);
        expect(error.message).toBe('schema.fields.a.attr is only supported for kind "attr" and "url"');
      }
    }
  });

  test('rejects pseudo-element selectors with an accurate structured schema error', () => {
    try {
      validateStructuredExtractSchema({
        kind: 'object',
        fields: {
          title: {
            kind: 'text',
            selector: 'div::before',
          },
        },
      });
      throw new Error('expected pseudo-element selector to fail validation');
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredExtractSchemaError);
      expect(error.statusCode).toBe(400);
      expect(error.message).toBe(
        'schema.fields.title.selector must target DOM elements; pseudo-elements are not supported',
      );
    }
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
