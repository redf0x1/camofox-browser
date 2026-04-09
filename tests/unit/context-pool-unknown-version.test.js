jest.mock('../../dist/src/middleware/logging', () => ({ log: () => {} }));

jest.mock('camoufox-js/dist/pkgman.js', () => ({
	installedVerStr: () => {
		throw new Error('not installed');
	},
}));

jest.mock('camoufox-js', () => ({
	launchOptions: () => ({}),
}));

jest.mock('camoufox-js/dist/fingerprints.js', () => ({
	generateFingerprint: () => ({}),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockProfilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'));
const mockDownloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-downloads-test-'));
const mockLaunchPersistentContext = jest.fn(async () => ({
	on: jest.fn(),
	pages: jest.fn(() => []),
	close: jest.fn(async () => {}),
}));

jest.mock('../../dist/src/utils/config', () => ({
	loadConfig: () => ({
		profilesDir: mockProfilesDir,
		maxSessions: 5,
		headless: true,
		port: 9377,
		host: '0.0.0.0',
		downloadsDir: mockDownloadsDir,
		downloadTtlMs: 3600000,
		proxy: {
			host: '',
			port: '',
			username: '',
			password: '',
		},
		vncResolution: '1920x1080x24',
	}),
}));

jest.mock('playwright-core', () => ({
	firefox: {
		launchPersistentContext: (...args) => mockLaunchPersistentContext(...args),
	},
}));

describe('context-pool unknown version blocking', () => {
	afterAll(() => {
		fs.rmSync(mockProfilesDir, { recursive: true, force: true });
		fs.rmSync(mockDownloadsDir, { recursive: true, force: true });
	});

	test('rejects persistent context launch when Camoufox version is unknown', async () => {
		const { ContextPool } = require('../../dist/src/services/context-pool');
		const pool = new ContextPool();

		await expect(pool.ensureContext('test-user')).rejects.toThrow(/Camoufox version could not be determined/);
		expect(mockLaunchPersistentContext).not.toHaveBeenCalled();
	});
});