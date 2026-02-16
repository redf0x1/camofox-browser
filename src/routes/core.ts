import crypto from 'node:crypto';

import express, { Router, type Request, type Response } from 'express';

import { safeError } from '../middleware/errors';
import { log } from '../middleware/logging';
import { isAuthorizedWithApiKey } from '../middleware/auth';
import { loadConfig } from '../utils/config';
import { getAllPresets, resolveContextOptions, validateContextOptions } from '../utils/presets';
import { ensureBrowser } from '../services/browser';
import {
	MAX_TABS_PER_SESSION,
	findTabById,
	getSession,
	getSessionMapKey,
	getSessionsForUser,
	getTabGroup,
	indexTab,
	normalizeUserId,
	unindexTab,
	closeSessionsForUser,
	countTotalTabsForSessions,
} from '../services/session';
import {
	backTab,
	buildRefs,
	clickTab,
	createTabState,
	evaluateTab,
	forwardTab,
	getLinks,
	pressTab,
	refreshTab,
	screenshotTab,
	scrollElementTab,
	snapshotTab,
	typeTab,
	validateUrl,
	waitForPageReady,
	withTabLock,
} from '../services/tab';

import type { CookieInput, ContextOverrides } from '../types';

const CONFIG = loadConfig();

const router = Router();

// Import cookies into a user's browser context (Playwright cookies format)
// POST /sessions/:userId/cookies { cookies: Cookie[] }
router.post(
	'/sessions/:userId/cookies',
	express.json({ limit: '512kb' }),
	async (req: Request<{ userId: string }, unknown, { cookies?: unknown; tabId?: unknown }>, res: Response) => {
		try {
			if (!CONFIG.apiKey) {
				return res.status(403).json({
					error: 'Cookie import is disabled. Set CAMOFOX_API_KEY to enable this endpoint.',
				});
			}

			if (!isAuthorizedWithApiKey(req, CONFIG.apiKey)) {
				return res.status(403).json({ error: 'Forbidden' });
			}

			const userId = req.params.userId;
			if (!req.body || !('cookies' in req.body)) {
				return res.status(400).json({ error: 'Missing "cookies" field in request body' });
			}

			const { cookies: cookiesUnknown, tabId: tabIdUnknown } = req.body as { cookies?: unknown; tabId?: unknown };
			if (!Array.isArray(cookiesUnknown)) {
				return res.status(400).json({ error: 'cookies must be an array' });
			}
			if (tabIdUnknown !== undefined && (typeof tabIdUnknown !== 'string' || !tabIdUnknown)) {
				return res.status(400).json({ error: 'tabId must be a non-empty string' });
			}
			const cookies = cookiesUnknown as CookieInput[];

			if (cookies.length > 500) {
				return res.status(400).json({ error: 'Too many cookies. Maximum 500 per request.' });
			}

			const invalid: Array<{ index: number; error?: string; missing?: string[] }> = [];
			for (let i = 0; i < cookies.length; i++) {
				const c = cookies[i];
				const missing: string[] = [];
				if (!c || typeof c !== 'object') {
					invalid.push({ index: i, error: 'cookie must be an object' });
					continue;
				}
				if (typeof c.name !== 'string' || !c.name) missing.push('name');
				if (typeof c.value !== 'string') missing.push('value');
				if (typeof c.domain !== 'string' || !c.domain) missing.push('domain');
				if (missing.length) invalid.push({ index: i, missing });
			}
			if (invalid.length) {
				return res.status(400).json({
					error: 'Invalid cookie objects: each cookie must include name, value, and domain',
					invalid,
				});
			}

			const allowedFields = ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'] as const;
			const sanitized = cookies.map((c) => {
				const clean: Record<string, unknown> = {};
				for (const k of allowedFields) {
					const value = (c as unknown as Record<string, unknown>)[k];
					if (value !== undefined) clean[k] = value;
				}
				return clean;
			});

			let session: Awaited<ReturnType<typeof getSession>>;
			if (tabIdUnknown) {
				const found = findTabById(tabIdUnknown, userId);
				if (!found) return res.status(404).json({ error: 'Tab not found' });
				session = found.session;
			} else {
				session = await getSession(userId);
			}
			await session.context.addCookies(sanitized as never);
			const result = { ok: true, userId: String(userId), count: sanitized.length };
			log('info', 'cookies imported', { reqId: req.reqId, userId: String(userId), count: sanitized.length });
			return res.json(result);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log('error', 'cookie import failed', { reqId: req.reqId, error: message });
			return res.status(500).json({ error: safeError(err) });
		}
	},
);

