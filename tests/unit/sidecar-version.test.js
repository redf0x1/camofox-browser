jest.mock('../../dist/src/middleware/logging', () => ({ log: () => {} }));

const fs = require('fs');
const path = require('path');
const os = require('os');

const { readVersionedSidecar, writeVersionedSidecar } = require('../../dist/src/utils/sidecar-version');

describe('sidecar-version', () => {
	let tmpDir;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-test-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	const opts = {
		currentVersion: 1,
		migrations: {
			0: (raw) => ({ migrated: true, original: raw }),
		},
		label: 'test sidecar',
	};

	describe('readVersionedSidecar', () => {
		test('returns null for missing file', () => {
			const result = readVersionedSidecar(path.join(tmpDir, 'missing.json'), opts);
			expect(result).toBeNull();
		});

		test('reads current version envelope', () => {
			const filePath = path.join(tmpDir, 'current.json');
			fs.writeFileSync(filePath, JSON.stringify({ version: 1, data: { key: 'value' } }));

			const result = readVersionedSidecar(filePath, opts);
			expect(result).toEqual({ key: 'value' });
		});

		test('migrates legacy v0 (no version field)', () => {
			const filePath = path.join(tmpDir, 'legacy.json');
			fs.writeFileSync(filePath, JSON.stringify({ oldField: 'data' }));

			const result = readVersionedSidecar(filePath, opts);
			expect(result).toEqual({ migrated: true, original: { oldField: 'data' } });
		});

		test('fails closed on newer version', () => {
			const filePath = path.join(tmpDir, 'future.json');
			fs.writeFileSync(filePath, JSON.stringify({ version: 99, data: {} }));

			expect(() => readVersionedSidecar(filePath, opts)).toThrow(/version 99.*only supports up to version 1/);
		});

		test('fails closed on corrupt JSON', () => {
			const filePath = path.join(tmpDir, 'corrupt.json');
			fs.writeFileSync(filePath, '{{{not json');

			expect(() => readVersionedSidecar(filePath, opts)).toThrow(/Corrupt test sidecar/);
		});

		test('fails closed on non-object JSON', () => {
			const filePath = path.join(tmpDir, 'string.json');
			fs.writeFileSync(filePath, '"just a string"');

			expect(() => readVersionedSidecar(filePath, opts)).toThrow(/Invalid test sidecar.*expected JSON object/);
		});

		test('fails closed when no migration path for version', () => {
			const filePath = path.join(tmpDir, 'nomigration.json');
			fs.writeFileSync(filePath, JSON.stringify({ someField: 'data' }));

			const noMigrationOpts = { ...opts, migrations: {} };
			expect(() => readVersionedSidecar(filePath, noMigrationOpts)).toThrow(/version 0.*no migration path/);
		});
	});

	describe('writeVersionedSidecar', () => {
		test('writes versioned envelope atomically', () => {
			const filePath = path.join(tmpDir, 'output.json');
			writeVersionedSidecar(filePath, 1, { key: 'value' });

			const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
			expect(content).toEqual({ version: 1, data: { key: 'value' } });
		});

		test('creates parent directories', () => {
			const filePath = path.join(tmpDir, 'deep', 'nested', 'output.json');
			writeVersionedSidecar(filePath, 1, { key: 'value' });

			expect(fs.existsSync(filePath)).toBe(true);
		});

		test('no tmp file left on success', () => {
			const filePath = path.join(tmpDir, 'clean.json');
			writeVersionedSidecar(filePath, 1, {});

			const files = fs.readdirSync(tmpDir);
			expect(files).toEqual(['clean.json']);
		});
	});
});