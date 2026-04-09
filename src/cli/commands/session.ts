import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { Command } from 'commander';

import { HttpError } from '../transport/http';
import type { CliContext } from '../types';
import { printWithOptionalFormat, requireTabId, resolveCommandUser } from '../utils/command-helpers';
import { atomicWrite } from '../utils/fs-helpers';
import { resolveTabId } from '../utils/session-resolver';

type SessionFilePayload = {
	version: 1;
	sessionName: string;
	userId: string;
	tabId: string;
	savedAt: string;
	cookies: unknown[];
	localStorage?: unknown;
	sessionStorage?: unknown;
};

const SESSIONS_DIR = join(homedir(), '.camofox', 'sessions');

function ensureSessionsDir(): void {
	mkdirSync(SESSIONS_DIR, { recursive: true });
}

function validateSessionName(name: string): string {
	const value = name.trim();
	if (value.length === 0) {
		throw new Error('Session name is required.');
	}
	if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
		throw new Error('Invalid session name. Use only letters, numbers, dot, underscore, and dash.');
	}
	return value;
}

function getSessionFilePath(sessionName: string): string {
	return join(SESSIONS_DIR, `${sessionName}.json`);
}

async function confirmDelete(sessionName: string): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return false;
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question(`Delete session \"${sessionName}\"? [y/N] `);
		const normalized = answer.trim().toLowerCase();
		return normalized === 'y' || normalized === 'yes';
	} finally {
		rl.close();
	}
}

async function getCookiesForTab(context: CliContext, tabId: string, userId: string): Promise<unknown[]> {
	const response = await context
		.getTransport()
		.get<unknown[]>(`/tabs/${encodeURIComponent(tabId)}/cookies?userId=${encodeURIComponent(userId)}`);
	if (!Array.isArray(response.data)) {
		throw new Error('Server returned invalid cookie payload. Expected an array.');
	}
	return response.data;
}

function readSessionFile(sessionName: string): SessionFilePayload {
	ensureSessionsDir();
	const filePath = getSessionFilePath(sessionName);

	const content = readFileSync(filePath, 'utf8');

	let raw: unknown;
	try {
		raw = JSON.parse(content);
	} catch (err) {
		throw new Error(
			`Corrupt session file "${sessionName}": ${err instanceof Error ? err.message : String(err)}. Delete ${filePath} to reset.`,
		);
	}

	if (Array.isArray(raw)) {
		return {
			version: 1,
			sessionName,
			userId: '',
			tabId: '',
			savedAt: new Date().toISOString(),
			cookies: raw,
		};
	}

	if (!raw || typeof raw !== 'object') {
		throw new Error(
			`Invalid session file "${sessionName}": expected JSON object or array. Delete ${filePath} to reset.`,
		);
	}

	const data = raw as Record<string, unknown>;
	const version = typeof data.version === 'number' ? data.version : 0;
	if (version > 1) {
		throw new Error(
			`Session file "${sessionName}" uses version ${version}, but this build only supports up to version 1. Upgrade camofox-browser or delete ${filePath} to reset.`,
		);
	}

	const cookies = Array.isArray(data.cookies) ? data.cookies : [];
	return {
		version: 1,
		sessionName,
		userId: typeof data.userId === 'string' ? data.userId : '',
		tabId: typeof data.tabId === 'string' ? data.tabId : '',
		savedAt: typeof data.savedAt === 'string' ? data.savedAt : new Date().toISOString(),
		cookies,
		localStorage: data.localStorage,
		sessionStorage: data.sessionStorage,
	};
}

function writeSessionFile(payload: SessionFilePayload): string {
	ensureSessionsDir();
	const filePath = getSessionFilePath(payload.sessionName);
	const withVersion = { ...payload, version: 1 as const };
	atomicWrite(filePath, `${JSON.stringify(withVersion, null, 2)}\n`, { mode: 0o600 });
	return filePath;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === 'object' && error !== null && 'code' in error;
}

