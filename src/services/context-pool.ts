import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { type ChildProcess, spawn } from 'node:child_process';
import { type Readable } from 'node:stream';

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
import type { ResolvedProxyConfig } from '../types';

const CONFIG = loadConfig();

const MAX_CONTEXTS = CONFIG.maxSessions;

type PersistentContextOptions = NonNullable<Parameters<typeof firefox.launchPersistentContext>[1]>;

export interface PoolEntry {
	context: BrowserContext;
	userId: string;
	profileKey: string;
	profileDir: string;
	lastAccess: number;
	createdAt: number;  // Timestamp when this entry was created
	launching?: Promise<BrowserContext>;
	staged?: boolean;
	stagedGeneration?: string;
	virtualDisplay?: any;
	proxyConfig?: ResolvedProxyConfig | null;
	seedOptions?: Pick<BrowserContextOptions, 'locale' | 'timezoneId' | 'geolocation' | 'viewport'>;
}

function getHostOS(): 'macos' | 'windows' | 'linux' {
	const platform = os.platform();
	if (platform === 'darwin') return 'macos';
	if (platform === 'win32') return 'windows';
	return 'linux';
}

function buildProxyConfig(proxy?: ResolvedProxyConfig | null): { server: string; username?: string; password?: string } | null {
	if (!proxy) {
		// Fallback to configured server proxy
		const { host, port, username, password } = CONFIG.proxy;
		if (!host || !port) return null;
		return {
			server: `http://${host}:${port}`,
			username: username || undefined,
			password: password || undefined,
		};
	}
	return {
		server: proxy.server,
		username: proxy.username,
		password: proxy.password,
	};
}

function getInstalledCamoufoxVersion(): string {
	try {
		return installedVerStr();
	} catch {
		return 'unknown';
	}
}

function decodeDefaultProfileUserId(profileKey: string): string | null {
	if (!profileKey.startsWith('u:') || profileKey.indexOf(':', 2) !== -1) return null;
	try {
		const encoded = profileKey.slice(2);
		const bytes = Buffer.from(encoded, 'base64url');
		if (bytes.length % 2 !== 0) return null;
		const decoded = bytes.toString('utf16le');
		if (/^(?:u|s|p|o):/.test(decoded)) return null;
		for (let i = 0; i < decoded.length; i += 1) {
			const code = decoded.charCodeAt(i);
			if (code >= 0xd800 && code <= 0xdbff) {
				if (i + 1 >= decoded.length) return null;
				const next = decoded.charCodeAt(i + 1);
				if (next < 0xdc00 || next > 0xdfff) return null;
				i += 1;
			} else if (code >= 0xdc00 && code <= 0xdfff) {
				return null;
			}
		}
		return `u:${Buffer.from(decoded, 'utf16le').toString('base64url')}` === profileKey ? decoded : null;
	} catch {
		return null;
	}
}

