jest.mock('../../dist/src/middleware/logging', () => ({ log: () => {} }));

const fs = require('fs');
const os = require('os');
const path = require('path');

const { readVersionedSidecar, writeVersionedSidecar } = require('../../dist/src/utils/sidecar-version');

describe('download registry version handling', () => {
	let tmpDir;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-test-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	const registryOpts = {
		currentVersion: 1,
		migrations: {
			0: (raw) => raw,
		},
		label: 'download registry',
	};

	test('returns null for missing registry (first run)', () => {
		const result = readVersionedSidecar(path.join(tmpDir, 'registry.json'), registryOpts);
		expect(result).toBeNull();
	});

	test('reads v1 envelope correctly', () => {
		const filePath = path.join(tmpDir, 'registry.json');
		const entries = { 'dl-1': { id: 'dl-1', userId: 'u1', savedFilename: 'file.txt' } };
		writeVersionedSidecar(filePath, 1, entries);

		const result = readVersionedSidecar(filePath, registryOpts);
		expect(result).toEqual(entries);
	});

	test('migrates legacy v0 flat record (no version field)', () => {
		const filePath = path.join(tmpDir, 'registry.json');
		const legacy = { 'dl-1': { id: 'dl-1', userId: 'u1', savedFilename: 'file.txt' } };
		fs.writeFileSync(filePath, JSON.stringify(legacy));

		const result = readVersionedSidecar(filePath, registryOpts);
		expect(result).toEqual(legacy);
	});

	test('throws on corrupt registry.json (fail closed)', () => {
		const filePath = path.join(tmpDir, 'registry.json');
		fs.writeFileSync(filePath, '{{broken');

		expect(() => readVersionedSidecar(filePath, registryOpts)).toThrow(/Corrupt download registry/);
	});

	test('throws on newer version registry.json (fail closed)', () => {
		const filePath = path.join(tmpDir, 'registry.json');
		fs.writeFileSync(filePath, JSON.stringify({ version: 5, data: {} }));

		expect(() => readVersionedSidecar(filePath, registryOpts)).toThrow(/version 5.*only supports up to version 1/);
	});

	test('atomic write produces correct v1 envelope', () => {
		const filePath = path.join(tmpDir, 'registry.json');
		const entries = { 'dl-1': { id: 'dl-1', userId: 'u1', savedFilename: 'file.txt' } };
		writeVersionedSidecar(filePath, 1, entries);

		const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
		expect(raw).toEqual({ version: 1, data: entries });
	});
});