// Export cookies from a tab's browser context
router.get(
	'/tabs/:tabId/cookies',
	async (req: Request<{ tabId: string }, unknown, unknown, { userId?: unknown }>, res: Response) => {
		try {
			if (!CONFIG.apiKey) {
				return res.status(403).json({
					error: 'Cookie export is disabled. Set CAMOFOX_API_KEY to enable this endpoint.',
				});
			}

			if (!isAuthorizedWithApiKey(req as unknown as Request, CONFIG.apiKey)) {
				return res.status(403).json({ error: 'Forbidden' });
			}

			const userId = req.query.userId;
			const tabId = req.params.tabId;
			const found = findTabById(tabId, userId);
			if (!found) return res.status(404).json({ error: 'Tab not found' });

			const { session } = found;
			const cookies = await session.context.cookies();

			log('info', 'cookies exported', {
				reqId: req.reqId,
				tabId,
				userId: String(userId),
				count: cookies.length,
			});
			return res.json(cookies);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log('error', 'cookie export failed', { reqId: req.reqId, error: message });
			return res.status(500).json({ error: safeError(err) });
		}
	},
);

// Health check
router.get('/health', async (_req: Request, res: Response) => {
	try {
		const b = await ensureBrowser();
		res.json({ ok: true, running: b.isConnected(), engine: 'camoufox', browserConnected: b.isConnected() });
	} catch (err) {
		res.status(500).json({ ok: false, error: safeError(err) });
	}
});

// GET /presets — List available presets
router.get('/presets', (_req: Request, res: Response) => {
	const presets = getAllPresets();
	const result: Record<string, unknown> = {};
	for (const [name, options] of Object.entries(presets)) {
		const opts = options as Record<string, unknown>;
		result[name] = {
			locale: opts.locale,
			timezoneId: opts.timezoneId,
			geolocation: opts.geolocation,
		};
	}
	res.json({ presets: result });
});

// Create new tab
router.post(
	'/tabs',
	async (
		req: Request<
			Record<string, never>,
			unknown,
			{
				userId?: unknown;
				sessionKey?: string;
				listItemId?: string;
				url?: string;
				preset?: string;
				locale?: string;
				timezoneId?: string;
				geolocation?: unknown;
				viewport?: unknown;
			}
		>,
		res: Response,
	) => {
		try {
			const { userId, sessionKey, listItemId, url, preset, locale, timezoneId, geolocation, viewport } = req.body;
			const resolvedSessionKey = sessionKey || listItemId;
			if (!userId || !resolvedSessionKey) {
				return res.status(400).json({ error: 'userId and sessionKey required' });
			}

			let contextOverrides: ContextOverrides | null = null;
			try {
				contextOverrides = resolveContextOptions({ preset, locale, timezoneId, geolocation, viewport });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return res.status(400).json({ error: message });
			}
			if (contextOverrides) {
				const validationError = validateContextOptions(contextOverrides);
				if (validationError) return res.status(400).json({ error: validationError });
			}

			const sessionMapKey = getSessionMapKey(userId, contextOverrides);
			const session = await getSession(userId, contextOverrides);

			const totalTabs = countTotalTabsForSessions([[sessionMapKey, session]]);
			if (totalTabs >= MAX_TABS_PER_SESSION) {
				return res.status(429).json({ error: 'Maximum tabs per session reached' });
			}

			const group = getTabGroup(session, resolvedSessionKey);
			const page = await session.context.newPage();
			const tabId = crypto.randomUUID();
			const tabState = createTabState(page);
			group.set(tabId, tabState);
			indexTab(tabId, sessionMapKey);

			if (url) {
				const urlErr = validateUrl(url);
				if (urlErr) return res.status(400).json({ error: urlErr });
				await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
				tabState.visitedUrls.add(url);
			}

			log('info', 'tab created', {
				reqId: req.reqId,
				tabId,
				userId,
				sessionKey: resolvedSessionKey,
				url: page.url(),
			});
			return res.json({ tabId, url: page.url() });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log('error', 'tab create failed', { reqId: req.reqId, error: message });
			return res.status(500).json({ error: safeError(err) });
		}
	},
);

