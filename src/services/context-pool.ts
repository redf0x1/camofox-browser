import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { type ChildProcess, spawn } from 'node:child_process';

import { launchOptions } from 'camoufox-js';
import { generateFingerprint } from 'camoufox-js/dist/fingerprints.js';
// camoufox-js does not export version info from its public API.
// This deep import is the only way to detect the installed engine version.
// If it breaks on upgrade, getInstalledCamoufoxVersion() catches and returns 'unknown'.
import { installedVerStr } from 'camoufox-js/dist/pkgman.js';
import { type Fingerprint } from 'fingerprint-generator';
import { firefox, type BrowserContext, type BrowserContextOptions } from 'playwright-core';

import { loadConfig } from '../utils/config';
import { readVersionedSidecar, writeVersionedSidecar } from '../utils/sidecar-version';
import { log } from '../middleware/logging';

const CONFIG = loadConfig();

const MAX_CONTEXTS = CONFIG.maxSessions;

type PersistentContextOptions = NonNullable<Parameters<typeof firefox.launchPersistentContext>[1]>;
type CamoufoxOS = 'macos' | 'windows' | 'linux';

export interface PoolEntry {
	context: BrowserContext;
	userId: string;
	profileDir: string;
	lastAccess: number;
	launching?: Promise<BrowserContext>;
	staged?: boolean;
	stagedGeneration?: string;
	virtualDisplay?: any;
	seedOptions?: Pick<BrowserContextOptions, 'locale' | 'timezoneId' | 'geolocation' | 'viewport'>;
}

function getHostOS(): CamoufoxOS {
	const platform = os.platform();
	if (platform === 'darwin') return 'macos';
	if (platform === 'win32') return 'windows';
	return 'linux';
}

function getConfiguredOperatingSystems(hostOS: CamoufoxOS): CamoufoxOS[] {
	const configured = CONFIG.fingerprint.os;
	if (!configured) return [hostOS];
	return Array.isArray(configured) ? configured : [configured];
}

function getLaunchOs(hostOS: CamoufoxOS): CamoufoxOS | CamoufoxOS[] {
	const operatingSystems = getConfiguredOperatingSystems(hostOS);
	return operatingSystems.length === 1 ? operatingSystems[0] : operatingSystems;
}

function buildCamoufoxScreen(): { minWidth: number; maxWidth: number; minHeight: number; maxHeight: number } | undefined {
	const configured = CONFIG.fingerprint.screen;
	if (!configured) return undefined;
	return {
		minWidth: configured.width,
		maxWidth: configured.width,
		minHeight: configured.height,
		maxHeight: configured.height,
	};
}

function buildProxyConfig(): { server: string; username?: string; password?: string } | null {
	const { host, port, username, password } = CONFIG.proxy;
	if (!host || !port) return null;
	return {
		server: `http://${host}:${port}`,
		username: username || undefined,
		password: password || undefined,
	};
}

function getInstalledCamoufoxVersion(): string {
	try {
		return installedVerStr();
	} catch {
		return 'unknown';
	}
}

function profileDirForUserId(userId: string): string {
	const safe = encodeURIComponent(String(userId));
	return path.join(CONFIG.profilesDir, safe);
}

function pickSeedOptions(opts?: BrowserContextOptions): PoolEntry['seedOptions'] | undefined {
	if (!opts) return undefined;
	const { locale, timezoneId, geolocation, viewport } = opts;
	if (locale === undefined && timezoneId === undefined && geolocation === undefined && viewport === undefined) return undefined;
	return { locale, timezoneId, geolocation, viewport };
}

function seedDiffers(a?: PoolEntry['seedOptions'], b?: PoolEntry['seedOptions']): boolean {
	const aj = JSON.stringify(a ?? null);
	const bj = JSON.stringify(b ?? null);
	return aj !== bj;
}

function hasUsableLinuxDisplay(): boolean {
	const display = process.env.DISPLAY;
	if (!display) return false;

	const match = /^:([0-9]+)(?:\.[0-9]+)?$/.exec(display);
	if (!match) return true;

	const lockFile = `/tmp/.X${match[1]}-lock`;
	return fs.existsSync(lockFile);
}

