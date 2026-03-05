import { statSync } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline';
import { createInterface } from 'node:readline/promises';

import { Command } from 'commander';

import type { CliContext } from '../types';
import { printWithOptionalFormat, requireTabId, resolveCommandUser } from '../utils/command-helpers';
import { resolveTabId } from '../utils/session-resolver';
import { toElementTarget } from '../utils/selector';
import {
	VAULT_DIR,
	deleteProfile,
	listProfiles,
	loadProfile,
	saveProfile,
	type VaultProfile,
	validateProfileName,
} from '../vault/store';

function overwriteStringBestEffort(value: string): void {
	if (value.length === 0) return;
	const buffer = Buffer.from(value, 'utf8');
	buffer.fill(0);
}

async function promptLine(prompt: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return (await rl.question(prompt)).trim();
	} finally {
		rl.close();
	}
}

async function promptPassword(prompt: string): Promise<string> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			return await rl.question(prompt);
		} finally {
			rl.close();
		}
	}

	return await new Promise<string>((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: true,
		});

		let password = '';
		const onData = (chunk: Buffer): void => {
			const c = chunk.toString('utf8');

			if (c === '\n' || c === '\r' || c === '\u0004') {
				process.stdout.write('\n');
				cleanup();
				resolve(password);
				return;
			}

			if (c === '\u0003') {
				cleanup();
				process.exit(130);
			}

			if (c === '\u007f' || c === '\b') {
				password = password.slice(0, -1);
				return;
			}

			if (c >= ' ') {
				password += c;
			}
		};

		const cleanup = (): void => {
			process.stdin.off('data', onData);
			if (process.stdin.isTTY) {
				process.stdin.setRawMode(false);
			}
			rl.close();
		};

		process.stdout.write(prompt);
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(true);
		}
		process.stdin.on('data', onData);
	});
}

function assertProfileName(name: string): string {
	const value = name.trim();
	if (!validateProfileName(value)) {
		throw new Error('Invalid profile name. Use only letters, numbers, underscore, and dash (max 64 chars).');
	}
	return value;
}

