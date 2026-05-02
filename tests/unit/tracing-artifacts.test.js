const path = require('node:path');

const mockTracesDir = path.resolve(__dirname, '../../.test-artifacts/unit-traces');

jest.mock('../../dist/src/utils/config', () => ({
  loadConfig: () => ({
    tracesDir: mockTracesDir,
    traceMaxDurationMs: 30_000,
  }),
}));

jest.mock('node:fs', () => ({
  mkdirSync: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn(),
  unlinkSync: jest.fn(),
  readFileSync: jest.fn().mockReturnValue(JSON.stringify({ version: 'test' })),
  createReadStream: jest.fn(),
}));

/** @type {{mkdirSync: jest.Mock, readdirSync: jest.Mock, statSync: jest.Mock, unlinkSync: jest.Mock, readFileSync: jest.Mock, createReadStream: jest.Mock}} */
let fs;

describe('tracing artifact helpers', () => {
  /** @type {(userId: string) => Array<{filename: string, size: number, createdAt: number}>} */
  let listTraceArtifacts;
  /** @type {(userId: string, filename: string) => boolean} */
  let deleteTraceArtifact;
  /** @type {(userId: string, filename: string) => string} */
  let resolveTraceArtifactPath;

  const TRACES_DIR = mockTracesDir;
  const userOneToken = Buffer.from('user/one').toString('base64url');
  const userUnderscoreToken = Buffer.from('user_one').toString('base64url');
  const prefixUserToken = Buffer.from('\u00A0').toString('base64url');
  const prefixedUserToken = Buffer.from('\u00A0>').toString('base64url');

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    fs = require('node:fs');
    ({ listTraceArtifacts, deleteTraceArtifact, resolveTraceArtifactPath } = require('../../dist/src/services/tracing'));
  });

  test('listTraceArtifacts() returns only zip files belonging to the exact user ownership token', () => {
    fs.readdirSync.mockReturnValue([
      { name: `${userOneToken}-300.zip`, isFile: () => true },
      { name: `${userOneToken}-200.zip`, isFile: () => true },
      { name: `${userOneToken}-not-a-zip.txt`, isFile: () => true },
      { name: `${userUnderscoreToken}-999.zip`, isFile: () => true },
      { name: `${userOneToken}-100.zip`, isFile: () => false },
    ]);
    fs.statSync.mockImplementation((artifactPath) => {
      const stats = {
        [`${TRACES_DIR}/${userOneToken}-300.zip`]: { size: 300, mtimeMs: 3000 },
        [`${TRACES_DIR}/${userOneToken}-200.zip`]: { size: 200, mtimeMs: 2000 },
      };
      return stats[artifactPath];
    });

    const artifacts = listTraceArtifacts('user/one');

    expect(fs.mkdirSync).toHaveBeenCalledWith(TRACES_DIR, { recursive: true });
    expect(artifacts).toEqual([
      {
        filename: `${userOneToken}-300.zip`,
        size: 300,
        createdAt: 3000,
      },
      {
        filename: `${userOneToken}-200.zip`,
        size: 200,
        createdAt: 2000,
      },
    ]);
  });

  test('listTraceArtifacts() skips entries that vanish before stat', () => {
    fs.readdirSync.mockReturnValue([
      { name: `${userOneToken}-100.zip`, isFile: () => true },
      { name: `${userOneToken}-200.zip`, isFile: () => true },
    ]);
    fs.statSync.mockImplementation((artifactPath) => {
      if (artifactPath === `${TRACES_DIR}/${userOneToken}-100.zip`) {
        const err = new Error('gone');
        err.code = 'ENOENT';
        throw err;
      }
      return { size: 200, mtimeMs: 2000 };
    });

    expect(listTraceArtifacts('user/one')).toEqual([
      {
        filename: `${userOneToken}-200.zip`,
        size: 200,
        createdAt: 2000,
      },
    ]);
  });

  test('listTraceArtifacts() rethrows unexpected stat errors', () => {
    fs.readdirSync.mockReturnValue([{ name: `${userOneToken}-300.zip`, isFile: () => true }]);
    fs.statSync.mockImplementation(() => {
      const err = new Error('permission denied');
      err.code = 'EACCES';
      throw err;
    });

    expect(() => listTraceArtifacts('user/one')).toThrow('permission denied');
  });

  test('colliding user ids cannot access each other trace artifacts', () => {
    expect(() => deleteTraceArtifact('user/one', '../escape.zip')).toThrow('Invalid trace filename');
    expect(() => deleteTraceArtifact('user/one', `${userUnderscoreToken}-1.zip`)).toThrow(
      'Trace artifact does not belong to this user',
    );

    expect(deleteTraceArtifact('user/one', `${userOneToken}-1.zip`)).toBe(true);
    expect(fs.unlinkSync).toHaveBeenCalledWith(`${TRACES_DIR}/${userOneToken}-1.zip`);
  });

  test('ownership checks reject tokens that merely share a prefix', () => {
    fs.readdirSync.mockReturnValue([
      { name: `${prefixUserToken}-100.zip`, isFile: () => true },
      { name: `${prefixedUserToken}-200.zip`, isFile: () => true },
    ]);
    fs.statSync.mockImplementation((artifactPath) => {
      const stats = {
        [`${TRACES_DIR}/${prefixUserToken}-100.zip`]: { size: 100, mtimeMs: 1000 },
        [`${TRACES_DIR}/${prefixedUserToken}-200.zip`]: { size: 200, mtimeMs: 2000 },
      };
      return stats[artifactPath];
    });

    expect(listTraceArtifacts('\u00A0')).toEqual([
      {
        filename: `${prefixUserToken}-100.zip`,
        size: 100,
        createdAt: 1000,
      },
    ]);
  });

  test('resolveTraceArtifactPath() rejects filenames outside the generated contract', () => {
    expect(() => resolveTraceArtifactPath('user/one', `${userOneToken}.zip`)).toThrow('Invalid trace filename');
    expect(() => resolveTraceArtifactPath('user/one', `${userOneToken}-not-a-timestamp.zip`)).toThrow(
      'Invalid trace filename',
    );
  });

  test('stopTracing() keeps managed artifacts inside the traces root when config has a trailing slash', async () => {
    jest.resetModules();
    jest.doMock('../../dist/src/utils/config', () => ({
      loadConfig: () => ({
        tracesDir: `${mockTracesDir}/`,
        traceMaxDurationMs: 30_000,
      }),
    }));

    fs = require('node:fs');
    fs.statSync.mockReturnValue({ size: 123 });

    const { startTracing, stopTracing } = require('../../dist/src/services/tracing');
    const context = {
      tracing: {
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn().mockResolvedValue(undefined),
      },
    };

    await startTracing('user/one', context);
    const result = await stopTracing('user/one', context, `${mockTracesDir}/`);

    expect(path.dirname(result.path)).toBe(mockTracesDir);
    expect(context.tracing.stop).toHaveBeenCalledWith({
      path: expect.stringMatching(new RegExp(`^${mockTracesDir}/${userOneToken}-\\d+\\.zip$`)),
    });
  });

  test('trace download returns JSON when the file stream errors before sending bytes', async () => {
    jest.resetModules();

    jest.doMock('../../dist/src/middleware/errors', () => ({
      safeError: (err) => (err instanceof Error ? err.message : String(err)),
    }));
    jest.doMock('../../dist/src/middleware/logging', () => ({ log: jest.fn() }));
    jest.doMock('../../dist/src/middleware/auth', () => ({ isAuthorizedWithApiKey: jest.fn().mockReturnValue(true) }));
    jest.doMock('../../dist/src/middleware/rate-limit', () => ({ checkRateLimit: jest.fn() }));
    jest.doMock('../../dist/src/utils/presets', () => ({
      getAllPresets: jest.fn().mockReturnValue({}),
      resolveContextOptions: jest.fn().mockReturnValue(null),
      validateContextOptions: jest.fn().mockReturnValue(null),
    }));
    jest.doMock('../../dist/src/services/context-pool', () => ({
      contextPool: { listActiveUserIds: jest.fn().mockReturnValue([]), size: jest.fn().mockReturnValue(0) },
      getDisplayForUser: jest.fn(),
    }));
    jest.doMock('../../dist/src/services/vnc', () => ({ startVnc: jest.fn(), stopVnc: jest.fn() }));
    jest.doMock('../../dist/src/services/session', () => ({
      MAX_TABS_PER_SESSION: 10,
      acquireFirstCreateMutex: jest.fn(),
      commitStagedFirstUse: jest.fn(),
      createCanonicalProfile: jest.fn(),
      createStagedSession: jest.fn(),
      findTabById: jest.fn(),
      getCanonicalProfile: jest.fn(),
      getSession: jest.fn(),
      getSessionMapKey: jest.fn(),
      getSessionsForUser: jest.fn().mockReturnValue([]),
      getTabGroup: jest.fn(),
      indexTab: jest.fn(),
      normalizeUserId: (value) => String(value),
      rollbackCanonicalMutex: jest.fn(),
      rollbackStagedFirstUse: jest.fn(),
      unindexTab: jest.fn(),
      closeSessionsForUser: jest.fn(),
      countTotalTabsForSessions: jest.fn().mockReturnValue(0),
      withUserLimit: jest.fn((_userId, _limit, operation) => operation()),
    }));
    jest.doMock('../../dist/src/services/tab', () => ({
      backTab: jest.fn(),
      buildSnapshotPayload: jest.fn(),
      buildRefs: jest.fn(),
      clickTab: jest.fn(),
      createTabState: jest.fn(),
      evaluateTab: jest.fn(),
      evaluateTabExtended: jest.fn(),
      forwardTab: jest.fn(),
      getLinks: jest.fn(),
      pressTab: jest.fn(),
      refreshTab: jest.fn(),
      screenshotTab: jest.fn(),
      scrollElementTab: jest.fn(),
      snapshotTab: jest.fn(),
      calculateTypeTimeoutMs: jest.fn(),
      typeTab: jest.fn(),
      safePageClose: jest.fn(),
      validateUrl: jest.fn(),
      waitForPageReady: jest.fn(),
      withTimeout: jest.fn(),
      withTabLock: jest.fn(),
    }));
    jest.doMock('../../dist/src/services/download', () => ({
      commitStagedDownloads: jest.fn(),
      registerDownloadListener: jest.fn(),
      listDownloads: jest.fn(),
      getDownload: jest.fn(),
      getDownloadPath: jest.fn(),
      deleteDownload: jest.fn(),
      getRecentDownloads: jest.fn(),
      cleanupUserDownloads: jest.fn(),
      markDownloadsStaged: jest.fn(),
    }));
    jest.doMock('../../dist/src/services/resource-extractor', () => ({
      extractResources: jest.fn(),
      resolveBlob: jest.fn(),
    }));
    jest.doMock('../../dist/src/services/batch-downloader', () => ({ batchDownload: jest.fn() }));
    jest.doMock('../../dist/src/services/tracing', () => ({
      startTracing: jest.fn(),
      stopTracing: jest.fn(),
      startTracingChunk: jest.fn(),
      stopTracingChunk: jest.fn(),
      getTracingState: jest.fn(),
      listTraceArtifacts: jest.fn().mockReturnValue([]),
      resolveTraceArtifactPath: jest.fn().mockReturnValue('/fake/trace.zip'),
      deleteTraceArtifact: jest.fn(),
    }));

    fs = require('node:fs');
    const { EventEmitter } = require('node:events');
    fs.createReadStream.mockImplementation(() => {
      const stream = new EventEmitter();
      stream.pipe = jest.fn(() => {
        process.nextTick(() => stream.emit('error', new Error('stream boom')));
      });
      return stream;
    });

    const express = require('express');
    const router = require('../../dist/src/routes/core').default;
    const app = express();
    app.use(router);

    const server = await new Promise((resolve) => {
      const instance = app.listen(0, () => resolve(instance));
    });

    try {
      const { port } = server.address();
      const response = await fetch(`http://127.0.0.1:${port}/sessions/user-a/traces/${userOneToken}-1.zip`);

      expect(response.status).toBe(500);
      expect(response.headers.get('content-type')).toContain('application/json');
      await expect(response.json()).resolves.toEqual({ ok: false, error: 'stream boom' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
