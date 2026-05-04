import { readFileSync } from 'node:fs';

import { Command } from 'commander';

import { resolveCommandUser, requireTabId } from '../utils/command-helpers';
import { resolveTabId } from '../utils/session-resolver';
import { HttpError } from '../transport/http';
import type { CliContext } from '../types';

type SearchEngine =
	| 'google'
	| 'youtube'
	| 'amazon'
	| 'bing'
	| 'reddit'
	| 'duckduckgo'
	| 'github'
	| 'stackoverflow';

const SEARCH_ENGINES: readonly SearchEngine[] = [
	'google',
	'youtube',
	'amazon',
	'bing',
	'reddit',
	'duckduckgo',
	'github',
	'stackoverflow',
];

function parseTimeout(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const timeout = Number(value);
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error('Invalid --timeout value. Expected a number greater than 0.');
	}
	return timeout;
}

function parseEngine(value: string | undefined): SearchEngine {
	const engine = (value ?? 'google').toLowerCase();
	if (!SEARCH_ENGINES.includes(engine as SearchEngine)) {
		throw new Error(`Invalid --engine value. Expected one of: ${SEARCH_ENGINES.join(', ')}.`);
	}
	return engine as SearchEngine;
}

function toSearchUrl(engine: SearchEngine, query: string): string {
	const encoded = encodeURIComponent(query);
	switch (engine) {
		case 'google':
			return `https://www.google.com/search?q=${encoded}`;
		case 'youtube':
			return `https://www.youtube.com/results?search_query=${encoded}`;
		case 'amazon':
			return `https://www.amazon.com/s?k=${encoded}`;
		case 'bing':
			return `https://www.bing.com/search?q=${encoded}`;
		case 'reddit':
			return `https://www.reddit.com/search?q=${encoded}`;
		case 'duckduckgo':
			return `https://duckduckgo.com/?q=${encoded}`;
		case 'github':
			return `https://github.com/search?q=${encoded}`;
		case 'stackoverflow':
			return `https://stackoverflow.com/search?q=${encoded}`;
		default:
			return `https://www.google.com/search?q=${encoded}`;
	}
}

