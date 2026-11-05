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
import { decrementActiveOps, incrementActiveOps, deleteUserHealth } from './health';
import { stopVnc } from './vnc';
import { clearNetworkCaptures, detachNetworkCaptureTab } from './network-capture';
import { cleanupTracing } from './tracing';

const CONFIG = loadConfig();

// userId -> { context, tabGroups: Map<sessionKey, Map<tabId, TabState>>, lastAccess }
// Note: sessionKey was previously called listItemId - both are accepted for backward compatibility
const sessions = new Map<string, SessionData>();
const sessionOwners = new Map<string, string>();

// sessionKey -> in-flight session creation promise
// Avoids storing partially-initialized sessions (e.g., context: null cast) and dedupes concurrent creates.
const launchingSessions = new Map<string, Promise<SessionData>>();
const launchingSessionOwners = new Map<string, string>();

type SessionRebindResult =
	| { ok: true; session: SessionData }
	| { ok: false; error: unknown };

interface SessionRebindReservation {
	token: string;
	session: SessionData;
	fromGeneration: string;
	promise: Promise<SessionRebindResult>;
	resolve: (result: SessionRebindResult) => void;
}

const sessionRebindReservations = new Map<string, SessionRebindReservation>();

const lifecycleIdleClosures = new Map<string, { pending: number; promise: Promise<void>; resolve: () => void }>();

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

export interface SessionProfileLaunchSettings {
	contextOverrides: ContextOverrides | null;
	proxy: ResolvedSessionProfile['proxy'];
}

// Canonical per-user profile: stores resolved overrides from the first core POST /tabs.
// Survives passive context eviction; cleared only on explicit session close/cleanup.
const canonicalProfiles = new Map<string, CanonicalProfile>();

// Session profiles keyed by userId::sessionKey to track separate proxy/geo profiles per session
const sessionProfiles = new Map<string, EstablishedSessionProfile>();
const defaultSessionProfileClaims = new Map<string, { userId: string; sessionKey: string }>();

// Per-user mutex covering the entire first-create lifecycle (establishment -> tab commit).
// Prevents sibling requests from observing provisional canonical state.
const firstCreateMutexes = new Map<string, { promise: Promise<boolean>; resolve: (committed: boolean) => void }>();
const sessionProfileCreateMutexes = new Map<string, {
	userId: string;
	sessionKey: string;
	signature: string;
	promise: Promise<boolean>;
	resolve: (committed: boolean) => void;
}>();

const userConcurrency = new Map<string, { active: number; queue: Array<() => void> }>();

interface CleanupSessionsForUserIdOptions {
	allowInternalSessionKey?: boolean;
}

export function __getUserConcurrencyStateForTests(userId: string): { active: number; queueLength: number } | null {
	const key = String(userId).toLowerCase().trim();
	const state = userConcurrency.get(key);
	if (!state) return null;
	return { active: state.active, queueLength: state.queue.length };
}

export function __getSessionsMapForTests(): Map<string, SessionData> {
	return sessions;
}

/**
 * Test-only: returns the sessionOwners map so tests can link
 * custom session keys to user IDs (needed for findTabById to
 * recognize sessions with non-default keys).
 */
export function __getSessionOwnersForTests(): Map<string, string> {
	return sessionOwners;
}

function createSessionRebindReservation(sessionMapKey: string, session: SessionData): SessionRebindReservation {
	let resolve!: (result: SessionRebindResult) => void;
	const promise = new Promise<SessionRebindResult>((r) => {
		resolve = r;
	});
	const reservation: SessionRebindReservation = {
		token: crypto.randomUUID(),
		session,
		fromGeneration: session.generation,
		promise,
		resolve,
	};
	sessionRebindReservations.set(sessionMapKey, reservation);
	return reservation;
}

function cancelSessionRebindReservation(sessionMapKey: string, error: unknown): void {
	const reservation = sessionRebindReservations.get(sessionMapKey);
	if (!reservation) return;
	sessionRebindReservations.delete(sessionMapKey);
	reservation.resolve({ ok: false, error });
}

function cancelSessionRebindReservationsForCleanupKey(
	cleanupKey: string,
	allowInternalSessionKey: boolean,
	error: Error,
): void {
	for (const sessionKey of Array.from(sessionRebindReservations.keys())) {
		if (isSessionMapKeyForCleanupKey(sessionKey, cleanupKey, allowInternalSessionKey)) {
			cancelSessionRebindReservation(sessionKey, error);
		}
	}
}

function contextNeedsRebind(session: SessionData, entry: PoolEntry | undefined): boolean {
	if (!entry || entry.closing !== undefined || entry.generation !== session.generation || entry.context !== session.context) {
		return true;
	}
	if (typeof entry.context.pages === 'function') {
		try {
			void entry.context.pages();
		} catch {
			return true;
		}
	}
	return false;
}