// GET /tabs - List all tabs (OpenClaw expects this)
router.get('/tabs', async (req: Request<unknown, unknown, unknown, { userId?: unknown }>, res: Response) => {
	try {
		const userId = req.query.userId;
		const tabs: Array<{ targetId: string; tabId: string; url: string; title: string; listItemId: string }> = [];
		const sessionsForUser = getSessionsForUser(userId);
		if (!sessionsForUser.length) return res.json({ running: true, tabs: [] });

		for (const [, session] of sessionsForUser) {
			for (const [listItemId, group] of session.tabGroups) {
				for (const [tabId, tabState] of group) {
					tabs.push({
						targetId: tabId,
						tabId,
						url: tabState.page.url(),
						title: await tabState.page.title().catch(() => ''),
						listItemId,
					});
				}
			}
		}

		return res.json({ running: true, tabs });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'list tabs failed', { reqId: req.reqId, error: message });
		return res.status(500).json({ error: safeError(err) });
	}
});

// Navigate
router.post('/tabs/:tabId/navigate', async (req: Request<{ tabId: string }, unknown, { userId?: unknown; url?: string; macro?: string; query?: string }>, res: Response) => {
	const tabId = req.params.tabId;
	try {
		const { userId, url, macro, query } = req.body;
		const found = findTabById(tabId, userId);
		if (!found) return res.status(404).json({ error: 'Tab not found' });

		const { tabState } = found;
		tabState.toolCalls++;

		const result = await withTabLock(tabId, async () => {
			let targetUrl = url;
			if (macro) {
				// Reuse the same macro expansion as the legacy server implementation.
				targetUrl = (await import('../utils/macros')).expandMacro(macro, query) || url;
			}
			if (!targetUrl) return { status: 400 as const, body: { error: 'url or macro required' } };

			const urlErr = validateUrl(targetUrl);
			if (urlErr) return { status: 400 as const, body: { error: urlErr } };

			await tabState.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
			tabState.visitedUrls.add(targetUrl);
			tabState.refs = await buildRefs(tabState.page);
			return { status: 200 as const, body: { ok: true, url: tabState.page.url() } };
		});

		if (result.status !== 200) return res.status(result.status).json(result.body);

		log('info', 'navigated', { reqId: req.reqId, tabId, url: result.body.url });
		return res.json(result.body);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'navigate failed', { reqId: req.reqId, tabId, error: message });
		return res.status(500).json({ error: safeError(err) });
	}
});

// Snapshot
router.get('/tabs/:tabId/snapshot', async (req: Request<{ tabId: string }, unknown, unknown, { userId?: unknown }>, res: Response) => {
	try {
		const userId = req.query.userId;
		const tabId = req.params.tabId;
		const found = findTabById(tabId, userId);
		if (!found) return res.status(404).json({ error: 'Tab not found' });

		const { tabState } = found;
		tabState.toolCalls++;
		const result = await snapshotTab(tabState);
		log('info', 'snapshot', {
			reqId: req.reqId,
			tabId,
			url: result.url,
			snapshotLen: (result.snapshot as string | undefined)?.length,
			refsCount: result.refsCount,
		});
		return res.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'snapshot failed', { reqId: req.reqId, tabId: req.params.tabId, error: message });
		return res.status(500).json({ error: safeError(err) });
	}
});

