import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { Command } from 'commander';

import { resolveCommandUser, requireTabId } from '../utils/command-helpers';
import { resolveTabId } from '../utils/session-resolver';
import type { CliContext } from '../types';

function ensureParentDir(filePath: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
}

function defaultScreenshotPath(): string {
	const folder = join(homedir(), '.camofox', 'screenshots');
	mkdirSync(folder, { recursive: true });
	return join(folder, `screenshot-${Date.now()}.png`);
}

export function registerNavigationCommands(program: Command, context: CliContext): void {
	program
		.command('navigate')
		.description('Navigate tab to URL')
		.argument('<url>', 'URL to navigate to')
		.argument('[tabId]', 'tab id (defaults to active tab)')
		.option('--user <user>', 'user id')
		.action(async (url: string, tabIdArg: string | undefined, options: { user?: string }, command: Command) => {
			try {
				const userId = resolveCommandUser({ command, user: options.user });
				const tabId = requireTabId(resolveTabId({ tabId: tabIdArg }), options);

				let body: Record<string, string>;
				if (url.startsWith('@')) {
					const spaceIdx = url.indexOf(' ');
					const macro = spaceIdx === -1 ? url : url.slice(0, spaceIdx);
					const query = spaceIdx === -1 ? '' : url.slice(spaceIdx + 1);
					body = { targetId: tabId, userId, macro, query };
				} else {
					body = { targetId: tabId, userId, url };
				}

				await context.getTransport().post('/navigate', body);
				context.print(command, { ok: true, tabId, url });
			} catch (error) {
				context.handleError(error);
			}
		})
		.addHelpText(
			'after',
			`\nExamples:\n  $ camofox navigate https://example.com\n  $ camofox navigate "@google_search weather today"\n`,
		);

	program
		.command('screenshot')
		.description('Take screenshot')
		.argument('[tabId]', 'tab id (defaults to active tab)')
		.option('--path <file>', 'output file path')
		.option('--output <file>', 'output file path')
		.option('--full-page', 'capture full page')
		.option('--user <user>', 'user id')
		.action(
			async (
				tabIdArg: string | undefined,
				options: { user?: string; path?: string; output?: string; fullPage?: boolean },
				command: Command,
			) => {
				try {
					const userId = resolveCommandUser({ command, user: options.user });
					const tabId = requireTabId(resolveTabId({ tabId: tabIdArg }), options);
					const query = new URLSearchParams({ userId, fullPage: String(Boolean(options.fullPage)) });
					const legacyUrl = `${context
						.getTransport()
						.getBaseUrl()}/tabs/${encodeURIComponent(tabId)}/screenshot?${query.toString()}`;
					const legacyResponse = await fetch(legacyUrl);
					if (!legacyResponse.ok) {
						throw new Error(`Legacy screenshot request failed: HTTP ${legacyResponse.status}`);
					}
					const bytes = Buffer.from(await legacyResponse.arrayBuffer());
					const base64 = bytes.toString('base64');

					if (!base64) {
						throw new Error('Server did not return screenshot data');
					}

					const outputPath = options.output ?? options.path ?? defaultScreenshotPath();
					ensureParentDir(outputPath);
					writeFileSync(outputPath, Buffer.from(base64, 'base64'));

					const format = context.getFormat(command);
					context.print(command, format === 'plain' ? outputPath : { path: outputPath });
				} catch (error) {
					context.handleError(error);
				}
			},
		);

	program
		.command('go-back')
		.description('Go back in browser history')
		.argument('[tabId]', 'tab id (defaults to active tab)')
		.option('--user <user>', 'user id')
		.action(async (tabIdArg: string | undefined, options: { user?: string }, command: Command) => {
			try {
				const userId = resolveCommandUser({ command, user: options.user });
				const tabId = requireTabId(resolveTabId({ tabId: tabIdArg }), options);
				await context.getTransport().post(`/tabs/${encodeURIComponent(tabId)}/back`, { userId });
				context.print(command, { ok: true });
			} catch (error) {
				context.handleError(error);
			}
		});

	program
		.command('go-forward')
		.description('Go forward in browser history')
		.argument('[tabId]', 'tab id (defaults to active tab)')
		.option('--user <user>', 'user id')
		.action(async (tabIdArg: string | undefined, options: { user?: string }, command: Command) => {
			try {
				const userId = resolveCommandUser({ command, user: options.user });
				const tabId = requireTabId(resolveTabId({ tabId: tabIdArg }), options);
				await context.getTransport().post(`/tabs/${encodeURIComponent(tabId)}/forward`, { userId });
				context.print(command, { ok: true });
			} catch (error) {
				context.handleError(error);
			}
		});
}
