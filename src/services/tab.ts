import type { Locator, Page } from 'playwright-core';

import { expandMacro } from '../utils/macros';
import type { EvaluateResult, RefInfo, ScrollPosition, TabState, WaitForPageReadyOptions } from '../types';
import { log } from '../middleware/logging';

const ALLOWED_URL_SCHEMES: ReadonlyArray<'http:' | 'https:'> = ['http:', 'https:'];

// Interactive roles to include - exclude combobox to avoid opening complex widgets
// (date pickers, dropdowns) that can interfere with navigation
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
	// 'combobox' excluded - can trigger date pickers and complex dropdowns
];

// Patterns to skip (date pickers, calendar widgets)
const SKIP_PATTERNS: ReadonlyArray<RegExp> = [/date/i, /calendar/i, /picker/i, /datepicker/i];

const MAX_SNAPSHOT_NODES = 500;

const MAX_EVAL_TIMEOUT = 30000;
const DEFAULT_EVAL_TIMEOUT = 5000;
const MAX_RESULT_SIZE = 1048576; // 1MB

// Per-tab locks to serialize operations on the same tab
// tabId -> Promise (the currently executing operation)
const tabLocks = new Map<string, Promise<unknown>>();

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

export function validateUrl(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (!ALLOWED_URL_SCHEMES.includes(parsed.protocol as 'http:' | 'https:')) {
			return `Blocked URL scheme: ${parsed.protocol} (only http/https allowed)`;
		}
		return null;
	} catch {
		return `Invalid URL: ${url}`;
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

			if (normalizedRole === 'combobox') return line;
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
		return true;
	} catch (err) {
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
	const refs = new Map<string, RefInfo>();

	if (!page || page.isClosed()) {
		log('warn', 'buildRefs: page closed or invalid');
		return refs;
	}

	await waitForPageReady(page, { waitForNetwork: false });

	let ariaYaml: string | null;
	try {
		ariaYaml = await page.locator('body').ariaSnapshot({ timeout: 10000 });
	} catch {
		log('warn', 'ariaSnapshot failed, retrying');
		await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
		ariaYaml = await page.locator('body').ariaSnapshot({ timeout: 10000 });
	}

	if (!ariaYaml) {
		log('warn', 'buildRefs: no aria snapshot');
		return refs;
	}

	const lines = ariaYaml.split('\n');
	let refCounter = 1;
	const seenCounts = new Map<string, number>();

	for (const line of lines) {
		if (refCounter > MAX_SNAPSHOT_NODES) break;

		const match = line.match(/^\s*-\s+(\w+)(?:\s+\"([^\"]*)\")?/);
		if (match) {
			const [, role, name] = match;
			const normalizedRole = role.toLowerCase();
			if (normalizedRole === 'combobox') continue;
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
	return page.locator('body').ariaSnapshot({ timeout: 10000 });
}

export function refToLocator(page: Page, ref: string, refs: Map<string, RefInfo>): Locator | null {
	const info = refs.get(ref);
	if (!info) return null;

	const { role, name, nth } = info;
	let locator = page.getByRole(role as never, name ? ({ name } as never) : undefined);
	locator = locator.nth(nth);
	return locator;
}

export function createTabState(page: Page): TabState {
	return {
		page,
		refs: new Map(),
		visitedUrls: new Set(),
		toolCalls: 0,
	};
}

export async function navigateTab(tabId: string, tabState: TabState, params: { url?: string; macro?: string; query?: string }): Promise<{ ok: true; url: string }>{
	const { url, macro, query } = params;
	let targetUrl = url;
	if (macro) {
		targetUrl = expandMacro(macro, query) || url;
	}
	if (!targetUrl) {
		throw new Error('url or macro required');
	}

	const urlErr = validateUrl(targetUrl);
	if (urlErr) {
		const err = new Error(urlErr);
		// Used by routes to map to 400.
		(err as Error & { statusCode?: number }).statusCode = 400;
		throw err;
	}

	return withTabLock(tabId, async () => {
		await tabState.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
		tabState.visitedUrls.add(targetUrl);
		tabState.refs = await buildRefs(tabState.page);
		return { ok: true as const, url: tabState.page.url() };
	});
}

export async function snapshotTab(tabState: TabState): Promise<{ url: string; snapshot: string; refsCount: number }>{
	tabState.refs = await buildRefs(tabState.page);
	const ariaYaml = await getAriaSnapshot(tabState.page);
	const annotatedYaml = annotateAriaYamlWithRefs(ariaYaml, tabState.refs);
	return {
		url: tabState.page.url(),
		snapshot: annotatedYaml,
		refsCount: tabState.refs.size,
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

		if (ref) {
			const locator = refToLocator(tabState.page, ref, tabState.refs);
			if (!locator) {
				const maxRef = tabState.refs.size > 0 ? `e${tabState.refs.size}` : 'none';
				throw new Error(
					`Unknown ref: ${ref} (valid refs: e1-${maxRef}, ${tabState.refs.size} total). Refs reset after navigation - call snapshot first.`,
				);
			}
			await doClick(locator, true);
		} else {
			await doClick(selector as string, false);
		}

		await tabState.page.waitForTimeout(500);
		tabState.refs = await buildRefs(tabState.page);

		const newUrl = tabState.page.url();
		tabState.visitedUrls.add(newUrl);
		return { ok: true as const, url: newUrl };
	});
}

export async function typeTab(tabId: string, tabState: TabState, params: { ref?: string; selector?: string; text: string }): Promise<{ ok: true }>{
	const { ref, selector, text } = params;
	if (!ref && !selector) {
		const err = new Error('ref or selector required');
		(err as Error & { statusCode?: number }).statusCode = 400;
		throw err;
	}

	await withTabLock(tabId, async () => {
		if (ref) {
			const locator = refToLocator(tabState.page, ref, tabState.refs);
			if (!locator) throw new Error(`Unknown ref: ${ref}`);
			await locator.fill(text, { timeout: 10000 });
		} else {
			await tabState.page.fill(selector as string, text, { timeout: 10000 });
		}
	});

	return { ok: true as const };
}

export async function pressTab(tabId: string, tabState: TabState, key: string): Promise<{ ok: true }>{
	await withTabLock(tabId, async () => {
		await tabState.page.keyboard.press(key);
	});
	return { ok: true as const };
}

export async function scrollTab(tabState: TabState, params: { direction?: 'up' | 'down'; amount?: number }): Promise<{ ok: true }>{
	const { direction = 'down', amount = 500 } = params;
	const delta = direction === 'up' ? -amount : amount;
	await tabState.page.mouse.wheel(0, delta);
	await tabState.page.waitForTimeout(300);
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
			const resolved = refToLocator(page, ref, tabState.refs);
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
		}

		const count = await locator.count();
		if (count === 0) {
			const err = new Error(`Element not found: ${ref || selector}`);
			(err as Error & { statusCode?: number }).statusCode = 400;
			throw err;
		}

		const element = locator.first();

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
	return withTabLock(tabId, async () => {
		const page = tabState.page;
		const timeout = Math.min(Math.max(params.timeout ?? DEFAULT_EVAL_TIMEOUT, 100), MAX_EVAL_TIMEOUT);

		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<never>((_resolve, reject) => {
			timeoutId = setTimeout(() => reject(new Error('EVAL_TIMEOUT')), timeout);
		});

		try {
			const result = await Promise.race([page.evaluate(params.expression), timeoutPromise]);

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
			const message = err instanceof Error ? err.message : String(err);
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

export async function backTab(tabId: string, tabState: TabState): Promise<{ ok: true; url: string }>{
	return withTabLock(tabId, async () => {
		await tabState.page.goBack({ timeout: 10000 });
		tabState.refs = await buildRefs(tabState.page);
		return { ok: true as const, url: tabState.page.url() };
	});
}

export async function forwardTab(tabId: string, tabState: TabState): Promise<{ ok: true; url: string }>{
	return withTabLock(tabId, async () => {
		await tabState.page.goForward({ timeout: 10000 });
		tabState.refs = await buildRefs(tabState.page);
		return { ok: true as const, url: tabState.page.url() };
	});
}

export async function refreshTab(tabId: string, tabState: TabState): Promise<{ ok: true; url: string }>{
	return withTabLock(tabId, async () => {
		await tabState.page.reload({ timeout: 30000 });
		tabState.refs = await buildRefs(tabState.page);
		return { ok: true as const, url: tabState.page.url() };
	});
}

export async function getLinks(
	tabState: TabState,
	params: { limit: number; offset: number },
): Promise<{ links: Array<{ url: string; text: string }>; pagination: { total: number; offset: number; limit: number; hasMore: boolean } }>{
	const { limit, offset } = params;
	const allLinks = await tabState.page.evaluate(() => {
		type AnchorLike = { href?: string; textContent?: string | null };
		type DocumentLike = {
			querySelectorAll(selector: string): { forEach(cb: (a: AnchorLike) => void): void };
		};
		const doc = (globalThis as unknown as { document: DocumentLike }).document;
		const links: Array<{ url: string; text: string }> = [];
		doc.querySelectorAll('a[href]').forEach((a) => {
			const href = typeof a.href === 'string' ? a.href : '';
			const text = (a.textContent ?? '').trim().slice(0, 100);
			if (href && href.startsWith('http')) {
				links.push({ url: href, text });
			}
		});
		return links;
	});

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
