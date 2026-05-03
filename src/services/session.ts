import crypto from 'node:crypto';
import type { BrowserContextOptions } from 'playwright-core';

import type { ContextOverrides, ResolvedSessionProfile, SessionData, TabState } from '../types';
import { log } from '../middleware/logging';
import { clearTabLock, clearAllTabLocks } from './tab';
import { loadConfig } from '../utils/config';
import type { ResolvedContextOptions } from '../utils/presets';
import { contextHash } from '../utils/presets';
import { contextPool, type PoolEntry } from './context-pool';
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

export interface EstablishedSessionProfile {
	userId: string;
	sessionKey: string;
	signature: string;
	resolvedProfile: ResolvedSessionProfile;
	establishedAt: number;
}

// Canonical per-user profile: stores resolved overrides from the first core POST /tabs.
// Survives passive context eviction; cleared only on explicit session close/cleanup.
const canonicalProfiles = new Map<string, CanonicalProfile>();

// Session profiles keyed by userId::sessionKey to track separate proxy/geo profiles per session
const sessionProfiles = new Map<string, EstablishedSessionProfile>();

// Per-user mutex covering the entire first-create lifecycle (establishment -> tab commit).
// Prevents sibling requests from observing provisional canonical state.
const firstCreateMutexes = new Map<string, { promise: Promise<boolean>; resolve: (committed: boolean) => void }>();

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
		const mutex = firstCreateMutexes.get(key);
		if (mutex) {
			mutex.resolve(false);
			firstCreateMutexes.delete(key);
		}
		// Also clear all session profiles for this user
		const profileKeysToDelete: string[] = [];
		for (const [profileKey, profile] of sessionProfiles.entries()) {
			if (profile.userId === key) {
				profileKeysToDelete.push(profileKey);
			}
		}
		for (const profileKey of profileKeysToDelete) {
			sessionProfiles.delete(profileKey);
		}
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

function sessionOverlayKey(userId: unknown, sessionKey: string): string {
	return `${normalizeUserId(userId)}::${sessionKey}`;
}

// Backward compatible version - takes contextOverrides instead of session profile  
export function getSessionMapKey(userId: unknown, contextOverridesOrSessionKey: ContextOverrides | null | undefined | string, profileSignature?: string): string {
	// New signature: (userId, sessionKey, profileSignature)
	if (typeof contextOverridesOrSessionKey === 'string') {
		const sessionKey = contextOverridesOrSessionKey;
		if (profileSignature) {
			return `${normalizeUserId(userId)}::${sessionKey}::${profileSignature}`;
		}
		return `${normalizeUserId(userId)}::${sessionKey}`;
	}
	// Old signature: (userId, contextOverrides) - backward compatibility
	// This maintains the user-scoped behavior for existing routes
	void contextOverridesOrSessionKey;
	return normalizeUserId(userId);
}

export function getEstablishedSessionProfile(userId: unknown, sessionKey: string): EstablishedSessionProfile | undefined {
	return sessionProfiles.get(sessionOverlayKey(userId, sessionKey));
}

export function getCanonicalProfile(userId: unknown): CanonicalProfile | undefined {
	return canonicalProfiles.get(normalizeUserId(userId));
}

export function hasCanonicalProfile(userId: unknown): boolean {
	return canonicalProfiles.has(normalizeUserId(userId));
}


/**
 * Try to acquire the first-create mutex for a user.
 * Returns { acquired: true } if we are the first creator (mutex acquired).
 * Returns { acquired: false, wait: Promise<boolean> } if another request is first-creating.
 * The promise resolves to true (committed) or false (rolled back).
 * If canonical already exists (committed), returns { acquired: false, wait: resolved-true }.
 */
export function acquireFirstCreateMutex(
	userId: unknown,
): { acquired: true } | { acquired: false; wait: Promise<boolean> } {
	const key = normalizeUserId(userId);

	if (canonicalProfiles.has(key)) {
		return { acquired: false, wait: Promise.resolve(true) };
	}

	const existing = firstCreateMutexes.get(key);
	if (existing) {
		return { acquired: false, wait: existing.promise };
	}

	let resolve!: (committed: boolean) => void;
	const promise = new Promise<boolean>((r) => {
		resolve = r;
	});
	firstCreateMutexes.set(key, { promise, resolve });
	return { acquired: true };
}

