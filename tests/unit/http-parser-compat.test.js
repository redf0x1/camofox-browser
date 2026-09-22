const request = require('supertest');

// These parser tests exercise real routes without loading the browser engine.
jest.mock('../../dist/src/services/context-pool', () => ({
  contextPool: { onEvict: jest.fn() },
}));

describe('HTTP parser compatibility', () => {
  const originalEnv = { ...process.env };
  let app;
  let extractImages;

  function createApp(apiKey = '') {
    jest.resetModules();
    process.env.CAMOFOX_HOST = '127.0.0.1';
    process.env.CAMOFOX_AUTH_MODE = 'auto';
    process.env.CAMOFOX_API_KEY = apiKey;
    const express = require('express');
    const sessions = require('../../dist/src/services/session');
    jest.spyOn(sessions, 'findTabById').mockReturnValue({
      tabState: { page: {}, toolCalls: 0 },
    });
    const extractor = require('../../dist/src/services/resource-extractor');
    extractImages = jest.spyOn(extractor, 'extractImages').mockImplementation(async (_page, options) => {
      const images = ['png', 'jpg'].filter(extension => !options.extensions || options.extensions.includes(extension));
      return { ok: true, resources: { images }, totals: { images: images.length } };
    });
    app = express();
    app.use(express.json({ limit: '100kb' }));
    app.use(require('../../dist/src/routes/core').default);
    app.use(require('../../dist/src/routes/openclaw').default);
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  }

  beforeEach(() => createApp());
  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of ['CAMOFOX_HOST', 'CAMOFOX_AUTH_MODE', 'CAMOFOX_API_KEY']) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  test.each(['/tabs', '/act'])('%s validates absent, empty, and unparsed bodies as client errors', async url => {
    for (const send of [req => req, req => req.send({}), req => req.type('text').send('text')]) {
      const response = await send(request(app).post(url));
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/userId/);
    }
  });

  test.each(['/tabs', '/act'])('%s rejects malformed JSON', async url => {
    const response = await request(app).post(url).type('json').send('{');
    expect(response.status).toBe(400);
  });

  test.each(['/tabs', '/act'])('%s enforces authentication before body validation', async url => {
    createApp('parser-test-key');
    const response = await request(app).post(url);
    expect(response.status).toBe(403);
    const authorized = await request(app).post(url).set('Authorization', 'Bearer parser-test-key');
    expect(authorized.status).toBe(400);
  });

  test.each([
    ['extensions[]=png', ['png']],
    ['extensions[0]=png', ['png']],
    ['extensions=png', ['png']],
    ['extensions=png&extensions=jpg', ['png', 'jpg']],
    ['extensions=png,jpg', ['png', 'jpg']],
    ['', undefined],
  ])('preserves the image filter for %s', async (query, extensions) => {
    const response = await request(app).get('/tabs/parser-tab/images?userId=parser-user&' + query);
    expect(response.status).toBe(200);
    expect(extractImages).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ extensions }));
    expect(response.body.images).toEqual(extensions || ['png', 'jpg']);
  });
});
