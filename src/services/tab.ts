import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { BrowserContext, Locator, Page } from 'playwright-core';

import { isElementRef as isSelectorElementRef } from '../cli/utils/selector';
import { expandMacro } from '../utils/macros';
import { loadConfig } from '../utils/config';
import { windowSnapshot } from '../utils/snapshot';
import type {
	ConsoleEntry,
	EvaluateResult,
	PageErrorEntry,
	RefInfo,
	ScrollPosition,
	TabState,
	WaitForPageReadyOptions,
} from '../types';
import { log } from '../middleware/logging';

const ALLOWED_URL_SCHEMES: ReadonlyArray<'http:' | 'https:'> = ['http:', 'https:'];
const CONFIG = loadConfig();
const METADATA_HOSTNAMES = new Set(['metadata.google.internal']);

// Selective set of actionable roles worth indexing as refs.
const INTERACTIVE_ROLES: ReadonlyArray<string> = [
	'button',
	'link',
	'textbox',
	'checkbox',
	'radio',
	'menuitem',
	'tab',
	'searchbox',
	'slider',
	'spinbutton',
	'switch',
	'combobox',
	'listbox',
	'option',
	'select',
	'dialog',
	'alertdialog',
	'gridcell',
	'treeitem',
];

// Patterns to skip (date pickers, calendar widgets)
const SKIP_PATTERNS: ReadonlyArray<RegExp> = [/date/i, /calendar/i, /picker/i, /datepicker/i];

const MAX_SNAPSHOT_NODES = CONFIG.maxSnapshotNodes;

const MAX_EVAL_TIMEOUT = 300000;
const DEFAULT_EVAL_TIMEOUT = 5000;
const MAX_EVAL_EXTENDED_TIMEOUT = 300000;
const DEFAULT_EVAL_EXTENDED_TIMEOUT = 30000;
const MAX_RESULT_SIZE = 1048576; // 1MB
const CONSOLE_BUFFER_SIZE = CONFIG.consoleBufferSize;
const POST_ACTION_NAVIGATION_SETTLE_MS = 500;
const ACTION_TRACKER_POLL_MS = 10;
type NavigationRoute = {
	request: () => {
		url: () => string;
		isNavigationRequest?: () => boolean;
		frame?: () => { page?: () => Page } | null;
	};
	continue: () => Promise<void>;
	abort: (errorCode?: string) => Promise<void>;
};
const navigationGuardHandlers = new WeakMap<BrowserContext, (route: NavigationRoute) => Promise<void>>();
const blockedNavigationErrors = new WeakMap<Page, string>();
const trackedBlockedNavigationErrors = new WeakMap<Page, Map<number, string>>();
const popupOpenerPages = new WeakMap<Page, Page>();
const inFlightGuardChecks = new WeakMap<Page, number>();
const trackedInFlightGuardChecks = new WeakMap<Page, Map<number, number>>();
const trackedPendingCounts = new WeakMap<Page, Map<number, number>>();
const actionTrackerInstalledPages = new WeakSet<Page>();
const actionTrackerBindingContexts = new WeakSet<BrowserContext>();
const actionTrackerTokens = new WeakMap<Page, number>();
const activeTrackedActionTokens = new WeakMap<Page, number>();

export const LONG_TEXT_THRESHOLD = 400;
export const TYPE_TIMEOUT_BASE_MS = 10000;
export const TYPE_TIMEOUT_PER_CHAR_MS = 80;
export const TYPE_TIMEOUT_MAX_MS = 120000;

interface EvaluateConfig {
	maxTimeout: number;
	defaultTimeout: number;
}

type BrowserTimerHandler = ((...args: unknown[]) => unknown) | string;
type BrowserFrameRequestCallback = (timestamp: number) => void;
type BrowserVoidFunction = () => void;

// Per-tab locks to serialize operations on the same tab
// tabId -> Promise (the currently executing operation)
const tabLocks = new Map<string, Promise<unknown>>();

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label = 'operation'): Promise<T> {
	const ms = Math.max(0, Number(timeoutMs) || 0);
	if (ms === 0) return promise;

	let timer: NodeJS.Timeout | null = null;
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			const err = new Error(`${label} timed out after ${ms}ms`);
			(err as Error & { code?: string }).code = 'ETIMEDOUT';
			reject(err);
		}, ms);
	});

	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function withTabLock<T>(tabId: string, operation: () => Promise<T>): Promise<T> {
	const pending = tabLocks.get(tabId);
	if (pending) {
		try {
			await pending;
		} catch {
			// Previous operation failed, continue anyway
		}
	}

	const promise = operation();
	tabLocks.set(tabId, promise);

	try {
		return await promise;
	} finally {
		if (tabLocks.get(tabId) === promise) {
			tabLocks.delete(tabId);
		}
	}
}

export function clearTabLock(tabId: string): void {
	tabLocks.delete(tabId);
}

export function clearAllTabLocks(): void {
	tabLocks.clear();
}

export function calculateTypeTimeoutMs(text: string): number {
	const textLength = typeof text === 'string' ? text.length : 0;
	const computedTimeoutMs = TYPE_TIMEOUT_BASE_MS + textLength * TYPE_TIMEOUT_PER_CHAR_MS;
	return Math.min(Math.max(computedTimeoutMs, TYPE_TIMEOUT_BASE_MS), TYPE_TIMEOUT_MAX_MS);
}


