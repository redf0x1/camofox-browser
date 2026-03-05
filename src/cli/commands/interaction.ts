import { Command } from 'commander';

import { resolveCommandUser, requireTabId } from '../utils/command-helpers';
import { resolveTabId } from '../utils/session-resolver';
import { HttpError } from '../transport/http';
import type { CliContext } from '../types';
import { toElementTarget } from '../utils/selector';

type FormPair = { ref: string; value: string };

function unescapeValue(value: string): string {
	return value.replace(/\\([\\"'nrt])/g, (_match, escaped: string) => {
		switch (escaped) {
			case 'n':
				return '\n';
			case 'r':
				return '\r';
			case 't':
				return '\t';
			default:
				return escaped;
		}
	});
}

function parseFillAssignments(assignments: string): FormPair[] {
	const FILL_PAIR_PATTERN = /\s*\[([^\]]+)\]\s*=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s]+))/y;
	const text = assignments.trim();
	if (!text) {
		throw new Error('Assignments are required. Example: [e1]="john" [e2]="doe@example.com"');
	}

	const pairs: FormPair[] = [];
	let cursor = 0;

	while (cursor < text.length) {
		FILL_PAIR_PATTERN.lastIndex = cursor;
		const match = FILL_PAIR_PATTERN.exec(text);
		if (!match) {
			throw new Error('Invalid assignments format. Expected: [e1]="value1" [e2]="value2"');
		}

		const ref = match[1].trim();
		if (!ref) {
			throw new Error('Invalid assignments format. Element ref cannot be empty.');
		}

		const rawValue = match[2] ?? match[3] ?? match[4] ?? '';
		pairs.push({ ref, value: unescapeValue(rawValue) });
		cursor = FILL_PAIR_PATTERN.lastIndex;
	}

	if (pairs.length === 0) {
		throw new Error('No assignments parsed. Example: [e1]="john" [e2]="doe@example.com"');
	}

	return pairs;
}

