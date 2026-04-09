const fs = require('fs');
const os = require('os');
const path = require('path');

const mockLog = jest.fn();

function loadDownloadsService(mockDownloadsDir) {
	jest.resetModules();
	mockLog.mockClear();

	jest.doMock('../../dist/src/middleware/logging', () => ({ log: mockLog }));
	jest.doMock('../../dist/src/utils/config', () => ({
		loadConfig: () => ({
			downloadsDir: mockDownloadsDir,
			profilesDir: path.join(os.tmpdir(), 'profiles-unused'),
			maxSessions: 5,
			headless: true,
			port: 9377,
			host: '0.0.0.0',
			downloadTtlMs: 3600000,
			maxDownloadSizeMb: 100,
			maxDownloadsPerUser: 500,
			maxBatchConcurrency: 5,
			maxBlobSizeMb: 5,
		}),
	}));

	return require('../../dist/src/services/download');
}

describe('download registry corrupt - no orphan rebuild', () => {
	let tmpDir;
	let downloadsDir;
	let registryFile;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-corrupt-test-'));
		downloadsDir = tmpDir;
		registryFile = path.join(downloadsDir, 'registry.json');

		fs.writeFileSync(registryFile, '{{corrupt json');

		const userDir = path.join(downloadsDir, 'testuser');
		fs.mkdirSync(userDir, { recursive: true });
		fs.writeFileSync(
			path.join(userDir, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890_test.txt'),
			'orphan content',
		);
	});

	afterEach(() => {
		jest.resetModules();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('corrupt registry does not trigger orphan scan rebuild', () => {
		const { listDownloads } = loadDownloadsService(downloadsDir);

		const result = listDownloads({ userId: 'testuser' });
		expect(result.downloads).toHaveLength(0);
		expect(mockLog).toHaveBeenCalledWith(
			'error',
			'download registry load failed; existing downloads unavailable until registry is fixed or deleted',
			expect.objectContaining({
				registryFile,
			}),
		);
	});

	test('newer version registry does not trigger orphan scan rebuild', () => {
		fs.writeFileSync(registryFile, JSON.stringify({ version: 99, data: {} }));

		const { listDownloads } = loadDownloadsService(downloadsDir);

		const result = listDownloads({ userId: 'testuser' });
		expect(result.downloads).toHaveLength(0);
		expect(mockLog).toHaveBeenCalledWith(
			'error',
			'download registry load failed; existing downloads unavailable until registry is fixed or deleted',
			expect.objectContaining({
				registryFile,
			}),
		);
	});

	test('v1 envelope with array data does not trigger orphan scan rebuild', () => {
		fs.writeFileSync(registryFile, JSON.stringify({ version: 1, data: ['not', 'a', 'map'] }));

		const { listDownloads } = loadDownloadsService(downloadsDir);

		const result = listDownloads({ userId: 'testuser' });
		expect(result.downloads).toHaveLength(0);
		expect(mockLog).toHaveBeenCalledWith(
			'error',
			'download registry load failed; existing downloads unavailable until registry is fixed or deleted',
			expect.objectContaining({
				registryFile,
			}),
		);
	});

	test('v1 envelope with null data does not trigger orphan scan rebuild', () => {
		fs.writeFileSync(registryFile, JSON.stringify({ version: 1, data: null }));

		const { listDownloads } = loadDownloadsService(downloadsDir);

		const result = listDownloads({ userId: 'testuser' });
		expect(result.downloads).toHaveLength(0);
		expect(mockLog).toHaveBeenCalledWith(
			'error',
			'download registry load failed; existing downloads unavailable until registry is fixed or deleted',
			expect.objectContaining({
				registryFile,
			}),
		);
	});

	test('v1 envelope with missing data field does not trigger orphan scan rebuild', () => {
		fs.writeFileSync(registryFile, JSON.stringify({ version: 1 }));

		const { listDownloads } = loadDownloadsService(downloadsDir);

		const result = listDownloads({ userId: 'testuser' });
		expect(result.downloads).toHaveLength(0);
		expect(mockLog).toHaveBeenCalledWith(
			'error',
			'download registry load failed; existing downloads unavailable until registry is fixed or deleted',
			expect.objectContaining({
				registryFile,
			}),
		);
	});
});