/**
 * Synchronous snapshot of a session's durable identity — owner and
 * generation — captured before any await to prevent the replacement race.
 *
 * Returns `{ owner, generation }` where:
 * - `owner` is the userId that owns this session key (from sessionOwners),
 *   or `undefined` if the session key has no owner mapping.
 * - `generation` is the session's opaque identity token (from SessionData),
 *   or `undefined` if no session record exists.
 *
 * This is called by `closeContextBySession` before its first await so that
 * `teardownSessionByKey` can validate the session's identity after the
 * context-close await without reading a potentially-replaced session record.
 */
export function getSessionSnapshot(sessionMapKey: string): { owner: string | undefined; generation: string | undefined } {
	const normalized = String(sessionMapKey);
	const session = sessions.get(normalized);
	return {
		owner: sessionOwners.get(normalized),
		generation: session?.generation,
	};
}

function beginLifecycleIdleClosure(userId: unknown): () => void {
	const key = normalizeUserId(userId);
	let state = lifecycleIdleClosures.get(key);
	if (!state) {
		let resolve!: () => void;
		const promise = new Promise<void>((r) => {
			resolve = r;
		});
		state = { pending: 0, promise, resolve };
		lifecycleIdleClosures.set(key, state);
	}
	state.pending++;

	let released = false;
	return () => {
		if (released) return;
		released = true;
		const current = lifecycleIdleClosures.get(key);
		if (!current) return;
		current.pending--;
		if (current.pending <= 0) {
			lifecycleIdleClosures.delete(key);
			current.resolve();
		}
	};
}

