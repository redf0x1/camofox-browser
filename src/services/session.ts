import type { BrowserContextOptions } from 'playwright-core';

import type { ContextOverrides, SessionData, TabState } from '../types';
import { log } from '../middleware/logging';
import { clearTabLock, clearAllTabLocks } from './tab';
import { loadConfig } from '../utils/config';
import type { ResolvedContextOptions } from '../utils/presets';
import { contextHash } from '../utils/presets';
import { contextPool } from './context-pool';
import { cleanupUserDownloads } from './download';
import { decrementActiveOps, incrementActiveOps } from './health';
import { stopVnc } from './vnc';
import { cleanupTracing } from './tracing';

const CONFIG = loadConfig();

// userId -> { context, tabGroups: Map<sessionKey, Map<tabId, TabState>>, lastAccess }
// Note: sessionKey was previously called listItemId - both are accepted for backward compatibility
const sessions = new Map<string, SessionData>();

// sessionKey -> in-flight session creation promise
// Avoids storing partially-initialized sessions (e.g., context: null cast) and dedupes concurrent creates.
const launchingSessions = new Map<string, Promise<SessionData>>();

// tabId -> sessions map key
// Persistent profiles are keyed only by userId, while tab endpoints only get tabId.
const tabSessionIndex = new Map<string, string>();

export interface CanonicalProfile {
	resolvedOverrides: ResolvedContextOptions | null;
	hash: string;
	establishedAt: number;
}

// Canonical per-user profile: stores resolved overrides from the first core POST /tabs.
// Survives passive context eviction; cleared only on explicit session close/cleanup.
const canonicalProfiles = new Map<string, CanonicalProfile>();

// Per-user establishment lock to serialize first-profile creation.
const profileEstablishmentLocks = new Map<string, Promise<CanonicalProfile>>();

const userConcurrency = new Map<string, { active: number; queue: Array<() => void> }>();

export function __getUserConcurrencyStateForTests(userId: string): { active: number; queueLength: number } | null {
	const key = String(userId).toLowerCase().trim();
	const state = userConcurrency.get(key);
	if (!state) return null;
	return { active: state.active, queueLength: state.queue.length };
}

export async function withUserLimit<T>(
	userId: string,
	maxConcurrent: number,
	operation: () => Promise<T>,
	operationTimeoutMs?: number,
): Promise<T> {
	const key = String(userId).toLowerCase().trim();
	let state = userConcurrency.get(key);
	if (!state) {
		state = { active: 0, queue: [] };
		userConcurrency.set(key, state);
	}

	if (state.active >= maxConcurrent) {
		await new Promise<void>((resolve, reject) => {
			const callback = (): void => {
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				const idx = state!.queue.indexOf(callback);
				if (idx !== -1) state!.queue.splice(idx, 1);
				reject(new Error('User concurrency limit reached, try again'));
			}, 30000);
			state!.queue.push(callback);
		});
	}

	state.active++;
	incrementActiveOps();
	try {
		if (typeof operationTimeoutMs === 'number' && Number.isFinite(operationTimeoutMs) && operationTimeoutMs > 0) {
			let operationTimer: NodeJS.Timeout | undefined;
			return await Promise.race<T>([
				operation(),
				new Promise<T>((_resolve, reject) => {
					operationTimer = setTimeout(() => reject(new Error('User operation timed out')), operationTimeoutMs);
				}),
			]).finally(() => {
				if (operationTimer) clearTimeout(operationTimer);
			});
		}

		return await operation();
	} finally {
		decrementActiveOps();
		state.active--;
		if (state.queue.length > 0) {
			const next = state.queue.shift()!;
			next();
		}
		if (state.active === 0 && state.queue.length === 0) {
			userConcurrency.delete(key);
		}
	}
}

function cleanupSessionsForUserId(userId: string, reason: string, clearCanonical = true): void {
	const key = normalizeUserId(userId);
	// If a session is currently being created, drop our reference so callers don't keep a stale placeholder.
	launchingSessions.delete(key);
	void stopVnc(key).catch(() => {});

	try {
		cleanupUserDownloads(key);
	} catch {
		// ignore cleanup errors
	}

	cleanupTracing(key);

	const session = sessions.get(key);
	if (session) {
		unindexSessionTabs(session);
		sessions.delete(key);
		log('info', 'session cleaned up', { userId: key, reason });
	}

	if (clearCanonical) {
		canonicalProfiles.delete(key);
		profileEstablishmentLocks.delete(key);
	}

	userConcurrency.delete(key);
}

