import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { Command } from 'commander';

import type { CliContext } from '../types';
import {
	parseFormat,
	printWithOptionalFormat,
	requireTabId,
	resolveCommandUser,
} from '../utils/command-helpers';
import { getActiveTabFilePath, readActiveTabId, resolveTabId, resolveUserId } from '../utils/session-resolver';
import { VAULT_DIR } from '../vault/store';

type RefEntry = {
	ref: string;
	index: number;
};

type SnapshotNode = {
	ref?: unknown;
	children?: unknown;
	[key: string]: unknown;
};

function ensureParentDir(filePath: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
}

function defaultScreenshotPath(prefix: string): string {
	const folder = join(homedir(), '.camofox', 'screenshots');
	mkdirSync(folder, { recursive: true });
	return join(folder, `${prefix}-${Date.now()}.png`);
}

function collectRefsFromObject(value: unknown, output: Set<string>): void {
	if (!value || typeof value !== 'object') return;
	if (Array.isArray(value)) {
		for (const item of value) {
			collectRefsFromObject(item, output);
		}
		return;
	}

	const node = value as SnapshotNode;
	if (typeof node.ref === 'string' && node.ref.trim().length > 0) {
		output.add(node.ref.trim());
	}

	for (const nested of Object.values(node)) {
		collectRefsFromObject(nested, output);
	}
}

function collectRefs(snapshotPayload: unknown): RefEntry[] {
	const refs = new Set<string>();
	if (typeof snapshotPayload === 'string') {
		const matches = snapshotPayload.matchAll(/\[[^\]\s]+\]/g);
		for (const match of matches) {
			const ref = match[0].trim();
			if (ref.length > 0) refs.add(ref);
		}
	} else {
		collectRefsFromObject(snapshotPayload, refs);
	}

	return [...refs]
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
		.map((ref, index) => ({ ref, index: index + 1 }));
}

function parseTabCount(data: unknown): number {
	if (Array.isArray(data)) {
		return data.length;
	}

	if (!data || typeof data !== 'object') {
		return 0;
	}

	const value = data as { tabs?: unknown; poolSize?: unknown; count?: unknown };
	if (Array.isArray(value.tabs)) return value.tabs.length;
	if (typeof value.poolSize === 'number' && Number.isFinite(value.poolSize)) return value.poolSize;
	if (typeof value.count === 'number' && Number.isFinite(value.count)) return value.count;
	return 0;
}

function resolveCliVersion(): string {
	const pkgPath = resolve(__dirname, '../../../../package.json');
	const raw = readFileSync(pkgPath, 'utf8');
	const pkg = JSON.parse(raw) as { version?: unknown };
	if (typeof pkg.version !== 'string' || pkg.version.trim().length === 0) {
		throw new Error('Unable to resolve CLI version from package.json');
	}
	return pkg.version;
}

async function checkArgon2Availability(): Promise<{ available: boolean; mode: 'argon2id' | 'pbkdf2' }> {
	try {
		await import('argon2');
		return { available: true, mode: 'argon2id' };
	} catch {
		return { available: false, mode: 'pbkdf2' };
	}
}

async function readSnapshot(context: CliContext, tabId: string, userId: string): Promise<unknown> {
	const response = await context
		.getTransport()
		.get<{ snapshot?: unknown }>(`/snapshot?targetId=${encodeURIComponent(tabId)}&userId=${encodeURIComponent(userId)}`);
	return response.data.snapshot ?? response.data;
}