async function waitForLifecycleIdleClosure(userId: unknown): Promise<void> {
	const key = normalizeUserId(userId);
	const pending = lifecycleIdleClosures.get(key);
	if (pending) {
		await pending.promise;
	}
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

export function cleanupSessionsForUserId(
	userId: string,
	reason: string,
	clearCanonical = true,
	options: CleanupSessionsForUserIdOptions = {},
): void {
	const key = normalizeUserId(userId);
	const allowInternalSessionKey = options.allowInternalSessionKey ?? true;
	const ownerKeys = new Set<string>();
	// If a session is currently being created, drop our reference so callers don't keep a stale placeholder.
	for (const launchKey of Array.from(launchingSessions.keys())) {
		if (isLaunchingSessionKeyForCleanupKey(launchKey, key, allowInternalSessionKey)) {
			ownerKeys.add(launchingSessionOwners.get(launchKey) ?? key);
			launchingSessions.delete(launchKey);
			launchingSessionOwners.delete(launchKey);
		}
	}

	for (const [sessionKey, session] of Array.from(sessions.entries())) {
		if (!isSessionMapKeyForCleanupKey(sessionKey, key, allowInternalSessionKey)) continue;
		cancelSessionRebindReservation(sessionKey, new Error('Session cleaned up'));
		ownerKeys.add(sessionOwners.get(sessionKey) ?? sessionKey);
		unindexSessionTabs(session);
		sessions.delete(sessionKey);
		sessionOwners.delete(sessionKey);
		// Evict per-session health entry so the map doesn't grow
		// unbounded across normal session lifecycle. The health key
		// is the sessionMapKey (or userId for legacy sessions).
		deleteUserHealth(key, sessionKey);
		log('info', 'session cleaned up', { userId: key, sessionKey, reason });
	}

	if (ownerKeys.size === 0) ownerKeys.add(key);
	for (const ownerKey of ownerKeys) {
		void stopVnc(ownerKey).catch(() => {});
		try {
			cleanupUserDownloads(ownerKey);
		} catch {
			// ignore cleanup errors
		}
		cleanupTracing(ownerKey);
		clearDefaultSessionProfileClaimsForUser(ownerKey);
	}

	if (clearCanonical) {
		canonicalProfiles.delete(key);
		clearDefaultSessionProfileClaimsForUser(key);
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
		for (const [profileKey, mutex] of Array.from(sessionProfileCreateMutexes.entries())) {
			if (mutex.userId === key) {
				mutex.resolve(false);
				sessionProfileCreateMutexes.delete(profileKey);
			}
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

function encodeKeyComponent(value: unknown): string {
	return Buffer.from(String(value), 'utf16le').toString('base64url');
}

function userSessionMapKey(userId: unknown): string {
	return `u:${encodeKeyComponent(normalizeUserId(userId))}`;
}

function sessionOverlayKey(userId: unknown, sessionKey: string): string {
	return `o:${encodeKeyComponent(normalizeUserId(userId))}:${encodeKeyComponent(sessionKey)}`;
}

function clearDefaultSessionProfileClaimsForUser(userId: unknown): void {
	const key = normalizeUserId(userId);
	for (const [claimKey, claim] of Array.from(defaultSessionProfileClaims.entries())) {
		if (claim.userId === key) {
			defaultSessionProfileClaims.delete(claimKey);
		}
	}
}

function isSessionMapKeyForUser(sessionMapKey: string, userKey: string): boolean {
	return sessionMapKey === userSessionMapKey(userKey) || sessionOwners.get(sessionMapKey) === userKey;
}

function isSessionMapKeyForCleanupKey(sessionMapKey: string, cleanupKey: string, allowInternalSessionKey = true): boolean {
	return (allowInternalSessionKey && sessionMapKey === cleanupKey) || isSessionMapKeyForUser(sessionMapKey, cleanupKey);
}

function isLaunchingSessionKeyForCleanupKey(sessionMapKey: string, cleanupKey: string, allowInternalSessionKey = true): boolean {
	return (
		(allowInternalSessionKey && sessionMapKey === cleanupKey) ||
		sessionMapKey === userSessionMapKey(cleanupKey) ||
		launchingSessionOwners.get(sessionMapKey) === cleanupKey
	);
}

// Backward compatible version - takes contextOverrides instead of session profile  
export function getSessionMapKey(userId: unknown, contextOverridesOrSessionKey: ContextOverrides | null | undefined | string, profileSignature?: string): string {
	// New signature: (userId, sessionKey, profileSignature)
	if (typeof contextOverridesOrSessionKey === 'string') {
		const sessionKey = contextOverridesOrSessionKey;
		if (profileSignature) {
			return `p:${encodeKeyComponent(normalizeUserId(userId))}:${encodeKeyComponent(sessionKey)}:${encodeKeyComponent(profileSignature)}`;
		}
		return `s:${encodeKeyComponent(normalizeUserId(userId))}:${encodeKeyComponent(sessionKey)}`;
	}
	// Old signature: (userId, contextOverrides) - backward compatibility
	// This maintains the user-scoped behavior for existing routes
	void contextOverridesOrSessionKey;
	return userSessionMapKey(userId);
}

export function getEstablishedSessionProfile(userId: unknown, sessionKey: string): EstablishedSessionProfile | undefined {
	return sessionProfiles.get(sessionOverlayKey(userId, sessionKey));
}

export function hasDefaultSessionProfileRuntime(userId: unknown, sessionKey: string): boolean {
	const key = normalizeUserId(userId);
	if (defaultSessionProfileClaims.has(sessionOverlayKey(key, sessionKey))) return true;
	const defaultSession = sessions.get(userSessionMapKey(key));
	return defaultSession?.tabGroups.has(sessionKey) ?? false;
}

export function claimDefaultSessionProfileRuntime(userId: unknown, sessionKey: string): boolean {
	if (getEstablishedSessionProfile(userId, sessionKey)) return false;
	if (hasDefaultSessionProfileRuntime(userId, sessionKey)) return false;
	const key = normalizeUserId(userId);
	defaultSessionProfileClaims.set(sessionOverlayKey(key, sessionKey), { userId: key, sessionKey });
	return true;
}

export function clearDefaultSessionProfileClaim(userId: unknown, sessionKey: string): void {
	defaultSessionProfileClaims.delete(sessionOverlayKey(userId, sessionKey));
}

function contextOverridesFromProfile(profile: ResolvedSessionProfile): ContextOverrides | null {
	const overrides: ContextOverrides = {};
	if (profile.locale !== undefined) overrides.locale = profile.locale;
	if (profile.timezoneId !== undefined) overrides.timezoneId = profile.timezoneId;
	if (profile.geolocation !== undefined) overrides.geolocation = profile.geolocation;
	if (profile.viewport !== undefined) overrides.viewport = profile.viewport;
	return Object.keys(overrides).length > 0 ? overrides : null;
}

export function getSessionProfileLaunchSettings(userId: unknown, profileKey: string): SessionProfileLaunchSettings | undefined {
	const key = normalizeUserId(userId);
	if (profileKey === userSessionMapKey(key)) {
		const canonical = canonicalProfiles.get(key);
		return canonical ? { contextOverrides: canonical.resolvedOverrides, proxy: null } : undefined;
	}

	for (const profile of sessionProfiles.values()) {
		if (profile.userId !== key) continue;
		if (getSessionMapKey(key, profile.sessionKey, profile.signature) !== profileKey) continue;
		return {
			contextOverrides: contextOverridesFromProfile(profile.resolvedProfile),
			proxy: profile.resolvedProfile.proxy,
		};
	}

	return undefined;
}

function resolveRuntimeSessionProfile(
	userId: unknown,
	sessionKey: string | undefined,
	contextOverrides?: ContextOverrides | null,
): {
	sessionMapKey: string;
	profileKey: string;
	contextOverrides: ContextOverrides | null | undefined;
	resolvedProxy: ResolvedSessionProfile['proxy'];
} {
	const userKey = normalizeUserId(userId);
	if (!sessionKey) {
		return {
			sessionMapKey: userSessionMapKey(userKey),
			profileKey: userSessionMapKey(userKey),
			contextOverrides,
			resolvedProxy: null,
		};
	}

	const established = getEstablishedSessionProfile(userId, sessionKey);
	if (!established) {
		return {
			sessionMapKey: userSessionMapKey(userKey),
			profileKey: userSessionMapKey(userKey),
			contextOverrides,
			resolvedProxy: null,
		};
	}

	const profileKey = getSessionMapKey(userId, sessionKey, established.signature);
	return {
		sessionMapKey: profileKey,
		profileKey,
		contextOverrides: contextOverridesFromProfile(established.resolvedProfile),
		resolvedProxy: established.resolvedProfile.proxy,
	};
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

export function acquireSessionProfileCreateMutex(
	userId: unknown,
	sessionKey: string,
	signature: string,
): { acquired: true; release: (committed: boolean) => void } | { acquired: false; wait: Promise<boolean> } {
	const key = sessionOverlayKey(userId, sessionKey);
	const existing = sessionProfileCreateMutexes.get(key);
	if (existing) {
		return { acquired: false, wait: existing.promise };
	}

	let resolve!: (committed: boolean) => void;
	const promise = new Promise<boolean>((r) => {
		resolve = r;
	});
	const mutex = {
		userId: normalizeUserId(userId),
		sessionKey,
		signature,
		promise,
		resolve,
	};
	sessionProfileCreateMutexes.set(key, mutex);
	let released = false;
	return {
		acquired: true,
		release: (committed: boolean): void => {
			if (released) return;
			released = true;
			const current = sessionProfileCreateMutexes.get(key);
			if (current === mutex) {
				current.resolve(committed);
				sessionProfileCreateMutexes.delete(key);
			}
		},
	};
}

export async function waitForSessionProfileCreate(userId: unknown, sessionKey: string): Promise<void> {
	const pending = sessionProfileCreateMutexes.get(sessionOverlayKey(userId, sessionKey));
	if (pending) {
		await pending.promise.catch(() => false);
	}
}

export async function rollbackSessionProfileRuntime(
	userId: unknown,
	sessionKey: string,
	profileSignature: string,
): Promise<void> {
	const overlayKey = sessionOverlayKey(userId, sessionKey);
	const existingProfile = sessionProfiles.get(overlayKey);
	if (existingProfile?.signature === profileSignature) {
		sessionProfiles.delete(overlayKey);
	}

	const sessionMapKey = getSessionMapKey(userId, sessionKey, profileSignature);
	const session = sessions.get(sessionMapKey);
	if (session) {
		cancelSessionRebindReservation(sessionMapKey, new Error('Session profile rolled back'));
		unindexSessionTabs(session);
		sessions.delete(sessionMapKey);
	}
	sessionOwners.delete(sessionMapKey);
	launchingSessions.delete(sessionMapKey);
	launchingSessionOwners.delete(sessionMapKey);
	await contextPool.closeContext(sessionMapKey).catch(() => {});
}

/**
 * Durable session identity captured synchronously by the caller before
 * any await, to prevent the replacement race where a new session with the
 * same key appears during the async gap.
 */
export interface SessionSnapshot {
	/** The session owner (userId) at snapshot time, or undefined if no owner mapping. */
	owner: string | undefined;
	/** The session's opaque generation at snapshot time, or undefined if no session record. */
	generation: string | undefined;
}

/**
 * Tear down a single session by its sessionMapKey: unindex all tabs,
 * delete the session entry, and close the backing context.
 *
 * This is the session-owned teardown used by nav recovery. Unlike
 * closeContextBySession (which only removes the pool entry), this also
 * removes the tab/session records from the index so findTabById can no
 * longer return stale Page objects for the recovered session.
 *
 * Sibling sessions for the same user are preserved — only the exact
 * sessionMapKey is torn down.
 *
 * Generation safety (HIGH B + HIGH C):
 * - When `expectedContextGeneration` is provided (pool entry existed and
 *   owner matched), the context is closed only if the exact immutable pool
 *   generation still matches the committed session generation. This
 *   prevents closing a replacement context that appeared during the await.
 * - When `expectedContextGeneration` is undefined (pool entry was missing at
 *   snapshot), stale session/tab records are cleaned up, but NO context
 *   close is attempted. A new context may have appeared during the await
 *   and must not be destroyed.
 *
 * Session record safety (HIGH C): the session's opaque `generation` is
 * captured before any await. After the await, the session is only deleted
 * if that exact generation still matches — preventing deletion of a
 * replacement or rebound session that reused the same key.
 *
 * Durable session identity (HIGH C round 8): the caller passes a
 * `sessionSnapshot` captured *before* the first await in
 * closeContextBySession. This prevents the replacement race where
 * teardownSessionByKey reads a session record that was replaced during
 * an async gap. The snapshot's `generation` is used as the authoritative
 * session identity; the snapshot's `owner` is
 * validated against the requesting user for the pool-missing path.
 *
 * Foreign ownership (HIGH round 8): when the pool entry is missing
 * (`expectedContextGeneration` is undefined), the session owner from the snapshot
 * is compared against `expectedSessionOwner`. If they don't match, the
 * call is a no-op — a foreign user must not delete another user's
 * session records.
 *
 * Recovery lock safety (HIGH D): deleteUserHealth is NOT called here.
 * Lock/health eviction is owned by handleNavFailure's finally block and
 * by ordinary session lifecycle paths (cleanupSessionsForUserId,
 * closeAllSessions, startCleanupInterval).
 *
 * Returns true if a session was found and torn down, false otherwise.
 */
export async function teardownSessionByKey(
	sessionMapKey: string,
	expectedContextGeneration?: string,
	sessionSnapshot?: SessionSnapshot,
): Promise<boolean> {
	const normalized = String(sessionMapKey);
	const session = sessions.get(normalized);
	if (!session) return false;
	if (sessionSnapshot && sessionSnapshot.generation === undefined) return false;

	// Foreign ownership check (HIGH round 8): when the pool entry was
	// missing at snapshot time, the session owner from the durable
	// snapshot must match the requesting user. A foreign user must not
	// delete another user's indexed session records.
	if (sessionSnapshot && expectedContextGeneration === undefined) {
		const snapshotOwner = sessionSnapshot.owner;
		if (snapshotOwner !== undefined) {
			// sessionOwners.get returns the current owner; compare against
			// the snapshot owner to detect replacement. If the snapshot
			// had no owner mapping, we cannot validate — proceed with
			// caution (index cleanup only, no context close).
			const currentOwner = sessionOwners.get(normalized);
			if (currentOwner !== undefined && currentOwner !== snapshotOwner) {
				log('warn', 'teardownSessionByKey: session owner replaced during await, aborting', {
					sessionMapKey: normalized,
					snapshotOwner,
					currentOwner,
				});
				return false;
			}
		}
	}

	// Use the durable session generation from the snapshot if provided.
	// Callers without a snapshot retain the direct teardown behavior by
	// using the generation of the session they resolved above.
	const sessionGeneration = sessionSnapshot ? sessionSnapshot.generation : session.generation;
	const capturedPairMatches = expectedContextGeneration === undefined || sessionGeneration === expectedContextGeneration;

	// Use generation-aware close to prevent the replacement race (HIGH B).
	// When an exact context generation is provided and matches the captured
	// committed session generation, close only that exact context entry.
	// A mixed old-session/pending-new-context pair is never closed here.
	// When expectedContextGeneration is undefined (pool entry was missing at
	// snapshot), do NOT close any context — a new context may have
	// appeared during the await and must not be destroyed.
	if (expectedContextGeneration !== undefined && capturedPairMatches) {
		await contextPool.closeContextIfMatches(normalized, expectedContextGeneration).catch(() => {});
	}
	// else: no pool entry at snapshot time → index cleanup only, no close.

	// If a getSession rebind started from the captured session generation,
	// wait for its reservation to commit or fail before deciding whether the
	// old session record is still authoritative. This keeps committed
	// SessionData identity unchanged while a replacement is only pending.
	const pendingRebind = sessionRebindReservations.get(normalized);
	if (pendingRebind && pendingRebind.session === session && pendingRebind.fromGeneration === sessionGeneration) {
		await pendingRebind.promise;
	}

	// Re-check session identity after the await (HIGH C).
	// If a replacement session replaced the old one during the await,
	// leave it intact and only clean up the old session's tab index.
	const currentSession = sessions.get(normalized);
	if (!currentSession || currentSession.generation !== sessionGeneration) {
		// The session was replaced during the await. Unindex the old
		// session's tabs only when it is a distinct object. A rebound
		// SessionData mutates in place, so unindexing it would also unindex
		// the now-current healthy session.
		if (currentSession !== session) unindexSessionTabs(session);
		log('warn', 'teardownSessionByKey: session replaced during await, leaving new session intact', {
			sessionMapKey: normalized,
			oldGeneration: sessionGeneration,
			newGeneration: currentSession?.generation,
		});
		return true;
	}

	// A captured mixed session/context pair fails closed while the newer
	// context entry still exists. If its launch failed, ensureContext removes
	// the entry and the stale old session can safely be cleaned below.
	if (!capturedPairMatches && contextPool.getEntry(normalized)) {
		log('warn', 'teardownSessionByKey: captured session/context generations differ, leaving session intact', {
			sessionMapKey: normalized,
			sessionGeneration,
			contextGeneration: expectedContextGeneration,
		});
		return false;
	}

	// Same session — safe to delete session records.
	unindexSessionTabs(currentSession);
	sessions.delete(normalized);
	sessionOwners.delete(normalized);
	launchingSessions.delete(normalized);
	launchingSessionOwners.delete(normalized);
	sessionRebindReservations.delete(normalized);

	log('info', 'session torn down by key (nav recovery)', { sessionMapKey: normalized, expectedContextGeneration });
	return true;
}

export function getSessionsForUser(userId: unknown): Array<[string, SessionData]> {
	if (userId === undefined || userId === null) return [];
	const key = normalizeUserId(userId);
	return Array.from(sessions.entries()).filter(([sessionKey]) => isSessionMapKeyForUser(sessionKey, key));
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

export function getLifecycleSessionSnapshot(): { liveSessions: number; liveTabs: number; stagedCreates: number } {
	return {
		liveSessions: sessions.size,
		liveTabs: countTotalTabsForSessions(),
		stagedCreates: launchingSessions.size,
	};
}

export function getSessionsSnapshot(): Map<string, SessionData> {
	return new Map(sessions);
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
			unindexTab(tabId);
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
		if (!isSessionMapKeyForUser(indexedKey, key)) {
			return null;
		}

		const session = sessions.get(indexedKey);
		if (session) {
			const found = findTab(session, tabId);
			if (found) return { sessionKey: indexedKey, session, ...found };
		}

		tabSessionIndex.delete(tabId);
	}

	const defaultSessionKey = userSessionMapKey(key);
	const session = sessions.get(defaultSessionKey);
	if (!session) return null;

	const found = findTab(session, tabId);
	if (found) {
		tabSessionIndex.set(tabId, defaultSessionKey);
		return { sessionKey: defaultSessionKey, session, ...found };
	}

	return null;
}

function buildBrowserContextOptions(contextOverrides?: ContextOverrides | null, hasSessionProxy = false): BrowserContextOptions {
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
	if ((!CONFIG.proxy.host && !hasSessionProxy) || hasOverrides) {
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
	sessionKey?: string,
): Promise<StagedFirstUse> {
	const runtimeProfile = resolveRuntimeSessionProfile(userId, sessionKey, contextOverrides);

	if (contextPool.size() >= MAX_SESSIONS) {
		throw new Error('Maximum concurrent sessions reached');
	}

	const generation = crypto.randomUUID();
	const contextOptions = buildBrowserContextOptions(runtimeProfile.contextOverrides, !!runtimeProfile.resolvedProxy);
	const entry = await contextPool.ensureContext(
		runtimeProfile.profileKey,
		normalizeUserId(userId),
		contextOptions,
		runtimeProfile.resolvedProxy,
		true,
		generation,
	);

	const session: SessionData = {
		context: entry.context,
		tabGroups: new Map(),
		lastAccess: Date.now(),
		createdAt: Date.now(),
		generation: entry.generation,
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
	const entry = contextPool.getEntry(tabInfo.sessionMapKey);
	if (!entry || entry.stagedGeneration !== generation) return false;

	if (!firstCreateMutexes.has(key) || canonicalProfiles.has(key)) {
		return false;
	}

	session.lastAccess = Date.now();
	const group = getTabGroup(session, tabInfo.sessionKey);
	group.set(tabInfo.tabId, tabInfo.tabState);
	sessions.set(tabInfo.sessionMapKey, session);
	sessionOwners.set(tabInfo.sessionMapKey, key);

	entry.staged = false;
	entry.stagedGeneration = undefined;

	indexTab(tabInfo.tabId, tabInfo.sessionMapKey);
	commitCanonicalProfile(userId, contextOverrides);

	return true;
}

export async function rollbackStagedFirstUse(userId: unknown, generation: string): Promise<void> {
	const key = normalizeUserId(userId);
	try {
		try {
			cleanupUserDownloads(key);
		} catch {
			// ignore cleanup errors
		}
		await contextPool.closeStagedContextByUserId(key, generation);
	} finally {
		rollbackCanonicalMutex(userId);
	}
}

export async function getSession(
	userId: unknown,
	contextOverrides?: ContextOverrides | null,
	sessionKey?: string,
): Promise<SessionData> {
	const key = normalizeUserId(userId);
	await waitForLifecycleIdleClosure(key);
	const runtimeProfile = resolveRuntimeSessionProfile(userId, sessionKey, contextOverrides);
	let session = sessions.get(runtimeProfile.sessionMapKey);
	const contextOptions = buildBrowserContextOptions(runtimeProfile.contextOverrides, !!runtimeProfile.resolvedProxy);

	if (!session) {
		const existingLaunch = launchingSessions.get(runtimeProfile.sessionMapKey);
		if (existingLaunch) {
			session = await existingLaunch;
			session.lastAccess = Date.now();
			return session;
		}

		if (contextPool.size() >= MAX_SESSIONS) {
			throw new Error('Maximum concurrent sessions reached');
		}

		const launchPromise = (async (): Promise<SessionData> => {
			const entry = await contextPool.ensureContext(
				runtimeProfile.profileKey,
				key,
				contextOptions,
				runtimeProfile.resolvedProxy,
			);
			const created: SessionData = {
				context: entry.context,
				tabGroups: new Map(),
				lastAccess: Date.now(),
				createdAt: Date.now(),
				generation: entry.generation,
			};
			sessions.set(runtimeProfile.sessionMapKey, created);
			sessionOwners.set(runtimeProfile.sessionMapKey, key);
			log('info', 'session created', { userId: key, sessionMapKey: runtimeProfile.sessionMapKey });
			return created;
		})();

		launchingSessionOwners.set(runtimeProfile.sessionMapKey, key);
		launchingSessions.set(runtimeProfile.sessionMapKey, launchPromise);
		try {
			session = await launchPromise;
		} finally {
			launchingSessions.delete(runtimeProfile.sessionMapKey);
			launchingSessionOwners.delete(runtimeProfile.sessionMapKey);
		}
	} else {
		// Re-resolve context on each access; ContextPool de-dupes launches and detects unexpected closes.
		const currentEntry = contextPool.getEntry(runtimeProfile.profileKey);
		if (contextNeedsRebind(session, currentEntry)) {
			const existingRebind = sessionRebindReservations.get(runtimeProfile.sessionMapKey);
			if (existingRebind) {
				const result = await existingRebind.promise;
				if (!result.ok) throw result.error;
				result.session.lastAccess = Date.now();
				return result.session;
			}

			const reservation = createSessionRebindReservation(runtimeProfile.sessionMapKey, session);
			let result: SessionRebindResult;
			try {
				const entry = await contextPool.ensureContext(
					runtimeProfile.profileKey,
					key,
					contextOptions,
					runtimeProfile.resolvedProxy,
				);

				if (
					sessionRebindReservations.get(runtimeProfile.sessionMapKey) !== reservation ||
					sessions.get(runtimeProfile.sessionMapKey) !== session ||
					session.generation !== reservation.fromGeneration
				) {
					await contextPool.closeContextIfMatches(runtimeProfile.profileKey, entry.generation).catch(() => {});
					throw new Error('Session rebind superseded');
				}

				// Commit the context and its immutable generation together. Until
				// this point SessionData still describes the previous context.
				session.context = entry.context;
				session.generation = entry.generation;
				session.lastAccess = Date.now();
				sessionOwners.set(runtimeProfile.sessionMapKey, key);
				result = { ok: true, session };
				return session;
			} catch (error) {
				result = { ok: false, error };
				throw error;
			} finally {
				if (sessionRebindReservations.get(runtimeProfile.sessionMapKey) === reservation) {
					sessionRebindReservations.delete(runtimeProfile.sessionMapKey);
				}
				reservation.resolve(result!);
			}
		} else {
			const entry = await contextPool.ensureContext(
				runtimeProfile.profileKey,
				key,
				contextOptions,
				runtimeProfile.resolvedProxy,
			);
			// No await occurs between an unexpected replacement result and this
			// commit, so bind the exact returned context generation atomically.
			if (session.context !== entry.context || session.generation !== entry.generation) {
				session.context = entry.context;
				session.generation = entry.generation;
			}
			session.lastAccess = Date.now();
			sessionOwners.set(runtimeProfile.sessionMapKey, key);
		}
	}

	// For newly created sessions, lastAccess/context are already set.
	session.lastAccess = Date.now();
	return session;
}

export function indexTab(tabId: string, sessionKey: string): void {
	tabSessionIndex.set(tabId, sessionKey);
}

export function unindexTab(tabId: string): void {
	detachNetworkCaptureTab(tabId);
	tabSessionIndex.delete(tabId);
	clearTabLock(tabId);
}

export function clearAllState(): void {
	clearNetworkCaptures();
	for (const [sessionKey] of sessionRebindReservations) {
		cancelSessionRebindReservation(sessionKey, new Error('Session state cleared'));
	}
	sessions.clear();
	sessionOwners.clear();
	launchingSessions.clear();
	launchingSessionOwners.clear();
	tabSessionIndex.clear();
	canonicalProfiles.clear();
	sessionProfiles.clear();
	defaultSessionProfileClaims.clear();
	for (const [, mutex] of sessionProfileCreateMutexes) mutex.resolve(false);
	sessionProfileCreateMutexes.clear();
	for (const [, state] of lifecycleIdleClosures) state.resolve();
	lifecycleIdleClosures.clear();
	for (const [, mutex] of firstCreateMutexes) mutex.resolve(false);
	firstCreateMutexes.clear();
	clearAllTabLocks();
	userConcurrency.clear();
}

export interface CloseSessionsForUserOptions {
	clearProfiles?: boolean;
}

export async function closeSessionsForUser(userId: string, options: CloseSessionsForUserOptions = {}): Promise<void> {
	const key = normalizeUserId(userId);
	const releaseClosure = await contextPool.beginUserClosure(key);
	try {
		cancelSessionRebindReservationsForCleanupKey(key, false, new Error('Session explicitly closed'));
		await contextPool.closeStagedContextByUserId(key).catch(() => {});
		await contextPool.closeContextByUserId(key).catch(() => {});
		cleanupSessionsForUserId(key, 'explicit_close', options.clearProfiles ?? true, { allowInternalSessionKey: false });
	} finally {
		releaseClosure();
	}
}

export async function closeAllSessions(): Promise<void> {
	const releaseClosure = await contextPool.beginGlobalClosure();
	try {
		for (const sessionKey of Array.from(sessionRebindReservations.keys())) {
			cancelSessionRebindReservation(sessionKey, new Error('All sessions closed'));
		}
		await contextPool.closeAll().catch(() => {});
		for (const [sessionKey, session] of sessions) {
			const ownerUserId = sessionOwners.get(sessionKey) ?? sessionKey;
			void stopVnc(ownerUserId).catch(() => {});
			unindexSessionTabs(session);
			sessions.delete(sessionKey);
			sessionOwners.delete(sessionKey);
			// Evict per-session health entry on bulk close.
			deleteUserHealth(ownerUserId, sessionKey);
			cleanupTracing(ownerUserId);
			try {
				cleanupUserDownloads(ownerUserId);
			} catch {
				// ignore
			}
		}
		launchingSessions.clear();
		launchingSessionOwners.clear();
		sessionOwners.clear();
		canonicalProfiles.clear();
		sessionProfiles.clear();
		defaultSessionProfileClaims.clear();
		for (const [, mutex] of sessionProfileCreateMutexes) mutex.resolve(false);
		sessionProfileCreateMutexes.clear();
		for (const [, mutex] of firstCreateMutexes) mutex.resolve(false);
		firstCreateMutexes.clear();
	} finally {
		releaseClosure();
	}
}

let cleanupInterval: NodeJS.Timeout | null = null;

export function startCleanupInterval(): NodeJS.Timeout {
	if (cleanupInterval) return cleanupInterval;
	cleanupInterval = setInterval(() => {
		const now = Date.now();
		for (const [sessionKey, session] of sessions) {
			if (now - session.lastAccess > SESSION_TIMEOUT_MS) {
				if (sessionRebindReservations.has(sessionKey)) continue;
				const ownerUserId = sessionOwners.get(sessionKey) ?? sessionKey;
				// Persistent profile is preserved on disk; closing the context frees resources.
				contextPool.closeContext(sessionKey).catch(() => {});
				unindexSessionTabs(session);
				clearDefaultSessionProfileClaimsForUser(ownerUserId);
				sessions.delete(sessionKey);
				sessionOwners.delete(sessionKey);
				// Evict per-session health entry on timeout expiry.
				deleteUserHealth(ownerUserId, sessionKey);
				cleanupTracing(ownerUserId);
				log('info', 'session expired', { userId: ownerUserId, sessionKey });
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

/**
 * Stage 1 idle cleanup: close runtime state (contexts, session data) for users with no tabs.
 * Does NOT clear stored session profiles - they survive idle cleanup.
 * Does NOT exit the daemon - that is Stage 2 (Task 4).
 * @param sessionSnapshot Snapshot of sessions map taken before cleanup started
 * @param contextSnapshot Snapshot of context pool entries taken before cleanup started
 * @param cleanupStartedMs Timestamp when cleanup was triggered (used to avoid closing newly-created contexts)
 */
export async function runLifecycleIdleCleanup(
	sessionSnapshot: Map<string, SessionData>,
	contextSnapshot: Map<string, PoolEntry>,
	cleanupStartedMs: number,
): Promise<{ closedUsers: string[] }> {
	const closedUsers: string[] = [];
	
	// Use the provided snapshots to avoid race with new context creation
	const sessionKeysToCleanup = new Set<string>();
	
	for (const [sessionKey, session] of sessionSnapshot.entries()) {
		const tabCount = countTotalTabsForSessions([[sessionKey, session]]);

		// Only cleanup sessions with zero tabs
		if (tabCount === 0) {
			sessionKeysToCleanup.add(sessionKey);
		}
	}
	
	// Close only the specific contexts from the snapshot that were created before cleanup started
	const contextsToClose: Array<{ profileKey: string; generation: string; lastAccess: number }> = [];
	for (const [profileKey, entry] of contextSnapshot.entries()) {
		// Skip staged, launching, or newly-created contexts
		if (sessionKeysToCleanup.has(profileKey) && !entry.staged && !entry.launching && entry.createdAt < cleanupStartedMs) {
			contextsToClose.push({ profileKey, generation: entry.generation, lastAccess: entry.lastAccess });
		}
	}
	
	// Close the specific contexts from the snapshot
	const actuallyClosedSessionKeys = new Set<string>();
	for (const { profileKey, generation, lastAccess } of contextsToClose) {
		const entry = contextSnapshot.get(profileKey);
		const releaseIdleClosure = entry ? beginLifecycleIdleClosure(entry.userId) : null;
		try {
			await contextPool.closeContextIfMatches(profileKey, generation, lastAccess);
			// Verify the context was actually closed (not skipped due to reuse)
			const stillExists = contextPool.getEntry(profileKey);
			if (!stillExists) {
				// Context was actually closed, mark this exact session/profile key for cleanup.
				actuallyClosedSessionKeys.add(profileKey);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log('error', 'idle cleanup failed to close context', { profileKey, error: message });
		} finally {
			releaseIdleClosure?.();
		}
	}
	
	// Clean up session data ONLY for session/profile keys whose contexts were actually closed.
	for (const sessionKey of actuallyClosedSessionKeys) {
		cleanupSessionsForUserId(sessionKey, 'idle_cleanup', false);
		closedUsers.push(sessionKey);
	}

	return { closedUsers };
}
