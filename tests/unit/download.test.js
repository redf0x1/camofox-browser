// download.ts imports config/logging/fs; keep unit tests CommonJS-friendly and avoid real IO.
jest.mock('../../dist/src/middleware/logging', () => ({ log: () => {} }));

jest.mock('../../dist/src/utils/config', () => ({
  loadConfig: () => ({
    downloadsDir: '/tmp/camofox-test-downloads',
    downloadTtlMs: 30 * 60 * 1000,
    maxDownloadSizeMb: 100,
    maxDownloadsPerUser: 5,
    maxBatchConcurrency: 5,
    maxBlobSizeMb: 5,
  }),
}));

jest.mock('node:fs', () => ({
  mkdirSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(true),
  statSync: jest.fn().mockReturnValue({ size: 1024 }),
  unlinkSync: jest.fn(),
  readdirSync: jest.fn().mockReturnValue([]),
  rmSync: jest.fn(),
}));

const path = require('node:path');

/** @type {{unlinkSync: jest.Mock, statSync: jest.Mock, existsSync: jest.Mock, mkdirSync: jest.Mock}} */
let fs;

describe('download.ts (unit)', () => {
  /** @type {(info: any) => void} */
  let upsertDownload;
  /** @type {(filters: any) => {downloads:any[],pagination:any}} */
  let listDownloads;
  /** @type {(id: string, userId: string) => any | null} */
  let getDownload;
  /** @type {(id: string, userId: string) => boolean} */
  let deleteDownload;
  /** @type {(ttlMs: number) => number} */
  let cleanupExpiredDownloads;
  /** @type {(userId: string) => number} */
  let cleanupUserDownloads;
  /** @type {(tabId: string, windowMs: number) => any[]} */
  let getRecentDownloads;

  const ROOT = '/tmp/camofox-test-downloads';

  function makeInfo(overrides = {}) {
    const base = {
      id: 'id-' + Math.random().toString(16).slice(2),
      tabId: 'tabA',
      userId: 'userA',
      suggestedFilename: 'file.txt',
      savedFilename: 'saved_file.txt',
      mimeType: 'text/plain',
      size: 10,
      status: 'completed',
      url: 'https://example.com/file.txt',
      createdAt: 1000,
      completedAt: 1100,
    };
    return { ...base, ...overrides };
  }

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    fs = require('node:fs');
    ({
      upsertDownload,
      listDownloads,
      getDownload,
      deleteDownload,
      cleanupExpiredDownloads,
      cleanupUserDownloads,
      getRecentDownloads,
    } = require('../../dist/src/services/download'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('upsertDownload() inserts new and updates existing', () => {
    const info1 = makeInfo({ id: 'd1', suggestedFilename: 'a.txt', savedFilename: 'd1_a.txt', size: 1 });
    upsertDownload(info1);

    const listed1 = listDownloads({ userId: 'userA' }).downloads;
    expect(listed1.map((d) => d.id)).toEqual(['d1']);

    const info1b = makeInfo({
      id: 'd1',
      suggestedFilename: 'a.txt',
      savedFilename: 'd1_a.txt',
      size: 999,
      status: 'failed',
      error: 'boom',
      createdAt: 2000,
    });
    upsertDownload(info1b);

    const after = getDownload('d1', 'userA');
    expect(after).toEqual(info1b);
  });

  test('upsertDownload() enforces per-user cap eviction (evicts oldest non-pending)', () => {
    // Insert 5 completed entries for the same user.
    for (let i = 0; i < 5; i++) {
      upsertDownload(
        makeInfo({
          id: `d${i}`,
          userId: 'userA',
          savedFilename: `d${i}_a.txt`,
          suggestedFilename: `a${i}.txt`,
          createdAt: 1000 + i,
          completedAt: 2000 + i,
          status: 'completed',
        }),
      );
    }

    // 6th insert triggers eviction of the oldest completed entry (d0).
    upsertDownload(
      makeInfo({
        id: 'd5',
        userId: 'userA',
        savedFilename: 'd5_a.txt',
        suggestedFilename: 'a5.txt',
        createdAt: 9999,
        completedAt: 9999,
        status: 'completed',
      }),
    );

    const { downloads } = listDownloads({ userId: 'userA', sort: 'createdAt:asc', limit: 50 });
    expect(downloads).toHaveLength(5);
    expect(downloads.map((d) => d.id)).not.toContain('d0');
    expect(downloads.map((d) => d.id)).toContain('d5');

    const evictedPath = path.join(ROOT, encodeURIComponent('userA'), 'd0_a.txt');
    expect(fs.unlinkSync).toHaveBeenCalledWith(evictedPath);
  });

  test('listDownloads() filters by userId, tabId, status, extension, mimeType, minSize, maxSize', () => {
    upsertDownload(makeInfo({ id: 'u1', userId: 'userA', tabId: 't1', suggestedFilename: 'pic.PNG', mimeType: 'image/png', size: 500 }));
    upsertDownload(makeInfo({ id: 'u2', userId: 'userA', tabId: 't1', suggestedFilename: 'doc.pdf', mimeType: 'application/pdf', size: 1500 }));
    upsertDownload(makeInfo({ id: 'u3', userId: 'userA', tabId: 't2', suggestedFilename: 'song.mp3', mimeType: 'audio/mpeg', size: 3000, status: 'failed' }));
    upsertDownload(makeInfo({ id: 'x1', userId: 'userB', tabId: 't1', suggestedFilename: 'other.txt', mimeType: 'text/plain', size: 10 }));

    expect(listDownloads({ userId: 'userA' }).downloads.map((d) => d.id).sort()).toEqual(['u1', 'u2', 'u3']);

    expect(listDownloads({ userId: 'userA', tabId: 't2' }).downloads.map((d) => d.id)).toEqual(['u3']);
    expect(listDownloads({ userId: 'userA', status: 'failed' }).downloads.map((d) => d.id)).toEqual(['u3']);

    // extension filter is normalized and case-insensitive
    expect(listDownloads({ userId: 'userA', extension: 'png' }).downloads.map((d) => d.id)).toEqual(['u1']);
    expect(listDownloads({ userId: 'userA', extension: '.PDF, .png' }).downloads.map((d) => d.id).sort()).toEqual(['u1', 'u2']);

    // mimeType prefix match
    expect(listDownloads({ userId: 'userA', mimeType: 'image/' }).downloads.map((d) => d.id)).toEqual(['u1']);

    // min/max size (unknown size=-1 bypasses, but here all are known)
    expect(listDownloads({ userId: 'userA', minSize: 1000 }).downloads.map((d) => d.id).sort()).toEqual(['u2', 'u3']);
    expect(listDownloads({ userId: 'userA', maxSize: 1000 }).downloads.map((d) => d.id)).toEqual(['u1']);
  });

  test('listDownloads() supports pagination (limit/offset) and sorting', () => {
    upsertDownload(makeInfo({ id: 's1', userId: 'userA', createdAt: 1, size: 10 }));
    upsertDownload(makeInfo({ id: 's2', userId: 'userA', createdAt: 2, size: 30 }));
    upsertDownload(makeInfo({ id: 's3', userId: 'userA', createdAt: 3, size: 20 }));

    const page1 = listDownloads({ userId: 'userA', sort: 'createdAt:asc', limit: 2, offset: 0 });
    expect(page1.downloads.map((d) => d.id)).toEqual(['s1', 's2']);
    expect(page1.pagination).toEqual({ total: 3, offset: 0, limit: 2, hasMore: true });

    const page2 = listDownloads({ userId: 'userA', sort: 'createdAt:asc', limit: 2, offset: 2 });
    expect(page2.downloads.map((d) => d.id)).toEqual(['s3']);
    expect(page2.pagination).toEqual({ total: 3, offset: 2, limit: 2, hasMore: false });

    const bySizeDesc = listDownloads({ userId: 'userA', sort: 'size:desc', limit: 50 }).downloads;
    expect(bySizeDesc.map((d) => d.id)).toEqual(['s2', 's3', 's1']);
  });

  test('getDownload() returns found, not found, and null for wrong userId', () => {
    upsertDownload(makeInfo({ id: 'g1', userId: 'userA' }));

    expect(getDownload('g1', 'userA').id).toBe('g1');
    expect(getDownload('missing', 'userA')).toBeNull();
    expect(getDownload('g1', 'userB')).toBeNull();
  });

  test('deleteDownload() returns success and not found', () => {
    upsertDownload(makeInfo({ id: 'del1', userId: 'userA', savedFilename: 'del1_a.txt' }));

    const ok = deleteDownload('del1', 'userA');
    expect(ok).toBe(true);
    expect(getDownload('del1', 'userA')).toBeNull();

    const filePath = path.join(ROOT, encodeURIComponent('userA'), 'del1_a.txt');
    expect(fs.unlinkSync).toHaveBeenCalledWith(filePath);

    expect(deleteDownload('missing', 'userA')).toBe(false);
  });

  test('cleanupExpiredDownloads() removes expired completed/failed and skips pending', () => {
    const now = 10_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);

    // Expired, should be removed
    upsertDownload(makeInfo({ id: 'e1', userId: 'userA', createdAt: now - 10_000, status: 'completed', savedFilename: 'e1_a.txt' }));
    upsertDownload(makeInfo({ id: 'e2', userId: 'userA', createdAt: now - 10_000, status: 'failed', savedFilename: 'e2_a.txt' }));

    // Expired but pending, should stay
    upsertDownload(makeInfo({ id: 'p1', userId: 'userA', createdAt: now - 10_000, status: 'pending', savedFilename: 'p1_a.txt' }));

    // Not expired, should stay
    upsertDownload(makeInfo({ id: 'n1', userId: 'userA', createdAt: now - 10, status: 'completed', savedFilename: 'n1_a.txt' }));

    const removed = cleanupExpiredDownloads(1000);
    expect(removed).toBe(2);
    expect(getDownload('e1', 'userA')).toBeNull();
    expect(getDownload('e2', 'userA')).toBeNull();
    expect(getDownload('p1', 'userA')).not.toBeNull();
    expect(getDownload('n1', 'userA')).not.toBeNull();

    expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(ROOT, encodeURIComponent('userA'), 'e1_a.txt'));
    expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(ROOT, encodeURIComponent('userA'), 'e2_a.txt'));
  });

  test('cleanupUserDownloads() removes all for userId', () => {
    upsertDownload(makeInfo({ id: 'cu1', userId: 'userA', savedFilename: 'cu1_a.txt' }));
    upsertDownload(makeInfo({ id: 'cu2', userId: 'userA', savedFilename: 'cu2_a.txt' }));
    upsertDownload(makeInfo({ id: 'cu3', userId: 'userB', savedFilename: 'cu3_b.txt' }));

    const removed = cleanupUserDownloads('userA');
    expect(removed).toBe(2);
    expect(getDownload('cu1', 'userA')).toBeNull();
    expect(getDownload('cu2', 'userA')).toBeNull();
    expect(getDownload('cu3', 'userB')).not.toBeNull();

    expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(ROOT, encodeURIComponent('userA'), 'cu1_a.txt'));
    expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(ROOT, encodeURIComponent('userA'), 'cu2_a.txt'));
  });

  test('getRecentDownloads() returns only recent entries within window', () => {
    const now = 50_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);

    upsertDownload(makeInfo({ id: 'r1', tabId: 'tabX', userId: 'userA', createdAt: now - 100 }));
    upsertDownload(makeInfo({ id: 'r2', tabId: 'tabX', userId: 'userA', createdAt: now - 5000 }));
    upsertDownload(makeInfo({ id: 'r3', tabId: 'tabY', userId: 'userA', createdAt: now - 100 }));

    const recent = getRecentDownloads('tabX', 1000);
    expect(recent.map((d) => d.id)).toEqual(['r1']);
  });
});