function profileDirForProfileKey(profileKey: string): string {
	// Avoid path traversal from untrusted route params.
	const defaultUserId = decodeDefaultProfileUserId(String(profileKey));
	const safe = encodeURIComponent(defaultUserId ?? String(profileKey));
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

function hasUsableLinuxDisplay(): boolean {
	const display = process.env.DISPLAY;
	if (!display) return false;

	const match = /^:([0-9]+)(?:\.[0-9]+)?$/.exec(display);
	if (!match) return true;

	const lockFile = `/tmp/.X${match[1]}-lock`;
	return fs.existsSync(lockFile);
}

async function spawnXvfb(resolution: string = '1920x1080x24'): Promise<{ display: string; process: ChildProcess }> {
	// Use -displayfd so Xvfb itself picks a free display number atomically.
	// This avoids the userspace race condition where multiple concurrent
	// spawnXvfb() calls all see the same absence of a lock file and pick
	// the same display number — only the first to create the lock succeeds,
	// the others exit with code 1.
	//
	// Xvfb writes "<display>\n" to fd 3 (e.g. "99\n"), which we read to
	// determine the assigned display. This is the same approach used by
	// camoufox-js's VirtualDisplay class (apify/camoufox-js#273).
	//
	// The fd3 output is line-delimited. We buffer until a newline is
	// received and parse the complete record, rather than matching
	// digits greedily — chunked writes could deliver a partial number
	// (e.g. "9" then "9\n") that would be accepted prematurely.
	const xvfbProcess = spawn('Xvfb', [
		'-displayfd', '3',
		'-screen', '0', resolution,
		'-ac', '-nolisten', 'tcp',
	], {
		stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
	});

	// Idempotent child cleanup — safe to call multiple times from any
	// error path (timeout, spawn error, fd3 error/close).
	// SIGTERM first, then SIGKILL after 3s if still alive.
	// When the child has already exited (childExited=true), cleanupChild()
	// is a no-op — no SIGTERM to a dead process, no new escalation timer.
	let childCleaned = false;
	let childExited = false;
	let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
	const cleanupChild = () => {
		if (childCleaned) return;
		childCleaned = true;
		if (childExited) return;
		try {
			xvfbProcess.kill('SIGTERM');
		} catch {
			// already dead
		}
		sigkillTimer = setTimeout(() => {
			sigkillTimer = null;
			try {
				xvfbProcess.kill('SIGKILL');
			} catch {
				// already dead
			}
		}, 3000);
		sigkillTimer.unref();
	};

	// Mark child as exited and cancel any pending SIGKILL escalation timer.
	// Called from the exit handler and the error handler (error often
	// precedes or accompanies exit). After this, cleanupChild() will not
	// send signals to the already-dead process.
	const onChildExit = () => {
		childExited = true;
		if (sigkillTimer) {
			clearTimeout(sigkillTimer);
			sigkillTimer = null;
		}
	};

	const display = await new Promise<string>((resolve, reject) => {
		let settled = false;
		const finalize = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			fn();
		};

		const timeout = setTimeout(() => {
			cleanupChild();
			finalize(() => reject(new Error('Xvfb start timeout')));
		}, 5000);

		const fd3 = xvfbProcess.stdio[3] as Readable;
		let buf = '';

		fd3.on('data', (chunk: Buffer | string) => {
			buf += chunk.toString();
			// Process ALL complete newline-delimited records currently in
			// the buffer. A single data event may contain multiple records
			// (e.g. "\n44\n" or "invalid\n44\n"). We loop through each
			// complete record, skip malformed/blank lines, and resolve on
			// the first valid display number. Any remaining incomplete data
			// stays in buf for the next data event.
			for (;;) {
				const newlineIdx = buf.indexOf('\n');
				if (newlineIdx === -1) break;
				const line = buf.slice(0, newlineIdx).trim();
				buf = buf.slice(newlineIdx + 1);
				// Skip blank or malformed records — Xvfb may emit leading
				// newlines or debug output before the display number.
				const match = line.match(/^(\d+)$/);
				if (match) {
					finalize(() => resolve(`:${match[1]}`));
					return;
				}
			}
		});

		xvfbProcess.once('error', (err) => {
			cleanupChild();
			onChildExit();
			finalize(() => reject(err));
		});

		xvfbProcess.once('exit', (code, signal) => {
			onChildExit();
			finalize(() => reject(new Error(`Xvfb exited early (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)));
		});

		// fd3 may close before data arrives (e.g. Xvfb exits immediately).
		fd3.once('end', () => {
			if (!settled) {
				cleanupChild();
				finalize(() => reject(new Error('Xvfb fd3 closed before writing display number')));
			}
		});

		// fd3 stream error — route through the same finalizer to avoid
		// unhandled stream errors. Guard with `!settled` so that a late
		// fd3 error after successful startup does not terminate a healthy
		// Xvfb child (same guard as the end/close handlers).
		fd3.once('error', (err) => {
			if (!settled) {
				cleanupChild();
				finalize(() => reject(new Error(`Xvfb fd3 stream error: ${err instanceof Error ? err.message : String(err)}`)));
			}
		});

		// fd3 closed without end event — the pipe is fully destroyed.
		// Reject immediately rather than waiting for the 5s timeout.
		fd3.once('close', () => {
			if (!settled) {
				cleanupChild();
				finalize(() => reject(new Error('Xvfb fd3 stream closed before writing display number')));
			}
		});
	});

	return { display, process: xvfbProcess };
}

// Test-only export of spawnXvfb for unit testing the fd3 parser and
// child cleanup logic without a real Xvfb binary. Not part of the
// public API; consumed by tests/unit/spawn-xvfb-displayfd.test.js.
export const spawnXvfbForTests = spawnXvfb;

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

	getEntry(profileKey: string): PoolEntry | undefined {
		return this.pool.get(profileKey);
	}

	getDisplayForUser(userId: string): string | null {
		// Find any entry for this userId (there may be multiple with different profile keys)
		for (const entry of this.pool.values()) {
			if (entry.userId !== String(userId)) continue;

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
		return null;
	}

	size(): number {
		return this.pool.size;
	}

	listActiveUserIds(): string[] {
		const userIds = new Set<string>();
		for (const entry of this.pool.values()) {
			if (!entry.staged) {
				userIds.add(entry.userId);
			}
		}
		return Array.from(userIds);
	}

	getLifecycleSnapshot(): { liveContexts: number; launchingContexts: number; stagedContexts: number } {
		let launchingContexts = 0;
		let stagedContexts = 0;
		for (const entry of this.pool.values()) {
			if (entry.launching) launchingContexts++;
			if (entry.staged) stagedContexts++;
		}
		return {
			liveContexts: this.pool.size,
			launchingContexts,
			stagedContexts,
		};
	}

	getPoolEntries(): Map<string, PoolEntry> {
		return new Map(this.pool);
	}

	private cleanupVirtualDisplay(entry: PoolEntry): void {
		if (!entry.virtualDisplay) return;
		try {
			entry.virtualDisplay.kill();
		} catch {
			// ignore cleanup errors
		} finally {
			entry.virtualDisplay = undefined;
		}
	}

	private async launchPersistentContext(
		userId: string,
		profileKey: string,
		contextOptions?: BrowserContextOptions,
		resolvedProxy?: ResolvedProxyConfig | null,
	): Promise<{ context: BrowserContext; virtualDisplay?: any }> {
		const hostOS = getHostOS();
		const proxy = buildProxyConfig(resolvedProxy);
		const headless = this.headlessOverrides.get(userId) ?? CONFIG.headless;

		const profileDir = profileDirForProfileKey(profileKey);
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
						// ignore cleanup errors
					}
					setTimeout(() => {
						try {
							xvfb.process.kill('SIGKILL');
						} catch {
							// ignore cleanup errors
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
			profileDir,
			geoip: !!proxy,
			headless,
			effectiveHeadless,
			virtualDisplay: !!virtualDisplay,
		});

		try {
			const fpPath = path.join(profileDir, 'fingerprint.json');
			let fingerprint: Fingerprint | undefined;

			const configuredOs = CONFIG.fingerprintDefaults.os;
			const fingerprintOperatingSystems = Array.isArray(configuredOs)
				? configuredOs
				: configuredOs
					? [configuredOs]
					: [hostOS];

			const configuredScreen = CONFIG.fingerprintDefaults.screen;
			const fingerprintScreen = configuredScreen
				? {
						minWidth: configuredScreen.width,
						maxWidth: configuredScreen.width,
						minHeight: configuredScreen.height,
						maxHeight: configuredScreen.height,
					}
				: undefined;

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
				fingerprint = generateFingerprint(undefined, {
					operatingSystems: fingerprintOperatingSystems,
					...(fingerprintScreen ? { screen: fingerprintScreen } : {}),
				});
				try {
					writeVersionedSidecar(fpPath, 1, fingerprint);
					log('info', 'generated new fingerprint and persisted it', { userId, fpPath });
				} catch {
					log('warn', 'generated new fingerprint but failed to persist it', { userId, fpPath });
				}
			}

			const opts = await launchOptions({
				headless: effectiveHeadless,
				...(virtualDisplay ? { virtual_display: virtualDisplay.get() } : {}),
				os: configuredOs ?? hostOS,
				humanize: CONFIG.fingerprintDefaults.humanize ?? true,
				...(CONFIG.fingerprintDefaults.allowWebgl !== undefined
					? { allow_webgl: CONFIG.fingerprintDefaults.allowWebgl }
					: {}),
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
					// ignore cleanup errors
				}
			}
			throw err;
		}
	}

	async restartContext(
		userId: string,
		headless?: boolean | 'virtual',
		profileKey?: string,
		options?: BrowserContextOptions,
		resolvedProxy?: ResolvedProxyConfig | null,
	): Promise<PoolEntry> {
		const normalized = String(userId);
		const targetProfileKey = profileKey ?? normalized;
		if (headless !== undefined) {
			this.headlessOverrides.set(normalized, headless);
		}

		// Close all contexts for this userId (there may be multiple with different profiles)
		const entriesToClose: string[] = [];
		for (const [profileKey, entry] of this.pool.entries()) {
			if (entry.userId === normalized) {
				entriesToClose.push(profileKey);
			}
		}
		for (const profileKey of entriesToClose) {
			await this.closeContext(profileKey);
		}

		// Return a new entry with the caller's runtime profile key.
		return this.ensureContext(targetProfileKey, normalized, options, resolvedProxy);
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
		this.notifyEviction(lru.profileKey);
		await this.closeContext(lru.profileKey);
	}

	async ensureContext(
		profileKey: string,
		userId: string,
		options?: BrowserContextOptions,
		resolvedProxy?: ResolvedProxyConfig | null,
		staged = false,
		stagedGeneration?: string,
	): Promise<PoolEntry> {
		const normalized = String(userId);
		let entry = this.pool.get(profileKey);
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

			// If context died unexpectedly, remove and relaunch.
			try {
				// A cheap call that throws if the context is closed.
				void entry.context.pages();
			} catch {
				this.pool.delete(profileKey);
				entry = undefined;
			}
		}

		if (entry) {
			if (seedDiffers(entry.seedOptions, seed)) {
				log('warn', 'persistent context already exists; ignoring new context overrides', {
					userId: normalized,
					profileKey,
					profileDir: entry.profileDir,
				});
			}
			entry.lastAccess = Date.now();
			return entry;
		}

		const profileDir = profileDirForProfileKey(profileKey);
		const newEntry: PoolEntry = {
			context: null as unknown as BrowserContext,
			userId: normalized,
			profileKey,
			profileDir,
			lastAccess: Date.now(),
			createdAt: Date.now(),
			staged,
			stagedGeneration,
			proxyConfig: resolvedProxy || null,
			seedOptions: seed,
		};

		newEntry.launching = this.launchPersistentContext(normalized, profileKey, options, resolvedProxy)
			.then(({ context, virtualDisplay }) => {
				newEntry.context = context;
				newEntry.virtualDisplay = virtualDisplay;
				newEntry.launching = undefined;
				newEntry.lastAccess = Date.now();
				context.on('close', () => {
					this.cleanupVirtualDisplay(newEntry);
					log('info', 'persistent context closed', { userId: normalized, profileKey, profileDir });
					this.pool.delete(profileKey);
				});
				return context;
			})
			.catch((err) => {
				this.cleanupVirtualDisplay(newEntry);
				this.pool.delete(profileKey);
				const message = err instanceof Error ? err.message : String(err);
				log('error', 'persistent context launch failed', { userId: normalized, profileKey, profileDir, error: message });
				throw err;
			});

		this.pool.set(profileKey, newEntry);
		await newEntry.launching;
		await this.evictIfNeeded();
		return newEntry;
	}

	async closeContext(profileKey: string): Promise<void> {
		const normalized = String(profileKey);
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
			// Only delete if this entry is still in the pool (avoid deleting a newer entry with same key)
			const currentEntry = this.pool.get(normalized);
			if (currentEntry === entry) {
				this.pool.delete(normalized);
				log('info', 'persistent context removed from pool', { userId: entry.userId, profileKey: normalized, profileDir: entry.profileDir });
			} else {
				log('info', 'persistent context closed but newer entry exists', { userId: entry.userId, profileKey: normalized, profileDir: entry.profileDir });
			}
		}
	}

	async closeContextIfMatches(profileKey: string, expectedCreatedAt: number, expectedLastAccess?: number): Promise<void> {
		const normalized = String(profileKey);
		const entry = this.pool.get(normalized);
		if (!entry) return;
		if (entry.createdAt !== expectedCreatedAt) return;
		// If lastAccess was provided and has changed, the context was reused - don't close
		if (expectedLastAccess !== undefined && entry.lastAccess !== expectedLastAccess) return;
		await this.closeContext(normalized);
	}

	setHeadlessOverride(userId: string, headless: boolean | 'virtual'): void {
		this.headlessOverrides.set(String(userId), headless);
	}

	async closeStagedContext(profileKey: string, generation?: string): Promise<void> {
		const normalized = String(profileKey);
		const entry = this.pool.get(normalized);
		if (!entry?.staged) return;
		if (generation && entry.stagedGeneration !== generation) return;
		entry.staged = false;
		entry.stagedGeneration = undefined;
		await this.closeContext(normalized);
	}

	async closeContextByUserId(userId: string): Promise<void> {
		const normalized = String(userId);
		// Close all contexts for this userId
		const entriesToClose: string[] = [];
		for (const [profileKey, entry] of this.pool.entries()) {
			if (entry.userId === normalized && !entry.staged) {
				entriesToClose.push(profileKey);
			}
		}
		for (const profileKey of entriesToClose) {
			await this.closeContext(profileKey);
		}
	}

	async closeStagedContextByUserId(userId: string, generation?: string): Promise<void> {
		const normalized = String(userId);
		// Close all staged contexts for this userId
		const entriesToClose: string[] = [];
		for (const [profileKey, entry] of this.pool.entries()) {
			if (entry.userId === normalized && entry.staged) {
				if (!generation || entry.stagedGeneration === generation) {
					entriesToClose.push(profileKey);
				}
			}
		}
		for (const profileKey of entriesToClose) {
			await this.closeStagedContext(profileKey, generation);
		}
	}

	async closeAll(): Promise<void> {
		const profileKeys = Array.from(this.pool.keys());
		for (const profileKey of profileKeys) {
			const entry = this.pool.get(profileKey);
			if (entry?.staged) {
				entry.staged = false;
				entry.stagedGeneration = undefined;
			}
			await this.closeContext(profileKey);
		}
	}
}

export const contextPool = new ContextPool();

export function getDisplayForUser(userId: string): string | null {
	return contextPool.getDisplayForUser(userId);
}