/**
 * Commit: store the canonical profile and release the mutex (signaling success to waiters).
 */
export function commitCanonicalProfile(userId: unknown, resolved: ResolvedContextOptions | null): CanonicalProfile {
	const key = normalizeUserId(userId);
	const profile: CanonicalProfile = {
		resolvedOverrides: resolved,
		hash: contextHash(resolved),
		establishedAt: Date.now(),
	};
	canonicalProfiles.set(key, profile);
	const mutex = firstCreateMutexes.get(key);
	if (mutex) {
		mutex.resolve(true);
		firstCreateMutexes.delete(key);
	}
	log('info', 'canonical profile committed', { userId: key, hash: profile.hash });
	return profile;
}

/**
 * Rollback: release the mutex (signaling failure to waiters). No canonical is stored.
 */
export function rollbackCanonicalMutex(userId: unknown): void {
	const key = normalizeUserId(userId);
	const mutex = firstCreateMutexes.get(key);
	if (mutex) {
		mutex.resolve(false);
		firstCreateMutexes.delete(key);
	}
}

/**
 * Create a CanonicalProfile object without storing it (for hash comparison during first-create).
 */
export function createCanonicalProfile(resolved: ResolvedContextOptions | null): CanonicalProfile {
	return {
		resolvedOverrides: resolved,
		hash: contextHash(resolved),
		establishedAt: Date.now(),
	};
}

export function clearCanonicalProfile(userId: unknown): void {
	const key = normalizeUserId(userId);
	canonicalProfiles.delete(key);
	const mutex = firstCreateMutexes.get(key);
	if (mutex) {
		mutex.resolve(false);
		firstCreateMutexes.delete(key);
	}
}

/**
 * Store or validate a session profile for a specific userId + sessionKey combination.
 * Returns the established profile if successful.
 * Throws if a conflicting profile is already established for the same userId + sessionKey.
 */
export function establishSessionProfile(
	userId: unknown,
	sessionKey: string,
	profile: ResolvedSessionProfile,
): EstablishedSessionProfile {
	const key = sessionOverlayKey(userId, sessionKey);
	const existing = sessionProfiles.get(key);

	if (existing) {
		if (existing.signature !== profile.signature) {
			throw new Error('Session profile conflict');
		}
		return existing;
	}

	const established: EstablishedSessionProfile = {
		userId: normalizeUserId(userId),
		sessionKey,
		signature: profile.signature,
		resolvedProfile: profile,
		establishedAt: Date.now(),
	};

	sessionProfiles.set(key, established);
	log('info', 'session profile established', {
		userId: established.userId,
		sessionKey,
		signature: profile.signature,
	});

	return established;
}

