import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { Command } from 'commander';

import type { OutputFormat } from '../output/formatter';
import { parsePort } from '../utils/command-helpers';
import { ServerManager } from '../server/manager';
import { loadConfig } from '../../utils/config';

const SERVER_BIN_PATH = resolve(__dirname, '../../../../bin/camofox-browser.js');

type CliContext = {
	getFormat: (command: Command) => OutputFormat;
	print: (command: Command, data: unknown) => void;
	handleError: (error: unknown) => never;
};

function parseIdleTimeoutMinutes(input: string | undefined): number | undefined {
	if (!input) return undefined;
	const minutes = Number(input);
	if (!Number.isFinite(minutes) || minutes <= 0) {
		throw new Error('Invalid --idle-timeout value. Expected number of minutes > 0.');
	}
	return minutes;
}

export function registerServerCommands(program: Command, context: CliContext): void {
	const server = program.command('server').description('Manage camofox server process');

	server
		.command('start')
		.option('--port <port>', 'server port')
		.option('--background', 'start daemon in background')
		.option('--idle-timeout <minutes>', 'idle timeout in minutes')
		.option('--idle-exit-timeout <minutes>', 'daemon exit timeout in minutes after cleanup stage')
		.action(async (options: { port?: string; background?: boolean; idleTimeout?: string; idleExitTimeout?: string }, command: Command) => {
			try {
				const cfg = loadConfig();
				const port = options.port ? parsePort(options.port) : undefined;
				const idleTimeoutMinutes = parseIdleTimeoutMinutes(options.idleTimeout);
				const idleTimeoutMs = idleTimeoutMinutes ? Math.floor(idleTimeoutMinutes * 60_000) : undefined;
				const idleExitTimeoutMinutes = parseIdleTimeoutMinutes(options.idleExitTimeout);
				const idleExitTimeoutMs = idleExitTimeoutMinutes ? Math.floor(idleExitTimeoutMinutes * 60_000) : undefined;
				const manager = new ServerManager(port);

				if (await manager.isRunning()) {
					context.print(command, `Server already running on port ${ServerManager.getPort(port)}`);
					return;
				}

				if (options.background) {
					await manager.startDaemon({ port, idleTimeoutMs, idleExitTimeoutMs });
					await manager.waitForReady();
					context.print(command, { ok: true, mode: 'background', port: ServerManager.getPort(port) });
					return;
				}

				const child = spawn(process.execPath, [SERVER_BIN_PATH, 'serve'], {
					stdio: 'inherit',
					env: {
						...cfg.serverEnv,
						PORT: String(ServerManager.getPort(port)),
						CAMOFOX_IDLE_TIMEOUT_MS: String(idleTimeoutMs ?? cfg.idleTimeoutMs),
						CAMOFOX_IDLE_EXIT_TIMEOUT_MS: String(idleExitTimeoutMs ?? cfg.idleExitTimeoutMs),
					},
				});

				child.on('exit', (code, signal) => {
					if (signal) {
						process.kill(process.pid, signal);
						return;
					}
					process.exit(code ?? 0);
				});
			} catch (error) {
				context.handleError(error);
			}
		});

	server.command('stop').action(async (_options: unknown, command: Command) => {
		try {
			const manager = new ServerManager();
			await manager.stopDaemon();
			context.print(command, { ok: true });
		} catch (error) {
			context.handleError(error);
		}
	});

	server
		.command('status')
		.option('--format <format>', 'json|text', 'text')
		.action(async (_options: { format?: 'json' | 'text' }, command: Command) => {
			try {
				const manager = new ServerManager();
				const status = await manager.status();
				const output = {
					status: status.running ? 'running' : 'stopped',
					pid: status.pid ?? null,
					port: status.port,
					uptime: status.uptimeSeconds ?? null,
					tabs: status.tabsCount,
				};

				const globalFormat = context.getFormat(command);
				if (globalFormat === 'plain') {
					context.print(command, output.status);
					return;
				}

				context.print(command, output);
			} catch (error) {
				context.handleError(error);
			}
		});
}
