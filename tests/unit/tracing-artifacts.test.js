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
}));

/** @type {{mkdirSync: jest.Mock, readdirSync: jest.Mock, statSync: jest.Mock, unlinkSync: jest.Mock}} */
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
});