async function readScreenshot(context: CliContext, tabId: string, userId: string): Promise<string> {
	const query = new URLSearchParams({ userId, fullPage: 'false' });
	const legacyUrl = `${context.getTransport().getBaseUrl()}/tabs/${encodeURIComponent(tabId)}/screenshot?${query.toString()}`;
	const response = await fetch(legacyUrl);
	if (!response.ok) {
		throw new Error(`Legacy screenshot request failed: HTTP ${response.status}`);
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	return bytes.toString('base64');
}

export function registerAdvancedCommands(program: Command, context: CliContext): void {
	program
		.command('annotate')
		.description('Capture screenshot and output element ref map')
		.argument('[tabId]', 'tab id (defaults to active tab)')
		.option('--user <user>', 'user id')
		.option('--output <file>', 'output screenshot file path')
		.option('--format <format>', 'output format: json|text|plain')
		.action(
			async (
				tabIdArg: string | undefined,
				options: { user?: string; output?: string; format?: string },
				command: Command,
			) => {
				try {
					parseFormat(options.format);
					const userId = resolveCommandUser({ command, user: options.user });
					const tabId = requireTabId(resolveTabId({ tabId: tabIdArg }), options);

					const snapshotPayload = await readSnapshot(context, tabId, userId);
					const refs: RefEntry[] = collectRefs(snapshotPayload);
					const screenshotBase64 = await readScreenshot(context, tabId, userId);

					if (!screenshotBase64) {
						throw new Error('Unable to generate annotated screenshot payload');
					}

					const outputPath = options.output ?? defaultScreenshotPath('annotated');
					ensureParentDir(outputPath);
					writeFileSync(outputPath, Buffer.from(screenshotBase64, 'base64'));

					const result = {
						path: outputPath,
						tabId,
						userId,
						annotatedByServer: false,
						refs,
					};

					if ((parseFormat(options.format) ?? context.getFormat(command)) === 'plain') {
						process.stdout.write(`${outputPath}\n`);
						return;
					}

					printWithOptionalFormat(context, command, options.format, result);
				} catch (error) {
					context.handleError(error);
				}
			},
		)
		.addHelpText(
			'after',
			`\nExamples:\n  $ camofox annotate\n  $ camofox annotate abc123 --output ./annotated.png --format json\n`,
		);

	program
		.command('health')
		.description('Check server, browser, and vault health')
		.option('--format <format>', 'output format: json|text|plain')
		.action(async (options: { format?: string }, command: Command) => {
			try {
				parseFormat(options.format);
				const port = Number(new URL(context.getTransport().getBaseUrl()).port);

				let healthPayload: unknown;
				let serverRunning = false;
				let serverError: string | undefined;

				try {
					const response = await context.getTransport().get('/health');
					healthPayload = response.data;
					serverRunning = true;
				} catch (error) {
					if (error instanceof Error) {
						serverError = error.message;
					}
				}

				let tabCount = 0;
				if (serverRunning) {
					try {
						const tabs = await context.getTransport().get(`/tabs?userId=${encodeURIComponent(resolveUserId({}))}`);
						tabCount = parseTabCount(tabs.data);
					} catch {
						// Tab listing may fail if no tabs open — graceful fallback
						tabCount = 0;
					}
				}

				const argon2 = await checkArgon2Availability();
				const result = {
					ok: serverRunning,
					server: {
						running: serverRunning,
						port,
						error: serverError ?? null,
						health: healthPayload ?? null,
					},
					browser: {
						tabCount,
					},
					vault: {
						path: VAULT_DIR,
						exists: existsSync(VAULT_DIR),
						argon2Available: argon2.available,
						cryptoMode: argon2.mode,
					},
				};

				printWithOptionalFormat(context, command, options.format, result);
			} catch (error) {
				context.handleError(error);
			}
		})
		.addHelpText('after', `\nExamples:\n  $ camofox health\n  $ camofox health --format json\n`);

	program
		.command('version')
		.description('Show CLI, server, and Node.js versions')
		.option('--format <format>', 'output format: json|text|plain')
		.action(async (options: { format?: string }, command: Command) => {
			try {
				parseFormat(options.format);
				const cliVersion = resolveCliVersion();
				let serverVersion: string = 'not running';
				try {
					const response = await context.getTransport().get('/health');
					const data = response.data as { version?: unknown };
					serverVersion = typeof data.version === 'string' && data.version.trim().length > 0 ? data.version : 'running';
				} catch {
					serverVersion = 'not running';
				}

				const result = {
					cli: cliVersion,
					server: serverVersion,
					node: process.version,
				};
				printWithOptionalFormat(context, command, options.format, result);
			} catch (error) {
				context.handleError(error);
			}
		});

	program
		.command('info')
		.description('Show current CLI configuration and active state')
		.option('--format <format>', 'output format: json|text|plain')
		.action(async (options: { format?: string }, command: Command) => {
			try {
				parseFormat(options.format);
				const port = Number(new URL(context.getTransport().getBaseUrl()).port);
				const result = {
					port,
					vaultDir: VAULT_DIR,
					sessionDir: join(homedir(), '.camofox', 'sessions'),
					activeTab: readActiveTabId() ?? null,
					activeTabFile: getActiveTabFilePath(),
					activeUser: resolveUserId({}),
					logFile: join(homedir(), '.camofox', 'logs', 'server.log'),
				};
				printWithOptionalFormat(context, command, options.format, result);
			} catch (error) {
				context.handleError(error);
			}
		})
		.addHelpText('after', `\nExamples:\n  $ camofox info\n  $ camofox info --format json\n`);
}
