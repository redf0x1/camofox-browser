jest.mock('camoufox-js/dist/pkgman.js', () => ({
  installedVerStr: jest.fn(() => '1.0.0'),
}));

jest.mock('playwright-core', () => ({
  firefox: {
    launchPersistentContext: jest.fn(async () => ({
      pages: jest.fn(() => []),
      newPage: jest.fn(async () => ({})),
      close: jest.fn(async () => {}),
      on: jest.fn(),
    })),
  },
}));

jest.mock('../../dist/src/middleware/logging', () => ({
  log: jest.fn(),
}));

jest.mock('../../dist/src/utils/config', () => ({
  loadConfig: jest.fn(() => ({
    maxSessions: 2,
    downloadsDir: '/tmp/camofox-test/downloads',
    profilesDir: '/tmp/camofox-test/profiles',
    headless: true,
    proxy: { host: '', port: '', username: '', password: '' },
    fingerprintDefaults: {
      os: ['windows', 'macos'],
      allowWebgl: true,
      humanize: false,
      screen: { width: 1920, height: 1080 },
    },
  })),
}));

const mockLaunchOptions = jest.fn(async (opts) => opts);
const mockGenerateFingerprint = jest.fn(() => ({ mocked: true }));
const mockReadVersionedSidecar = jest.fn(() => null);
const mockWriteVersionedSidecar = jest.fn();

jest.mock('camoufox-js', () => ({
  launchOptions: (...args) => mockLaunchOptions(...args),
}));

jest.mock('camoufox-js/dist/fingerprints.js', () => ({
  generateFingerprint: (...args) => mockGenerateFingerprint(...args),
}));

jest.mock('../../dist/src/utils/sidecar-version', () => ({
  readVersionedSidecar: (...args) => mockReadVersionedSidecar(...args),
  writeVersionedSidecar: (...args) => mockWriteVersionedSidecar(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
  // Default: readVersionedSidecar returns null (no persisted data)
  mockReadVersionedSidecar.mockReturnValue(null);
});

test('applies fingerprint env defaults to launch options and new fingerprint generation', async () => {
  const { ContextPool } = require('../../dist/src/services/context-pool');
  const pool = new ContextPool();

  await pool.ensureContext('user-a', 'user-a');

  // Screen constraints must flow into generateFingerprint (where they take effect),
  // not just into launchOptions (which ignores screen when a fingerprint is provided).
  expect(mockGenerateFingerprint).toHaveBeenCalledWith(undefined, {
    operatingSystems: ['windows', 'macos'],
    screen: { minWidth: 1920, maxWidth: 1920, minHeight: 1080, maxHeight: 1080 },
  });
  expect(mockLaunchOptions).toHaveBeenCalledWith(
    expect.objectContaining({
      os: ['windows', 'macos'],
      allow_webgl: true,
      humanize: false,
    }),
  );
  // screen must NOT be passed to launchOptions — it is a no-op there when fingerprint is set.
  expect(mockLaunchOptions).toHaveBeenCalledWith(
    expect.not.objectContaining({ screen: expect.anything() }),
  );
});

test('keeps an existing fingerprint sidecar without regeneration', async () => {
  // readVersionedSidecar is called twice: once for compat check, once for fingerprint.
  // Both have existing data so no writes should happen.
  mockReadVersionedSidecar
    .mockReturnValueOnce({ camoufoxVersion: '1.0.0', createdAt: '2020-01-01T00:00:00.000Z' })
    .mockReturnValueOnce({ persisted: true });
  const { ContextPool } = require('../../dist/src/services/context-pool');
  const pool = new ContextPool();

  await pool.ensureContext('user-b', 'user-b');

  expect(mockGenerateFingerprint).not.toHaveBeenCalled();
  expect(mockWriteVersionedSidecar).not.toHaveBeenCalled();
});