// Wait for page ready
router.post('/tabs/:tabId/wait', async (req: Request<{ tabId: string }, unknown, { userId?: unknown; timeout?: number; waitForNetwork?: boolean }>, res: Response) => {
	try {
		const { userId, timeout = 10000, waitForNetwork = true } = req.body;
		const found = findTabById(req.params.tabId, userId);
		if (!found) return res.status(404).json({ error: 'Tab not found' });

		const { tabState } = found;
		const ready = await waitForPageReady(tabState.page, { timeout, waitForNetwork });
		return res.json({ ok: true, ready });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'wait failed', { reqId: req.reqId, error: message });
		return res.status(500).json({ error: safeError(err) });
	}
});

// Click
router.post('/tabs/:tabId/click', async (req: Request<{ tabId: string }, unknown, { userId?: unknown; ref?: string; selector?: string }>, res: Response) => {
	const tabId = req.params.tabId;
	try {
		const { userId, ref, selector } = req.body;
		const found = findTabById(tabId, userId);
		if (!found) return res.status(404).json({ error: 'Tab not found' });
		const { tabState } = found;
		tabState.toolCalls++;

		const result = await clickTab(tabId, tabState, { ref, selector });
		log('info', 'clicked', { reqId: req.reqId, tabId, url: result.url });
		return res.json(result);
	} catch (err) {
		const statusCode = (err as { statusCode?: number } | null)?.statusCode;
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'click failed', { reqId: req.reqId, tabId, error: message });
		if (statusCode === 400) return res.status(400).json({ error: message });
		return res.status(500).json({ error: safeError(err) });
	}
});

// Type
router.post('/tabs/:tabId/type', async (req: Request<{ tabId: string }, unknown, { userId?: unknown; ref?: string; selector?: string; text?: string }>, res: Response) => {
	const tabId = req.params.tabId;
	try {
		const { userId, ref, selector, text } = req.body;
		const found = findTabById(tabId, userId);
		if (!found) return res.status(404).json({ error: 'Tab not found' });

		const { tabState } = found;
		tabState.toolCalls++;

		const result = await typeTab(tabId, tabState, { ref, selector, text: String(text ?? '') });
		return res.json(result);
	} catch (err) {
		const statusCode = (err as { statusCode?: number } | null)?.statusCode;
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'type failed', { reqId: req.reqId, error: message });
		if (statusCode === 400) return res.status(400).json({ error: message });
		return res.status(500).json({ error: safeError(err) });
	}
});

// Press key
router.post('/tabs/:tabId/press', async (req: Request<{ tabId: string }, unknown, { userId?: unknown; key?: string }>, res: Response) => {
	const tabId = req.params.tabId;
	try {
		const { userId, key } = req.body;
		const found = findTabById(tabId, userId);
		if (!found) return res.status(404).json({ error: 'Tab not found' });
		const { tabState } = found;
		tabState.toolCalls++;
		await pressTab(tabId, tabState, String(key ?? ''));
		return res.json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'press failed', { reqId: req.reqId, error: message });
		return res.status(500).json({ error: safeError(err) });
	}
});

// Scroll
router.post('/tabs/:tabId/scroll', async (req: Request<{ tabId: string }, unknown, { userId?: unknown; direction?: 'up' | 'down'; amount?: number }>, res: Response) => {
	try {
		const { userId, direction = 'down', amount = 500 } = req.body;
		const found = findTabById(req.params.tabId, userId);
		if (!found) return res.status(404).json({ error: 'Tab not found' });
		const { tabState } = found;
		tabState.toolCalls++;
		const delta = direction === 'up' ? -amount : amount;
		await tabState.page.mouse.wheel(0, delta);
		await tabState.page.waitForTimeout(300);
		return res.json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'scroll failed', { reqId: req.reqId, error: message });
		return res.status(500).json({ error: safeError(err) });
	}
});

