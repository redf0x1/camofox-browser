import { Command } from 'commander';

import { formatOutput, type OutputFormat } from './output/formatter';
import { registerCoreCommands } from './commands/core';
import { registerAuthCommands } from './commands/auth';
import { registerContentCommands } from './commands/content';
import { registerDownloadCommands } from './commands/download';
import { registerInteractionCommands } from './commands/interaction';
import { registerNavigationCommands } from './commands/navigation';
import { registerSessionCommands } from './commands/session';
import { registerServerCommands } from './commands/server';
import { registerAdvancedCommands } from './commands/advanced';
import { registerPipeCommands } from './commands/pipe';
import { registerConsoleCommands } from './commands/console';
import { registerTraceCommands } from './commands/trace';
import { parsePort } from './utils/command-helpers';
import { handleError } from './utils/error-handler';
import { HttpTransport } from './transport/http';
import { ServerManager } from './server/manager';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf-8')) as { version?: unknown };
if (typeof pkg.version !== 'string' || !pkg.version.trim()) {
	throw new Error('Unable to resolve CLI version from package.json');
}
const CLI_VERSION = pkg.version;

function getGlobalOptions(command: Command): { port?: string; format?: OutputFormat; local?: boolean } {
	const withGlobals = command.optsWithGlobals();
	return withGlobals as { port?: string; format?: OutputFormat; local?: boolean };
}

export async function run(argv = process.argv): Promise<void> {
	const program = new Command();

	program
		.name('camofox')
		.description('CLI for camofox-browser REST API')
		.version(CLI_VERSION, '-V, --version', 'Output the version number')
		.option('--user <user>', 'default user id (overrides CAMOFOX_CLI_USER)')
		.option('--port <port>', 'server port (overrides CAMOFOX_PORT)')
		.option('--format <format>', 'output format: json|text|plain', 'text')
		.option('--local', 'reserved for v2')
		.showHelpAfterError();

	let transport: HttpTransport | undefined;

	const getFormat = (command: Command): OutputFormat => {
		const options = getGlobalOptions(command);
		const format = options.format ?? 'text';
		if (format !== 'json' && format !== 'text' && format !== 'plain') {
			throw new Error('Invalid --format value. Expected one of: json, text, plain.');
		}
		return format;
	};

	const print = (command: Command, data: unknown): void => {
		const format = getFormat(command);
		const output = formatOutput(data, format);
		if (output.length > 0) {
			process.stdout.write(`${output}\n`);
		}
	};

	const getTransport = (command: Command): HttpTransport => {
		if (transport) return transport;
		const globalOptions = getGlobalOptions(command);
		const port = ServerManager.getPort(globalOptions.port ? parsePort(globalOptions.port) : undefined);
		transport = new HttpTransport(port);
		return transport;
	};

	program.hook('preAction', async (_thisCommand, actionCommand) => {
		const globalOptions = getGlobalOptions(actionCommand);
		if (globalOptions.local) {
			throw new Error('--local is reserved for v2');
		}

		const parentName = actionCommand.parent?.name();
		if (parentName === 'server') {
			return;
		}

		if (actionCommand.name() === 'health' || actionCommand.name() === 'version' || actionCommand.name() === 'info') {
			return;
		}

		const port = ServerManager.getPort(globalOptions.port ? parsePort(globalOptions.port) : undefined);
		const manager = new ServerManager(port);
		await manager.ensureRunning();
		void getTransport(actionCommand);
	});

	registerCoreCommands(program, {
		getTransport: () => {
			const command = program;
			return getTransport(command);
		},
		getFormat,
		print,
		handleError: (error: unknown): never => handleError(error as Error),
	});

	registerNavigationCommands(program, {
		getTransport: () => {
			const command = program;
			return getTransport(command);
		},
		getFormat,
		print,
		handleError: (error: unknown): never => handleError(error as Error),
	});

	registerInteractionCommands(program, {
		getTransport: () => {
			const command = program;
			return getTransport(command);
		},
		getFormat,
		print,
		handleError: (error: unknown): never => handleError(error as Error),
	});

	registerContentCommands(program, {
		getTransport: () => {
			const command = program;
			return getTransport(command);
		},
		getFormat,
		print,
		handleError: (error: unknown): never => handleError(error as Error),
	});

	registerSessionCommands(program, {
		getTransport: () => {
			const command = program;
			return getTransport(command);
		},
		getFormat,
		print,
		handleError: (error: unknown): never => handleError(error as Error),
	});

	registerDownloadCommands(program, {
		getTransport: () => {
			const command = program;
			return getTransport(command);
		},
		getFormat,
		print,
		handleError: (error: unknown): never => handleError(error as Error),
	});

	registerAuthCommands(program, {
		getTransport: () => {
			const command = program;
			return getTransport(command);
		},
		getFormat,
		print,
		handleError: (error: unknown): never => handleError(error as Error),
	});

	registerServerCommands(program, {
		getFormat,
		print,
		handleError: (error: unknown): never => handleError(error as Error),
	});

	registerAdvancedCommands(program, {
		getTransport: () => {
			const command = program;
			return getTransport(command);
		},
		getFormat,
		print,
		handleError: (error: unknown): never => handleError(error as Error),
	});

	registerPipeCommands(program, {
		getTransport: () => {
			const command = program;
			return getTransport(command);
		},
		getFormat,
		print,
		handleError: (error: unknown): never => handleError(error as Error),
	});

	registerConsoleCommands(program, {
		getTransport: () => {
			const command = program;
			return getTransport(command);
		},
		getFormat,
		print,
		handleError: (error: unknown): never => handleError(error as Error),
	});

	registerTraceCommands(program, {
		getTransport: () => {
			const command = program;
			return getTransport(command);
		},
		getFormat,
		print,
		handleError: (error: unknown): never => handleError(error as Error),
	});

	process.on('SIGINT', () => {
		process.stderr.write('\nInterrupted\n');
		process.exit(130);
	});

	try {
		await program.parseAsync(argv);
	} catch (error) {
		handleError(error as Error);
	}
}
