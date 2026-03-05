import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { Command } from 'commander';

import { HttpError } from '../transport/http';
import type { CliContext } from '../types';
import { requireTabId, printWithOptionalFormat, resolveCommandUser } from '../utils/command-helpers';
import { atomicWrite } from '../utils/fs-helpers';
import { resolveTabId } from '../utils/session-resolver';

function ensureParentDir(filePath: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
}

function parseCookiesFromFile(path: string): unknown[] {
	const raw = readFileSync(path, 'utf8');
	const data = JSON.parse(raw) as unknown;
	if (!Array.isArray(data)) {
		throw new Error('Cookie file must contain a JSON array of Playwright-compatible cookie objects.');
	}
	return data;
}

async function exportCookies(context: CliContext, tabId: string, userId: string): Promise<unknown[]> {
	try {
		const response = await context.getTransport().post<unknown[]>('/export-cookies', { tabId, userId });
		return response.data;
	} catch (error) {
		if (!(error instanceof HttpError) || error.status !== 404) {
			throw error;
		}
		const response = await context
			.getTransport()
			.get<unknown[]>(`/tabs/${encodeURIComponent(tabId)}/cookies?userId=${encodeURIComponent(userId)}`);
		if (!Array.isArray(response.data)) {
			throw new Error('Server returned invalid cookie payload. Expected an array.');
		}
		return response.data;
	}
}

export function registerDownloadCommands(program: Command, context: CliContext): void {
	const cookie = program.command('cookie').description('Import/export browser cookies');

	cookie
		.command('export')
		.argument('[tabId]', 'tab id (defaults to active tab)')
		.option('--path <file>', 'write cookies JSON to file')
		.option('--user <user>', 'user id')
		.action(async (tabIdArg: string | undefined, options: { path?: string; user?: string }, command: Command) => {
			try {
				const userId = resolveCommandUser({ command, user: options.user });
				const tabId = requireTabId(resolveTabId({ tabId: tabIdArg }), options);
				const cookies = await exportCookies(context, tabId, userId);

				if (options.path) {
					ensureParentDir(options.path);
					atomicWrite(options.path, `${JSON.stringify(cookies, null, 2)}\n`, { mode: 0o600 });
					const format = context.getFormat(command);
					context.print(command, format === 'plain' ? options.path : { path: options.path, count: cookies.length });
					return;
				}

				context.print(command, cookies);
			} catch (error) {
				context.handleError(error);
			}
		});

	cookie
		.command('import')
		.argument('<file>', 'path to cookies JSON file')
		.argument('[tabId]', 'tab id (defaults to active tab)')
		.option('--user <user>', 'user id')
		.action(async (filePath: string, tabIdArg: string | undefined, options: { user?: string }, command: Command) => {
			try {
				const userId = resolveCommandUser({ command, user: options.user });
				const tabId = requireTabId(resolveTabId({ tabId: tabIdArg }), options);
				const cookies = parseCookiesFromFile(filePath);

				try {
					await context.getTransport().post('/import-cookies', {
						tabId,
						userId,
						cookies,
					});
				} catch (error) {
					if (!(error instanceof HttpError) || error.status !== 404) {
						throw error;
					}
					try {
						await context.getTransport().post(`/tabs/${encodeURIComponent(tabId)}/restore-cookies`, {
							userId,
							cookies,
						});
					} catch (restoreError) {
						if (!(restoreError instanceof HttpError) || restoreError.status !== 404) {
							throw restoreError;
						}
						await context.getTransport().post(`/sessions/${encodeURIComponent(userId)}/cookies`, {
							tabId,
							cookies,
						});
					}
				}

				context.print(command, { ok: true, imported: cookies.length, file: filePath, tabId });
			} catch (error) {
				context.handleError(error);
			}
		});

	program
		.command('download')
		.argument('[url]', 'URL to download')
		.option('--path <dir>', 'download target directory')
		.option('--user <user>', 'user id')
		.action(async (_url: string | undefined, options: { path?: string; user?: string }, command: Command) => {
			try {
				void options;
				context.print(command, {
					ok: false,
					requires: 'server v2.0+',
					message:
						'The "download" command requires a server v2.0+ direct download endpoint, which is not available on this server. Use "camofox downloads" to inspect completed downloads or call batch download on a tab via the API.',
				});
			} catch (error) {
				context.handleError(error);
			}
		});

	program
		.command('downloads')
		.option('--user <user>', 'user id')
		.option('--format <format>', 'output format: json|text|plain')
		.action(async (options: { user?: string; format?: string }, command: Command) => {
			try {
				const userId = resolveCommandUser({ command, user: options.user });
				let data: unknown;

				try {
					const response = await context
						.getTransport()
						.get(`/users/${encodeURIComponent(userId)}/downloads`);
					data = response.data;
				} catch (error) {
					// Fallback to older downloads endpoint if the specific user endpoint returns 404
					if (!(error instanceof HttpError) || error.status !== 404) {
						throw error;
					}

					const response = await context.getTransport().get(`/downloads?userId=${encodeURIComponent(userId)}`);
					data = response.data;
				}

				printWithOptionalFormat(context, command, options.format, data);
			} catch (error) {
				context.handleError(error);
			}
		});
}