// Scroll element (selector or ref)
router.post(
	'/tabs/:tabId/scroll-element',
	async (
		req: Request<
			{ tabId: string },
			unknown,
			{
				userId?: unknown;
				selector?: string;
				ref?: string;
				deltaX?: number;
				deltaY?: number;
				scrollTo?: { top?: number; left?: number };
			}
		>,
		res: Response,
	) => {
		const tabId = req.params.tabId;
		try {
			const { userId, selector, ref, deltaX, deltaY, scrollTo } = req.body;
			const found = findTabById(tabId, userId);
			if (!found) return res.status(404).json({ error: 'Tab not found' });
			const { tabState } = found;
			tabState.toolCalls++;

			const result = await scrollElementTab(tabId, tabState, { selector, ref, deltaX, deltaY, scrollTo });
			return res.json(result);
		} catch (err) {
			const statusCode = (err as { statusCode?: number } | null)?.statusCode;
			const message = err instanceof Error ? err.message : String(err);
			log('error', 'scroll-element failed', { reqId: req.reqId, tabId, error: message });
			if (statusCode === 400) return res.status(400).json({ error: message });
			return res.status(500).json({ error: safeError(err) });
		}
	},
);

// Evaluate JS (requires API key)
router.post(
	'/tabs/:tabId/evaluate',
	express.json({ limit: '64kb' }),
	async (req: Request<{ tabId: string }, unknown, { userId?: unknown; expression?: unknown; timeout?: number }>, res: Response) => {
		const tabId = req.params.tabId;
		try {
			if (!CONFIG.apiKey) {
				return res.status(403).json({
					error: 'JavaScript evaluation is disabled. Set CAMOFOX_API_KEY to enable this endpoint.',
				});
			}

			if (!isAuthorizedWithApiKey(req as unknown as Request, CONFIG.apiKey)) {
				return res.status(403).json({ error: 'Forbidden' });
			}

			const { userId, expression, timeout } = req.body;
			if (!expression || typeof expression !== 'string') {
				return res.status(400).json({ error: 'expression is required and must be a string' });
			}
			if (expression.length > 65536) {
				return res.status(400).json({ error: 'expression exceeds maximum length of 64KB' });
			}

			const found = findTabById(tabId, userId);
			if (!found) return res.status(404).json({ error: 'Tab not found' });
			const { tabState } = found;
			tabState.toolCalls++;

			const result = await evaluateTab(tabId, tabState, { expression, timeout });
			return res.json(result);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log('error', 'evaluate failed', { reqId: req.reqId, tabId, error: message });
			return res.status(500).json({ error: safeError(err) });
		}
	},
);

// Back
router.post('/tabs/:tabId/back', async (req: Request<{ tabId: string }, unknown, { userId?: unknown }>, res: Response) => {
	const tabId = req.params.tabId;
	try {
		const { userId } = req.body;
		const found = findTabById(tabId, userId);
		if (!found) return res.status(404).json({ error: 'Tab not found' });
		const { tabState } = found;
		tabState.toolCalls++;
		const result = await backTab(tabId, tabState);
		return res.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'back failed', { reqId: req.reqId, error: message });
		return res.status(500).json({ error: safeError(err) });
	}
});

// Forward
router.post('/tabs/:tabId/forward', async (req: Request<{ tabId: string }, unknown, { userId?: unknown }>, res: Response) => {
	const tabId = req.params.tabId;
	try {
		const { userId } = req.body;
		const found = findTabById(tabId, userId);
		if (!found) return res.status(404).json({ error: 'Tab not found' });
		const { tabState } = found;
		tabState.toolCalls++;
		const result = await forwardTab(tabId, tabState);
		return res.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'forward failed', { reqId: req.reqId, error: message });
		return res.status(500).json({ error: safeError(err) });
	}
});

// Refresh
router.post('/tabs/:tabId/refresh', async (req: Request<{ tabId: string }, unknown, { userId?: unknown }>, res: Response) => {
	const tabId = req.params.tabId;
	try {
		const { userId } = req.body;
		const found = findTabById(tabId, userId);
		if (!found) return res.status(404).json({ error: 'Tab not found' });
		const { tabState } = found;
		tabState.toolCalls++;
		const result = await refreshTab(tabId, tabState);
		return res.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'refresh failed', { reqId: req.reqId, error: message });
		return res.status(500).json({ error: safeError(err) });
	}
});