function parseStructuredSchemaArg(input: string): unknown {
	let raw = input;
	if (input.startsWith('@')) {
		try {
			raw = readFileSync(input.slice(1), 'utf8');
		} catch (error) {
			throw new Error(
				`Cannot load structured schema from file: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	try {
		return JSON.parse(raw) as unknown;
	} catch (error) {
		throw new Error(`Invalid structured schema JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function registerContentCommands(program: Command, context: CliContext): void {
	program
		.command('extract-structured')
		.argument('<schemaOrFile>', 'JSON schema string or @path/to/schema.json')
		.argument('[tabId]', 'tab id (defaults to active tab)')
		.option('--user <user>', 'user id')
		.action(
			async (
				schemaOrFile: string,
				tabIdArg: string | undefined,
				options: { user?: string },
				command: Command,
			) => {
				try {
					const userId = resolveCommandUser({ command, user: options.user });
					const tabId = requireTabId(resolveTabId({ tabId: tabIdArg }), options);
					const schema = parseStructuredSchemaArg(schemaOrFile);
					const response = await context
						.getTransport()
						.post(`/tabs/${encodeURIComponent(tabId)}/extract-structured`, { userId, schema });
					context.print(command, response.data);
				} catch (error) {
					context.handleError(error);
				}
			},
		);

	program
		.command('get-text')
		.argument('[tabId]', 'tab id (defaults to active tab)')
		.option('--selector <selector>', 'CSS selector to extract text from')
		.option('--user <user>', 'user id')
		.action(async (tabIdArg: string | undefined, options: { selector?: string; user?: string }, command: Command) => {
			try {
				const userId = resolveCommandUser({ command, user: options.user });
				const tabId = requireTabId(resolveTabId({ tabId: tabIdArg }), options);
				const body: Record<string, unknown> = { tabId, userId };
				if (options.selector) body.selector = options.selector;

				let data: unknown;
				try {
					const response = await context.getTransport().post('/get-text', body);
					data = response.data;
				} catch (error) {
					if (!(error instanceof HttpError) || error.status !== 404) {
						throw error;
					}
					const selectorArg = JSON.stringify(options.selector ?? 'body');
					const expr = `(function(){ const el = document.querySelector(${selectorArg}); return el ? (el.textContent || '').trim() : ''; })()`;
					const evalResponse = await context.getTransport().post<{ result?: unknown; value?: unknown }>(
						`/tabs/${encodeURIComponent(tabId)}/evaluate`,
						{ userId, expression: expr },
					);
					const payload = evalResponse.data as { result?: unknown; value?: unknown };
					data = payload.result ?? payload.value ?? payload;
				}

				context.print(command, data);
			} catch (error) {
				context.handleError(error);
			}
		});

	program
		.command('get-url')
		.argument('[tabId]', 'tab id (defaults to active tab)')
		.option('--user <user>', 'user id')
		.action(async (tabIdArg: string | undefined, options: { user?: string }, command: Command) => {
			try {
				const userId = resolveCommandUser({ command, user: options.user });
				const tabId = requireTabId(resolveTabId({ tabId: tabIdArg }), options);
				let data: unknown;

				try {
					const response = await context.getTransport().post('/get-url', { tabId, userId });
					data = response.data;
				} catch (error) {
					if (!(error instanceof HttpError) || error.status !== 404) {
						throw error;
					}
					const stats = await context
						.getTransport()
						.get<{ url?: string }>(`/tabs/${encodeURIComponent(tabId)}/stats?userId=${encodeURIComponent(userId)}`);
					data = stats.data.url ?? stats.data;
				}

				const format = context.getFormat(command);
				if (format === 'plain' && typeof data !== 'string') {
					const url = (data as { url?: unknown })?.url;
					context.print(command, typeof url === 'string' ? url : data);
					return;
				}
				context.print(command, data);
			} catch (error) {
				context.handleError(error);
			}
		});

	program
		.command('get-links')
		.argument('[tabId]', 'tab id (defaults to active tab)')
		.option('--user <user>', 'user id')
		.action(async (tabIdArg: string | undefined, options: { user?: string }, command: Command) => {
			try {
				const userId = resolveCommandUser({ command, user: options.user });
				const tabId = requireTabId(resolveTabId({ tabId: tabIdArg }), options);

				let data: unknown;
				try {
					const response = await context.getTransport().post('/get-links', { tabId, userId });
					data = response.data;
				} catch (error) {
					if (!(error instanceof HttpError) || error.status !== 404) {
						throw error;
					}
					const response = await context
						.getTransport()
						.get<{ links?: Array<{ url?: string; text?: string }> }>(
							`/tabs/${encodeURIComponent(tabId)}/links?userId=${encodeURIComponent(userId)}&limit=1000&offset=0`,
						);
					data = response.data;
				}

				const format = context.getFormat(command);
				if (format === 'plain') {
					const links =
						(Array.isArray(data)
							? data
							: (data as { links?: unknown[] } | null | undefined)?.links) ?? [];
					const lines = links.map((item) => {
						if (typeof item === 'string') return item;
						if (item && typeof item === 'object') {
							const record = item as { url?: unknown; href?: unknown };
							if (typeof record.url === 'string') return record.url;
							if (typeof record.href === 'string') return record.href;
						}
						return String(item);
					});
					context.print(command, lines.join('\n'));
					return;
				}

				context.print(command, data);
			} catch (error) {
				context.handleError(error);
			}
		});

	program
		.command('get-tabs')
		.option('--user <user>', 'user id')
		.action(async (options: { user?: string }, command: Command) => {
			try {
				const userId = resolveCommandUser({ command, user: options.user });
				let data: unknown;

				try {
					const response = await context.getTransport().post('/get-tabs', { userId });
					data = response.data;
				} catch (error) {
					if (!(error instanceof HttpError) || error.status !== 404) {
						throw error;
					}
					const response = await context
						.getTransport()
						.get<{ tabs?: unknown[] }>(`/tabs?userId=${encodeURIComponent(userId)}`);
					data = response.data;
				}

				context.print(command, data);
			} catch (error) {
				context.handleError(error);
			}
		});

	program
		.command('eval')
		.argument('<expression>', 'JavaScript expression to evaluate in page context')
		.argument('[tabId]', 'tab id (defaults to active tab)')
		.option('--user <user>', 'user id')
		.action(async (expression: string, tabIdArg: string | undefined, options: { user?: string }, command: Command) => {
			try {
				const userId = resolveCommandUser({ command, user: options.user });
				const tabId = requireTabId(resolveTabId({ tabId: tabIdArg }), options);

				let data: unknown;
				try {
					const response = await context.getTransport().post('/evaluate', {
						tabId,
						userId,
						expression,
					});
					data = response.data;
				} catch (error) {
					if (!(error instanceof HttpError) || error.status !== 404) {
						throw error;
					}
					const response = await context.getTransport().post(`/tabs/${encodeURIComponent(tabId)}/evaluate`, {
						userId,
						expression,
					});
					data = response.data;
				}

				context.print(command, data);
			} catch (error) {
				context.handleError(error);
			}
		});

	program
		.command('wait')
		.argument('<condition>', 'selector, navigation, or networkidle')
		.argument('[tabId]', 'tab id (defaults to active tab)')
		.option('--timeout <ms>', 'timeout in milliseconds')
		.option('--user <user>', 'user id')
		.action(
			async (
				condition: string,
				tabIdArg: string | undefined,
				options: { timeout?: string; user?: string },
				command: Command,
			) => {
				try {
					const userId = resolveCommandUser({ command, user: options.user });
					const tabId = requireTabId(resolveTabId({ tabId: tabIdArg }), options);
					const timeout = parseTimeout(options.timeout);
					const httpTimeout = (timeout ?? 20000) + 5000;
					const body: Record<string, unknown> = { tabId, userId, condition };
					if (timeout !== undefined) body.timeout = timeout;

					try {
						await context.getTransport().post('/wait-for', body, { timeoutMs: httpTimeout });
					} catch (error) {
						if (!(error instanceof HttpError) || error.status !== 404) {
							throw error;
						}

						const normalized = condition.toLowerCase();
						if (normalized === 'navigation' || normalized === 'networkidle') {
							await context.getTransport().post(`/tabs/${encodeURIComponent(tabId)}/wait`, {
								userId,
								timeout,
								waitForNetwork: normalized === 'networkidle',
							}, { timeoutMs: httpTimeout });
						} else {
							const selectorJson = JSON.stringify(condition);
							const timeoutMs = timeout ?? 10000;
							const expression = `new Promise((resolve, reject) => {\n  const selector = ${selectorJson};\n  const deadline = Date.now() + ${timeoutMs};\n  const check = () => {\n    if (document.querySelector(selector)) { resolve(true); return; }\n    if (Date.now() >= deadline) { reject(new Error('Timeout waiting for selector: ' + selector)); return; }\n    setTimeout(check, 100);\n  };\n  check();\n})`;
							await context.getTransport().post(`/tabs/${encodeURIComponent(tabId)}/evaluate`, {
								userId,
								expression,
								timeout: timeoutMs + 1000,
							}, { timeoutMs: httpTimeout });
						}
					}

					context.print(command, { ok: true, condition });
				} catch (error) {
					context.handleError(error);
				}
			},
		);

	program
		.command('search')
		.argument('<query>', 'search query')
		.argument('[tabId]', 'tab id (defaults to active tab)')
		.option('--engine <engine>', 'google|youtube|amazon|bing|reddit|duckduckgo|github|stackoverflow', 'google')
		.option('--user <user>', 'user id')
		.action(
			async (
				query: string,
				tabIdArg: string | undefined,
				options: { engine?: string; user?: string },
				command: Command,
			) => {
				try {
					const userId = resolveCommandUser({ command, user: options.user });
					const tabId = requireTabId(resolveTabId({ tabId: tabIdArg }), options);
					const engine = parseEngine(options.engine);

					let data: unknown;
					try {
						const response = await context.getTransport().post('/web-search', {
							tabId,
							userId,
							query,
							engine,
						});
						data = response.data;
					} catch (error) {
						if (!(error instanceof HttpError) || error.status !== 404) {
							throw error;
						}
						const url = toSearchUrl(engine, query);
						const response = await context
							.getTransport()
							.post(`/tabs/${encodeURIComponent(tabId)}/navigate`, { userId, url });
						data = response.data;
					}

					context.print(command, data);
				} catch (error) {
					context.handleError(error);
				}
			},
		);
}
