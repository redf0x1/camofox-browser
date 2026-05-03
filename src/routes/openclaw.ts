import crypto from 'node:crypto';
import fs from 'node:fs';
import { resolve } from 'node:path';

import { Router, type Request, type Response } from 'express';
import type { Locator } from 'playwright-core';

import { safeError } from '../middleware/errors';
import { log } from '../middleware/logging';
import { isAuthorizedWithAdminKey, isAuthorizedWithApiKey } from '../middleware/auth';
import { loadConfig } from '../utils/config';
import { closeBrowser } from '../services/browser';
import { contextPool } from '../services/context-pool';
import { registerDownloadListener } from '../services/download';
import {
	MAX_TABS_PER_SESSION,
	closeAllSessions,
	clearAllState,
	countTotalTabsForSessions,
	findTabById,
	getCanonicalProfile,
	getSession,
	getSessionMapKey,
	getTabGroup,
	indexTab,
	unindexTab,
	withUserLimit,
} from '../services/session';
import {
	buildSnapshotPayload,
	buildRefs,
	createTabState,
	flushBlockedNavigationError,
	navigateWithSafetyGuard,
	refToLocator,
	safePageClose,
	snapshotTab,
	smartFill,
	validateNavigationUrl,
	withBlockedNavigationTracking,
	withTabLock,
	withTimeout,
} from '../services/tab';

const CONFIG = loadConfig();
const PKG_VERSION = (() => {
	const pkgPath = resolve(__dirname, '../../../package.json');
	const raw = fs.readFileSync(pkgPath, 'utf8');
	const pkg = JSON.parse(raw) as { version?: unknown };
	if (typeof pkg.version !== 'string' || pkg.version.trim().length === 0) {
		throw new Error('Unable to resolve server version from package.json');
	}
	return pkg.version;
})();

const router = Router();

function getRouteErrorStatus(err: unknown): number {
	if (typeof err === 'object' && err !== null && 'statusCode' in err && typeof err.statusCode === 'number') {
		return err.statusCode;
	}
	if (typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number') {
		return err.status;
	}
	return 500;
}


type LoadStateLike = 'load' | 'domcontentloaded' | 'networkidle';

function isLoadState(value: string): value is LoadStateLike {
	return value === 'load' || value === 'domcontentloaded' || value === 'networkidle';
}

