import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { launchOptions } from 'camoufox-js';
import { firefox, type BrowserContext, type BrowserContextOptions } from 'playwright-core';

import { loadConfig } from '../utils/config';
import { log } from '../middleware/logging';

const CONFIG = loadConfig();

const MAX_CONTEXTS = Math.max(1, Number.parseInt(process.env.CAMOFOX_MAX_SESSIONS || '', 10) || 50);

type PersistentContextOptions = NonNullable<Parameters<typeof firefox.launchPersistentContext>[1]>;

export interface PoolEntry {
	context: BrowserContext;
	userId: string;
	profileDir: string;
	lastAccess: number;
	launching?: Promise<BrowserContext>;
	seedOptions?: Pick<BrowserContextOptions, 'locale' | 'timezoneId' | 'geolocation' | 'viewport'>;
}

function getHostOS(): 'macos' | 'windows' | 'linux' {
	const platform = os.platform();
	if (platform === 'darwin') return 'macos';
	if (platform === 'win32') return 'windows';
	return 'linux';
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

function profileDirForUserId(userId: string): string {
	// Avoid path traversal from untrusted route params.
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
	// Note: JSON.stringify is order-sensitive; this assumes deterministic key order for our simple, fixed-shape objects.
	const aj = JSON.stringify(a ?? null);
	const bj = JSON.stringify(b ?? null);
	return aj !== bj;
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

	size(): number {
		return this.pool.size;
	}

	listActiveUserIds(): string[] {
		return Array.from(this.pool.keys());
	}

	private async launchPersistentContext(userId: string, contextOptions?: BrowserContextOptions): Promise<BrowserContext> {
		const hostOS = getHostOS();
		const proxy = buildProxyConfig();
		const headless = this.headlessOverrides.get(userId) ?? CONFIG.headless;

		const profileDir = profileDirForUserId(userId);
		fs.mkdirSync(profileDir, { recursive: true });

		log('info', 'launching persistent context', { userId, hostOS, profileDir, geoip: !!proxy });

		const opts = await launchOptions({
			headless: headless as unknown as boolean,
			os: hostOS,
			humanize: true,
			enable_cache: true,
			proxy: proxy ?? undefined,
			geoip: !!proxy,
		});

		const persistentOptions: PersistentContextOptions = {
			...(opts as unknown as PersistentContextOptions),
			...(contextOptions as unknown as BrowserContextOptions),
			acceptDownloads: true,
			downloadsPath: CONFIG.downloadsDir,
		};

		const context = await firefox.launchPersistentContext(profileDir, persistentOptions);
		log('info', 'persistent context launched', { userId, profileDir });
		return context;
	}

	async restartContext(userId: string, headless?: boolean | 'virtual'): Promise<PoolEntry> {
		const normalized = String(userId);
		if (headless !== undefined) {
			this.headlessOverrides.set(normalized, headless);
		}

		const existing = this.pool.get(normalized);
		if (existing) {
			try {
				if (existing.launching) {
					await existing.launching.catch(() => {});
					existing.launching = undefined;
				}
				await existing.context?.close();
			} catch {
				// ignore close errors
			}
			this.pool.delete(normalized);
		}

		return this.ensureContext(normalized);
	}

	private async evictIfNeeded(): Promise<void> {
		if (this.pool.size <= MAX_CONTEXTS) return;

		let lru: PoolEntry | null = null;
		for (const entry of this.pool.values()) {
			if (entry.launching) continue;
			if (!lru || entry.lastAccess < lru.lastAccess) lru = entry;
		}
		if (!lru) return;

		log('info', 'evicting persistent context (LRU)', { userId: lru.userId, profileDir: lru.profileDir });
		this.notifyEviction(lru.userId);
		await this.closeContext(lru.userId);
	}

	async ensureContext(userId: string, options?: BrowserContextOptions): Promise<PoolEntry> {
		const normalized = String(userId);
		let entry = this.pool.get(normalized);
		const seed = pickSeedOptions(options);

		if (entry) {
			entry.lastAccess = Date.now();
			if (entry.launching) {
				entry.context = await entry.launching;
				entry.launching = undefined;
				entry.lastAccess = Date.now();
				return entry;
			}

			// If context died unexpectedly, remove and relaunch.
			try {
				// A cheap call that throws if the context is closed.
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
			seedOptions: seed,
		};

		newEntry.launching = this.launchPersistentContext(normalized, options)
			.then((ctx) => {
				newEntry.context = ctx;
				newEntry.launching = undefined;
				newEntry.lastAccess = Date.now();
				ctx.on('close', () => {
					log('info', 'persistent context closed', { userId: normalized, profileDir });
					this.pool.delete(normalized);
				});
				return ctx;
			})
			.catch((err) => {
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
		if (!entry) return;

		try {
			if (entry.launching) {
				await entry.launching.catch(() => {});
				entry.launching = undefined;
			}
			await entry.context?.close().catch(() => {});
		} finally {
			this.pool.delete(normalized);
			log('info', 'persistent context removed from pool', { userId: normalized, profileDir: entry.profileDir });
		}
	}

	async closeAll(): Promise<void> {
		const userIds = Array.from(this.pool.keys());
		for (const userId of userIds) {
			await this.closeContext(userId);
		}
	}
}

export const contextPool = new ContextPool();
