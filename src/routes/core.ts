import crypto from 'node:crypto';
import fs from 'node:fs';

import express, { Router, type Request, type Response } from 'express';

import { safeError } from '../middleware/errors';
import { log } from '../middleware/logging';
import { isAuthorizedWithApiKey } from '../middleware/auth';
import { loadConfig } from '../utils/config';
import { getAllPresets, resolveContextOptions, validateContextOptions } from '../utils/presets';
import { contextPool } from '../services/context-pool';
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
	withUserLimit,
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
	safePageClose,
	validateUrl,
	waitForPageReady,
	withTimeout,
	withTabLock,
} from '../services/tab';

import {
	registerDownloadListener,
	listDownloads,
	getDownload,
	getDownloadPath,
	deleteDownload,
	getRecentDownloads,
	cleanupUserDownloads,
} from '../services/download';
import { extractResources, resolveBlob } from '../services/resource-extractor';
import { batchDownload } from '../services/batch-downloader';
import { getHealthState, recordNavFailure, recordNavSuccess } from '../services/health';

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
			if (CONFIG.apiKey && !isAuthorizedWithApiKey(req, CONFIG.apiKey)) {
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
			if (CONFIG.apiKey && !isAuthorizedWithApiKey(req as unknown as Request, CONFIG.apiKey)) {
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
		const health = getHealthState();
		if (health.isRecovering) {
			return res.status(503).json({ ok: false, engine: 'camoufox', recovering: true });
		}

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
			running: true,
			engine: 'camoufox',
			browserConnected: activeUserIds.length > 0,
			consecutiveFailures: health.consecutiveNavFailures,
			activeOps: health.activeOps,
			poolSize: contextPool.size(),
			activeUserIds,
			profileDirsTotal,
		});
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
			(page as unknown as { __camofox_tabId?: string }).__camofox_tabId = tabId;
			const tabState = createTabState(page);
			group.set(tabId, tabState);
			indexTab(tabId, sessionMapKey);

			registerDownloadListener(tabId, String(userId), page);

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
		if (!userId) return res.status(400).json({ error: 'userId required' });
		const found = findTabById(tabId, userId);
		if (!found) return res.status(404).json({ error: 'Tab not found' });

		const { tabState } = found;
		tabState.toolCalls++;

		const result = await withUserLimit(String(userId), CONFIG.maxConcurrentPerUser, () =>
			withTimeout(
				withTabLock(tabId, async () => {
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
					tabState.lastSnapshot = null;
					recordNavSuccess();
					return { status: 200 as const, body: { ok: true, url: tabState.page.url() } };
				}),
				CONFIG.handlerTimeoutMs,
				'navigate',
			),
		);

		if (result.status !== 200) return res.status(result.status).json(result.body);

		log('info', 'navigated', { reqId: req.reqId, tabId, url: result.body.url });
		return res.json(result.body);
	} catch (err) {
		const shouldWarn = recordNavFailure();
		const message = err instanceof Error ? err.message : String(err);
		if (shouldWarn) {
			log('error', 'consecutive nav failures exceeded threshold', {
				tabId,
				failureThreshold: CONFIG.failureThreshold,
			});
		}
		log('error', 'navigate failed', { reqId: req.reqId, tabId, error: message });
		const status = err instanceof Error && err.message?.startsWith('Blocked URL scheme') ? 400 : 500;
		return res.status(status).json({ error: safeError(err) });
	}
});