export function registerAuthCommands(program: Command, context: CliContext): void {
	const auth = program.command('auth').description('Manage encrypted auth vault profiles');

	auth
		.command('save')
		.description('Save encrypted credentials in vault')
		.argument('<profile-name>', 'vault profile name')
		.option('--url <url>', 'site URL for this profile')
		.option('--notes <notes>', 'optional notes (stored encrypted)')
		.action(
			async (nameArg: string, options: { url?: string; notes?: string }, command: Command) => {
				let masterPassword = '';
				let accountPassword = '';
				try {
					const name = assertProfileName(nameArg);
					masterPassword = await promptPassword('Master password: ');
					if (!masterPassword || masterPassword.length < 8) {
						throw new Error('Master password must be at least 8 characters.');
					}
					const username = await promptLine('Username: ');
					accountPassword = await promptPassword('Password: ');

					if (!username) {
						throw new Error('Username is required.');
					}
					if (!accountPassword) {
						throw new Error('Password is required.');
					}

					const now = new Date().toISOString();
					const profile: VaultProfile = {
						name,
						url: options.url,
						username,
						password: accountPassword,
						notes: options.notes,
						createdAt: now,
						updatedAt: now,
					};

					await saveProfile(name, profile, masterPassword);
					context.print(command, `Profile '${name}' saved successfully`);
				} catch (error) {
					context.handleError(error);
				} finally {
					overwriteStringBestEffort(accountPassword);
					overwriteStringBestEffort(masterPassword);
					accountPassword = '';
					masterPassword = '';
				}
			},
		)
		.addHelpText(
			'after',
			`\nExamples:\n  $ camofox auth save gmail --url https://gmail.com\n  $ camofox auth load gmail --inject\n`,
		);

	auth
		.command('load')
		.description('Load credentials from vault profile')
		.argument('<profile-name>', 'vault profile name')
		.option('--inject [tabId]', 'Inject credentials into a browser tab')
		.option('--username-ref <ref>', 'Element ref for username field (e.g., e5)')
		.option('--password-ref <ref>', 'Element ref for password field (e.g., e12)')
		.option('--user <user>', 'user id (for --inject)')
		.action(
			async (
				nameArg: string,
				options: { inject?: string | boolean; usernameRef?: string; passwordRef?: string; user?: string },
				command: Command,
			) => {
				let masterPassword = '';
				try {
					const name = assertProfileName(nameArg);
					masterPassword = await promptPassword('Master password: ');
					if (!masterPassword) {
						throw new Error('Master password is required.');
					}
					const profile = await loadProfile(name, masterPassword);

					if (options.inject !== undefined) {
						const usernameRef = options.usernameRef;
						const passwordRef = options.passwordRef;

						if (!usernameRef || !passwordRef) {
							throw new Error(
								'When using --inject, you must specify --username-ref and --password-ref.\n' +
									'Use "camofox snapshot" first to find the correct element refs.',
							);
						}

						const userId = resolveCommandUser({ command, user: options.user });
						const injectTabId = typeof options.inject === 'string' ? options.inject : undefined;
						const tabId = requireTabId(resolveTabId({ tabId: injectTabId }), options);
						const transport = context.getTransport();
						await transport.post('/act', {
							kind: 'type',
							targetId: tabId,
							userId,
							...toElementTarget(usernameRef),
							text: profile.username,
						});
						await transport.post('/act', {
							kind: 'type',
							targetId: tabId,
							userId,
							...toElementTarget(passwordRef),
							text: profile.password,
						});
						context.print(command, 'Credentials injected into tab');
						return;
					}

					context.print(command, profile.username);
				} catch (error) {
					context.handleError(error);
				} finally {
					overwriteStringBestEffort(masterPassword);
					masterPassword = '';
				}
			},
		)
		.addHelpText(
			'after',
			`\nExamples:\n  $ camofox auth load gmail\n  $ camofox auth load gmail --inject --username-ref e5 --password-ref e12\n`,
		);

	auth
		.command('list')
		.description('List vault profiles')
		.option('--format <format>', 'output format: json|text|plain')
		.action(async (options: { format?: string }, command: Command) => {
			try {
				const profiles: Array<{ name: string; url: null; createdAt: string }> = [];
				for (const name of listProfiles()) {
					try {
						const filePath = join(VAULT_DIR, `${name}.enc`);
						const stats = statSync(filePath);
						profiles.push({
							name,
							url: null,
							createdAt: stats.birthtime.toISOString(),
						});
					} catch {
						continue;
					}
				}

				printWithOptionalFormat(context, command, options.format, profiles);
			} catch (error) {
				context.handleError(error);
			}
		});

	auth
		.command('delete')
		.description('Delete vault profile')
		.argument('<profile-name>', 'vault profile name')
		.action(async (nameArg: string, command: Command) => {
			let masterPassword = '';
			try {
				const name = assertProfileName(nameArg);
				masterPassword = await promptPassword('Master password: ');
				if (!masterPassword) {
					throw new Error('Master password is required.');
				}
				await loadProfile(name, masterPassword);
				deleteProfile(name);
				context.print(command, `Profile '${name}' deleted`);
			} catch (error) {
				context.handleError(error);
			} finally {
				overwriteStringBestEffort(masterPassword);
				masterPassword = '';
			}
		});

	auth
		.command('change-password')
		.description('Change vault profile master password')
		.argument('<profile-name>', 'vault profile name')
		.action(async (nameArg: string, command: Command) => {
			let currentPassword = '';
			let newPassword = '';
			let confirmPassword = '';
			try {
				const name = assertProfileName(nameArg);
				currentPassword = await promptPassword('Current master password: ');
				if (!currentPassword) {
					throw new Error('Current master password is required.');
				}
				const profile = await loadProfile(name, currentPassword);
				newPassword = await promptPassword('New master password: ');
				if (!newPassword || newPassword.length < 8) {
					throw new Error('Master password must be at least 8 characters.');
				}
				confirmPassword = await promptPassword('Confirm new master password: ');
				if (!confirmPassword) {
					throw new Error('Confirm new master password is required.');
				}

				if (newPassword !== confirmPassword) {
					throw new Error('New master passwords do not match');
				}

				const updated: VaultProfile = {
					...profile,
					updatedAt: new Date().toISOString(),
				};
				await saveProfile(name, updated, newPassword);
				context.print(command, `Master password updated for profile '${name}'`);
			} catch (error) {
				context.handleError(error);
			} finally {
				overwriteStringBestEffort(currentPassword);
				overwriteStringBestEffort(newPassword);
				overwriteStringBestEffort(confirmPassword);
				currentPassword = '';
				newPassword = '';
				confirmPassword = '';
			}
		});
}