// Get links
router.get('/tabs/:tabId/links', async (req: Request<{ tabId: string }, unknown, unknown, { userId?: unknown; limit?: string; offset?: string }>, res: Response) => {
	try {
		const userId = req.query.userId;
		const limit = Number.parseInt(String(req.query.limit ?? ''), 10) || 50;
		const offset = Number.parseInt(String(req.query.offset ?? ''), 10) || 0;
		const found = findTabById(req.params.tabId, userId);
		if (!found) {
			log('warn', 'links: tab not found', { reqId: req.reqId, tabId: req.params.tabId, userId });
			return res.status(404).json({ error: 'Tab not found' });
		}

		const { tabState } = found;
		tabState.toolCalls++;
		const result = await getLinks(tabState, { limit, offset });
		return res.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'links failed', { reqId: req.reqId, error: message });
		return res.status(500).json({ error: safeError(err) });
	}
});

// Screenshot
router.get('/tabs/:tabId/screenshot', async (req: Request<{ tabId: string }, unknown, unknown, { userId?: unknown; fullPage?: string }>, res: Response) => {
	try {
		const userId = req.query.userId;
		const fullPage = req.query.fullPage === 'true';
		const found = findTabById(req.params.tabId, userId);
		if (!found) return res.status(404).json({ error: 'Tab not found' });
		const { tabState } = found;
		const buffer = await screenshotTab(tabState, fullPage);
		res.set('Content-Type', 'image/png');
		return res.send(buffer);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'screenshot failed', { reqId: req.reqId, error: message });
		return res.status(500).json({ error: safeError(err) });
	}
});

// Stats
router.get('/tabs/:tabId/stats', async (req: Request<{ tabId: string }, unknown, unknown, { userId?: unknown }>, res: Response) => {
	try {
		const userId = req.query.userId;
		const found = findTabById(req.params.tabId, userId);
		if (!found) return res.status(404).json({ error: 'Tab not found' });
		const { tabState, listItemId } = found;
		return res.json({
			tabId: req.params.tabId,
			sessionKey: listItemId,
			listItemId,
			url: tabState.page.url(),
			visitedUrls: Array.from(tabState.visitedUrls),
			toolCalls: tabState.toolCalls,
			refsCount: tabState.refs.size,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'stats failed', { reqId: req.reqId, error: message });
		return res.status(500).json({ error: safeError(err) });
	}
});

// Close tab
router.delete('/tabs/:tabId', async (req: Request<{ tabId: string }, unknown, { userId?: unknown }>, res: Response) => {
	try {
		const { userId } = req.body;
		const found = findTabById(req.params.tabId, userId);
		if (found) {
			await found.tabState.page.close();
			found.group.delete(req.params.tabId);
			unindexTab(req.params.tabId);
			if (found.group.size === 0) {
				found.session.tabGroups.delete(found.listItemId);
			}
			log('info', 'tab closed', { reqId: req.reqId, tabId: req.params.tabId, userId });
		}
		return res.json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'tab close failed', { reqId: req.reqId, error: message });
		return res.status(500).json({ error: safeError(err) });
	}
});

// Close tab group
router.delete('/tabs/group/:listItemId', async (req: Request<{ listItemId: string }, unknown, { userId?: unknown }>, res: Response) => {
	try {
		const { userId } = req.body;
		const sessionsForUser = getSessionsForUser(userId);
		for (const [sessionKey, session] of sessionsForUser) {
			const group = session?.tabGroups.get(req.params.listItemId);
			if (!group) continue;
			for (const [tabId, tabState] of group) {
				await tabState.page.close().catch(() => {});
				unindexTab(tabId);
			}
			session.tabGroups.delete(req.params.listItemId);
			log('info', 'tab group closed', {
				reqId: req.reqId,
				listItemId: req.params.listItemId,
				userId,
				sessionKey,
			});
		}
		return res.json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'tab group close failed', { reqId: req.reqId, error: message });
		return res.status(500).json({ error: safeError(err) });
	}
});

// Close session
router.delete('/sessions/:userId', async (req: Request<{ userId: string }>, res: Response) => {
	try {
		const userId = normalizeUserId(req.params.userId);
		await closeSessionsForUser(userId);
		return res.json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'session close failed', { error: message });
		return res.status(500).json({ error: safeError(err) });
	}
});

export default router;