async function spawnXvfb(resolution: string = '1920x1080x24'): Promise<{ display: string; process: ChildProcess }> {
	let displayNum = 99;
	while (fs.existsSync(`/tmp/.X${displayNum}-lock`)) {
		displayNum++;
	}

	const display = `:${displayNum}`;
	const xvfbProcess = spawn('Xvfb', [
		display,
		'-screen',
		'0',
		resolution,
		'-ac',
		'-nolisten',
		'tcp',
	], { stdio: 'pipe' });

	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const finalizeResolve = () => {
			if (settled) return;
			settled = true;
			clearInterval(check);
			clearTimeout(timeout);
			resolve();
		};
		const finalizeReject = (err: Error) => {
			if (settled) return;
			settled = true;
			clearInterval(check);
			clearTimeout(timeout);
			reject(err);
		};

		const timeout = setTimeout(() => {
			finalizeReject(new Error('Xvfb start timeout'));
		}, 5000);

		const check = setInterval(() => {
			if (fs.existsSync(`/tmp/.X${displayNum}-lock`)) {
				finalizeResolve();
			}
		}, 100);

		xvfbProcess.once('error', (err) => {
			finalizeReject(err);
		});

		xvfbProcess.once('exit', (code, signal) => {
			finalizeReject(new Error(`Xvfb exited early (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
		});
	});

	return { display, process: xvfbProcess };
}

export class ContextPool {
	private pool: Map<string, PoolEntry> = new Map();
	private headlessOverrides = new Map<string, boolean | 'virtual'>();
	private onEvictCallbacks: Array<(userId: string) => void> = [];

	onEvict(callback: (userId: string) => void): void {
		this.onEvictCallbacks.push(callback);
	}

	private notifyEviction(userId: string): void {
		for (const cb of this.onEvictCallbacks) {
			try {
				cb(userId);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				log('error', 'context pool onEvict callback failed', { userId, error: message });
			}
		}
	}

	getEntry(userId: string): PoolEntry | undefined {
		return this.pool.get(userId);
	}

	getDisplayForUser(userId: string): string | null {
		const entry = this.pool.get(String(userId));
		if (!entry) return null;

		if (entry.virtualDisplay) {
			try {
				const display = entry.virtualDisplay.get();
				return typeof display === 'string' ? display : null;
			} catch {
				return null;
			}
		}

		const processDisplay = process.env.DISPLAY;
		return typeof processDisplay === 'string' && processDisplay ? processDisplay : null;
	}

	size(): number {
		return this.pool.size;
	}

	listActiveUserIds(): string[] {
		return Array.from(this.pool.entries())
			.filter(([, entry]) => !entry.staged)
			.map(([userId]) => userId);
	}

	private cleanupVirtualDisplay(entry: PoolEntry): void {
		if (!entry.virtualDisplay) return;
		try {
			entry.virtualDisplay.kill();
		} catch {
		} finally {
			entry.virtualDisplay = undefined;
		}
	}

	private async launchPersistentContext(userId: string, contextOptions?: BrowserContextOptions): Promise<{ context: BrowserContext; virtualDisplay?: any }> {
		const hostOS = getHostOS();
		const operatingSystems = getConfiguredOperatingSystems(hostOS);
		const launchOs = getLaunchOs(hostOS);
		const screen = buildCamoufoxScreen();
		const proxy = buildProxyConfig();
		const headless = this.headlessOverrides.get(userId) ?? CONFIG.headless;

		const profileDir = profileDirForUserId(userId);
		fs.mkdirSync(profileDir, { recursive: true });
		const compatPath = path.join(profileDir, 'compatibility.json');

		try {
			const currentVersion = getInstalledCamoufoxVersion();
			if (currentVersion === 'unknown') {
				throw new Error(
					`Cannot verify profile compatibility for user "${userId}": installed Camoufox version could not be determined. ` +
					`Resolve the camoufox-js installation or delete the profile directory to reset: ${profileDir}`,
				);
			}

			const compat = readVersionedSidecar<{ camoufoxVersion: string; createdAt: string }>(compatPath, {
				currentVersion: 1,
				migrations: {},
				label: 'profile compatibility',
			});

			if (compat) {
				if (compat.camoufoxVersion === 'unknown') {
					throw new Error(
						`Profile for user "${userId}" has unknown version provenance and cannot be verified. Delete the profile directory to reset: ${profileDir}`,
					);
				}
				if (compat.camoufoxVersion !== currentVersion) {
					throw new Error(
						`Profile for user "${userId}" was created with Camoufox ${compat.camoufoxVersion}, but the current version is ${currentVersion}. Delete the profile directory to reset: ${profileDir}`,
					);
				}
			} else {
				writeVersionedSidecar(compatPath, 1, {
					camoufoxVersion: currentVersion,
					createdAt: new Date().toISOString(),
				});
			}
		} catch (err) {
			throw err instanceof Error
				? err
				: new Error(
					`Profile compatibility check failed for user "${userId}": ${String(err)}. Delete the profile directory to reset: ${profileDir}`,
				);
		}

		let effectiveHeadless: boolean = headless === true;
		let virtualDisplay: any = undefined;

		if (headless === 'virtual' || (headless === false && hostOS === 'linux' && !hasUsableLinuxDisplay())) {
			const xvfb = await spawnXvfb(CONFIG.vncResolution);
			virtualDisplay = {
				get: () => xvfb.display,
				kill: () => {
					try {
						xvfb.process.kill('SIGTERM');
					} catch {
					}
					setTimeout(() => {
						try {
							xvfb.process.kill('SIGKILL');
						} catch {
						}
					}, 3000).unref();
				},
			};
			effectiveHeadless = false;
			if (headless === false) {
				log('warn', 'headed mode requested without DISPLAY; auto-falling back to virtual display', {
					userId,
					hostOS,
					profileDir,
				});
			}
		}

		log('info', 'launching persistent context', {
			userId,
			hostOS,
			launchOs,
			profileDir,
			geoip: !!proxy,
			headless,
			effectiveHeadless,
			virtualDisplay: !!virtualDisplay,
		});

		try {
			const fpPath = path.join(profileDir, 'fingerprint.json');
			let fingerprint: Fingerprint | undefined;

			try {
				const persistedFingerprint = readVersionedSidecar<Fingerprint>(fpPath, {
					currentVersion: 1,
					migrations: {
						0: (raw) => raw as Fingerprint,
					},
					label: 'fingerprint sidecar',
				});
				fingerprint = persistedFingerprint ?? undefined;
				if (fingerprint) {
					log('info', 'loaded persisted fingerprint', { userId, fpPath });
				}
			} catch (err) {
				throw err instanceof Error
					? err
					: new Error(`Fingerprint sidecar failed for user "${userId}": ${String(err)}. Delete ${fpPath} to reset.`);
			}

			if (!fingerprint) {
				fingerprint = generateFingerprint(undefined, { operatingSystems });
				try {
					writeVersionedSidecar(fpPath, 1, fingerprint);
					log('info', 'generated new fingerprint and persisted it', { userId, fpPath, operatingSystems });
				} catch {
					log('warn', 'generated new fingerprint but failed to persist it', { userId, fpPath });
				}
			}

			const opts = await launchOptions({
				headless: effectiveHeadless,
				...(virtualDisplay ? { virtual_display: virtualDisplay.get() } : {}),
				os: launchOs,
				allow_webgl: CONFIG.fingerprint.allowWebgl,
				humanize: CONFIG.fingerprint.humanize,
				...(screen ? { screen } : {}),
				enable_cache: true,
				proxy: proxy ?? undefined,
				geoip: !!proxy,
				fingerprint,
			});

			const persistentOptions: PersistentContextOptions = {
				...(opts as unknown as PersistentContextOptions),
				...(contextOptions as unknown as BrowserContextOptions),
				acceptDownloads: true,
				downloadsPath: CONFIG.downloadsDir,
			};

			const context = await firefox.launchPersistentContext(profileDir, persistentOptions);
			log('info', 'persistent context launched', { userId, profileDir, virtualDisplay: !!virtualDisplay });
			return { context, virtualDisplay };
		} catch (err) {
			if (virtualDisplay) {
				try {
					virtualDisplay.kill();
				} catch {
				}
			}
			throw err;
		}
	}

	async restartContext(userId: string, headless?: boolean | 'virtual'): Promise<PoolEntry> {
		const normalized = String(userId);
		if (headless !== undefined) {
			this.headlessOverrides.set(normalized, headless);
		}

		const existing = this.pool.get(normalized);
		if (existing) {
			await this.closeContext(normalized);
		}

		return this.ensureContext(normalized);
	}

	private async evictIfNeeded(): Promise<void> {
		if (this.pool.size <= MAX_CONTEXTS) return;

		let lru: PoolEntry | null = null;
		for (const entry of this.pool.values()) {
			if (entry.launching || entry.staged) continue;
			if (!lru || entry.lastAccess < lru.lastAccess) lru = entry;
		}
		if (!lru) return;

		log('info', 'evicting persistent context (LRU)', { userId: lru.userId, profileDir: lru.profileDir });
		this.notifyEviction(lru.userId);
		await this.closeContext(lru.userId);
	}

	async ensureContext(
		userId: string,
		options?: BrowserContextOptions,
		staged = false,
		stagedGeneration?: string,
	): Promise<PoolEntry> {
		const normalized = String(userId);
		let entry = this.pool.get(normalized);
		const seed = pickSeedOptions(options);

		if (entry) {
			if (staged) {
				entry.staged = true;
				entry.stagedGeneration = stagedGeneration;
			}
			entry.lastAccess = Date.now();
			if (entry.launching) {
				entry.context = await entry.launching;
				entry.launching = undefined;
				entry.lastAccess = Date.now();
				return entry;
			}

			try {
				void entry.context.pages();
			} catch {
				this.pool.delete(normalized);
				entry = undefined;
			}
		}

		if (entry) {
			if (seedDiffers(entry.seedOptions, seed)) {
				log('warn', 'persistent context already exists; ignoring new context overrides', {
					userId: normalized,
					profileDir: entry.profileDir,
				});
			}
			entry.lastAccess = Date.now();
			return entry;
		}

		const profileDir = profileDirForUserId(normalized);
		const newEntry: PoolEntry = {
			context: null as unknown as BrowserContext,
			userId: normalized,
			profileDir,
			lastAccess: Date.now(),
			staged,
			stagedGeneration,
			seedOptions: seed,
		};

		newEntry.launching = this.launchPersistentContext(normalized, options)
			.then(({ context, virtualDisplay }) => {
				newEntry.context = context;
				newEntry.virtualDisplay = virtualDisplay;
				newEntry.launching = undefined;
				newEntry.lastAccess = Date.now();
				context.on('close', () => {
					this.cleanupVirtualDisplay(newEntry);
					log('info', 'persistent context closed', { userId: normalized, profileDir });
					this.pool.delete(normalized);
				});
				return context;
			})
			.catch((err) => {
				this.cleanupVirtualDisplay(newEntry);
				this.pool.delete(normalized);
				const message = err instanceof Error ? err.message : String(err);
				log('error', 'persistent context launch failed', { userId: normalized, profileDir, error: message });
				throw err;
			});

		this.pool.set(normalized, newEntry);
		await newEntry.launching;
		await this.evictIfNeeded();
		return newEntry;
	}

	async closeContext(userId: string): Promise<void> {
		const normalized = String(userId);
		const entry = this.pool.get(normalized);
		if (!entry || entry.staged) return;

		try {
			if (entry.launching) {
				await entry.launching.catch(() => {});
				entry.launching = undefined;
			}
			await entry.context?.close().catch(() => {});
		} finally {
			this.cleanupVirtualDisplay(entry);
			this.pool.delete(normalized);
			log('info', 'persistent context removed from pool', { userId: normalized, profileDir: entry.profileDir });
		}
	}

	async closeStagedContext(userId: string, generation?: string): Promise<void> {
		const normalized = String(userId);
		const entry = this.pool.get(normalized);
		if (!entry?.staged) return;
		if (generation && entry.stagedGeneration !== generation) return;
		entry.staged = false;
		entry.stagedGeneration = undefined;
		await this.closeContext(normalized);
	}

	async closeAll(): Promise<void> {
		const userIds = Array.from(this.pool.keys());
		for (const userId of userIds) {
			const entry = this.pool.get(userId);
			if (entry?.staged) {
				entry.staged = false;
				entry.stagedGeneration = undefined;
			}
			await this.closeContext(userId);
		}
	}
}

export const contextPool = new ContextPool();

export function getDisplayForUser(userId: string): string | null {
	return contextPool.getDisplayForUser(userId);
}