// GET / - Status (alias for GET /health)
router.get('/', async (_req: Request, res: Response) => {
	try {
		const activeUserIds = contextPool.listActiveUserIds();
		let profileDirsTotal = 0;
		try {
			profileDirsTotal = fs
				.readdirSync(CONFIG.profilesDir, { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.length;
		} catch {
			profileDirsTotal = 0;
		}

		res.json({
			ok: true,
			enabled: true,
			running: true,
			engine: 'camoufox',
			version: PKG_VERSION,
			browserConnected: activeUserIds.length > 0,
			poolSize: contextPool.size(),
			activeUserIds,
			profileDirsTotal,
		});
	} catch (err) {
		res.status(500).json({ ok: false, error: safeError(err) });
	}
});

// POST /tabs/open - Open tab (alias for POST /tabs, OpenClaw format)
router.post('/tabs/open', async (req: Request<unknown, unknown, { url?: string; userId?: unknown; listItemId?: string; proxyProfile?: string; proxy?: unknown; geoMode?: string }>, res: Response) => {
	try {
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req as unknown as Request, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		const { url, userId, listItemId = 'default', proxyProfile, proxy, geoMode } = req.body;
		if (!userId) {
			return res.status(400).json({ error: 'userId is required' });
		}
		if (!url) {
			return res.status(400).json({ error: 'url is required' });
		}

		// Validate proxy fields if provided
		if (proxyProfile || proxy || geoMode) {
			const { resolveSessionProfileInput, getConfiguredServerProxy, loadProxyProfiles } = await import('../utils/proxy-profiles');
			const profileInput = {
				proxy: proxy as any,
				proxyProfile,
				geoMode: geoMode as any,
			};
			const deps = {
				serverProxy: getConfiguredServerProxy(CONFIG.proxy),
				proxyProfiles: loadProxyProfiles(CONFIG.proxyProfilesFile),
			};
			try {
				// Validate the fields are well-formed
				resolveSessionProfileInput(profileInput, deps);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return res.status(400).json({ error: message });
			}
		}

		const urlErr = await validateNavigationUrl(url, {
			allowPrivateNetworkTargets: CONFIG.allowPrivateNetworkTargets,
		});
		if (urlErr) return res.status(400).json({ error: urlErr });

		const canonical = getCanonicalProfile(userId);
		if (!canonical) {
			log('warn', 'openclaw tab open rejected: no canonical profile', { userId: String(userId) });
			return res.status(409).json({
				error: 'No canonical profile',
				message: 'Cannot open tabs via this endpoint without an established canonical profile. Use core POST /tabs first.',
			});
		}

		const sessionMapKey = getSessionMapKey(userId, canonical.resolvedOverrides);
		const session = await getSession(userId, canonical.resolvedOverrides);

		const totalTabs = countTotalTabsForSessions([[sessionMapKey, session]]);
		if (totalTabs >= MAX_TABS_PER_SESSION) {
			return res.status(429).json({ error: 'Maximum tabs per session reached' });
		}

		const group = getTabGroup(session, listItemId);
		const page = await session.context.newPage();
		const tabId = crypto.randomUUID();
		const tabState = await createTabState(page);
		group.set(tabId, tabState);
		indexTab(tabId, sessionMapKey);
		registerDownloadListener(tabId, String(userId), page);

		await navigateWithSafetyGuard(page, url, {
			allowPrivateNetworkTargets: CONFIG.allowPrivateNetworkTargets,
			waitUntil: 'domcontentloaded',
			timeout: 30000,
		});
		tabState.visitedUrls.add(url);

		log('info', 'openclaw tab opened', { reqId: req.reqId, tabId, url: page.url() });
		return res.json({
			ok: true,
			targetId: tabId,
			tabId,
			url: page.url(),
			title: await page.title().catch(() => ''),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'openclaw tab open failed', { reqId: req.reqId, error: message });
		return res.status(getRouteErrorStatus(err)).json({ error: safeError(err) });
	}
});

// POST /start - Start browser (OpenClaw expects this)
router.post('/start', async (_req: Request, res: Response) => {
	try {
		res.json({ ok: true, profile: 'camoufox' });
	} catch (err) {
		res.status(500).json({ ok: false, error: safeError(err) });
	}
});

// POST /stop - Stop browser (OpenClaw expects this)
router.post('/stop', async (req: Request, res: Response) => {
	try {
		if (!isAuthorizedWithAdminKey(req, CONFIG.adminKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		await closeAllSessions();
		await closeBrowser();
		clearAllState();
		res.json({ ok: true, stopped: true, profile: 'camoufox' });
	} catch (err) {
		res.status(500).json({ ok: false, error: safeError(err) });
	}
});

// POST /navigate - Navigate (OpenClaw format with targetId in body)
router.post('/navigate', async (req: Request<unknown, unknown, { targetId?: string; url?: string; macro?: string; query?: string; userId?: unknown }>, res: Response) => {
	try {
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req as unknown as Request, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		const { targetId, url, macro, query, userId } = req.body;
		if (!userId) {
			return res.status(400).json({ error: 'userId is required' });
		}
		if (!url && !macro) {
			return res.status(400).json({ error: 'url or macro required' });
		}

		const found = findTabById(String(targetId), userId);
		if (!found) {
			return res.status(404).json({ error: 'Tab not found' });
		}

		const { tabState } = found;
		tabState.toolCalls++;

		const result = await withUserLimit(String(userId), CONFIG.maxConcurrentPerUser, () =>
			withTimeout(
				withTabLock(String(targetId), async () => {
					let targetUrl = url;
					if (macro) {
						const { expandMacro } = await import('../utils/macros');
						targetUrl = expandMacro(macro, query) || url;
					}
					if (!targetUrl) return { status: 400 as const, body: { error: 'url or macro required' } };

					const urlErr = await validateNavigationUrl(targetUrl, {
						allowPrivateNetworkTargets: CONFIG.allowPrivateNetworkTargets,
					});
					if (urlErr) return { status: 400 as const, body: { error: urlErr } };

					await navigateWithSafetyGuard(tabState.page, targetUrl, {
						allowPrivateNetworkTargets: CONFIG.allowPrivateNetworkTargets,
						waitUntil: 'domcontentloaded',
						timeout: 30000,
					});
					tabState.visitedUrls.add(targetUrl);
					tabState.refs = await buildRefs(tabState.page);
					return { status: 200 as const, body: { ok: true, targetId, url: tabState.page.url() } };
				}),
				CONFIG.handlerTimeoutMs,
				'openclaw-navigate',
			),
		);

		if (result.status !== 200) return res.status(result.status).json(result.body);
		return res.json(result.body);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'openclaw navigate failed', { reqId: req.reqId, error: message });
		return res.status(getRouteErrorStatus(err)).json({ error: safeError(err) });
	}
});

// GET /snapshot - Snapshot (OpenClaw format with query params)
router.get('/snapshot', async (req: Request<unknown, unknown, unknown, { targetId?: string; userId?: unknown; format?: string; offset?: string }>, res: Response) => {
	try {
		const { targetId, userId } = req.query;
		if (!userId) {
			return res.status(400).json({ error: 'userId is required' });
		}

		const found = findTabById(String(targetId), userId);
		if (!found) {
			return res.status(404).json({ error: 'Tab not found' });
		}

		const { tabState } = found;
		tabState.toolCalls++;

		const rawOffset = Number(req.query.offset);
		const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

		const raw = await withUserLimit(String(userId), CONFIG.maxConcurrentPerUser, () =>
			withTimeout(snapshotTab(tabState), CONFIG.handlerTimeoutMs, 'openclaw-snapshot'),
		);
		const payload = buildSnapshotPayload(raw, offset);

		return res.json({
			ok: true,
			format: 'aria',
			targetId,
			...payload,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'openclaw snapshot failed', { reqId: req.reqId, error: message });
		return res.status(getRouteErrorStatus(err)).json({ error: safeError(err) });
	}
});

// POST /act - Combined action endpoint (OpenClaw format)
router.post('/act', async (req: Request<unknown, unknown, Record<string, unknown>>, res: Response) => {
	try {
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req as unknown as Request, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		interface ActRequestBase {
			kind: string;
			targetId: string;
			userId: unknown;
		}
		interface ActClickRequest extends ActRequestBase {
			kind: 'click';
			ref?: string;
			selector?: string;
			doubleClick?: boolean;
		}
		interface ActTypeRequest extends ActRequestBase {
			kind: 'type';
			ref?: string;
			selector?: string;
			text: string;
			submit?: boolean;
		}
		interface ActSelectRequest extends ActRequestBase {
			kind: 'select';
			ref?: string;
			selector?: string;
			value: string;
		}
		interface ActPressRequest extends ActRequestBase {
			kind: 'press';
			key: string;
		}
		interface ActScrollRequest extends ActRequestBase {
			kind: 'scroll' | 'scrollIntoView';
			ref?: string;
			direction?: 'up' | 'down' | 'left' | 'right';
			amount?: number;
		}
		interface ActHoverRequest extends ActRequestBase {
			kind: 'hover';
			ref?: string;
			selector?: string;
		}
		interface ActWaitRequest extends ActRequestBase {
			kind: 'wait';
			timeMs?: number;
			text?: string;
			loadState?: LoadStateLike;
		}
		const body = req.body;
		const kind = typeof body.kind === 'string' ? body.kind : undefined;
		const targetId = typeof body.targetId === 'string' ? body.targetId : undefined;
		const userId = (body as { userId?: unknown }).userId;
		if (!userId) {
			return res.status(400).json({ error: 'userId is required' });
		}
		if (!kind) {
			return res.status(400).json({ error: 'kind is required' });
		}
		if (!targetId) {
			return res.status(400).json({ error: 'targetId is required' });
		}

		const found = findTabById(targetId, userId);
		if (!found) {
			return res.status(404).json({ error: 'Tab not found' });
		}

		const { tabState } = found;
		tabState.toolCalls++;

		const result = await withUserLimit(String(userId), CONFIG.maxConcurrentPerUser, () =>
			withTimeout(
				withTabLock(targetId, async () => {
			switch (kind) {
				case 'click': {
					const params = body as unknown as ActClickRequest;
					const { ref, selector, doubleClick } = params;
					if (!ref && !selector) {
						throw new Error('ref or selector required');
					}

					const doClick = async (target: Locator | string): Promise<void> => {
						const locator = typeof target === 'string' ? tabState.page.locator(target) : target;
						const clickOpts: { timeout: number; clickCount?: number; force?: boolean } = { timeout: 5000 };
						if (doubleClick) clickOpts.clickCount = 2;
						try {
							await locator.click(clickOpts);
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err);
							if (message.includes('intercepts pointer events')) {
								await locator.click({ ...clickOpts, force: true });
							} else {
								throw err;
							}
						}
					};

					await withBlockedNavigationTracking(tabState.page, async () => {
						if (ref) {
							const locator = await refToLocator(tabState.page, ref, tabState.refs);
							if (!locator) throw new Error(`Unknown ref: ${ref}`);
							await doClick(locator);
						} else {
							await doClick(String(selector));
						}
					});
					tabState.refs = await buildRefs(tabState.page);
					return { ok: true, targetId, url: tabState.page.url() };
				}

				case 'type': {
					const params = body as unknown as ActTypeRequest;
					const { ref, selector, text, submit } = params;
					if (!ref && !selector) {
						throw new Error('ref or selector required');
					}
					if (typeof text !== 'string' || text.length === 0) {
						throw new Error('text is required');
					}

					await withBlockedNavigationTracking(tabState.page, async () => {
						if (ref) {
							const locator = await refToLocator(tabState.page, ref, tabState.refs);
							if (!locator) throw new Error(`Unknown ref: ${ref}`);
							await smartFill(locator, tabState.page, text);
							if (submit) await tabState.page.keyboard.press('Enter');
						} else {
							const locator = tabState.page.locator(String(selector));
							await smartFill(locator, tabState.page, text);
							if (submit) await tabState.page.keyboard.press('Enter');
						}
					});
					return { ok: true, targetId };
				}

				case 'select': {
					const params = body as unknown as ActSelectRequest;
					const { ref, selector, value } = params;
					if (!ref && !selector) {
						throw new Error('ref or selector required');
					}
					if (typeof value !== 'string') {
						throw new Error('value is required');
					}

					await withBlockedNavigationTracking(tabState.page, async () => {
						if (ref) {
							const locator = await refToLocator(tabState.page, ref, tabState.refs);
							if (!locator) throw new Error(`Unknown ref: ${ref}`);
							await locator.selectOption(value);
						} else {
							await tabState.page.locator(String(selector)).selectOption(value);
						}
					});
					return { ok: true, targetId };
				}

				case 'press': {
					const params = body as unknown as ActPressRequest;
					const { key } = params;
					if (!key) throw new Error('key is required');
					await withBlockedNavigationTracking(tabState.page, async () => {
						await tabState.page.keyboard.press(key);
					});
					return { ok: true, targetId };
				}

				case 'scroll':
				case 'scrollIntoView': {
					const params = body as unknown as ActScrollRequest;
					const ref = params.ref;
					const direction = params.direction ?? 'down';
					const amount = params.amount ?? 500;
					await withBlockedNavigationTracking(tabState.page, async () => {
						if (ref) {
							const locator = await refToLocator(tabState.page, ref, tabState.refs);
							if (!locator) throw new Error(`Unknown ref: ${ref}`);
							await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
						} else {
							const isHorizontal = direction === 'left' || direction === 'right';
							const delta = direction === 'up' || direction === 'left' ? -amount : amount;
							await tabState.page.mouse.wheel(isHorizontal ? delta : 0, isHorizontal ? 0 : delta);
						}
						await tabState.page.waitForTimeout(300);
					});
					return { ok: true, targetId };
				}

				case 'hover': {
					const params = body as unknown as ActHoverRequest;
					const { ref, selector } = params;
					if (!ref && !selector) throw new Error('ref or selector required');
					await withBlockedNavigationTracking(tabState.page, async () => {
						if (ref) {
							const locator = await refToLocator(tabState.page, ref, tabState.refs);
							if (!locator) throw new Error(`Unknown ref: ${ref}`);
							await locator.hover({ timeout: 5000 });
						} else {
							await tabState.page.locator(String(selector)).hover({ timeout: 5000 });
						}
					});
					return { ok: true, targetId };
				}

				case 'wait': {
					const params = body as unknown as ActWaitRequest;
					const { timeMs, text } = params;
					const loadStateUnknown = (params as { loadState?: unknown }).loadState;
					const loadState = typeof loadStateUnknown === 'string' && isLoadState(loadStateUnknown) ? loadStateUnknown : undefined;
					await withBlockedNavigationTracking(tabState.page, async () => {
						try {
							if (timeMs) {
								await tabState.page.waitForTimeout(timeMs);
							} else if (text) {
								await tabState.page.waitForSelector(`text=${text}`, { timeout: 30000 });
							} else if (loadState) {
								await tabState.page.waitForLoadState(loadState, { timeout: 30000 });
							}
						} catch (err) {
							await flushBlockedNavigationError(tabState.page);
							throw err;
						}
					});
					return { ok: true, targetId, url: tabState.page.url() };
				}

				case 'close': {
					await safePageClose(tabState.page);
					found.group.delete(String(targetId));
					unindexTab(String(targetId));
					if (found.group.size === 0) {
						found.session.tabGroups.delete(found.listItemId);
					}
					return { ok: true, targetId };
				}

				default:
					throw new Error(`Unsupported action kind: ${kind}`);
			}
				}),
				CONFIG.handlerTimeoutMs,
				'act',
			),
		);

		return res.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const kindFromBody = typeof (req.body as { kind?: unknown }).kind === 'string' ? (req.body as { kind?: unknown }).kind : undefined;
		log('error', 'act failed', { reqId: req.reqId, kind: kindFromBody, error: message });
		return res.status(getRouteErrorStatus(err)).json({ error: safeError(err) });
	}
});

export default router;