contextPool.onEvict((userId) => {
	cleanupSessionsForUserId(userId, 'context_evicted', false);
	// Note: the pool will close the context; session cleanup only removes dead Page references.
});

export const SESSION_TIMEOUT_MS = CONFIG.sessionTimeoutMs;
export const MAX_SESSIONS = CONFIG.maxSessions;
export const MAX_TABS_PER_SESSION = CONFIG.maxTabsPerSession;

export function normalizeUserId(userId: unknown): string {
	return String(userId);
}

export function getSessionMapKey(userId: unknown, contextOverrides: ContextOverrides | null | undefined): string {
	// Persistent profiles are keyed only by userId; overrides are applied on first launch.
	void contextOverrides;
	return normalizeUserId(userId);
}

export function getCanonicalProfile(userId: unknown): CanonicalProfile | undefined {
	return canonicalProfiles.get(normalizeUserId(userId));
}

export function hasCanonicalProfile(userId: unknown): boolean {
	return canonicalProfiles.has(normalizeUserId(userId));
}

export async function establishCanonicalProfile(
	userId: unknown,
	resolved: ResolvedContextOptions | null,
): Promise<CanonicalProfile> {
	const key = normalizeUserId(userId);
	const existing = canonicalProfiles.get(key);
	if (existing) return existing;

	const pending = profileEstablishmentLocks.get(key);
	if (pending) return pending;

	const promise = (async (): Promise<CanonicalProfile> => {
		const recheck = canonicalProfiles.get(key);
		if (recheck) return recheck;

		const profile: CanonicalProfile = {
			resolvedOverrides: resolved,
			hash: contextHash(resolved),
			establishedAt: Date.now(),
		};
		canonicalProfiles.set(key, profile);
		log('info', 'canonical profile established', { userId: key, hash: profile.hash });
		return profile;
	})();

	profileEstablishmentLocks.set(key, promise);
	try {
		return await promise;
	} finally {
		profileEstablishmentLocks.delete(key);
	}
}

export function clearCanonicalProfile(userId: unknown): void {
	const key = normalizeUserId(userId);
	canonicalProfiles.delete(key);
	profileEstablishmentLocks.delete(key);
}

export function getSessionsForUser(userId: unknown): Array<[string, SessionData]> {
	if (userId === undefined || userId === null) return [];
	const key = normalizeUserId(userId);
	const session = sessions.get(key);
	return session ? [[key, session]] : [];
}

export function getAllSessions(): Map<string, SessionData> {
	return sessions;
}

export function countTotalTabsForSessions(sessionsForUser?: Array<[string, SessionData]>): number {
	let totalTabs = 0;
	const iter = sessionsForUser ?? Array.from(sessions.entries());
	for (const [, session] of iter) {
		for (const group of session.tabGroups.values()) totalTabs += group.size;
	}
	return totalTabs;
}

export function getTabGroup(session: SessionData, sessionKey: string): Map<string, TabState> {
	let group = session.tabGroups.get(sessionKey);
	if (!group) {
		group = new Map();
		session.tabGroups.set(sessionKey, group);
	}
	return group;
}

function findTab(session: SessionData, tabId: string): { tabState: TabState; listItemId: string; group: Map<string, TabState> } | null {
	for (const [listItemId, group] of session.tabGroups) {
		if (group.has(tabId)) {
			const tabState = group.get(tabId);
			if (!tabState) continue;
			return { tabState, listItemId, group };
		}
	}
	return null;
}

export function unindexSessionTabs(session: SessionData): void {
	if (!session) return;
	for (const [, group] of session.tabGroups) {
		for (const tabId of group.keys()) {
			tabSessionIndex.delete(tabId);
			clearTabLock(tabId);
		}
	}
}

export function findTabById(
	tabId: string,
	userId: unknown,
):
	| (ReturnType<typeof findTab> & {
			sessionKey: string;
			session: SessionData;
		})
	| null {
	if (userId === undefined || userId === null) return null;
	const key = normalizeUserId(userId);

	const indexedKey = tabSessionIndex.get(tabId);
	if (indexedKey) {
		if (indexedKey !== key) {
			return null;
		}

		const session = sessions.get(indexedKey);
		if (session) {
			const found = findTab(session, tabId);
			if (found) return { sessionKey: indexedKey, session, ...found };
		}

		tabSessionIndex.delete(tabId);
	}

	const session = sessions.get(key);
	if (!session) return null;

	const found = findTab(session, tabId);
	if (found) {
		tabSessionIndex.set(tabId, key);
		return { sessionKey: key, session, ...found };
	}

	return null;
}

