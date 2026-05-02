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
  /** @type {(userId: string) => Array<{filename: string, path: string, size: number, createdAt: number}>} */
  let listTraceArtifacts;
  /** @type {(userId: string, filename: string) => boolean} */
  let deleteTraceArtifact;

  const TRACES_DIR = mockTracesDir;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    fs = require('node:fs');
    ({ listTraceArtifacts, deleteTraceArtifact } = require('../../dist/src/services/tracing'));
  });

  test('listTraceArtifacts() returns only zip files belonging to the user prefix', () => {
    fs.readdirSync.mockReturnValue([
      { name: 'user_one-300.zip', isFile: () => true },
      { name: 'user_one-200.zip', isFile: () => true },
      { name: 'user_one-not-a-zip.txt', isFile: () => true },
      { name: 'user_two-999.zip', isFile: () => true },
      { name: 'user_one-100.zip', isFile: () => false },
    ]);
    fs.statSync.mockImplementation((artifactPath) => {
      const stats = {
        [`${TRACES_DIR}/user_one-300.zip`]: { size: 300, mtimeMs: 3000 },
        [`${TRACES_DIR}/user_one-200.zip`]: { size: 200, mtimeMs: 2000 },
      };
      return stats[artifactPath];
    });

    const artifacts = listTraceArtifacts('user/one');

    expect(fs.mkdirSync).toHaveBeenCalledWith(TRACES_DIR, { recursive: true });
    expect(artifacts).toEqual([
      {
        filename: 'user_one-300.zip',
        path: `${TRACES_DIR}/user_one-300.zip`,
        size: 300,
        createdAt: 3000,
      },
      {
        filename: 'user_one-200.zip',
        path: `${TRACES_DIR}/user_one-200.zip`,
        size: 200,
        createdAt: 2000,
      },
    ]);
  });

  test('deleteTraceArtifact() rejects traversal and deletes a valid user-owned trace file', () => {
    expect(() => deleteTraceArtifact('user/one', '../escape.zip')).toThrow('Invalid trace filename');
    expect(() => deleteTraceArtifact('user/one', 'user_two-1.zip')).toThrow(
      'Trace artifact does not belong to this user',
    );

    expect(deleteTraceArtifact('user/one', 'user_one-1.zip')).toBe(true);
    expect(fs.unlinkSync).toHaveBeenCalledWith(`${TRACES_DIR}/user_one-1.zip`);
  });
});