export function clearSessionProfile(userId: unknown, sessionKey: string): void {
	const key = sessionOverlayKey(userId, sessionKey);
	sessionProfiles.delete(key);
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

function buildBrowserContextOptions(contextOverrides?: ContextOverrides | null): BrowserContextOptions {
	const resolved = contextOverrides || {};
	const contextOptions: BrowserContextOptions = {
		viewport: resolved.viewport || { width: 1280, height: 720 },
		permissions: ['geolocation'],
	};

	const hasOverrides = !!(
		contextOverrides &&
		(contextOverrides.locale !== undefined ||
			contextOverrides.timezoneId !== undefined ||
			contextOverrides.geolocation !== undefined)
	);

	// With proxy+geoip, camoufox auto-configures locale/timezone/geo from proxy IP.
	// If caller explicitly supplies overrides, apply them even when proxy is active.
	if (!CONFIG.proxy.host || hasOverrides) {
		contextOptions.locale = resolved.locale || 'en-US';
		contextOptions.timezoneId = resolved.timezoneId || 'America/Los_Angeles';
		contextOptions.geolocation = resolved.geolocation || { latitude: 37.7749, longitude: -122.4194 };
	}

	return contextOptions;
}

export interface StagedFirstUse {
	session: SessionData;
	contextEntry: PoolEntry;
	generation: string;
}

export async function createStagedSession(
	userId: unknown,
	contextOverrides?: ContextOverrides | null,
): Promise<StagedFirstUse> {
	const key = normalizeUserId(userId);

	if (contextPool.size() >= MAX_SESSIONS) {
		throw new Error('Maximum concurrent sessions reached');
	}

	const generation = crypto.randomUUID();
	const contextOptions = buildBrowserContextOptions(contextOverrides);
	// For backward compatibility, use userId as profileKey when no session profile is provided
	const entry = await contextPool.ensureContext(key, key, contextOptions, null, true, generation);

	const session: SessionData = {
		context: entry.context,
		tabGroups: new Map(),
		lastAccess: Date.now(),
	};

	return { session, contextEntry: entry, generation };
}

export function commitStagedFirstUse(
	userId: unknown,
	session: SessionData,
	contextOverrides: ContextOverrides | null,
	tabInfo: {
		tabId: string;
		sessionMapKey: string;
		sessionKey: string;
		tabState: TabState;
	},
	generation: string,
): boolean {
	const key = normalizeUserId(userId);
	const entry = contextPool.getEntry(key);
	if (!entry || entry.stagedGeneration !== generation) return false;

	if (!firstCreateMutexes.has(key) || canonicalProfiles.has(key)) {
		return false;
	}

	session.lastAccess = Date.now();
	const group = getTabGroup(session, tabInfo.sessionKey);
	group.set(tabInfo.tabId, tabInfo.tabState);
	sessions.set(key, session);

	entry.staged = false;
	entry.stagedGeneration = undefined;

	indexTab(tabInfo.tabId, tabInfo.sessionMapKey);
	commitCanonicalProfile(userId, contextOverrides);

	return true;
}

export async function rollbackStagedFirstUse(userId: unknown, generation: string): Promise<void> {
	const key = normalizeUserId(userId);
	const entry = contextPool.getEntry(key);
	if (!(entry?.staged === true && entry.stagedGeneration === generation)) return;
	try {
		cleanupUserDownloads(key);
	} catch {
		// ignore cleanup errors
	}
	await contextPool.closeStagedContext(key, generation);
	rollbackCanonicalMutex(userId);
}

export async function getSession(userId: unknown, contextOverrides?: ContextOverrides | null): Promise<SessionData> {
	const key = normalizeUserId(userId);
	let session = sessions.get(key);
	const contextOptions = buildBrowserContextOptions(contextOverrides);

	if (!session) {
		const existingLaunch = launchingSessions.get(key);
		if (existingLaunch) {
			session = await existingLaunch;
			session.lastAccess = Date.now();
			return session;
		}

		if (contextPool.size() >= MAX_SESSIONS) {
			throw new Error('Maximum concurrent sessions reached');
		}

		const launchPromise = (async (): Promise<SessionData> => {
			const entry = await contextPool.ensureContext(key, key, contextOptions);
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
		const entry = await contextPool.ensureContext(key, key, contextOptions);
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
	sessionProfiles.clear();
	for (const [, mutex] of firstCreateMutexes) mutex.resolve(false);
	firstCreateMutexes.clear();
	clearAllTabLocks();
	userConcurrency.clear();
}

export async function closeSessionsForUser(userId: string): Promise<void> {
	const key = normalizeUserId(userId);
	await contextPool.closeStagedContextByUserId(key).catch(() => {});
	await contextPool.closeContextByUserId(key).catch(() => {});
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
	sessionProfiles.clear();
	for (const [, mutex] of firstCreateMutexes) mutex.resolve(false);
	firstCreateMutexes.clear();
}

let cleanupInterval: NodeJS.Timeout | null = null;

export function startCleanupInterval(): NodeJS.Timeout {
	if (cleanupInterval) return cleanupInterval;
	cleanupInterval = setInterval(() => {
		const now = Date.now();
		for (const [sessionKey, session] of sessions) {
			if (now - session.lastAccess > SESSION_TIMEOUT_MS) {
				// Persistent profile is preserved on disk; closing the context frees resources.
				contextPool.closeContextByUserId(sessionKey).catch(() => {});
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