export async function getSession(userId: unknown, contextOverrides?: ContextOverrides | null): Promise<SessionData> {
	const key = getSessionMapKey(userId, contextOverrides);
	let session = sessions.get(key);

	const resolved = contextOverrides || {};

	const contextOptions: BrowserContextOptions = {
		viewport: resolved.viewport || { width: 1280, height: 720 },
		permissions: ['geolocation'],
	};

	const hasOverrides = !!(
		contextOverrides &&
		(contextOverrides.locale !== undefined || contextOverrides.timezoneId !== undefined || contextOverrides.geolocation !== undefined)
	);

	// With proxy+geoip, camoufox auto-configures locale/timezone/geo from proxy IP.
	// If caller explicitly supplies overrides, apply them even when proxy is active.
	if (!CONFIG.proxy.host || hasOverrides) {
		contextOptions.locale = resolved.locale || 'en-US';
		contextOptions.timezoneId = resolved.timezoneId || 'America/Los_Angeles';
		contextOptions.geolocation = resolved.geolocation || { latitude: 37.7749, longitude: -122.4194 };
	}

	if (!session) {
		const existingLaunch = launchingSessions.get(key);
		if (existingLaunch) {
			session = await existingLaunch;
			session.lastAccess = Date.now();
			return session;
		}

		if (sessions.size + launchingSessions.size >= MAX_SESSIONS) {
			throw new Error('Maximum concurrent sessions reached');
		}

		const launchPromise = (async (): Promise<SessionData> => {
			const entry = await contextPool.ensureContext(normalizeUserId(userId), contextOptions);
			const created: SessionData = { context: entry.context, tabGroups: new Map(), lastAccess: Date.now() };
			sessions.set(key, created);
			log('info', 'session created', { userId: key });
			return created;
		})();

		launchingSessions.set(key, launchPromise);
		try {
			session = await launchPromise;
		} finally {
			launchingSessions.delete(key);
		}
	} else {
		// Re-resolve context on each access; ContextPool de-dupes launches and detects unexpected closes.
		const entry = await contextPool.ensureContext(normalizeUserId(userId), contextOptions);
		session.context = entry.context;
		session.lastAccess = Date.now();
	}

	// For newly created sessions, lastAccess/context are already set.
	session.lastAccess = Date.now();
	return session;
}

export function indexTab(tabId: string, sessionKey: string): void {
	tabSessionIndex.set(tabId, sessionKey);
}

export function unindexTab(tabId: string): void {
	tabSessionIndex.delete(tabId);
	clearTabLock(tabId);
}

export function clearAllState(): void {
	sessions.clear();
	tabSessionIndex.clear();
	canonicalProfiles.clear();
	profileEstablishmentLocks.clear();
	clearAllTabLocks();
	userConcurrency.clear();
}

export async function closeSessionsForUser(userId: string): Promise<void> {
	const key = normalizeUserId(userId);
	await contextPool.closeContext(key).catch(() => {});
	cleanupSessionsForUserId(key, 'explicit_close');
}

export async function closeAllSessions(): Promise<void> {
	await contextPool.closeAll().catch(() => {});
	for (const [userId, session] of sessions) {
		void stopVnc(userId).catch(() => {});
		unindexSessionTabs(session);
		sessions.delete(userId);
		cleanupTracing(userId);
		try {
			cleanupUserDownloads(userId);
		} catch {
			// ignore
		}
	}
	launchingSessions.clear();
	canonicalProfiles.clear();
	profileEstablishmentLocks.clear();
}

let cleanupInterval: NodeJS.Timeout | null = null;

export function startCleanupInterval(): NodeJS.Timeout {
	if (cleanupInterval) return cleanupInterval;
	cleanupInterval = setInterval(() => {
		const now = Date.now();
		for (const [sessionKey, session] of sessions) {
			if (now - session.lastAccess > SESSION_TIMEOUT_MS) {
				// Persistent profile is preserved on disk; closing the context frees resources.
				contextPool.closeContext(sessionKey).catch(() => {});
				unindexSessionTabs(session);
				sessions.delete(sessionKey);
				cleanupTracing(sessionKey);
				log('info', 'session expired', { userId: sessionKey });
			}
		}
	}, 60_000);
	return cleanupInterval;
}

export function stopCleanupInterval(): void {
	if (cleanupInterval) {
		clearInterval(cleanupInterval);
		cleanupInterval = null;
	}
}