// Snapshot
router.get('/tabs/:tabId/snapshot', async (req: Request<{ tabId: string }, unknown, unknown, { userId?: unknown; offset?: unknown }>, res: Response) => {
	try {
		const userId = req.query.userId;
		const offset = parseInt(req.query.offset as string) || 0;
		if (!userId) return res.status(400).json({ error: 'userId required' });
		const tabId = req.params.tabId;
		const found = findTabById(tabId, userId);
		if (!found) return res.status(404).json({ error: 'Tab not found' });

		const { tabState } = found;
		tabState.toolCalls++;
		const result = await withUserLimit(String(userId), CONFIG.maxConcurrentPerUser, () =>
			withTimeout(snapshotTab(tabState, offset), CONFIG.handlerTimeoutMs, 'snapshot'),
		);
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
		if (!userId) return res.status(400).json({ error: 'userId required' });
		const found = findTabById(tabId, userId);
		if (!found) return res.status(404).json({ error: 'Tab not found' });
		const { tabState } = found;
		tabState.toolCalls++;
		const result = await withUserLimit(String(userId), CONFIG.maxConcurrentPerUser, () =>
			withTimeout(clickTab(tabId, tabState, { ref, selector }), CONFIG.handlerTimeoutMs, 'click'),
		);
		const responseObj: Record<string, unknown> = { ...result };
		const recentDownloads = getRecentDownloads(tabId, 2000);
		if (recentDownloads.length > 0) {
			responseObj.downloads = recentDownloads.map((d) => ({
				id: d.id,
				filename: d.suggestedFilename,
				status: d.status,
				size: d.size,
				contentUrl: d.contentUrl,
			}));
		}
		log('info', 'clicked', { reqId: req.reqId, tabId, url: result.url });
		return res.json(responseObj);
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
		const result = await withTimeout(typeTab(tabId, tabState, { ref, selector, text: String(text ?? '') }), CONFIG.handlerTimeoutMs, 'type');
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
		await withTimeout(pressTab(tabId, tabState, String(key ?? '')), CONFIG.handlerTimeoutMs, 'press');
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

// Evaluate JS (API key optional)
router.post(
	'/tabs/:tabId/evaluate',
	express.json({ limit: '64kb' }),
	async (req: Request<{ tabId: string }, unknown, { userId?: unknown; expression?: unknown; timeout?: number }>, res: Response) => {
		const tabId = req.params.tabId;
		try {
			if (CONFIG.apiKey && !isAuthorizedWithApiKey(req as unknown as Request, CONFIG.apiKey)) {
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
		const result = await withTimeout(backTab(tabId, tabState), CONFIG.handlerTimeoutMs, 'back');
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
		const result = await withTimeout(forwardTab(tabId, tabState), CONFIG.handlerTimeoutMs, 'forward');
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
		const result = await withTimeout(refreshTab(tabId, tabState), CONFIG.handlerTimeoutMs, 'refresh');
		return res.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'refresh failed', { reqId: req.reqId, error: message });
		return res.status(500).json({ error: safeError(err) });
	}
});

// Get links
router.get(
	'/tabs/:tabId/links',
	async (
		req: Request<{ tabId: string }, unknown, unknown, { userId?: unknown; limit?: string; offset?: string; scope?: string; extension?: string; downloadOnly?: string }>,
		res: Response,
	) => {
	try {
		const userId = req.query.userId;
		const limit = Number.parseInt(String(req.query.limit ?? ''), 10) || 50;
		const offset = Number.parseInt(String(req.query.offset ?? ''), 10) || 0;
		const scope = typeof req.query.scope === 'string' && req.query.scope ? req.query.scope : undefined;
		const extension = typeof req.query.extension === 'string' && req.query.extension ? req.query.extension : undefined;
		const downloadOnly = String(req.query.downloadOnly || '').toLowerCase() === 'true';
		const found = findTabById(req.params.tabId, userId);
		if (!found) {
			log('warn', 'links: tab not found', { reqId: req.reqId, tabId: req.params.tabId, userId });
			return res.status(404).json({ error: 'Tab not found' });
		}

		const { tabState } = found;
		tabState.toolCalls++;
		const result = await getLinks(tabState, { limit, offset, scope, extension, downloadOnly });
		return res.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'links failed', { reqId: req.reqId, error: message });
		return res.status(500).json({ error: safeError(err) });
	}
	},
);

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
			await safePageClose(found.tabState.page);
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
				await safePageClose(tabState.page);
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
		// Ensure downloads are cleaned even if the session was already partially removed.
		cleanupUserDownloads(userId);
		return res.json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'session close failed', { error: message });
		return res.status(500).json({ error: safeError(err) });
	}
});

// Downloads: list by tab
router.get('/tabs/:tabId/downloads', async (req, res) => {
	try {
		const { tabId } = req.params as { tabId: string };
		const userId = req.query.userId as string;
		if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });
		const filters = {
			tabId,
			userId,
			status: req.query.status as string,
			extension: req.query.extension as string,
			mimeType: req.query.mimeType as string,
			minSize: req.query.minSize ? Number(req.query.minSize) : undefined,
			maxSize: req.query.maxSize ? Number(req.query.maxSize) : undefined,
			sort: req.query.sort as string,
			limit: req.query.limit ? Number(req.query.limit) : 50,
			offset: req.query.offset ? Number(req.query.offset) : 0,
		};
		const result = listDownloads(filters);
		res.json({ ok: true, ...result });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'downloads list by tab failed', { error: message });
		res.status(500).json({ ok: false, error: safeError(err) });
	}
});

// Downloads: list by user
router.get('/users/:userId/downloads', async (req, res) => {
	try {
		const userId = req.params.userId as string;
		if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });
		const filters = {
			userId,
			status: req.query.status as string,
			extension: req.query.extension as string,
			mimeType: req.query.mimeType as string,
			minSize: req.query.minSize ? Number(req.query.minSize) : undefined,
			maxSize: req.query.maxSize ? Number(req.query.maxSize) : undefined,
			sort: req.query.sort as string,
			limit: req.query.limit ? Number(req.query.limit) : 50,
			offset: req.query.offset ? Number(req.query.offset) : 0,
		};
		const result = listDownloads(filters);
		res.json({ ok: true, ...result });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'downloads list by user failed', { error: message });
		res.status(500).json({ ok: false, error: safeError(err) });
	}
});

// Downloads: get one
router.get('/downloads/:downloadId', async (req, res) => {
	try {
		const userId = req.query.userId as string;
		if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });
		const dl = getDownload(req.params.downloadId, userId);
		if (!dl) return res.status(404).json({ ok: false, error: 'Download not found' });
		res.json({ ok: true, download: dl });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'download get failed', { error: message });
		res.status(500).json({ ok: false, error: safeError(err) });
	}
});