export function registerSessionCommands(program: Command, context: CliContext): void {
	const session = program.command('session').description('Manage saved browser sessions');

	session
		.command('save')
		.argument('<name>', 'session name')
		.argument('[tabId]', 'tab id (defaults to active tab)')
		.option('--user <user>', 'user id')
		.action(async (nameArg: string, tabIdArg: string | undefined, options: { user?: string }, command: Command) => {
			try {
				const sessionName = validateSessionName(nameArg);
				const userId = resolveCommandUser({ command, user: options.user });
				const tabId = requireTabId(resolveTabId({ tabId: tabIdArg }), options);

				const cookies = await getCookiesForTab(context, tabId, userId);
				const savedAt = new Date().toISOString();
				const filePath = writeSessionFile({
					version: 1,
					sessionName,
					userId,
					tabId,
					savedAt,
					cookies,
					localStorage: null,
					sessionStorage: null,
				});

				context.print(command, {
					ok: true,
					session: sessionName,
					path: filePath,
					tabId,
					cookies: cookies.length,
					savedAt,
				});
			} catch (error) {
				context.handleError(error);
			}
		});

	session
		.command('load')
		.argument('<name>', 'session name')
		.argument('[tabId]', 'tab id (defaults to active tab)')
		.option('--user <user>', 'user id')
		.action(async (nameArg: string, tabIdArg: string | undefined, options: { user?: string }, command: Command) => {
			try {
				const sessionName = validateSessionName(nameArg);
				const userId = resolveCommandUser({ command, user: options.user });
				const tabId = requireTabId(resolveTabId({ tabId: tabIdArg }), options);

				const payload = readSessionFile(sessionName);
				const cookies = payload.cookies;

				try {
					await context.getTransport().post(`/sessions/${encodeURIComponent(userId)}/cookies`, {
						tabId,
						cookies,
					});
				} catch (error) {
					if (!(error instanceof HttpError) || error.status !== 404) {
						throw error;
					}
					await context.getTransport().post(`/tabs/${encodeURIComponent(tabId)}/restore-cookies`, {
						userId,
						cookies,
					});
				}

				context.print(command, {
					ok: true,
					session: sessionName,
					tabId,
					loadedFrom: 'local',
					cookies: cookies.length,
				});
			} catch (error) {
				if (isErrnoException(error) && error.code === 'ENOENT') {
					context.handleError(
						new Error(
							`Session "${nameArg}" not found. Use "camofox session list" to see available sessions.`,
						),
					);
				}
				context.handleError(error);
			}
		});

	session
		.command('list')
		.option('--format <format>', 'output format: json|text|plain')
		.action(async (options: { format?: string }, command: Command) => {
			try {
				ensureSessionsDir();
				const sessions = readdirSync(SESSIONS_DIR)
					.filter((entry) => entry.endsWith('.json'))
					.map((entry) => {
						try {
							const fullPath = join(SESSIONS_DIR, entry);
							const stats = statSync(fullPath);
							return {
								name: entry.replace(/\.json$/, ''),
								size: stats.size,
								modified: stats.mtime.toISOString(),
							};
						} catch {
							return null;
						}
					})
					.filter(
						(session): session is { name: string; size: number; modified: string } =>
							session !== null,
					)
					.sort((a, b) => b.modified.localeCompare(a.modified));

				printWithOptionalFormat(context, command, options.format, sessions);
			} catch (error) {
				context.handleError(error);
			}
		});

	session
		.command('delete')
		.argument('<name>', 'session name')
		.option('--force', 'delete without confirmation')
		.action(async (nameArg: string, options: { force?: boolean }, command: Command) => {
			try {
				const sessionName = validateSessionName(nameArg);
				const filePath = getSessionFilePath(sessionName);
				if (!existsSync(filePath)) {
					context.print(command, {
						ok: false,
						notFound: true,
						session: sessionName,
						message: `Session "${sessionName}" not found`,
					});
					return;
				}
				if (!options.force) {
					const confirmed = await confirmDelete(sessionName);
					if (!confirmed) {
						context.print(command, { ok: false, canceled: true, session: sessionName });
						return;
					}
				}

				rmSync(filePath, { force: true });
				context.print(command, { ok: true, deleted: sessionName });
			} catch (error) {
				context.handleError(error);
			}
		});
}
