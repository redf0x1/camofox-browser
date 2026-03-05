import { closeSync, openSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Socket } from 'node:net';

export interface ServerStatus {
	running: boolean;
	pid?: number;
	port: number;
	uptimeSeconds?: number;
	tabsCount: number;
}

const DEFAULT_PORT = 9377;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SERVER_BIN_PATH = resolve(__dirname, '../../../../bin/camofox-browser.js');

export class ServerManager {
	private readonly port: number;
	private readonly camofoxDir: string;
	private readonly pidFilePath: string;
	private readonly logFilePath: string;

	constructor(port?: number) {
		this.port = ServerManager.getPort(port);
		this.camofoxDir = join(homedir(), '.camofox');
		this.pidFilePath = join(this.camofoxDir, 'server.pid');
		this.logFilePath = join(this.camofoxDir, 'logs', 'server.log');
	}

	public static getPort(overridePort?: number): number {
		if (typeof overridePort === 'number' && ServerManager.isValidPort(overridePort)) {
			return overridePort;
		}

		const envPort = process.env.CAMOFOX_PORT;
		if (envPort) {
			const parsed = Number(envPort);
			if (ServerManager.isValidPort(parsed)) {
				return parsed;
			}
		}

		return DEFAULT_PORT;
	}

	public async ensureRunning(): Promise<void> {
		const running = await this.isRunning();
		if (running) return;

		await this.startDaemon();
		await this.waitForReady();
	}

	public async startDaemon(options?: { idleTimeoutMs?: number; port?: number }): Promise<void> {
		const targetPort = ServerManager.getPort(options?.port ?? this.port);
		this.ensureDirectories();
		if (await this.isPortInUse(targetPort)) {
			throw new Error(
				`Port ${targetPort} is already in use. If a stale daemon is running, stop it with \"camofox server stop\" and retry.`,
			);
		}

		const logFd = openSync(this.logFilePath, 'a');
		try {
			const child = spawn(process.execPath, [SERVER_BIN_PATH], {
				detached: true,
				stdio: ['ignore', logFd, logFd],
				env: {
					...process.env,
					PORT: String(targetPort),
					CAMOFOX_IDLE_TIMEOUT_MS: String(options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS),
				},
			});

			if (!child.pid) {
				throw new Error('Failed to start server daemon process');
			}

			child.unref();
			this.writePidFileAtomic(child.pid);
		} finally {
			closeSync(logFd);
		}
	}

	public async stopDaemon(): Promise<void> {
		const pid = this.readPid();
		if (!pid) return;

		try {
			process.kill(pid, 'SIGTERM');
		} catch {
			this.cleanupPidFile();
			return;
		}

		const start = Date.now();
		while (Date.now() - start < 5000) {
			if (!this.isPidAlive(pid)) {
				this.cleanupPidFile();
				return;
			}
			await this.delay(150);
		}

		throw new Error(`Timed out waiting for server process ${pid} to stop`);
	}

	public async status(): Promise<ServerStatus> {
		const running = await this.isRunning();
		const pid = this.readPid();
		let health: unknown;
		if (running) {
			try {
				health = await this.fetchHealth();
			} catch {
				health = undefined;
			}
		}

		return {
			running,
			pid,
			port: this.port,
			uptimeSeconds: undefined,
			tabsCount: Number((health as { poolSize?: unknown } | undefined)?.poolSize ?? 0),
		};
	}

	public async isRunning(): Promise<boolean> {
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 1500);
			timeoutId.unref();
			const response = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: controller.signal });
			clearTimeout(timeoutId);
			if (response.status !== 200) {
				return false;
			}

			const body = (await response.json()) as Record<string, unknown>;
			return body?.engine === 'camoufox' && body?.running === true;
		} catch {
			return false;
		}
	}

	public async waitForReady(): Promise<void> {
		const startedAt = Date.now();
		let delayMs = 200;

		while (Date.now() - startedAt <= 30_000) {
			if (await this.isRunning()) {
				return;
			}
			await this.delay(delayMs);
			delayMs = Math.min(delayMs * 2, 4000);
		}

		throw new Error(`Server did not become ready on port ${this.port} within 30 seconds`);
	}

	private async fetchHealth(): Promise<unknown> {
		const response = await fetch(`http://127.0.0.1:${this.port}/health`);
		if (!response.ok) {
			throw new Error(`Health check failed with status ${response.status}`);
		}
		return response.json();
	}

	private ensureDirectories(): void {
		mkdirSync(this.camofoxDir, { recursive: true });
		mkdirSync(join(this.camofoxDir, 'logs'), { recursive: true });
	}

	private readPid(): number | undefined {
		try {
			const raw = readFileSync(this.pidFilePath, 'utf8').trim();
			const pid = Number(raw);
			return Number.isInteger(pid) && pid > 0 ? pid : undefined;
		} catch {
			return undefined;
		}
	}

	private writePidFileAtomic(pid: number): void {
		this.ensureDirectories();
		const tempPath = `${this.pidFilePath}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(tempPath, `${pid}\n`, 'utf8');
		renameSync(tempPath, this.pidFilePath);
	}

	private cleanupPidFile(): void {
		try {
			rmSync(this.pidFilePath, { force: true });
		} catch {
			// ignore
		}
	}

	private isPidAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	private async delay(ms: number): Promise<void> {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => resolve(), ms);
			timer.unref();
		});
	}

	private async isPortInUse(port: number): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const socket = new Socket();
			let settled = false;

			const finish = (result: boolean): void => {
				if (settled) return;
				settled = true;
				socket.destroy();
				resolve(result);
			};

			socket.setTimeout(300);
			socket.once('connect', () => finish(true));
			socket.once('timeout', () => finish(false));
			socket.once('error', () => finish(false));
			socket.connect(port, '127.0.0.1');
		});
	}

	private static isValidPort(port: number): boolean {
		return Number.isInteger(port) && port >= 1 && port <= 65535;
	}
}