// Downloads: stream content
router.get('/downloads/:downloadId/content', async (req, res) => {
	try {
		const userId = req.query.userId as string;
		if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });
		const dl = getDownload(req.params.downloadId, userId);
		if (!dl) return res.status(404).json({ ok: false, error: 'Download not found' });
		if (dl.status !== 'completed') return res.status(409).json({ ok: false, error: 'Download not completed' });
		const filePath = getDownloadPath(req.params.downloadId, userId);
		if (!filePath) return res.status(404).json({ ok: false, error: 'File not found on disk' });

		// Hardened Content-Disposition
		const safeName = dl.suggestedFilename.replace(/[\r\n\0"]/g, '');
		res.setHeader('Content-Type', dl.mimeType || 'application/octet-stream');
		res.setHeader('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`);

		const fsMod = await import('fs');
		const stream = fsMod.createReadStream(filePath);
		stream.on('error', (_err) => {
			if (!res.headersSent) {
				res.status(500).json({ ok: false, error: 'File read error' });
			}
			res.destroy();
		});
		stream.pipe(res);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'download content failed', { error: message });
		res.status(500).json({ ok: false, error: safeError(err) });
	}
});

// Downloads: delete
router.delete('/downloads/:downloadId', async (req, res) => {
	try {
		const userId = (req.body as any)?.userId || (req.query.userId as string);
		if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });
		const deleted = deleteDownload(req.params.downloadId, userId);
		if (!deleted) return res.status(404).json({ ok: false, error: 'Download not found' });
		res.json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'download delete failed', { error: message });
		res.status(500).json({ ok: false, error: safeError(err) });
	}
});

// Extract resources from a scoped container
router.post('/tabs/:tabId/extract-resources', async (req, res) => {
	try {
		const { tabId } = req.params as { tabId: string };
		const { userId, selector, types, extensions, resolveBlobs, triggerLazyLoad } = req.body as any;
		if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });
		const found = findTabById(tabId, userId);
		if (!found) return res.status(404).json({ ok: false, error: 'Tab not found' });
		const { tabState } = found;
		tabState.toolCalls++;

		const result = await withUserLimit(String(userId), CONFIG.maxConcurrentPerUser, () =>
			withTimeout(
				withTabLock(tabId, async () =>
					extractResources(tabState.page, {
						userId,
						selector,
						types,
						extensions,
						resolveBlobs,
						triggerLazyLoad,
					}),
				),
				CONFIG.handlerTimeoutMs,
				'extract-resources',
			),
		);
		res.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'extract resources failed', { error: message });
		res.status(500).json({ ok: false, error: safeError(err) });
	}
});

// Batch download from a scoped container
router.post('/tabs/:tabId/batch-download', async (req, res) => {
	try {
		const { tabId } = req.params as { tabId: string };
		const body = req.body as any;
		const userId = body?.userId;
		if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });
		const found = findTabById(tabId, userId);
		if (!found) return res.status(404).json({ ok: false, error: 'Tab not found' });
		const { tabState } = found;
		tabState.toolCalls++;

		const result = await withUserLimit(String(userId), CONFIG.maxConcurrentPerUser, () =>
			withTimeout(
				withTabLock(tabId, async () => batchDownload(tabState.page, body, CONFIG)),
				300_000,
				'batch-download',
			),
		);
		res.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'batch download failed', { error: message });
		res.status(500).json({ ok: false, error: safeError(err) });
	}
});

// Resolve a list of blob: URLs into base64 data URLs
router.post('/tabs/:tabId/resolve-blobs', async (req, res) => {
	try {
		const { tabId } = req.params as { tabId: string };
		const { userId, urls } = req.body as any;
		if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });
		if (!urls || !Array.isArray(urls)) return res.status(400).json({ ok: false, error: 'urls array required' });
		if (urls.length > 25) return res.status(400).json({ ok: false, error: 'urls array too large (max 25)' });
		const found = findTabById(tabId, userId);
		if (!found) return res.status(404).json({ ok: false, error: 'Tab not found' });
		const { tabState } = found;
		tabState.toolCalls++;

		const urlList = urls.map((u: unknown) => String(u));
		const settled = await withUserLimit(String(userId), CONFIG.maxConcurrentPerUser, () =>
			withTimeout(
				withTabLock(tabId, async () => Promise.allSettled(urlList.map((u) => resolveBlob(tabState.page, u)))),
				CONFIG.handlerTimeoutMs,
				'resolve-blobs',
			),
		);

		const results: Array<{ url: string; resolved: { base64: string; mimeType: string } | null }> = urlList.map((url, i) => {
			const entry = settled[i];
			if (!entry || entry.status !== 'fulfilled') return { url, resolved: null };
			return { url, resolved: entry.value || null };
		});
		res.json({ ok: true, results });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'resolve blobs failed', { error: message });
		res.status(500).json({ ok: false, error: safeError(err) });
	}
});

export default router;