export async function safePageClose(
	page:
		| (Pick<Page, 'close'> & { isClosed?: () => boolean })
		| { close: (...args: any[]) => Promise<unknown>; isClosed?: () => boolean }
		| null
		| undefined,
): Promise<void> {
	if (!page) return;
	try {
		if (typeof page.isClosed === 'function' && page.isClosed()) return;
	} catch {
		// ignore
	}

	try {
		await withTimeout((page as any).close({ runBeforeUnload: true }), 5000, 'page.close');
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[camofox] page close failed: ${message}`);
	}
}

function normalizeHostname(hostname: string): string {
	return hostname.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

function parseIpv4Octets(hostname: string): number[] | null {
	const parts = hostname.split('.');
	if (parts.length !== 4) return null;
	const octets = parts.map((part) => Number.parseInt(part, 10));
	if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
	return octets;
}

function isBlockedIpv4(hostname: string): boolean {
	const octets = parseIpv4Octets(hostname);
	if (!octets) return false;
	const [a, b] = octets;
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 198 && (b === 18 || b === 19)) return true;
	return false;
}

function isBlockedIpv6(hostname: string): boolean {
	const normalized = normalizeHostname(hostname);
	if (normalized === '::1') return true;

	const nat64DottedMatch = normalized.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/i);
	if (nat64DottedMatch) {
		return isBlockedIpv4(nat64DottedMatch[1]);
	}

	const nat64HexMatch = normalized.match(/^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
	if (nat64HexMatch) {
		const high = Number.parseInt(nat64HexMatch[1], 16);
		const low = Number.parseInt(nat64HexMatch[2], 16);
		if (Number.isFinite(high) && Number.isFinite(low)) {
			const mappedIpv4 = [
				(high >> 8) & 0xff,
				high & 0xff,
				(low >> 8) & 0xff,
				low & 0xff,
			].join('.');
			return isBlockedIpv4(mappedIpv4);
		}
	}

	const mappedIpv4Match = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
	if (mappedIpv4Match) {
		return isBlockedIpv4(mappedIpv4Match[1]);
	}

	const mappedIpv4HexMatch = normalized.match(/^::ffff:([0-9a-f]{1,4})(?::([0-9a-f]{1,4}))?$/i);
	if (mappedIpv4HexMatch) {
		const high = Number.parseInt(mappedIpv4HexMatch[1], 16);
		const low = Number.parseInt(mappedIpv4HexMatch[2] || '0', 16);
		if (Number.isFinite(high) && Number.isFinite(low)) {
			const mappedIpv4 = [
				(high >> 8) & 0xff,
				high & 0xff,
				(low >> 8) & 0xff,
				low & 0xff,
			].join('.');
			return isBlockedIpv4(mappedIpv4);
		}
	}

	const firstHextetRaw = normalized.split(':', 1)[0] || '0';
	const firstHextet = Number.parseInt(firstHextetRaw, 16);
	if (!Number.isFinite(firstHextet)) return false;
	if ((firstHextet & 0xfe00) === 0xfc00) return true;
	if ((firstHextet & 0xffc0) === 0xfe80) return true;
	return false;
}

function isBlockedPrivateNetworkHostname(hostname: string): boolean {
	const normalized = normalizeHostname(hostname);
	if (normalized === 'localhost' || normalized === 'localhost.localdomain') return true;
	if (METADATA_HOSTNAMES.has(normalized)) return true;

	const ipVersion = isIP(normalized);
	if (ipVersion === 4) return isBlockedIpv4(normalized);
	if (ipVersion === 6) return isBlockedIpv6(normalized);
	return false;
}

export interface ValidateUrlOptions {
	allowPrivateNetworkTargets?: boolean;
}

function createNavigationBlockError(message: string): Error & { statusCode: number } {
	const error = new Error(message) as Error & { statusCode: number };
	error.statusCode = 400;
	return error;
}

function takeBlockedNavigationError(page: Page): (Error & { statusCode: number }) | null {
	const message = blockedNavigationErrors.get(page);
	if (!message) return null;
	blockedNavigationErrors.delete(page);
	return createNavigationBlockError(message);
}

function setTrackedBlockedNavigationError(page: Page, token: number, message: string): void {
	const existing = trackedBlockedNavigationErrors.get(page) || new Map<number, string>();
	existing.set(token, message);
	trackedBlockedNavigationErrors.set(page, existing);
}

function takeTrackedBlockedNavigationError(page: Page, token: number): (Error & { statusCode: number }) | null {
	const existing = trackedBlockedNavigationErrors.get(page);
	const message = existing?.get(token);
	if (!message) return null;
	existing?.delete(token);
	if (existing && existing.size === 0) {
		trackedBlockedNavigationErrors.delete(page);
	}
	return createNavigationBlockError(message);
}

function rethrowWithBlockedNavigationError(page: Page, err: unknown): never {
	const blockedError = takeBlockedNavigationError(page);
	if (blockedError) throw blockedError;
	throw err;
}

function rethrowWithTrackedBlockedNavigationError(page: Page, token: number, err: unknown): never {
	const blockedError = takeTrackedBlockedNavigationError(page, token);
	if (blockedError) throw blockedError;
	throw err;
}

export function throwBlockedNavigationErrorIfPresent(page: Page): void {
	const blockedError = takeBlockedNavigationError(page);
	if (blockedError) throw blockedError;
}

function throwTrackedBlockedNavigationErrorIfPresent(page: Page, token: number): void {
	const blockedError = takeTrackedBlockedNavigationError(page, token);
	if (blockedError) throw blockedError;
}

function clearBlockedNavigationError(page: Page): void {
	blockedNavigationErrors.delete(page);
}

function installActionTrackerScript(): void {
	const browserGlobal = globalThis as any;
	if (browserGlobal.__camofoxActionTracker) return;

	const state = {
		activeToken: 0,
		pendingCounts: new Map<number, number>(),
		timeoutTokens: new Map<any, number>(),
		intervalTokens: new Map<any, number>(),
		rafTokens: new Map<any, number>(),
	};

	const increment = (token: number) => {
		state.pendingCounts.set(token, (state.pendingCounts.get(token) || 0) + 1);
		void browserGlobal.__camofoxUpdatePendingCount?.(token, state.pendingCounts.get(token) || 0);
	};

	const decrement = (token: number) => {
		const next = (state.pendingCounts.get(token) || 0) - 1;
		if (next > 0) {
			state.pendingCounts.set(token, next);
		} else {
			state.pendingCounts.delete(token);
		}
		void browserGlobal.__camofoxUpdatePendingCount?.(token, state.pendingCounts.get(token) || 0);
	};

	const syncActiveToken = (token: number) => {
		state.activeToken = token;
		void browserGlobal.__camofoxUpdateActiveToken?.(token);
	};

	const withToken = <T>(token: number, fn: () => T): T => {
		const previousToken = state.activeToken;
		syncActiveToken(token);
		try {
			return fn();
		} finally {
			syncActiveToken(previousToken);
		}
	};

	const runHandler = (handler: BrowserTimerHandler, args: unknown[]) => {
		if (typeof handler === 'function') {
			return handler(...args);
		}
		return browserGlobal.eval(String(handler));
	};

	const originalSetTimeout = browserGlobal.setTimeout.bind(browserGlobal);
	const originalClearTimeout = browserGlobal.clearTimeout.bind(browserGlobal);
	const originalSetInterval = browserGlobal.setInterval.bind(browserGlobal);
	const originalClearInterval = browserGlobal.clearInterval.bind(browserGlobal);
	const originalRequestAnimationFrame = typeof browserGlobal.requestAnimationFrame === 'function'
		? browserGlobal.requestAnimationFrame.bind(browserGlobal)
		: null;
	const originalCancelAnimationFrame = typeof browserGlobal.cancelAnimationFrame === 'function'
		? browserGlobal.cancelAnimationFrame.bind(browserGlobal)
		: null;
	const originalQueueMicrotask = typeof browserGlobal.queueMicrotask === 'function'
		? browserGlobal.queueMicrotask.bind(browserGlobal)
		: null;

	browserGlobal.setTimeout = (handler: BrowserTimerHandler, delay?: number, ...args: unknown[]) => {
		const token = state.activeToken;
		if (!token) {
			return originalSetTimeout(handler, delay, ...args);
		}
		increment(token);
		let timeoutId: ReturnType<typeof setTimeout>;
		const wrapped = (...callbackArgs: unknown[]) => {
			const trackedToken = state.timeoutTokens.get(timeoutId) || token;
			state.timeoutTokens.delete(timeoutId);
			try {
				return withToken(trackedToken, () => runHandler(handler, callbackArgs));
			} finally {
				decrement(trackedToken);
			}
		};
		timeoutId = originalSetTimeout(wrapped, delay, ...args);
		state.timeoutTokens.set(timeoutId, token);
		return timeoutId;
	};

	browserGlobal.clearTimeout = (timeoutId: ReturnType<typeof setTimeout>) => {
		const token = state.timeoutTokens.get(timeoutId);
		if (token) {
			state.timeoutTokens.delete(timeoutId);
			decrement(token);
		}
		return originalClearTimeout(timeoutId);
	};

	browserGlobal.setInterval = (handler: BrowserTimerHandler, delay?: number, ...args: unknown[]) => {
		const token = state.activeToken;
		if (!token) {
			return originalSetInterval(handler, delay, ...args);
		}
		let intervalId: ReturnType<typeof setInterval>;
		const wrapped = (...callbackArgs: unknown[]) => {
			const trackedToken = state.intervalTokens.get(intervalId) || token;
			increment(trackedToken);
			try {
				return withToken(trackedToken, () => runHandler(handler, callbackArgs));
			} finally {
				decrement(trackedToken);
			}
		};
		intervalId = originalSetInterval(wrapped, delay, ...args);
		state.intervalTokens.set(intervalId, token);
		return intervalId;
	};

	browserGlobal.clearInterval = (intervalId: ReturnType<typeof setInterval>) => {
		state.intervalTokens.delete(intervalId);
		return originalClearInterval(intervalId);
	};

	if (originalRequestAnimationFrame && originalCancelAnimationFrame) {
		browserGlobal.requestAnimationFrame = (callback: BrowserFrameRequestCallback) => {
			const token = state.activeToken;
			if (!token) {
				return originalRequestAnimationFrame(callback);
			}
			increment(token);
			let rafId = 0;
			const wrapped: BrowserFrameRequestCallback = (timestamp: number) => {
				const trackedToken = state.rafTokens.get(rafId) || token;
				state.rafTokens.delete(rafId);
				try {
					return withToken(trackedToken, () => callback(timestamp));
				} finally {
					decrement(trackedToken);
				}
			};
			rafId = originalRequestAnimationFrame(wrapped);
			state.rafTokens.set(rafId, token);
			return rafId;
		};

		browserGlobal.cancelAnimationFrame = (rafId: number) => {
			const token = state.rafTokens.get(rafId);
			if (token) {
				state.rafTokens.delete(rafId);
				decrement(token);
			}
			return originalCancelAnimationFrame(rafId);
		};
	}

	if (originalQueueMicrotask) {
		browserGlobal.queueMicrotask = (callback: BrowserVoidFunction) => {
			const token = state.activeToken;
			if (!token) {
				return originalQueueMicrotask(callback);
			}
			increment(token);
			return originalQueueMicrotask(() => {
				try {
					return withToken(token, callback);
				} finally {
					decrement(token);
				}
			});
		};
	}

	browserGlobal.__camofoxActionTracker = {
		startAction(token: number) {
			syncActiveToken(token);
		},
		finishAction(token: number) {
			if (state.activeToken === token) {
				syncActiveToken(0);
			}
		},
		getPendingCount(token: number) {
			return state.pendingCounts.get(token) || 0;
		},
		getActiveToken() {
			return state.activeToken || 0;
		},
	};
}

async function ensureActionNavigationTracker(page: Page): Promise<boolean> {
	if (actionTrackerInstalledPages.has(page)) return true;
	if (typeof page.addInitScript !== 'function' || typeof page.evaluate !== 'function') return false;

	try {
		const context = page.context();
		if (!actionTrackerBindingContexts.has(context) && typeof (context as BrowserContext & { exposeBinding?: unknown }).exposeBinding === 'function') {
			await (context as BrowserContext & {
				exposeBinding: (
					name: string,
					callback: (source: { page?: Page }, token: unknown) => void | Promise<void>,
				) => Promise<void>;
			}).exposeBinding('__camofoxUpdateActiveToken', async ({ page: bindingPage }, token) => {
				if (!bindingPage) return;
				if (typeof token === 'number' && token > 0) {
					activeTrackedActionTokens.set(bindingPage, token);
				} else {
					activeTrackedActionTokens.delete(bindingPage);
				}
			});
			await (context as BrowserContext & {
				exposeBinding: (
					name: string,
					callback: (source: { page?: Page }, token: unknown, count: unknown) => void | Promise<void>,
				) => Promise<void>;
			}).exposeBinding('__camofoxUpdatePendingCount', async ({ page: bindingPage }, token, count) => {
				if (!bindingPage || typeof token !== 'number' || token <= 0) return;
				const existing = trackedPendingCounts.get(bindingPage) || new Map<number, number>();
				if (typeof count === 'number' && count > 0) {
					existing.set(token, count);
					trackedPendingCounts.set(bindingPage, existing);
					return;
				}
				existing.delete(token);
				if (existing.size === 0) {
					trackedPendingCounts.delete(bindingPage);
				} else {
					trackedPendingCounts.set(bindingPage, existing);
				}
			});
			actionTrackerBindingContexts.add(context);
		}
		await page.addInitScript(installActionTrackerScript);
		await page.evaluate(installActionTrackerScript);
		actionTrackerInstalledPages.add(page);
		return true;
	} catch {
		return false;
	}
}

function nextActionTrackerToken(page: Page): number {
	const nextToken = (actionTrackerTokens.get(page) || 0) + 1;
	actionTrackerTokens.set(page, nextToken);
	return nextToken;
}

async function startTrackedAction(page: Page): Promise<number | null> {
	const trackerReady = await ensureActionNavigationTracker(page);
	if (!trackerReady) return null;
	const token = nextActionTrackerToken(page);
	await page.evaluate((trackedToken) => {
		(globalThis as any).__camofoxActionTracker?.startAction(trackedToken);
	}, token);
	activeTrackedActionTokens.set(page, token);
	return token;
}

async function finishTrackedAction(page: Page, token: number | null): Promise<void> {
	if (token === null || typeof page.evaluate !== 'function') return;
	await page.evaluate((trackedToken) => {
		(globalThis as any).__camofoxActionTracker?.finishAction(trackedToken);
	}, token).catch(() => {});
	if (activeTrackedActionTokens.get(page) === token) {
		activeTrackedActionTokens.delete(page);
	}
}

async function getTrackedPendingCount(page: Page, token: number): Promise<number> {
	const syncedCount = trackedPendingCounts.get(page)?.get(token);
	if (typeof syncedCount === 'number') {
		return syncedCount;
	}
	if (typeof page.evaluate !== 'function') return 0;
	try {
		return await page.evaluate((trackedToken) => {
			return (globalThis as any).__camofoxActionTracker?.getPendingCount(trackedToken) || 0;
		}, token);
	} catch {
		return 0;
	}
}

async function getCurrentTrackedActionToken(page: Page): Promise<number | null> {
	if (typeof page.evaluate !== 'function' || !actionTrackerInstalledPages.has(page)) {
		return activeTrackedActionTokens.get(page) || null;
	}
	try {
		const token = await page.evaluate(() => {
			return (globalThis as any).__camofoxActionTracker?.getActiveToken?.() || 0;
		});
		if (typeof token === 'number' && token > 0) {
			return token;
		}
		return activeTrackedActionTokens.get(page) || null;
	} catch {
		return activeTrackedActionTokens.get(page) || null;
	}
}

function incrementInFlightGuardCheck(page: Page): void {
	inFlightGuardChecks.set(page, (inFlightGuardChecks.get(page) || 0) + 1);
}

function decrementInFlightGuardCheck(page: Page): void {
	const next = (inFlightGuardChecks.get(page) || 0) - 1;
	if (next > 0) {
		inFlightGuardChecks.set(page, next);
	} else {
		inFlightGuardChecks.delete(page);
	}
}

function incrementTrackedInFlightGuardCheck(page: Page, token: number): void {
	const existing = trackedInFlightGuardChecks.get(page) || new Map<number, number>();
	existing.set(token, (existing.get(token) || 0) + 1);
	trackedInFlightGuardChecks.set(page, existing);
}

function decrementTrackedInFlightGuardCheck(page: Page, token: number): void {
	const existing = trackedInFlightGuardChecks.get(page);
	if (!existing) return;
	const next = (existing.get(token) || 0) - 1;
	if (next > 0) {
		existing.set(token, next);
	} else {
		existing.delete(token);
	}
	if (existing.size === 0) {
		trackedInFlightGuardChecks.delete(page);
	}
}

function getTrackedInFlightGuardCheckCount(page: Page, token: number): number {
	return trackedInFlightGuardChecks.get(page)?.get(token) || 0;
}

export async function flushBlockedNavigationError(page: Page): Promise<void> {
	if (typeof page.waitForTimeout === 'function') {
		await page.waitForTimeout(POST_ACTION_NAVIGATION_SETTLE_MS);
	}
	throwBlockedNavigationErrorIfPresent(page);
}

export async function withBlockedNavigationTracking<T>(page: Page, action: () => Promise<T>): Promise<T> {
	if (CONFIG.allowPrivateNetworkTargets) {
		return action();
	}

	clearBlockedNavigationError(page);
	const actionToken = await startTrackedAction(page);
	clearBlockedNavigationError(page);
	let finishedTracking = false;
	const finish = async () => {
		if (finishedTracking) return;
		finishedTracking = true;
		await finishTrackedAction(page, actionToken);
	};

	try {
		const result = await action();
		throwBlockedNavigationErrorIfPresent(page);

		if (actionToken === null) {
			await finish();
			await flushBlockedNavigationError(page);
			return result;
		}

		let sawPendingWork = false;
		while (true) {
			throwTrackedBlockedNavigationErrorIfPresent(page, actionToken);
			if (sawPendingWork) {
				throwBlockedNavigationErrorIfPresent(page);
			}
			const pendingCount = await getTrackedPendingCount(page, actionToken);
			const inFlightGuardCount = getTrackedInFlightGuardCheckCount(page, actionToken);
			if (pendingCount === 0 && inFlightGuardCount === 0) {
				if (!sawPendingWork) {
					await new Promise((resolve) => setTimeout(resolve, ACTION_TRACKER_POLL_MS));
					throwTrackedBlockedNavigationErrorIfPresent(page, actionToken);
					throwBlockedNavigationErrorIfPresent(page);
					if ((await getTrackedPendingCount(page, actionToken)) === 0 && getTrackedInFlightGuardCheckCount(page, actionToken) === 0) {
						break;
					}
					sawPendingWork = true;
					continue;
				}
				await new Promise((resolve) => setTimeout(resolve, ACTION_TRACKER_POLL_MS));
				throwTrackedBlockedNavigationErrorIfPresent(page, actionToken);
				throwBlockedNavigationErrorIfPresent(page);
				if ((await getTrackedPendingCount(page, actionToken)) === 0 && getTrackedInFlightGuardCheckCount(page, actionToken) === 0) break;
			} else {
				sawPendingWork = true;
				await new Promise((resolve) => setTimeout(resolve, ACTION_TRACKER_POLL_MS));
			}
		}

		throwTrackedBlockedNavigationErrorIfPresent(page, actionToken);
		if (sawPendingWork) {
			throwBlockedNavigationErrorIfPresent(page);
		}
		await finish();
		return result;
	} catch (err) {
		await finish();
		if (typeof err === 'object' && err !== null && 'statusCode' in err && typeof err.statusCode === 'number') {
			throw err;
		}
		if (actionToken !== null) {
			rethrowWithTrackedBlockedNavigationError(page, actionToken, err);
		}
		rethrowWithBlockedNavigationError(page, err);
	}
}

export function validateUrl(url: string, options: ValidateUrlOptions = {}): string | null {
	const { allowPrivateNetworkTargets = CONFIG.allowPrivateNetworkTargets } = options;
	try {
		const parsed = new URL(url);
		if (!ALLOWED_URL_SCHEMES.includes(parsed.protocol as 'http:' | 'https:')) {
			return `Blocked URL scheme: ${parsed.protocol} (only http/https allowed)`;
		}
		if (!allowPrivateNetworkTargets && isBlockedPrivateNetworkHostname(parsed.hostname)) {
			return `Blocked private network target: ${parsed.hostname}`;
		}
		return null;
	} catch {
		return `Invalid URL: ${url}`;
	}
}

async function hostnameResolvesToBlockedAddress(hostname: string): Promise<boolean> {
	const normalized = normalizeHostname(hostname);
	if (isBlockedPrivateNetworkHostname(normalized)) return true;

	try {
		const results = await lookup(normalized, { all: true, verbatim: true });
		return results.some((result) => isBlockedPrivateNetworkHostname(result.address));
	} catch {
		return false;
	}
}

export async function validateNavigationUrl(url: string, options: ValidateUrlOptions = {}): Promise<string | null> {
	const urlError = validateUrl(url, options);
	if (urlError) return urlError;

	const { allowPrivateNetworkTargets = CONFIG.allowPrivateNetworkTargets } = options;
	if (allowPrivateNetworkTargets) return null;

	const parsed = new URL(url);
	if (await hostnameResolvesToBlockedAddress(parsed.hostname)) {
		return `Blocked private network target: ${parsed.hostname}`;
	}
	return null;
}

export async function navigateWithSafetyGuard(
	page: Pick<Page, 'goto' | 'route' | 'unroute' | 'mainFrame'>,
	targetUrl: string,
	options: ValidateUrlOptions & { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number } = {},
): Promise<void> {
	const { allowPrivateNetworkTargets = CONFIG.allowPrivateNetworkTargets, waitUntil = 'domcontentloaded', timeout = 30000 } = options;
	const initialError = await validateNavigationUrl(targetUrl, { allowPrivateNetworkTargets });
	if (initialError) {
		throw createNavigationBlockError(initialError);
	}
	if (allowPrivateNetworkTargets) {
		await page.goto(targetUrl, { waitUntil, timeout });
		return;
	}

	const typedPage = page as Page;
	await ensureNavigationSafetyGuard(typedPage, { allowPrivateNetworkTargets });
	blockedNavigationErrors.delete(typedPage);
	try {
		await page.goto(targetUrl, { waitUntil, timeout });
	} catch (err) {
		rethrowWithBlockedNavigationError(typedPage, err);
	}
}

export function annotateAriaYamlWithRefs(ariaYaml: string | null, refs: Map<string, RefInfo>): string {
	let annotatedYaml = ariaYaml || '';
	if (!annotatedYaml || !refs || refs.size === 0) return annotatedYaml;

	const refsByKey = new Map<string, string>();
	for (const [refId, info] of refs) {
		const role = String(info.role || '').toLowerCase();
		const name = info.name || '';
		const nth = Number.isFinite(info.nth) ? info.nth : 0;
		refsByKey.set(`${role}:${name}:${nth}`, refId);
	}

	const annotationCounts = new Map<string, number>();
	const lines = annotatedYaml.split('\n');
	annotatedYaml = lines
		.map((line) => {
			const match = line.match(/^(\s*-\s+)(\w+)(\s+\"([^\"]*)\")?(.*)$/);
			if (!match) return line;

			const [, prefix, role, nameMatch, name, suffix] = match;
			const normalizedRole = role.toLowerCase();

			if (name && SKIP_PATTERNS.some((p) => p.test(name))) return line;
			if (!INTERACTIVE_ROLES.includes(normalizedRole)) return line;

			const normalizedName = name || '';
			const countKey = `${normalizedRole}:${normalizedName}`;
			const nth = annotationCounts.get(countKey) || 0;
			annotationCounts.set(countKey, nth + 1);

			const refId = refsByKey.get(`${normalizedRole}:${normalizedName}:${nth}`);
			if (!refId) return line;

			return `${prefix}${role}${nameMatch || ''} [${refId}]${suffix}`;
		})
		.join('\n');

	return annotatedYaml;
}

export async function waitForPageReady(page: Page, options: WaitForPageReadyOptions = {}): Promise<boolean> {
	const { timeout = 10000, waitForNetwork = true } = options;

	try {
		await withBlockedNavigationTracking(page, async () => {
			await page.waitForLoadState('domcontentloaded', { timeout });

			if (waitForNetwork) {
				await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
					log('warn', 'networkidle timeout, continuing');
				});
			}

			// Framework hydration wait (React/Next.js/Vue) - mirrors Swift WebView.swift logic
			// Wait for readyState === 'complete' + network quiet (40 iterations × 250ms max)
			await page
				.evaluate(async () => {
					type ResourceTimingEntryLike = { responseEnd: number };
					type PerformanceLike = {
						getEntriesByType(type: 'resource'): ResourceTimingEntryLike[];
						now(): number;
					};
					type DocumentLike = { readyState: string };
					type RafLike = (cb: () => void) => number;

					const perf = (globalThis as unknown as { performance: PerformanceLike }).performance;
					const doc = (globalThis as unknown as { document: DocumentLike }).document;
					const raf = (globalThis as unknown as { requestAnimationFrame: RafLike }).requestAnimationFrame;

					for (let i = 0; i < 40; i++) {
						// Check if network is quiet (no recent resource loads)
						const entries = perf.getEntriesByType('resource');
						const recentEntries = entries.slice(-5);
						const netQuiet = recentEntries.every((e) => (perf.now() - e.responseEnd) > 400);

						if (doc.readyState === 'complete' && netQuiet) {
							// Double RAF to ensure paint is complete
							await new Promise<void>((r) => raf(() => raf(() => r())));
							break;
						}
						await new Promise((r) => setTimeout(r, 250));
					}
				})
				.catch(() => {
					log('warn', 'hydration wait failed, continuing');
				});

			await page.waitForTimeout(200);
			await dismissConsentDialogs(page);
		});
		return true;
	} catch (err) {
		if (typeof err === 'object' && err !== null && 'statusCode' in err && typeof err.statusCode === 'number') {
			throw err;
		}
		const blockedError = takeBlockedNavigationError(page);
		if (blockedError) throw blockedError;
		const message = err instanceof Error ? err.message : String(err);
		log('warn', 'page ready failed', { error: message });
		return false;
	}
}

export async function dismissConsentDialogs(page: Page): Promise<void> {
	const dismissSelectors: ReadonlyArray<string> = [
		// OneTrust (very common)
		'#onetrust-banner-sdk button#onetrust-accept-btn-handler',
		'#onetrust-banner-sdk button#onetrust-reject-all-handler',
		'#onetrust-close-btn-container button',
		// Generic patterns
		'button[data-test="cookie-accept-all"]',
		'button[aria-label="Accept all"]',
		'button[aria-label="Accept All"]',
		'button[aria-label="Close"]',
		'button[aria-label="Dismiss"]',
		// Dialog close buttons
		'dialog button:has-text("Close")',
		'dialog button:has-text("Accept")',
		'dialog button:has-text("I Accept")',
		'dialog button:has-text("Got it")',
		'dialog button:has-text("OK")',
		// GDPR/CCPA specific
		'[class*="consent"] button[class*="accept"]',
		'[class*="consent"] button[class*="close"]',
		'[class*="privacy"] button[class*="close"]',
		'[class*="cookie"] button[class*="accept"]',
		'[class*="cookie"] button[class*="close"]',
		// Overlay close buttons
		'[class*="modal"] button[class*="close"]',
		'[class*="overlay"] button[class*="close"]',
	];

	for (const selector of dismissSelectors) {
		try {
			const button = page.locator(selector).first();
			if (await button.isVisible({ timeout: 100 })) {
				await button.click({ timeout: 1000 }).catch(() => {});
				log('info', 'dismissed consent dialog', { selector });
				await page.waitForTimeout(300);
				break;
			}
		} catch {
			// Selector not found or not clickable, continue
		}
	}
}

export async function buildRefs(page: Page): Promise<Map<string, RefInfo>> {
	if (!page || page.isClosed()) {
		log('warn', 'buildRefs: page closed or invalid');
		return new Map<string, RefInfo>();
	}

	const ariaYaml = await getAriaSnapshot(page);
	if (!ariaYaml) {
		log('warn', 'buildRefs: no aria snapshot');
		return new Map<string, RefInfo>();
	}

	return buildRefsFromAriaSnapshot(ariaYaml);
}

export function buildRefsFromAriaSnapshot(ariaYaml: string | null): Map<string, RefInfo> {
	const refs = new Map<string, RefInfo>();
	if (!ariaYaml) return refs;

	const lines = ariaYaml.split('\n');
	let refCounter = 1;
	const seenCounts = new Map<string, number>();

	for (const line of lines) {
		if (refCounter > MAX_SNAPSHOT_NODES) break;

		const match = line.match(/^\s*-\s+(\w+)(?:\s+\"([^\"]*)\")?/);
		if (match) {
			const [, role, name] = match;
			const normalizedRole = role.toLowerCase();
			if (name && SKIP_PATTERNS.some((p) => p.test(name))) continue;

			if (INTERACTIVE_ROLES.includes(normalizedRole)) {
				const normalizedName = name || '';
				const key = `${normalizedRole}:${normalizedName}`;

				const nth = seenCounts.get(key) || 0;
				seenCounts.set(key, nth + 1);

				const refId = `e${refCounter++}`;
				refs.set(refId, { role: normalizedRole, name: normalizedName, nth });
			}
		}
	}

	return refs;
}

export async function getAriaSnapshot(page: Page): Promise<string | null> {
	if (!page || page.isClosed()) return null;
	await waitForPageReady(page, { waitForNetwork: false });
	try {
		return await page.locator('body').ariaSnapshot({ timeout: 10000 });
	} catch {
		log('warn', 'ariaSnapshot failed, retrying');
		await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
		return page.locator('body').ariaSnapshot({ timeout: 10000 });
	}
}

export function isElementRef(target: string): boolean {
	return isSelectorElementRef(target);
}

function toLocatorRole(role: string): string {
	return role === 'select' ? 'combobox' : role;
}

export async function refToLocator(page: Page, ref: string, refs: Map<string, RefInfo>): Promise<Locator | null> {
	const info = refs.get(ref);
	if (!info) return null;

	const { role, name, nth } = info;
	const locator = page.getByRole(toLocatorRole(role) as never, name ? ({ name } as never) : undefined);
	const count = await locator.count();
	if (count <= nth) {
		const err = new Error(`Ref ${ref} may be stale - snapshot again for fresh refs`);
		(err as Error & { statusCode?: number }).statusCode = 400;
		throw err;
	}
	return locator.nth(nth);
}

function attachConsoleListeners(state: TabState): void {
	const { page } = state;

	page.on('console', (msg) => {
		const location = msg.location();
		const entry: ConsoleEntry = {
			timestamp: Date.now(),
			type: msg.type() as ConsoleEntry['type'],
			text: msg.text(),
			location: location
				? {
					url: location.url,
					lineNumber: location.lineNumber,
					columnNumber: location.columnNumber,
				}
				: undefined,
		};
		state.consoleMessages.push(entry);
		if (state.consoleMessages.length > CONSOLE_BUFFER_SIZE) {
			state.consoleMessages.shift();
		}

		if (msg.type() === 'error') {
			const errorText = msg.text();
			const now = Date.now();
			const lastError = state.pageErrors[state.pageErrors.length - 1];
			if (!lastError || now - lastError.timestamp > 100 || !errorText.includes(lastError.message)) {
				state.pageErrors.push({
					timestamp: now,
					message: errorText,
					stack: undefined,
				});
				if (state.pageErrors.length > CONSOLE_BUFFER_SIZE) {
					state.pageErrors.shift();
				}
			}
		}
	});

	page.on('pageerror', (error) => {
		const now = Date.now();
		const last = state.consoleMessages[state.consoleMessages.length - 1];
		const errorMsg = error?.message || String(error);
		if (last?.type === 'error' && now - last.timestamp < 100 && last.text.includes(errorMsg)) {
			return;
		}

		const entry: PageErrorEntry = {
			timestamp: now,
			message: errorMsg,
			stack: error?.stack,
		};
		state.pageErrors.push(entry);
		if (state.pageErrors.length > CONSOLE_BUFFER_SIZE) {
			state.pageErrors.shift();
		}
	});
}

async function ensureNavigationSafetyGuard(page: Pick<Page, 'context'>, options: ValidateUrlOptions = {}): Promise<void> {
	const { allowPrivateNetworkTargets = CONFIG.allowPrivateNetworkTargets } = options;
	if (allowPrivateNetworkTargets) return;

	const context = page.context();
	if (navigationGuardHandlers.has(context)) return;

	const routeHandler = async (route: NavigationRoute) => {
		const request = route.request();
		if (typeof request.isNavigationRequest === 'function' && !request.isNavigationRequest()) {
			return route.continue();
		}

		const requestFrame = typeof request.frame === 'function' ? request.frame() : null;
		const requestPage = requestFrame && typeof requestFrame.page === 'function' ? requestFrame.page() : null;
		const relatedPages = new Set<Page>();
		let trackedToken: number | null = null;
		if (requestPage) {
			relatedPages.add(requestPage);
			trackedToken = await getCurrentTrackedActionToken(requestPage);
			const mappedOpener = popupOpenerPages.get(requestPage);
			if (mappedOpener) {
				relatedPages.add(mappedOpener);
				if (trackedToken === null) {
					trackedToken = await getCurrentTrackedActionToken(mappedOpener);
				}
			} else if (typeof requestPage.opener === 'function') {
				const openerPage = await requestPage.opener().catch(() => null);
				if (openerPage) {
					relatedPages.add(openerPage);
					if (trackedToken === null) {
						trackedToken = await getCurrentTrackedActionToken(openerPage);
					}
				}
			}
		}

		for (const relatedPage of relatedPages) {
			incrementInFlightGuardCheck(relatedPage);
			if (trackedToken !== null) {
				incrementTrackedInFlightGuardCheck(relatedPage, trackedToken);
			}
		}

		try {
			const requestError = await validateNavigationUrl(request.url(), { allowPrivateNetworkTargets: false });
			if (requestError) {
				for (const relatedPage of relatedPages) {
					if (trackedToken !== null) {
						setTrackedBlockedNavigationError(relatedPage, trackedToken, requestError);
					} else {
						blockedNavigationErrors.set(relatedPage, requestError);
					}
				}
				return route.abort('blockedbyclient');
			}
			return route.continue();
		} finally {
			for (const relatedPage of relatedPages) {
				decrementInFlightGuardCheck(relatedPage);
				if (trackedToken !== null) {
					decrementTrackedInFlightGuardCheck(relatedPage, trackedToken);
				}
			}
		}
	};

	await context.route('**/*', routeHandler);
	navigationGuardHandlers.set(context, routeHandler);
}

export async function createTabState(page: Page): Promise<TabState> {
	const state: TabState = {
		page,
		refs: new Map(),
		visitedUrls: new Set(),
		toolCalls: 0,
		consoleMessages: [],
		pageErrors: [],
	};

	attachConsoleListeners(state);
	page.on('popup', (popupPage) => {
		popupOpenerPages.set(popupPage, page);
	});
	await ensureNavigationSafetyGuard(page, { allowPrivateNetworkTargets: CONFIG.allowPrivateNetworkTargets });
	return state;
}

export async function navigateTab(
	tabId: string,
	tabState: TabState,
	params: { url?: string; macro?: string; query?: string; allowPrivateNetworkTargets?: boolean },
): Promise<{ ok: true; url: string }>{
	const { url, macro, query } = params;
	let targetUrl = url;
	if (macro) {
		targetUrl = expandMacro(macro, query) || url;
	}
	if (!targetUrl) {
		throw new Error('url or macro required');
	}

	const urlErr = await validateNavigationUrl(targetUrl, { allowPrivateNetworkTargets: params.allowPrivateNetworkTargets });
	if (urlErr) {
		const err = new Error(urlErr);
		// Used by routes to map to 400.
		(err as Error & { statusCode?: number }).statusCode = 400;
		throw err;
	}

	return withTabLock(tabId, async () => {
		await navigateWithSafetyGuard(tabState.page, targetUrl, {
			allowPrivateNetworkTargets: params.allowPrivateNetworkTargets,
			waitUntil: 'domcontentloaded',
			timeout: 30000,
		});
		tabState.visitedUrls.add(targetUrl);
		tabState.refs = await buildRefs(tabState.page);
		return { ok: true as const, url: tabState.page.url() };
	});
}

export async function snapshotTab(tabState: TabState): Promise<{ url: string; snapshot: string; refsCount: number }>{
	const ariaYaml = await getAriaSnapshot(tabState.page);
	tabState.refs = buildRefsFromAriaSnapshot(ariaYaml);
	const annotatedYaml = annotateAriaYamlWithRefs(ariaYaml, tabState.refs);
	return {
		url: tabState.page.url(),
		snapshot: annotatedYaml,
		refsCount: tabState.refs.size,
	};
}

export interface SnapshotPayload {
	url: string;
	snapshot: string;
	refsCount: number;
	offset: number;
	truncated: boolean;
	totalChars: number;
	hasMore: boolean;
	nextOffset: number | null;
}

export function buildSnapshotPayload(
	raw: { url: string; snapshot: string; refsCount: number },
	offset: number = 0,
): SnapshotPayload {
	const windowed = windowSnapshot(raw.snapshot, offset, CONFIG.maxSnapshotChars, CONFIG.snapshotTailChars);
	return {
		url: raw.url,
		snapshot: windowed.text,
		refsCount: raw.refsCount,
		offset: windowed.offset,
		truncated: windowed.truncated,
		totalChars: windowed.totalChars,
		hasMore: windowed.hasMore ?? false,
		nextOffset: windowed.nextOffset ?? null,
	};
}

export async function clickTab(tabId: string, tabState: TabState, params: { ref?: string; selector?: string }): Promise<{ ok: true; url: string }>{
	const { ref, selector } = params;
	if (!ref && !selector) {
		const err = new Error('ref or selector required');
		(err as Error & { statusCode?: number }).statusCode = 400;
		throw err;
	}

	return withTabLock(tabId, async () => {
		try {
			const dispatchMouseSequence = async (locator: Locator): Promise<void> => {
			const box = await locator.boundingBox();
			if (!box) throw new Error('Element not visible (no bounding box)');

			const x = box.x + box.width / 2;
			const y = box.y + box.height / 2;

			await tabState.page.mouse.move(x, y);
			await tabState.page.waitForTimeout(50);

			await tabState.page.mouse.down();
			await tabState.page.waitForTimeout(50);
			await tabState.page.mouse.up();

			log('info', 'mouse sequence dispatched', { x: x.toFixed(0), y: y.toFixed(0) });
		};

			const doClick = async (locatorOrSelector: Locator | string, isLocator: boolean): Promise<void> => {
				const locator = isLocator ? (locatorOrSelector as Locator) : tabState.page.locator(locatorOrSelector as string);

				try {
					await locator.click({ timeout: 5000 });
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					if (message.includes('intercepts pointer events')) {
						log('warn', 'click intercepted, retrying with force');
						try {
							await locator.click({ timeout: 5000, force: true });
						} catch {
							log('warn', 'force click failed, trying mouse sequence');
							await dispatchMouseSequence(locator);
						}
					} else if (message.includes('not visible') || message.includes('timeout')) {
						log('warn', 'click timeout, trying mouse sequence');
						await dispatchMouseSequence(locator);
					} else {
						throw err;
					}
				}
			};

			await withBlockedNavigationTracking(tabState.page, async () => {
				if (ref) {
					const locator = await refToLocator(tabState.page, ref, tabState.refs);
					if (!locator) {
						const maxRef = tabState.refs.size > 0 ? `e${tabState.refs.size}` : 'none';
						const err = new Error(
							`Unknown ref: ${ref} (valid refs: e1-${maxRef}, ${tabState.refs.size} total). Refs reset after navigation - call snapshot first.`,
						);
						(err as any).statusCode = 400;
						throw err;
					}
					await doClick(locator, true);
				} else {
					await doClick(selector as string, false);
				}
			});
			tabState.refs = await buildRefs(tabState.page);

			const newUrl = tabState.page.url();
			tabState.visitedUrls.add(newUrl);
			return { ok: true as const, url: newUrl };
		} catch (err) {
			rethrowWithBlockedNavigationError(tabState.page, err);
		}
	});
}

/**
 * Smart fill that handles contenteditable elements differently from standard inputs.
 * Prevents text doubling on rich-text editors (Lexical, ProseMirror, Slate, etc.)
 */
export async function smartFill(locator: Locator, page: Page, text: string): Promise<void> {
	const elementMetadata = await locator
		.evaluate((el) => ({
			isContentEditable: Boolean((el as any).isContentEditable),
			tagName: typeof (el as { tagName?: string }).tagName === 'string' ? (el as { tagName: string }).tagName : '',
		}))
		.catch(() => ({ isContentEditable: false, tagName: '' }));
	const { isContentEditable, tagName } = elementMetadata;
	const shouldUseBulkInsert = text.length >= LONG_TEXT_THRESHOLD;

	if (shouldUseBulkInsert) {
		// Long text would exceed the humanized per-character route budget, so set it in one DOM operation.
		await locator.evaluate((element, value) => {
			const browserGlobal = globalThis as any;
			const browserDocument = browserGlobal.document as any;
			const eventCtor = browserGlobal.Event as { new(type: string, init?: { bubbles?: boolean }): Event } | undefined;
			const target = element as any;
			const dispatch = (eventName: string) => {
				if (typeof eventCtor === 'function') {
					target.dispatchEvent(new eventCtor(eventName, { bubbles: true }));
				}
			};

			if (typeof target.focus === 'function') {
				target.focus();
			}
			dispatch('focus');

			if (target.isContentEditable) {
				const selection = browserDocument?.defaultView?.getSelection?.() ?? browserGlobal.getSelection?.();
				if (selection && browserDocument?.createRange) {
					const range = browserDocument.createRange();
					range.selectNodeContents(target);
					selection.removeAllRanges();
					selection.addRange(range);
				}

				const inserted = typeof browserDocument?.execCommand === 'function'
					? browserDocument.execCommand('insertText', false, value)
					: false;
				if (!inserted) {
					target.textContent = value;
				}
			} else if (target instanceof browserGlobal.HTMLInputElement || target instanceof browserGlobal.HTMLTextAreaElement) {
				const prototype = target instanceof browserGlobal.HTMLTextAreaElement
					? browserGlobal.HTMLTextAreaElement.prototype
					: browserGlobal.HTMLInputElement.prototype;
				const nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
				if (typeof nativeSetter === 'function') {
					nativeSetter.call(target, value);
				} else {
					target.value = value;
				}
			} else {
				target.textContent = value;
			}

			dispatch('input');
			dispatch('change');
		}, text);
		return;
	}

	if (isContentEditable) {
		await locator.focus();
		await page.keyboard.press('ControlOrMeta+a');
		await page.keyboard.press('Backspace');
		await page.keyboard.insertText(text);
	} else if (tagName === 'INPUT' || tagName === 'TEXTAREA') {
		await locator.fill(text, { timeout: 10000 });
	} else {
		await locator.fill(text, { timeout: 10000 });
	}
}

export async function typeTab(tabId: string, tabState: TabState, params: { ref?: string; selector?: string; text: string }): Promise<{ ok: true }>{
	const { ref, selector, text } = params;
	if (!ref && !selector) {
		const err = new Error('ref or selector required');
		(err as Error & { statusCode?: number }).statusCode = 400;
		throw err;
	}

	await withTabLock(tabId, async () => {
		let locator: Locator;
		if (ref) {
			const resolved = await refToLocator(tabState.page, ref, tabState.refs);
			if (!resolved) {
				const err = new Error(`Unknown ref: ${ref}. Call snapshot first.`);
				(err as any).statusCode = 400;
				throw err;
			}
			locator = resolved;
		} else {
			locator = tabState.page.locator(selector as string);
		}

		await withBlockedNavigationTracking(tabState.page, async () => {
			await smartFill(locator, tabState.page, text);
		});
	});

	return { ok: true as const };
}

export async function pressTab(tabId: string, tabState: TabState, key: string): Promise<{ ok: true }>{
	await withTabLock(tabId, async () => {
		try {
			await withBlockedNavigationTracking(tabState.page, async () => {
				await tabState.page.keyboard.press(key);
			});
		} catch (err) {
			rethrowWithBlockedNavigationError(tabState.page, err);
		}
	});
	return { ok: true as const };
}

export async function scrollTab(
	tabState: TabState,
	params: { direction?: 'up' | 'down' | 'left' | 'right'; amount?: number },
): Promise<{ ok: true }>{
	const { direction = 'down', amount = 500 } = params;
	const isHorizontal = direction === 'left' || direction === 'right';
	const delta = direction === 'up' || direction === 'left' ? -amount : amount;
	await withBlockedNavigationTracking(tabState.page, async () => {
		await tabState.page.mouse.wheel(isHorizontal ? delta : 0, isHorizontal ? 0 : delta);
		await tabState.page.waitForTimeout(300);
	});
	return { ok: true as const };
}

export async function scrollElementTab(
	tabId: string,
	tabState: TabState,
	params: { selector?: string; ref?: string; deltaX?: number; deltaY?: number; scrollTo?: { top?: number; left?: number } },
): Promise<{ ok: true; scrollPosition: ScrollPosition }>{
	const { selector, ref, scrollTo } = params;
	if (!ref && !selector) {
		const err = new Error('ref or selector required');
		(err as Error & { statusCode?: number }).statusCode = 400;
		throw err;
	}

	return withTabLock(tabId, async () => {
		const page = tabState.page;

		let locator: Locator;
		if (ref) {
			const resolved = await refToLocator(page, ref, tabState.refs);
			if (!resolved) {
				const maxRef = tabState.refs.size > 0 ? `e${tabState.refs.size}` : 'none';
				const err = new Error(
					`Unknown ref: ${ref} (valid refs: e1-${maxRef}, ${tabState.refs.size} total). Refs reset after navigation - call snapshot first.`,
				);
				(err as Error & { statusCode?: number }).statusCode = 400;
				throw err;
			}
			locator = resolved;
		} else {
			locator = page.locator(selector as string);
			const count = await locator.count();
			if (count === 0) {
				const err = new Error(`Element not found: ${selector}`);
				(err as Error & { statusCode?: number }).statusCode = 400;
				throw err;
			}
		}

		const element = locator.first();

		await withBlockedNavigationTracking(page, async () => {
			if (scrollTo) {
				await element.evaluate(
					(el, pos) => {
						const e = el as unknown as { scrollTop: number; scrollLeft: number };
						const p = pos as { top?: number; left?: number };
						if (p.top !== undefined) e.scrollTop = p.top;
						if (p.left !== undefined) e.scrollLeft = p.left;
					},
					scrollTo,
				);
			} else {
				const deltaX = params.deltaX ?? 0;
				const deltaY = params.deltaY ?? 300;
				await element.evaluate(
					(el, delta) => {
						(el as unknown as { scrollBy: (opts: { top: number; left: number; behavior: 'auto' }) => void }).scrollBy({
							top: (delta as { y: number }).y,
							left: (delta as { x: number }).x,
							behavior: 'auto',
						});
					},
					{ x: deltaX, y: deltaY },
				);
			}

			await page.waitForTimeout(200);
		});

		const scrollPosition = (await element.evaluate((el) => {
			const e = el as unknown as {
				scrollTop: number;
				scrollLeft: number;
				scrollHeight: number;
				clientHeight: number;
				scrollWidth: number;
				clientWidth: number;
			};
			return {
				scrollTop: e.scrollTop,
				scrollLeft: e.scrollLeft,
				scrollHeight: e.scrollHeight,
				clientHeight: e.clientHeight,
				scrollWidth: e.scrollWidth,
				clientWidth: e.clientWidth,
			};
		})) as ScrollPosition;

		return { ok: true as const, scrollPosition };
	});
}

export async function evaluateTab(
	tabId: string,
	tabState: TabState,
	params: { expression: string; timeout?: number },
): Promise<EvaluateResult> {
	return _evaluateInternal(tabId, tabState, params, {
		maxTimeout: MAX_EVAL_TIMEOUT,
		defaultTimeout: DEFAULT_EVAL_TIMEOUT,
	});
}

async function _evaluateInternal(
	tabId: string,
	tabState: TabState,
	params: { expression: string; timeout?: number },
	config: EvaluateConfig,
): Promise<EvaluateResult> {
	return withTabLock(tabId, async () => {
		const page = tabState.page;
		const timeout = Math.min(Math.max(params.timeout ?? config.defaultTimeout, 100), config.maxTimeout);

		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<never>((_resolve, reject) => {
			timeoutId = setTimeout(() => reject(new Error('EVAL_TIMEOUT')), timeout);
		});

		try {
			const result = await withBlockedNavigationTracking(page, async () => {
				return Promise.race([page.evaluate(params.expression), timeoutPromise]);
			});

			const serialized = JSON.stringify(result);
			if (serialized === undefined) {
				return {
					ok: true,
					result,
					resultType: typeof result,
					truncated: false,
				};
			}

			const truncated = serialized.length > MAX_RESULT_SIZE;
			if (truncated) {
				return {
					ok: true,
					result: `[Truncated: result was ${serialized.length} bytes, max ${MAX_RESULT_SIZE}]`,
					resultType: 'string',
					truncated: true,
				};
			}

			return {
				ok: true,
				result,
				resultType: result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result,
				truncated: false,
			};
		} catch (err: unknown) {
			if (typeof err === 'object' && err !== null && 'statusCode' in err && typeof err.statusCode === 'number') {
				throw err;
			}
			const message = err instanceof Error ? err.message : String(err);
			throwBlockedNavigationErrorIfPresent(page);
			if (message === 'EVAL_TIMEOUT') {
				return {
					ok: false,
					error: `Evaluation timed out after ${timeout}ms`,
					errorType: 'timeout',
				};
			}
			return {
				ok: false,
				error: message,
				errorType: 'js_error',
			};
		} finally {
			if (timeoutId) clearTimeout(timeoutId);
		}
	});
}

export async function evaluateTabExtended(
	tabId: string,
	tabState: TabState,
	params: { expression: string; timeout?: number },
): Promise<EvaluateResult> {
	return _evaluateInternal(tabId, tabState, params, {
		maxTimeout: MAX_EVAL_EXTENDED_TIMEOUT,
		defaultTimeout: DEFAULT_EVAL_EXTENDED_TIMEOUT,
	});
}

export async function backTab(tabId: string, tabState: TabState): Promise<{ ok: true; url: string }>{
	return withTabLock(tabId, async () => {
		try {
			await tabState.page.goBack({ timeout: 10000 });
			tabState.refs = await buildRefs(tabState.page);
			return { ok: true as const, url: tabState.page.url() };
		} catch (err) {
			rethrowWithBlockedNavigationError(tabState.page, err);
		}
	});
}

export async function forwardTab(tabId: string, tabState: TabState): Promise<{ ok: true; url: string }>{
	return withTabLock(tabId, async () => {
		try {
			await tabState.page.goForward({ timeout: 10000 });
			tabState.refs = await buildRefs(tabState.page);
			return { ok: true as const, url: tabState.page.url() };
		} catch (err) {
			rethrowWithBlockedNavigationError(tabState.page, err);
		}
	});
}

export async function refreshTab(tabId: string, tabState: TabState): Promise<{ ok: true; url: string }>{
	return withTabLock(tabId, async () => {
		try {
			await tabState.page.reload({ timeout: 30000 });
			tabState.refs = await buildRefs(tabState.page);
			return { ok: true as const, url: tabState.page.url() };
		} catch (err) {
			rethrowWithBlockedNavigationError(tabState.page, err);
		}
	});
}

export async function getLinks(
	tabState: TabState,
	params: { limit: number; offset: number; scope?: string; extension?: string; downloadOnly?: boolean },
): Promise<{ links: Array<{ url: string; text: string }>; pagination: { total: number; offset: number; limit: number; hasMore: boolean } }>{
	const { limit, offset, scope, extension, downloadOnly } = params;
	const extFilters = String(extension || '')
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean)
		.map((e) => (e.startsWith('.') ? e : `.${e}`));

	const allLinks = await tabState.page.evaluate(
		({ scopeSel, dlOnly, exts }) => {
			type AnchorLike = { href?: string; textContent?: string | null; hasAttribute?(name: string): boolean };
			type QueryRootLike = {
				querySelector?(selector: string): QueryRootLike | null;
				querySelectorAll(selector: string): { forEach(cb: (a: AnchorLike) => void): void };
			};
			type DocumentLike = QueryRootLike;
			const doc = (globalThis as unknown as { document: DocumentLike }).document;

			const root: QueryRootLike | null = scopeSel ? (doc.querySelector ? doc.querySelector(scopeSel) : null) : doc;
			if (!root) return [] as Array<{ url: string; text: string }>;

			const extOk = (href: string): boolean => {
				if (!exts || exts.length === 0) return true;
				try {
					const u = new URL(href);
					const p = (u.pathname || '').toLowerCase();
					return (exts as string[]).some((e) => p.endsWith(e));
				} catch {
					return false;
				}
			};

			const links: Array<{ url: string; text: string }> = [];
			root.querySelectorAll('a[href]').forEach((a) => {
				if (dlOnly && !(typeof a.hasAttribute === 'function' && a.hasAttribute('download'))) return;
				const href = typeof a.href === 'string' ? a.href : '';
				const text = (a.textContent ?? '').trim().slice(0, 100);
				if (href && href.startsWith('http') && extOk(href)) {
					links.push({ url: href, text });
				}
			});
			return links;
		},
		{ scopeSel: scope || null, dlOnly: !!downloadOnly, exts: extFilters },
	);

	const total = allLinks.length;
	const paginated = allLinks.slice(offset, offset + limit);
	return {
		links: paginated,
		pagination: { total, offset, limit, hasMore: offset + limit < total },
	};
}

export async function screenshotTab(tabState: TabState, fullPage: boolean): Promise<Buffer> {
	const buffer = await tabState.page.screenshot({ type: 'png', fullPage });
	return buffer as Buffer;
}

export async function waitTab(tabState: TabState, params: { timeout: number; waitForNetwork: boolean }): Promise<{ ok: true; ready: boolean }>{
	const ready = await waitForPageReady(tabState.page, { timeout: params.timeout, waitForNetwork: params.waitForNetwork });
	return { ok: true as const, ready };
}
