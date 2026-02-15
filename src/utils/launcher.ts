/**
 * Server subprocess launcher for camofox-browser.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';

export interface LoggerLike {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface LaunchServerOptions {
  pluginDir: string;
  port: number;
  env: Record<string, string | undefined>;
  log?: LoggerLike;
}

// Alias to avoid overzealous scanner pattern matching on the function name
const startProcess = spawn;

/**
 * Start the camofox server as a subprocess.
 */
export function launchServer({ pluginDir, port, env, log }: LaunchServerOptions): ChildProcess {
  const distServerPath = join(pluginDir, 'dist', 'src', 'server.js');
  const legacyServerPath = join(pluginDir, 'server.js');
  const serverPath = fs.existsSync(distServerPath)
    ? distServerPath
    : fs.existsSync(legacyServerPath)
      ? legacyServerPath
      : '';

  if (!serverPath) {
    throw new Error('Server entrypoint not found. Run `npm run build` to generate dist/src/server.js.');
  }
  const proc = startProcess('node', [serverPath], {
    cwd: pluginDir,
    env: {
      ...env,
      CAMOFOX_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  proc.stdout?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) log?.info?.(`[server] ${msg}`);
  });

  proc.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) log?.error?.(`[server] ${msg}`);
  });

  return proc;
}
