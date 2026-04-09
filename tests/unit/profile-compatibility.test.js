jest.mock('../../dist/src/middleware/logging', () => ({ log: () => {} }));

const fs = require('fs');
const os = require('os');
const path = require('path');

const { readVersionedSidecar, writeVersionedSidecar } = require('../../dist/src/utils/sidecar-version');

describe('profile compatibility sidecar', () => {
	let tmpDir;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-test-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	const compatOpts = {
		currentVersion: 1,
		migrations: {},
		label: 'profile compatibility',
	};

	test('returns null for new profile (no compatibility.json)', () => {
		const result = readVersionedSidecar(path.join(tmpDir, 'compatibility.json'), compatOpts);
		expect(result).toBeNull();
	});

	test('reads valid v1 compatibility sidecar', () => {
		const filePath = path.join(tmpDir, 'compatibility.json');
		writeVersionedSidecar(filePath, 1, { camoufoxVersion: '0.8.5', createdAt: '2024-01-01T00:00:00Z' });

		const result = readVersionedSidecar(filePath, compatOpts);
		expect(result).toEqual({ camoufoxVersion: '0.8.5', createdAt: '2024-01-01T00:00:00Z' });
	});

	test('throws on corrupt compatibility.json (fail closed)', () => {
		const filePath = path.join(tmpDir, 'compatibility.json');
		fs.writeFileSync(filePath, '{{not json');

		expect(() => readVersionedSidecar(filePath, compatOpts)).toThrow(/Corrupt profile compatibility/);
	});

	test('throws on newer version compatibility.json (fail closed)', () => {
		const filePath = path.join(tmpDir, 'compatibility.json');
		fs.writeFileSync(filePath, JSON.stringify({ version: 99, data: { camoufoxVersion: '1.0.0' } }));

		expect(() => readVersionedSidecar(filePath, compatOpts)).toThrow(/version 99.*only supports up to version 1/);
	});

	test('throws on unversioned legacy compatibility.json with no migration (fail closed)', () => {
		const filePath = path.join(tmpDir, 'compatibility.json');
		fs.writeFileSync(filePath, JSON.stringify({ camoufoxVersion: '0.8.5' }));

		expect(() => readVersionedSidecar(filePath, compatOpts)).toThrow(/version 0.*no migration path/);
	});

	test('atomic write creates correct v1 envelope', () => {
		const filePath = path.join(tmpDir, 'compatibility.json');
		writeVersionedSidecar(filePath, 1, { camoufoxVersion: '0.8.5', createdAt: '2024-01-01T00:00:00Z' });

		const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
		expect(raw).toEqual({
			version: 1,
			data: { camoufoxVersion: '0.8.5', createdAt: '2024-01-01T00:00:00Z' },
		});
	});

	test('stored unknown version reads correctly for caller rejection', () => {
		const filePath = path.join(tmpDir, 'compatibility.json');
		writeVersionedSidecar(filePath, 1, { camoufoxVersion: 'unknown', createdAt: '2024-01-01T00:00:00Z' });

		const result = readVersionedSidecar(filePath, compatOpts);
		expect(result.camoufoxVersion).toBe('unknown');
		// Owner (context-pool.ts) throws on this value — see launchPersistentContext L236-239
	});
});