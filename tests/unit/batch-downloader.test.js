jest.mock('../../dist/src/middleware/logging', () => ({ log: jest.fn() }));

jest.mock('../../dist/src/services/resource-extractor', () => ({
  extractResources: jest.fn(),
  resolveBlob: jest.fn(),
}));

jest.mock('../../dist/src/services/download', () => ({
  upsertDownload: jest.fn(),
  buildContentUrl: (id, userId) => `/downloads/${String(id)}/content?userId=${encodeURIComponent(String(userId))}`,
}));

jest.mock('node:fs', () => ({
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

/** @type {{mkdirSync: jest.Mock, writeFileSync: jest.Mock}} */
let fs;

function makeMockPage(evaluateResult = {}) {
  return {
    __camofox_tabId: 'tab-1',
    isClosed: jest.fn().mockReturnValue(false),
    evaluate: jest.fn().mockResolvedValue(evaluateResult),
    waitForTimeout: jest.fn().mockResolvedValue(undefined),
    context: jest.fn().mockReturnValue({
      request: {
        get: jest.fn().mockResolvedValue({
          ok: () => true,
          status: () => 200,
          body: () => Buffer.from('test-data'),
          headers: () => ({ 'content-type': 'image/png' }),
        }),
      },
    }),
    on: jest.fn(),
  };
}

describe('batch-downloader.ts (unit)', () => {
  /** @type {(page:any, params:any, config:any) => Promise<any>} */
  let batchDownload;
  /** @type {{extractResources: jest.Mock, resolveBlob: jest.Mock}} */
  let extractor;
  /** @type {{upsertDownload: jest.Mock}} */
  let downloadSvc;
  /** @type {{log: jest.Mock}} */
  let logging;

  const config = {
    downloadsDir: '/tmp/camofox-test-downloads',
    downloadTtlMs: 30 * 60 * 1000,
    maxDownloadSizeMb: 100,
    maxDownloadsPerUser: 5,
    maxBatchConcurrency: 5,
    maxBlobSizeMb: 5,
  };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    fs = require('node:fs');

    ({ batchDownload } = require('../../dist/src/services/batch-downloader'));
    extractor = require('../../dist/src/services/resource-extractor');
    downloadSvc = require('../../dist/src/services/download');
    logging = require('../../dist/src/middleware/logging');

    logging.log.mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('batchDownload() throws when page is closed', async () => {
    const page = makeMockPage();
    page.isClosed.mockReturnValue(true);

    await expect(
      batchDownload(page, { userId: 'userA', selector: 'img' }, config),
    ).rejects.toThrow('Page is closed');
  });

  test('batchDownload() handles data URIs (base64)', async () => {
    const page = makeMockPage();
    const payload = Buffer.from('hello').toString('base64');
    extractor.extractResources.mockResolvedValue({
      ok: true,
      resources: {
        images: [{ url: `data:image/png;base64,${payload}`, filename: 'img.png' }],
        links: [],
        media: [],
        documents: [],
      },
    });

    const res = await batchDownload(page, { userId: 'userA', maxFiles: 10 }, config);
    expect(res.ok).toBe(true);
    expect(res.downloads).toHaveLength(1);
    expect(res.downloads[0].status).toBe('completed');
    expect(res.downloads[0].mimeType).toBe('image/png');
    expect(res.downloads[0].size).toBe(5);

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    expect(downloadSvc.upsertDownload).toHaveBeenCalled();
  });

  test('batchDownload() handles data URIs (non-base64/URL-encoded)', async () => {
    const page = makeMockPage();
    extractor.extractResources.mockResolvedValue({
      ok: true,
      resources: {
        images: [{ url: 'data:text/plain,hello%20world', filename: 'msg.txt' }],
        links: [],
        media: [],
        documents: [],
      },
    });

    const res = await batchDownload(page, { userId: 'userA' }, config);
    expect(res.ok).toBe(true);
    expect(res.downloads).toHaveLength(1);
    expect(res.downloads[0].status).toBe('completed');
    expect(res.downloads[0].mimeType).toBe('text/plain');
    expect(res.downloads[0].size).toBe(Buffer.byteLength('hello world'));
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  test('batchDownload() handles HTTP URLs', async () => {
    const page = makeMockPage();
    extractor.extractResources.mockResolvedValue({
      ok: true,
      resources: {
        images: [{ url: 'https://example.com/a.png', filename: 'a.png' }],
        links: [],
        media: [],
        documents: [],
      },
    });

    const res = await batchDownload(page, { userId: 'userA' }, config);
    expect(res.ok).toBe(true);
    expect(res.downloads).toHaveLength(1);
    expect(res.downloads[0].status).toBe('completed');
    expect(res.downloads[0].mimeType).toBe('image/png');
    expect(res.downloads[0].size).toBe(Buffer.from('test-data').length);

    expect(page.context().request.get).toHaveBeenCalledTimes(1);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  test('batchDownload() respects maxFiles cap', async () => {
    const page = makeMockPage();
    extractor.extractResources.mockResolvedValue({
      ok: true,
      resources: {
        images: [
          { url: 'https://example.com/1.png', filename: '1.png' },
          { url: 'https://example.com/2.png', filename: '2.png' },
          { url: 'https://example.com/3.png', filename: '3.png' },
        ],
        links: [],
        media: [],
        documents: [],
      },
    });

    const res = await batchDownload(page, { userId: 'userA', maxFiles: 2 }, config);
    expect(res.ok).toBe(true);
    expect(res.downloads).toHaveLength(2);
    expect(page.context().request.get).toHaveBeenCalledTimes(2);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
  });

  test('batchDownload() handles individual download failures gracefully', async () => {
    const page = makeMockPage();
    const req = page.context().request;
    req.get
      .mockResolvedValueOnce({
        ok: () => true,
        status: () => 200,
        body: () => Buffer.from('ok'),
        headers: () => ({ 'content-type': 'image/png' }),
      })
      .mockImplementationOnce(() => {
        throw new Error('network boom');
      });

    extractor.extractResources.mockResolvedValue({
      ok: true,
      resources: {
        images: [
          { url: 'https://example.com/ok.png', filename: 'ok.png' },
          { url: 'https://example.com/bad.png', filename: 'bad.png' },
        ],
        links: [],
        media: [],
        documents: [],
      },
    });

    const res = await batchDownload(page, { userId: 'userA' }, config);
    expect(res.ok).toBe(true);
    expect(res.downloads).toHaveLength(2);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toEqual({ url: 'https://example.com/bad.png', error: 'network boom' });

    const failed = res.downloads.find((d) => d.url === 'https://example.com/bad.png');
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('network boom');
  });

  test('batchDownload() marks pending entries as failed on outer error', async () => {
    const page = makeMockPage();
    extractor.extractResources.mockResolvedValue({
      ok: true,
      resources: {
        images: [
          { url: 'https://example.com/one.png', filename: 'one.png' },
          { url: 'https://example.com/two.png', filename: 'two.png' },
        ],
        links: [],
        media: [],
        documents: [],
      },
    });

    // Force an outer error by making the per-item catch throw (Promise.all rejects).
    logging.log.mockImplementation((level, msg) => {
      if (msg === 'batch download item failed') throw new Error('logger broke');
    });

    // First request throws to enter per-item catch -> log() throws -> bubble to outer catch.
    page.context().request.get.mockImplementationOnce(() => {
      throw new Error('network boom');
    });

    const res = await batchDownload(page, { userId: 'userA' }, config);
    expect(res.ok).toBe(false);

    // The created download should be marked failed even though the per-item catch aborted.
    expect(res.downloads.length).toBeGreaterThan(0);
    expect(res.downloads.every((d) => d.status !== 'pending')).toBe(true);
    expect(res.errors.length).toBeGreaterThan(0);
  });
});