export function registerInteractionCommands(program: Command, context: CliContext): void {
	program
		.command('fill')
		.argument('<assignments>', 'format: [e1]="value1" [e2]="value2"')
		.argument('[tabId]', 'tab id (defaults to active tab)')
		.option('--user <user>', 'user id')
		.action(async (assignments: string, tabIdArg: string | undefined, options: { user?: string }, command: Command) => {
			try {
				const userId = resolveCommandUser({ command, user: options.user });
				const tabId = requireTabId(resolveTabId({ tabId: tabIdArg }), options);
				const formData = parseFillAssignments(assignments);
				const body = { tabId, userId, formData };

				try {
					await context.getTransport().post('/fill-form', body);
				} catch (error) {
					if (!(error instanceof HttpError) || error.status !== 404) {
						throw error;
					}
					for (const entry of formData) {
						await context.getTransport().post('/act', {
							kind: 'type',
							targetId: tabId,
							userId,
							ref: entry.ref,
							text: entry.value,
						});
					}
				}

				context.print(command, { ok: true, count: formData.length });
			} catch (error) {
				context.handleError(error);
			}
		});

	program
		.command('scroll')
		.argument('[direction]', 'up|down|left|right', 'down')
		.argument('[tabId]', 'tab id (defaults to active tab)')
		.option('--amount <N>', 'scroll amount in px')
		.option('--user <user>', 'user id')
		.action(
			async (
				directionArg: string | undefined,
				tabIdArg: string | undefined,
				options: { amount?: string; user?: string },
				command: Command,
			) => {
				try {
					const userId = resolveCommandUser({ command, user: options.user });
					const tabId = requireTabId(resolveTabId({ tabId: tabIdArg }), options);
					const direction = (directionArg ?? 'down').toLowerCase();
					if (!['up', 'down', 'left', 'right'].includes(direction)) {
						throw new Error('Invalid direction. Expected one of: up, down, left, right.');
					}

					let amount: number | undefined;
					if (options.amount !== undefined) {
						amount = Number(options.amount);
						if (!Number.isFinite(amount) || amount <= 0) {
							throw new Error('Invalid --amount value. Expected a number greater than 0.');
						}
					}

					const body: Record<string, unknown> = { tabId, userId, direction };
					if (amount !== undefined) body.amount = amount;

					try {
						await context.getTransport().post('/scroll', body);
					} catch (error) {
						if (!(error instanceof HttpError) || error.status !== 404) {
							throw error;
						}

						if (direction === 'left' || direction === 'right') {
							const delta = direction === 'left' ? -Math.abs(amount ?? 500) : Math.abs(amount ?? 500);
							await context.getTransport().post(`/tabs/${encodeURIComponent(tabId)}/evaluate`, {
								userId,
								expression: `window.scrollBy(${delta}, 0); true;`,
							});
						} else {
							await context.getTransport().post(`/tabs/${encodeURIComponent(tabId)}/scroll`, {
								userId,
								direction,
								amount,
							});
						}
					}

					context.print(command, { ok: true, direction, amount: amount ?? null });
				} catch (error) {
					context.handleError(error);
				}
			},
		);

	program
		.command('select')
		.argument('<ref>', 'element ref like e5 or CSS selector')
		.argument('<value>', 'option value/label to select')
		.argument('[tabId]', 'tab id (defaults to active tab)')
		.option('--user <user>', 'user id')
		.action(async (ref: string, value: string, tabIdArg: string | undefined, options: { user?: string }, command: Command) => {
			try {
				const userId = resolveCommandUser({ command, user: options.user });
				const tabId = requireTabId(resolveTabId({ tabId: tabIdArg }), options);
				const target = toElementTarget(ref);
				const body = { tabId, userId, ...target, value };

				try {
					await context.getTransport().post('/select-option', body);
				} catch (error) {
					if (!(error instanceof HttpError) || error.status !== 404) {
						throw error;
					}
					await context.getTransport().post('/act', {
						kind: 'select',
						targetId: tabId,
						userId,
						...target,
						value,
					});
				}

				context.print(command, { ok: true });
			} catch (error) {
				context.handleError(error);
			}
		});

	program
		.command('hover')
		.argument('<ref>', 'element ref like e5 or CSS selector')
		.argument('[tabId]', 'tab id (defaults to active tab)')
		.option('--user <user>', 'user id')
		.action(async (ref: string, tabIdArg: string | undefined, options: { user?: string }, command: Command) => {
			try {
				const userId = resolveCommandUser({ command, user: options.user });
				const tabId = requireTabId(resolveTabId({ tabId: tabIdArg }), options);
				const target = toElementTarget(ref);
				const body = { tabId, userId, ...target };

				try {
					await context.getTransport().post('/hover', body);
				} catch (error) {
					if (!(error instanceof HttpError) || error.status !== 404) {
						throw error;
					}
					await context.getTransport().post('/act', {
						kind: 'hover',
						targetId: tabId,
						userId,
						...target,
					});
				}

				context.print(command, { ok: true });
			} catch (error) {
				context.handleError(error);
			}
		});

	program
		.command('press')
		.argument('<key>', 'keyboard key (Enter, Tab, Escape, ArrowDown, ...)')
		.argument('[tabId]', 'tab id (defaults to active tab)')
		.option('--user <user>', 'user id')
		.action(async (key: string, tabIdArg: string | undefined, options: { user?: string }, command: Command) => {
			try {
				const userId = resolveCommandUser({ command, user: options.user });
				const tabId = requireTabId(resolveTabId({ tabId: tabIdArg }), options);
				const body = { tabId, userId, key };

				try {
					await context.getTransport().post('/press-key', body);
				} catch (error) {
					if (!(error instanceof HttpError) || error.status !== 404) {
						throw error;
					}
					try {
						await context.getTransport().post(`/tabs/${encodeURIComponent(tabId)}/press`, { userId, key });
					} catch (innerError) {
						if (!(innerError instanceof HttpError) || innerError.status !== 404) {
							throw innerError;
						}
						await context.getTransport().post('/act', {
							kind: 'press',
							targetId: tabId,
							userId,
							key,
						});
					}
				}

				context.print(command, { ok: true });
			} catch (error) {
				context.handleError(error);
			}
		});
}
