const fs = require('fs');
const os = require('os');
const path = require('path');

describe('CLI session file version handling', () => {
	let tmpHome;
	let originalHome;

	beforeEach(() => {
		originalHome = process.env.HOME;
		tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-version-'));
	});

	afterEach(() => {
		jest.resetModules();
		jest.dontMock('node:os');
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		fs.rmSync(tmpHome, { recursive: true, force: true });
	});

	function getSessionsDir() {
		return path.join(tmpHome, '.camofox', 'sessions');
	}

	function getSessionFilePath(sessionName) {
		return path.join(getSessionsDir(), `${sessionName}.json`);
	}

	function writeRawSessionFile(sessionName, content) {
		fs.mkdirSync(getSessionsDir(), { recursive: true });
		fs.writeFileSync(getSessionFilePath(sessionName), content);
	}

	function writeJsonSessionFile(sessionName, payload) {
		writeRawSessionFile(sessionName, JSON.stringify(payload, null, 2));
	}

	function createHarness(transportOverrides = {}) {
		process.env.HOME = tmpHome;
		jest.resetModules();
		jest.doMock('node:os', () => ({
			...jest.requireActual('node:os'),
			homedir: () => tmpHome,
		}));

		const { Command } = require('commander');
		const { registerSessionCommands } = require('../../dist/src/cli/commands/session');

		const transport = {
			get: jest.fn(async () => ({ data: [] })),
			post: jest.fn(async () => ({ data: { ok: true } })),
			...transportOverrides,
		};
		const outputs = [];
		const context = {
			getTransport: () => transport,
			getFormat: () => 'json',
			print: jest.fn((_command, data) => {
				outputs.push(data);
			}),
			handleError: (error) => {
				throw error;
			},
		};

		const program = new Command();
		registerSessionCommands(program, context);

		return { program, outputs, transport };
	}

	async function runCli(args, transportOverrides) {
		const harness = createHarness(transportOverrides);
		await harness.program.parseAsync(['node', 'test', ...args]);
		return harness;
	}

	test('reads legacy v0 bare cookie arrays through session load', async () => {
		const sessionName = 'legacy-array';
		const cookies = [{ name: 'a', value: 'b', domain: '.example.com' }];
		writeJsonSessionFile(sessionName, cookies);

		const { outputs, transport } = await runCli(['session', 'load', sessionName, 'tab-1', '--user', 'user-1']);

		expect(transport.post).toHaveBeenCalledWith('/sessions/user-1/cookies', {
			tabId: 'tab-1',
			cookies,
		});
		expect(outputs[0]).toMatchObject({
			ok: true,
			session: sessionName,
			tabId: 'tab-1',
			loadedFrom: 'local',
			cookies: 1,
		});
	});

	test('reads v0.5 object files without a version field through session load', async () => {
		const sessionName = 'legacy-object';
		const cookies = [{ name: 'cookie', value: 'value', domain: '.example.com' }];
		writeJsonSessionFile(sessionName, {
			sessionName,
			userId: 'stored-user',
			tabId: 'stored-tab',
			savedAt: '2024-01-01T00:00:00.000Z',
			cookies,
			localStorage: { origin: 'https://example.com', entries: [{ key: 'theme', value: 'dark' }] },
		});

		const { outputs, transport } = await runCli(['session', 'load', sessionName, 'tab-2', '--user', 'user-2']);

		expect(transport.post).toHaveBeenCalledWith('/sessions/user-2/cookies', {
			tabId: 'tab-2',
			cookies,
		});
		expect(outputs[0]).toMatchObject({
			ok: true,
			session: sessionName,
			tabId: 'tab-2',
			cookies: 1,
		});
	});

	test('reads v1 files through session load', async () => {
		const sessionName = 'versioned-session';
		const cookies = [{ name: 'token', value: '123', domain: '.example.com' }];
		writeJsonSessionFile(sessionName, {
			version: 1,
			sessionName,
			userId: 'stored-user',
			tabId: 'stored-tab',
			savedAt: '2024-01-01T00:00:00.000Z',
			cookies,
			sessionStorage: { origin: 'https://example.com', entries: [{ key: 'nonce', value: 'abc' }] },
		});

		const { outputs, transport } = await runCli(['session', 'load', sessionName, 'tab-3', '--user', 'user-3']);

		expect(transport.post).toHaveBeenCalledWith('/sessions/user-3/cookies', {
			tabId: 'tab-3',
			cookies,
		});
		expect(outputs[0]).toMatchObject({
			ok: true,
			session: sessionName,
			tabId: 'tab-3',
			cookies: 1,
		});
	});

	test('rejects version 2 and newer session files', async () => {
		const sessionName = 'future-session';
		writeJsonSessionFile(sessionName, {
			version: 2,
			sessionName,
			cookies: [],
		});

		await expect(runCli(['session', 'load', sessionName, 'tab-4', '--user', 'user-4'])).rejects.toThrow(
			/uses version 2, but this build only supports up to version 1/,
		);
	});

	test('rejects corrupt JSON session files', async () => {
		const sessionName = 'corrupt-session';
		writeRawSessionFile(sessionName, '{{not json');

		await expect(runCli(['session', 'load', sessionName, 'tab-5', '--user', 'user-5'])).rejects.toThrow(
			/Corrupt session file "corrupt-session":/,
		);
	});

	test('session save writes version 1 envelopes', async () => {
		const sessionName = 'saved-session';
		const cookies = [{ name: 'saved', value: 'cookie', domain: '.example.com' }];

		const { outputs } = await runCli(['session', 'save', sessionName, 'tab-6', '--user', 'user-6'], {
			get: jest.fn(async () => ({ data: cookies })),
		});

		const filePath = getSessionFilePath(sessionName);
		const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));

		expect(parsed).toMatchObject({
			version: 1,
			sessionName,
			userId: 'user-6',
			tabId: 'tab-6',
			cookies,
			localStorage: null,
			sessionStorage: null,
		});
		expect(typeof parsed.savedAt).toBe('string');
		expect(outputs[0]).toMatchObject({
			ok: true,
			session: sessionName,
			path: filePath,
			tabId: 'tab-6',
			cookies: 1,
		});
	});
});