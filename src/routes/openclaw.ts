import crypto from 'node:crypto';

import { Router, type Request, type Response } from 'express';
import type { Locator } from 'playwright-core';

import { safeError } from '../middleware/errors';
import { log } from '../middleware/logging';
import { isAuthorizedWithAdminKey } from '../middleware/auth';
import { loadConfig } from '../utils/config';
import { ensureBrowser, getBrowser, closeBrowser } from '../services/browser';
import {
	MAX_TABS_PER_SESSION,
	clearAllState,
	countTotalTabsForSessions,
	findTabById,
	getSession,
	getSessionMapKey,
	getTabGroup,
	indexTab,
	unindexTab,
} from '../services/session';
import { annotateAriaYamlWithRefs, buildRefs, createTabState, getAriaSnapshot, refToLocator, smartFill, validateUrl, withTabLock } from '../services/tab';

const CONFIG = loadConfig();

const router = Router();


type LoadStateLike = 'load' | 'domcontentloaded' | 'networkidle';

function isLoadState(value: string): value is LoadStateLike {
	return value === 'load' || value === 'domcontentloaded' || value === 'networkidle';
}

// GET / - Status (alias for GET /health)
router.get('/', async (_req: Request, res: Response) => {
	try {
		const b = await ensureBrowser();
		res.json({
			ok: true,
			enabled: true,
			running: b.isConnected(),
			engine: 'camoufox',
			browserConnected: b.isConnected(),
		});
	} catch (err) {
		res.status(500).json({ ok: false, error: safeError(err) });
	}
});

// POST /tabs/open - Open tab (alias for POST /tabs, OpenClaw format)
router.post('/tabs/open', async (req: Request<unknown, unknown, { url?: string; userId?: unknown; listItemId?: string }>, res: Response) => {
	try {
		const { url, userId, listItemId = 'default' } = req.body;
		if (!userId) {
			return res.status(400).json({ error: 'userId is required' });
		}
		if (!url) {
			return res.status(400).json({ error: 'url is required' });
		}

		const urlErr = validateUrl(url);
		if (urlErr) return res.status(400).json({ error: urlErr });

		const sessionMapKey = getSessionMapKey(userId, null);
		const session = await getSession(userId);

		const totalTabs = countTotalTabsForSessions([[sessionMapKey, session]]);
		if (totalTabs >= MAX_TABS_PER_SESSION) {
			return res.status(429).json({ error: 'Maximum tabs per session reached' });
		}

		const group = getTabGroup(session, listItemId);
		const page = await session.context.newPage();
		const tabId = crypto.randomUUID();
		const tabState = createTabState(page);
		group.set(tabId, tabState);
		indexTab(tabId, sessionMapKey);

		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
		return res.status(500).json({ error: safeError(err) });
	}
});

// POST /start - Start browser (OpenClaw expects this)
router.post('/start', async (_req: Request, res: Response) => {
	try {
		await ensureBrowser();
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

		if (getBrowser()) {
			await closeBrowser();
		}
		clearAllState();
		res.json({ ok: true, stopped: true, profile: 'camoufox' });
	} catch (err) {
		res.status(500).json({ ok: false, error: safeError(err) });
	}
});

// POST /navigate - Navigate (OpenClaw format with targetId in body)
router.post('/navigate', async (req: Request<unknown, unknown, { targetId?: string; url?: string; userId?: unknown }>, res: Response) => {
	try {
		const { targetId, url, userId } = req.body;
		if (!userId) {
			return res.status(400).json({ error: 'userId is required' });
		}
		if (!url) {
			return res.status(400).json({ error: 'url is required' });
		}

		const urlErr = validateUrl(url);
		if (urlErr) return res.status(400).json({ error: urlErr });

		const found = findTabById(String(targetId), userId);
		if (!found) {
			return res.status(404).json({ error: 'Tab not found' });
		}

		const { tabState } = found;
		tabState.toolCalls++;

		const result = await withTabLock(String(targetId), async () => {
			await tabState.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
			tabState.visitedUrls.add(url);
			tabState.refs = await buildRefs(tabState.page);
			return { ok: true, targetId, url: tabState.page.url() };
		});

		return res.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'openclaw navigate failed', { reqId: req.reqId, error: message });
		return res.status(500).json({ error: safeError(err) });
	}
});

