import type { BrowserContext, Page } from 'playwright-core';
import { log } from '../middleware/logging';
import { recordNavFailure, acquireRecoveryLock, releaseRecoveryLock, deleteUserHealth } from './health';
import { contextPool } from './context-pool';
import { acquirePageForNewTab, safePageClose, withTimeout } from './tab';

async function recoverSessionContext(userId: string, sessionMapKey: string | undefined, reason: string): Promise<void> {
	const target = { userId, sessionMapKey: sessionMapKey ?? null };
	if (!acquireRecoveryLock(userId, sessionMapKey)) {
		log('info', `${reason}, recovery already in flight`, target);
		return;
	}
	try {
		log('info', `${reason}, recovering browser context`, target);
		await contextPool.closeContextBySession(userId, sessionMapKey);
	} catch {
		// Recovery is best-effort and must not replace the original route error.
	} finally {
		releaseRecoveryLock(userId, sessionMapKey);
		deleteUserHealth(userId, sessionMapKey);
	}
}

/** Bound page creation on an established context, without waiting for teardown. */
export async function acquirePageForSession(
	context: BrowserContext, userId: string, sessionMapKey: string, generation: string, timeoutMs: number,
): Promise<Page> {
	let expired = false;
	let settled = false;
	const pending = acquirePageForNewTab(context).then((page) => {
		settled = true;
		// Playwright does not cancel newPage when the caller's deadline expires.
		if (expired) void safePageClose(page);
		return page;
	}, (err: unknown) => {
		settled = true;
		throw err;
	});
	try {
		return await withTimeout(pending, timeoutMs, 'tab creation');
	} catch (err) {
		if (settled) throw err;
		expired = true;
		const entry = contextPool.getEntry(sessionMapKey);
		// A deadline from an old request must not close a replacement context.
		if (entry?.generation === generation && entry.context === context && entry.userId === userId && !entry.staged) {
			void recoverSessionContext(userId, sessionMapKey, 'tab creation timed out');
		}
		throw Object.assign(err as Error, { statusCode: 504 });
	}
}

/**
 * Record a navigation failure for a specific session and recover
 * that session's browser context when the consecutive failure threshold
 * is exceeded.
 *
 * Session-scoped: recovery targets the specific session/profile that had
 * the navigation failure, so one failing tab never terminates unrelated
 * sessions for the same user. When `sessionMapKey` is unavailable, falls
 * back to closing all of the user's contexts (backward compatible).
 *
 * Per-session: health accounting and the single-flight lock are keyed by
 * sessionMapKey when available (independent failure counters per session).
 * When no session key is present, falls back to userId-wide keying.
 *
 * Lock ownership: `releaseRecoveryLock` and `deleteUserHealth` are
 * called **only** by the invocation that acquired the lock. This
 * prevents a below-threshold or non-owner early return from clearing
 * a counter or lock owned by another in-flight request.
 *
 * Safe to call from route catch blocks: best-effort, never throws.
 */
export async function handleNavFailure(userId: string, sessionMapKey?: string): Promise<void> {
	try {
		if (!userId) return;
		const exceeded = recordNavFailure(userId, sessionMapKey);
		if (!exceeded) return;
		await recoverSessionContext(userId, sessionMapKey, 'nav failure threshold exceeded');
	} catch {
		// Best-effort recovery — never propagate
	}
}