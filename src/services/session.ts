import type { BrowserContextOptions } from 'playwright-core';

import { contextHash } from '../utils/presets';
import type { ContextOverrides, SessionData, TabState } from '../types';
import { log } from '../middleware/logging';
import { ensureBrowser } from './browser';
import { clearTabLock, clearAllTabLocks } from './tab';
import { loadConfig } from '../utils/config';

const CONFIG = loadConfig();

// userId -> { context, tabGroups: Map<sessionKey, Map<tabId, TabState>>, lastAccess }
// Note: sessionKey was previously called listItemId - both are accepted for backward compatibility
const sessions = new Map<string, SessionData>();

// tabId -> sessions map key
// Sessions may be keyed by composite `${userId}:${contextHash}`, while tab endpoints only get tabId.
const tabSessionIndex = new Map<string, string>();

export const SESSION_TIMEOUT_MS = Math.max(60000, Number.parseInt(process.env.CAMOFOX_SESSION_TIMEOUT || '', 10) || 1800000);
export const MAX_SESSIONS = Math.max(1, Number.parseInt(process.env.CAMOFOX_MAX_SESSIONS || '', 10) || 50);
export const MAX_TABS_PER_SESSION = Math.max(1, Number.parseInt(process.env.CAMOFOX_MAX_TABS || '', 10) || 10);

export function normalizeUserId(userId: unknown): string {
	return String(userId);
}

export function getSessionMapKey(userId: unknown, contextOverrides: ContextOverrides | null | undefined): string {
	return normalizeUserId(userId) + contextHash(contextOverrides ?? null);
}

export function getSessionsForUser(userId: unknown): Array<[string, SessionData]> {
	if (userId === undefined || userId === null) return [];
	const prefix = normalizeUserId(userId);
	const out: Array<[string, SessionData]> = [];
	for (const [key, session] of sessions) {
		if (key === prefix || key.startsWith(prefix + ':')) out.push([key, session]);
	}
	return out;
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
	const prefix = normalizeUserId(userId);

	const indexedKey = tabSessionIndex.get(tabId);
	if (indexedKey) {
		if (!(indexedKey === prefix || indexedKey.startsWith(prefix + ':'))) {
			return null;
		}

		const session = sessions.get(indexedKey);
		if (session) {
			const found = findTab(session, tabId);
			if (found) return { sessionKey: indexedKey, session, ...found };
		}

		tabSessionIndex.delete(tabId);
	}

	for (const [sessionKey, session] of sessions) {
		if (!(sessionKey === prefix || sessionKey.startsWith(prefix + ':'))) continue;
		const found = findTab(session, tabId);
		if (found) {
			tabSessionIndex.set(tabId, sessionKey);
			return { sessionKey, session, ...found };
		}
	}

	return null;
}

export async function getSession(userId: unknown, contextOverrides?: ContextOverrides | null): Promise<SessionData> {
	const key = getSessionMapKey(userId, contextOverrides);
	let session = sessions.get(key);

	if (!session) {
		if (sessions.size >= MAX_SESSIONS) {
			throw new Error('Maximum concurrent sessions reached');
		}
		const b = await ensureBrowser();
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

		const context = await b.newContext(contextOptions);
		session = { context, tabGroups: new Map(), lastAccess: Date.now() };
		sessions.set(key, session);
		log('info', 'session created', { userId: key });
	}

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
	clearAllTabLocks();
}

export async function closeSessionsForUser(userId: string): Promise<void> {
	const prefix = userId;
	for (const [key, session] of sessions) {
		if (key === prefix || key.startsWith(prefix + ':')) {
			await session.context.close().catch(() => {});
			unindexSessionTabs(session);
			sessions.delete(key);
			log('info', 'session closed', { userId: key });
		}
	}
}

export async function closeAllSessions(): Promise<void> {
	for (const [userId, session] of sessions) {
		await session.context.close().catch(() => {});
		unindexSessionTabs(session);
		sessions.delete(userId);
	}
}

let cleanupInterval: NodeJS.Timeout | null = null;

export function startCleanupInterval(): NodeJS.Timeout {
	if (cleanupInterval) return cleanupInterval;
	cleanupInterval = setInterval(() => {
		const now = Date.now();
		for (const [sessionKey, session] of sessions) {
			if (now - session.lastAccess > SESSION_TIMEOUT_MS) {
				session.context.close().catch(() => {});
				unindexSessionTabs(session);
				sessions.delete(sessionKey);
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