// GET /snapshot - Snapshot (OpenClaw format with query params)
router.get('/snapshot', async (req: Request<unknown, unknown, unknown, { targetId?: string; userId?: unknown; format?: string }>, res: Response) => {
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
		tabState.refs = await buildRefs(tabState.page);

		const ariaYaml = await getAriaSnapshot(tabState.page);
		const annotatedYaml = annotateAriaYamlWithRefs(ariaYaml, tabState.refs);

		return res.json({
			ok: true,
			format: 'aria',
			targetId,
			url: tabState.page.url(),
			snapshot: annotatedYaml,
			refsCount: tabState.refs.size,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'openclaw snapshot failed', { reqId: req.reqId, error: message });
		return res.status(500).json({ error: safeError(err) });
	}
});

// POST /act - Combined action endpoint (OpenClaw format)
router.post('/act', async (req: Request<unknown, unknown, Record<string, unknown>>, res: Response) => {
	try {
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
		interface ActPressRequest extends ActRequestBase {
			kind: 'press';
			key: string;
		}
		interface ActScrollRequest extends ActRequestBase {
			kind: 'scroll' | 'scrollIntoView';
			ref?: string;
			direction?: 'up' | 'down';
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

		const result = await withTabLock(targetId, async () => {
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

					if (ref) {
						const locator = refToLocator(tabState.page, ref, tabState.refs);
						if (!locator) throw new Error(`Unknown ref: ${ref}`);
						await doClick(locator);
					} else {
						await doClick(String(selector));
					}

					await tabState.page.waitForTimeout(500);
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

					if (ref) {
						const locator = refToLocator(tabState.page, ref, tabState.refs);
						if (!locator) throw new Error(`Unknown ref: ${ref}`);
						await smartFill(locator, tabState.page, text);
						if (submit) await tabState.page.keyboard.press('Enter');
					} else {
						const locator = tabState.page.locator(String(selector));
						await smartFill(locator, tabState.page, text);
						if (submit) await tabState.page.keyboard.press('Enter');
					}
					return { ok: true, targetId };
				}

				case 'press': {
					const params = body as unknown as ActPressRequest;
					const { key } = params;
					if (!key) throw new Error('key is required');
					await tabState.page.keyboard.press(key);
					return { ok: true, targetId };
				}

				case 'scroll':
				case 'scrollIntoView': {
					const params = body as unknown as ActScrollRequest;
					const ref = params.ref;
					const direction = params.direction ?? 'down';
					const amount = params.amount ?? 500;
					if (ref) {
						const locator = refToLocator(tabState.page, ref, tabState.refs);
						if (!locator) throw new Error(`Unknown ref: ${ref}`);
						await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
					} else {
						const delta = direction === 'up' ? -amount : amount;
						await tabState.page.mouse.wheel(0, delta);
					}
					await tabState.page.waitForTimeout(300);
					return { ok: true, targetId };
				}

				case 'hover': {
					const params = body as unknown as ActHoverRequest;
					const { ref, selector } = params;
					if (!ref && !selector) throw new Error('ref or selector required');
					if (ref) {
						const locator = refToLocator(tabState.page, ref, tabState.refs);
						if (!locator) throw new Error(`Unknown ref: ${ref}`);
						await locator.hover({ timeout: 5000 });
					} else {
						await tabState.page.locator(String(selector)).hover({ timeout: 5000 });
					}
					return { ok: true, targetId };
				}

				case 'wait': {
					const params = body as unknown as ActWaitRequest;
					const { timeMs, text } = params;
					const loadStateUnknown = (params as { loadState?: unknown }).loadState;
					const loadState = typeof loadStateUnknown === 'string' && isLoadState(loadStateUnknown) ? loadStateUnknown : undefined;
					if (timeMs) {
						await tabState.page.waitForTimeout(timeMs);
					} else if (text) {
						await tabState.page.waitForSelector(`text=${text}`, { timeout: 30000 });
					} else if (loadState) {
						await tabState.page.waitForLoadState(loadState, { timeout: 30000 });
					}
					return { ok: true, targetId, url: tabState.page.url() };
				}

				case 'close': {
					await tabState.page.close();
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
		});

		return res.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const kindFromBody = typeof (req.body as { kind?: unknown }).kind === 'string' ? (req.body as { kind?: unknown }).kind : undefined;
		log('error', 'act failed', { reqId: req.reqId, kind: kindFromBody, error: message });
		return res.status(500).json({ error: safeError(err) });
	}
});

export default router;
