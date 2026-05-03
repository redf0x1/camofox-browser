import crypto from 'node:crypto';
import fs from 'node:fs';
import { basename, resolve } from 'node:path';

import express, { Router, type Request, type Response } from 'express';

import { safeError } from '../middleware/errors';
import { log } from '../middleware/logging';
import { isAuthorizedWithApiKey } from '../middleware/auth';
import { checkRateLimit } from '../middleware/rate-limit';
import { loadConfig } from '../utils/config';
import { getAllPresets, resolveContextOptions, validateContextOptions } from '../utils/presets';
import { contextPool, getDisplayForUser } from '../services/context-pool';
import { startVnc, stopVnc } from '../services/vnc';
import {
	MAX_TABS_PER_SESSION,
	acquireFirstCreateMutex,
	commitStagedFirstUse,
	createCanonicalProfile,
	createStagedSession,
	findTabById,
	getCanonicalProfile,
	getSession,
	getSessionMapKey,
	getSessionsForUser,
	getTabGroup,
	indexTab,
	normalizeUserId,
	rollbackCanonicalMutex,
	rollbackStagedFirstUse,
	unindexTab,
	closeSessionsForUser,
	countTotalTabsForSessions,
	withUserLimit,
} from '../services/session';
import {
	backTab,
	buildSnapshotPayload,
	buildRefs,
	clickTab,
	createTabState,
	evaluateTab,
	evaluateTabExtended,
	forwardTab,
	getLinks,
	pressTab,
	refreshTab,
	screenshotTab,
	scrollTab,
	scrollElementTab,
	snapshotTab,
	calculateTypeTimeoutMs,
	navigateWithSafetyGuard,
	typeTab,
	safePageClose,
	validateNavigationUrl,
	waitForPageReady,
	withTimeout,
	withTabLock,
} from '../services/tab';

import {
	commitStagedDownloads,
	registerDownloadListener,
	listDownloads,
	getDownload,
	getDownloadPath,
	deleteDownload,
	getRecentDownloads,
	cleanupUserDownloads,
	markDownloadsStaged,
} from '../services/download';
import { extractImages, extractResources, resolveBlob } from '../services/resource-extractor';
import { batchDownload } from '../services/batch-downloader';
import {
	startTracing,
	stopTracing,
	startTracingChunk,
	stopTracingChunk,
	getTracingState,
	listTraceArtifacts,
	resolveTraceArtifactPath,
	deleteTraceArtifact,
} from '../services/tracing';

import type { CookieInput, ContextOverrides, TabState } from '../types';

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

function getTab(tabId: string, userId: unknown): TabState | undefined {
	return findTabById(tabId, userId)?.tabState;
}

function getTracingErrorStatus(err: unknown): number {
	const message = err instanceof Error ? err.message : String(err);
	if (message.includes('already active')) return 409;
	if (message.includes('No active tracing')) return 400;
	if (message.includes('Must start tracing')) return 400;
	if (message.includes('Tracing not started')) return 400;
	if (message.includes('Chunk already active')) return 409;
	if (message.includes('No active chunk')) return 400;
	if (message.includes('Invalid trace output path')) return 400;
	return 500;
}

function getTraceArtifactErrorStatus(err: unknown): number {
	const message = err instanceof Error ? err.message : String(err);
	if (message.includes('Invalid trace filename')) return 400;
	if (message.includes('does not belong to this user')) return 404;
	if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') return 404;
	return 500;
}

function getRouteErrorStatus(err: unknown): number {
	if (typeof err === 'object' && err !== null && 'statusCode' in err && typeof err.statusCode === 'number') {
		return err.statusCode;
	}
	if (typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number') {
		return err.status;
	}
	return 500;
}

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
				const canonical = getCanonicalProfile(userId);
				if (!canonical) {
					log('warn', 'cookie import rejected: no canonical profile', { userId: String(userId) });
					return res.status(409).json({
						error: 'No canonical profile',
						message: 'Cannot import cookies without an established canonical profile. Create a tab via POST /tabs first.',
					});
				}
				const existingSessions = getSessionsForUser(userId);
				if (existingSessions.length === 0) {
					log('warn', 'cookie import rejected: no active session', { userId: String(userId) });
					return res.status(409).json({
						error: 'No active session',
						message: 'Cannot import cookies without an active session. Create a tab via POST /tabs first.',
					});
				}
				session = existingSessions[0][1];
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
		let createUserId: string | undefined;
		let isFirstCreator = false;
		let stagedGeneration: string | undefined;
		try {
			if (CONFIG.apiKey && !isAuthorizedWithApiKey(req, CONFIG.apiKey)) {
				return res.status(403).json({ error: 'Forbidden' });
			}

			const { userId, sessionKey, listItemId, url, preset, locale, timezoneId, geolocation, viewport } = req.body;
			const resolvedSessionKey = sessionKey || listItemId;
			if (!userId || !resolvedSessionKey) {
				return res.status(400).json({ error: 'userId and sessionKey required' });
			}
			createUserId = String(userId);

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
			if (url) {
				const urlErr = await validateNavigationUrl(url, {
					allowPrivateNetworkTargets: CONFIG.allowPrivateNetworkTargets,
				});
				if (urlErr) return res.status(400).json({ error: urlErr });
			}

			const requestedProfile = createCanonicalProfile(contextOverrides);
			const requestHash = requestedProfile.hash;

			const MAX_CANONICAL_RETRIES = 3;
			for (let attempt = 0; attempt < MAX_CANONICAL_RETRIES; attempt++) {
				const existingProfile = getCanonicalProfile(userId);
				if (existingProfile) {
					if (contextOverrides === null) {
						contextOverrides = existingProfile.resolvedOverrides;
					} else if (requestHash !== existingProfile.hash) {
						log('warn', 'canonical profile conflict', { userId: String(userId) });
						return res.status(409).json({
							error: 'Context override conflict',
							message: 'A canonical profile already exists for this user with different overrides. Close the session first to reconfigure.',
						});
					} else {
						contextOverrides = existingProfile.resolvedOverrides;
					}
					break;
				}

				const mutex = acquireFirstCreateMutex(userId);
				if (mutex.acquired) {
					isFirstCreator = true;
					break;
				}

				await mutex.wait;
			}

			if (!getCanonicalProfile(userId) && !isFirstCreator) {
				log('error', 'canonical profile acquisition failed after retries', { userId: String(userId) });
				return res.status(503).json({ error: 'Could not acquire canonical profile, try again' });
			}

			const sessionMapKey = getSessionMapKey(userId, contextOverrides);
			let tabId: string;
			let pageUrl: string;

			if (isFirstCreator) {
				const staged = await createStagedSession(userId, contextOverrides);
				stagedGeneration = staged.generation;
				const { session, generation } = staged;
				const page = await session.context.newPage();
				tabId = crypto.randomUUID();
				(page as unknown as { __camofox_tabId?: string }).__camofox_tabId = tabId;
				const tabState = await createTabState(page);

				registerDownloadListener(tabId, String(userId), page);
				markDownloadsStaged(tabId);

				if (url) {
					await navigateWithSafetyGuard(page, url, {
						allowPrivateNetworkTargets: CONFIG.allowPrivateNetworkTargets,
						waitUntil: 'domcontentloaded',
						timeout: 30000,
					});
					tabState.visitedUrls.add(url);
				}

				const committed = commitStagedFirstUse(userId, session, contextOverrides, {
					tabId,
					sessionMapKey,
					sessionKey: resolvedSessionKey,
					tabState,
				}, generation);
				if (!committed) {
					await rollbackStagedFirstUse(createUserId ?? userId, generation).catch(() => {});
					return res.status(409).json({ error: 'Session closed during creation' });
				}
				commitStagedDownloads(tabId);

				pageUrl = page.url();
			} else {
				const session = await getSession(userId, contextOverrides);
				const totalTabs = countTotalTabsForSessions([[sessionMapKey, session]]);
				if (totalTabs >= MAX_TABS_PER_SESSION) {
					return res.status(429).json({ error: 'Maximum tabs per session reached' });
				}

				const group = getTabGroup(session, resolvedSessionKey);
				const page = await session.context.newPage();
				tabId = crypto.randomUUID();
				(page as unknown as { __camofox_tabId?: string }).__camofox_tabId = tabId;
				const tabState = await createTabState(page);
				group.set(tabId, tabState);
				indexTab(tabId, sessionMapKey);

				registerDownloadListener(tabId, String(userId), page);

				if (url) {
					await navigateWithSafetyGuard(page, url, {
						allowPrivateNetworkTargets: CONFIG.allowPrivateNetworkTargets,
						waitUntil: 'domcontentloaded',
						timeout: 30000,
					});
					tabState.visitedUrls.add(url);
				}

				pageUrl = page.url();
			}

			log('info', 'tab created', {
				reqId: req.reqId,
				tabId,
				userId,
				sessionKey: resolvedSessionKey,
				url: pageUrl,
			});
			return res.json({ tabId, url: pageUrl });
		} catch (err) {
			if (isFirstCreator && createUserId) {
				if (stagedGeneration) {
					await rollbackStagedFirstUse(createUserId, stagedGeneration).catch(() => {});
				} else {
					rollbackCanonicalMutex(createUserId);
				}
			}
			const message = err instanceof Error ? err.message : String(err);
			log('error', 'tab create failed', { reqId: req.reqId, error: message });
			return res.status(getRouteErrorStatus(err)).json({ error: safeError(err) });
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
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

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
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'navigate failed', { reqId: req.reqId, tabId, error: message });
		return res.status(getRouteErrorStatus(err)).json({ error: safeError(err) });
	}
});

// Snapshot
router.get('/tabs/:tabId/snapshot', async (req: Request<{ tabId: string }, unknown, unknown, { userId?: unknown; offset?: string }>, res: Response) => {
	try {
		const userId = req.query.userId;
		if (!userId) return res.status(400).json({ error: 'userId required' });
		const tabId = req.params.tabId;
		const found = findTabById(tabId, userId);
		if (!found) return res.status(404).json({ error: 'Tab not found' });

		const { tabState } = found;
		tabState.toolCalls++;

		const rawOffset = Number(req.query.offset);
		const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

		const raw = await withUserLimit(String(userId), CONFIG.maxConcurrentPerUser, () =>
			withTimeout(snapshotTab(tabState), CONFIG.handlerTimeoutMs, 'snapshot'),
		);
		const result = buildSnapshotPayload(raw, offset);
		log('info', 'snapshot', {
			reqId: req.reqId,
			tabId,
			url: result.url,
			snapshotLen: result.snapshot.length,
			refsCount: result.refsCount,
		});
		return res.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'snapshot failed', { reqId: req.reqId, tabId: req.params.tabId, error: message });
		return res.status(getRouteErrorStatus(err)).json({ error: safeError(err) });
	}
});

// Wait for page ready
router.post('/tabs/:tabId/wait', async (req: Request<{ tabId: string }, unknown, { userId?: unknown; timeout?: number; waitForNetwork?: boolean }>, res: Response) => {
	try {
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		const { userId, timeout = 10000, waitForNetwork = true } = req.body;
		const found = findTabById(req.params.tabId, userId);
		if (!found) return res.status(404).json({ error: 'Tab not found' });

		const { tabState } = found;
		const ready = await waitForPageReady(tabState.page, { timeout, waitForNetwork });
		return res.json({ ok: true, ready });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'wait failed', { reqId: req.reqId, error: message });
		return res.status(getRouteErrorStatus(err)).json({ error: safeError(err) });
	}
});

// Click
router.post('/tabs/:tabId/click', async (req: Request<{ tabId: string }, unknown, { userId?: unknown; ref?: string; selector?: string }>, res: Response) => {
	const tabId = req.params.tabId;
	try {
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

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
			}));
		}
		log('info', 'clicked', { reqId: req.reqId, tabId, url: result.url });
		return res.json(responseObj);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'click failed', { reqId: req.reqId, tabId, error: message });
		return res.status(getRouteErrorStatus(err)).json({ error: safeError(err) });
	}
});

// Type
router.post('/tabs/:tabId/type', async (req: Request<{ tabId: string }, unknown, { userId?: unknown; ref?: string; selector?: string; text?: string }>, res: Response) => {
	const tabId = req.params.tabId;
	try {
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		const { userId, ref, selector, text } = req.body;
		const found = findTabById(tabId, userId);
		if (!found) return res.status(404).json({ error: 'Tab not found' });

		const { tabState } = found;
		tabState.toolCalls++;
		const textValue = String(text ?? '');
		const result = await withTimeout(typeTab(tabId, tabState, { ref, selector, text: textValue }), calculateTypeTimeoutMs(textValue), 'type');
		return res.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'type failed', { reqId: req.reqId, error: message });
		return res.status(getRouteErrorStatus(err)).json({ error: safeError(err) });
	}
});

// Press key
router.post('/tabs/:tabId/press', async (req: Request<{ tabId: string }, unknown, { userId?: unknown; key?: string }>, res: Response) => {
	const tabId = req.params.tabId;
	try {
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

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
		return res.status(getRouteErrorStatus(err)).json({ error: safeError(err) });
	}
});

// Scroll
router.post('/tabs/:tabId/scroll', async (req: Request<{ tabId: string }, unknown, { userId?: unknown; direction?: 'up' | 'down' | 'left' | 'right'; amount?: number }>, res: Response) => {
	try {
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		const { userId, direction = 'down', amount = 500 } = req.body;
		const found = findTabById(req.params.tabId, userId);
		if (!found) return res.status(404).json({ error: 'Tab not found' });
		const { tabState } = found;
		tabState.toolCalls++;
		const result = await withTimeout(scrollTab(tabState, { direction, amount }), CONFIG.handlerTimeoutMs, 'scroll');
		return res.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'scroll failed', { reqId: req.reqId, error: message });
		return res.status(getRouteErrorStatus(err)).json({ error: safeError(err) });
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
			if (CONFIG.apiKey && !isAuthorizedWithApiKey(req, CONFIG.apiKey)) {
				return res.status(403).json({ error: 'Forbidden' });
			}

			const { userId, selector, ref, deltaX, deltaY, scrollTo } = req.body;
			const found = findTabById(tabId, userId);
			if (!found) return res.status(404).json({ error: 'Tab not found' });
			const { tabState } = found;
			tabState.toolCalls++;

			const result = await scrollElementTab(tabId, tabState, { selector, ref, deltaX, deltaY, scrollTo });
			return res.json(result);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log('error', 'scroll-element failed', { reqId: req.reqId, tabId, error: message });
			return res.status(getRouteErrorStatus(err)).json({ error: safeError(err) });
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
			return res.status(getRouteErrorStatus(err)).json({ error: safeError(err) });
		}
	},
);

// Evaluate JS extended (API key optional)
router.post(
	'/tabs/:tabId/evaluate-extended',
	express.json({ limit: '64kb' }),
	async (req: Request<{ tabId: string }, unknown, { userId?: unknown; expression?: unknown; timeout?: unknown }>, res: Response) => {
		const tabId = req.params.tabId;
		try {
			if (CONFIG.apiKey && !isAuthorizedWithApiKey(req as unknown as Request, CONFIG.apiKey)) {
				return res.status(403).json({ ok: false, error: 'Forbidden' });
			}

			const userId = req.body?.userId;
			if (!userId || typeof userId !== 'string') {
				return res.status(400).json({ ok: false, error: 'userId is required' });
			}

			const normalizedRateLimitUserId = String(userId).toLowerCase().trim();

			const rateCheck = checkRateLimit(
				normalizedRateLimitUserId,
				CONFIG.evalExtendedRateLimitMax,
				CONFIG.evalExtendedRateLimitWindowMs,
			);
			if (!rateCheck.allowed) {
				res.set('Retry-After', String(Math.ceil((rateCheck.retryAfterMs || 60000) / 1000)));
				return res
					.status(429)
					.json({ ok: false, error: 'Rate limit exceeded', retryAfterMs: rateCheck.retryAfterMs });
			}

			const { expression, timeout } = req.body;
			if (!expression || typeof expression !== 'string') {
				return res.status(400).json({ ok: false, error: 'expression is required and must be a string' });
			}
			if (Buffer.byteLength(expression, 'utf8') > 65536) {
				return res.status(400).json({ ok: false, error: 'expression exceeds 64KB limit' });
			}

			if (timeout !== undefined && (typeof timeout !== 'number' || timeout < 100 || timeout > 300000)) {
				return res.status(400).json({ ok: false, error: 'timeout must be a number between 100 and 300000' });
			}

			const found = findTabById(tabId, userId);
			if (!found) return res.status(404).json({ ok: false, error: 'Tab not found' });
			const { tabState } = found;
			tabState.toolCalls++;

			const effectiveTimeout = Math.min(Math.max((timeout as number | undefined) ?? 30000, 100), 300000);
			const outerTimeout = effectiveTimeout + 10000;

			const result = await withUserLimit(String(userId), CONFIG.maxConcurrentPerUser, async () =>
				withTimeout(
					evaluateTabExtended(tabId, tabState, { expression, timeout: effectiveTimeout }),
					outerTimeout,
					`Evaluate-extended timed out after ${outerTimeout}ms`,
				),
			);

			if (result.ok) {
				return res.json(result);
			}

			if (result.errorType === 'timeout') {
				return res.status(408).json(result);
			}

			return res.status(500).json(result);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			log('error', 'evaluate-extended failed', { reqId: req.reqId, tabId, error: message });
			const status = getRouteErrorStatus(err);
			if (status === 400) {
				return res.status(400).json({ ok: false, error: safeError(err), errorType: 'js_error' });
			}

			if (message.includes('timed out') || message.includes('Timeout')) {
				return res.status(408).json({ ok: false, error: message, errorType: 'timeout' });
			}
			if (message.includes('concurrency limit') || message.includes('Concurrency limit')) {
				return res
					.status(429)
					.json({ ok: false, error: 'Concurrent operation limit reached, try again later' });
			}

			return res.status(500).json({ ok: false, error: safeError(err), errorType: 'js_error' });
		}
	},
);

// Back
router.post('/tabs/:tabId/back', async (req: Request<{ tabId: string }, unknown, { userId?: unknown }>, res: Response) => {
	const tabId = req.params.tabId;
	try {
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

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
		return res.status(getRouteErrorStatus(err)).json({ error: safeError(err) });
	}
});

// Forward
router.post('/tabs/:tabId/forward', async (req: Request<{ tabId: string }, unknown, { userId?: unknown }>, res: Response) => {
	const tabId = req.params.tabId;
	try {
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

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
		return res.status(getRouteErrorStatus(err)).json({ error: safeError(err) });
	}
});

// Refresh
router.post('/tabs/:tabId/refresh', async (req: Request<{ tabId: string }, unknown, { userId?: unknown }>, res: Response) => {
	const tabId = req.params.tabId;
	try {
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

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
		return res.status(getRouteErrorStatus(err)).json({ error: safeError(err) });
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

// Images
router.get(
	'/tabs/:tabId/images',
	async (
		req: Request<
			{ tabId: string },
			unknown,
			unknown,
			{ userId?: unknown; selector?: unknown; extensions?: unknown; resolveBlobs?: unknown; triggerLazyLoad?: unknown }
		>,
		res: Response,
	) => {
		try {
			if (CONFIG.apiKey && !isAuthorizedWithApiKey(req as unknown as Request, CONFIG.apiKey)) {
				return res.status(403).json({ ok: false, error: 'Forbidden' });
			}

			const userId = req.query.userId;
			const found = findTabById(req.params.tabId, userId);
			if (!found) {
				log('warn', 'images: tab not found', { reqId: req.reqId, tabId: req.params.tabId, userId });
				return res.status(404).json({ error: 'Tab not found' });
			}

			const selector = typeof req.query.selector === 'string' && req.query.selector ? req.query.selector : undefined;
			const extensions = Array.isArray(req.query.extensions)
				? req.query.extensions.map((value) => String(value)).filter(Boolean)
				: typeof req.query.extensions === 'string' && req.query.extensions
					? req.query.extensions
							.split(',')
							.map((value) => value.trim())
							.filter(Boolean)
					: undefined;
			const resolveBlobs = String(req.query.resolveBlobs || '').toLowerCase() === 'true';
			const triggerLazyLoad = String(req.query.triggerLazyLoad || '').toLowerCase() === 'true';

			const { tabState } = found;
			tabState.toolCalls++;

			const result = await withUserLimit(String(userId), CONFIG.maxConcurrentPerUser, () =>
				withTimeout(
					withTabLock(req.params.tabId, async () =>
						extractImages(tabState.page, {
							selector,
							extensions,
							resolveBlobs,
							triggerLazyLoad,
						}),
					),
					CONFIG.handlerTimeoutMs,
					'images',
				),
			);

			return res.json({
				ok: result.ok,
				container: result.container,
				images: result.resources.images,
				totals: {
					images: result.totals.images,
					total: result.totals.images,
				},
				metadata: result.metadata,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log('error', 'images failed', { reqId: req.reqId, error: message });
			return res.status(500).json({ error: safeError(err) });
		}
	},
);

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
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

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
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

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
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

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

// Toggle display mode (headless/headed/virtual) for a user session
router.post(
	'/sessions/:userId/toggle-display',
	async (
		req: Request<{ userId: string }, unknown, { headless?: unknown }>,
		res: Response,
	) => {
		try {
			if (CONFIG.apiKey && !isAuthorizedWithApiKey(req, CONFIG.apiKey)) {
				return res.status(403).json({ error: 'Forbidden' });
			}

			const userId = normalizeUserId(req.params.userId);
			const { headless } = req.body ?? {};

			if (typeof headless !== 'boolean' && headless !== 'virtual') {
				return res.status(400).json({
					error: 'headless must be a boolean or "virtual"',
				});
			}

			// Existing tabs become invalid after context restart.
			await closeSessionsForUser(userId);
			await contextPool.restartContext(userId, headless);

			let vncUrl: string | undefined;
			if (headless === true) {
				await stopVnc(userId).catch(() => {});
			} else {
				const displayNum = getDisplayForUser(userId);
				if (displayNum) {
					try {
						const vnc = await startVnc(userId, displayNum);
						vncUrl = vnc.vncUrl;
					} catch (vncErr) {
						const vncMessage = vncErr instanceof Error ? vncErr.message : String(vncErr);
						log('warn', 'vnc start failed after display toggle', { userId, error: vncMessage, displayNum });
					}
				}
			}

			const modeLabel = headless === false ? 'headed mode' : headless === 'virtual' ? 'virtual display mode' : 'headless mode';
			return res.json({
				ok: true,
				headless,
				...(vncUrl
					? { vncUrl, message: 'Browser visible via VNC' }
					: { message: `Browser restarted in ${modeLabel}. Previous tabs invalidated — create new tabs.` }),
				userId,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log('error', 'toggle display failed', { error: message });
			return res.status(500).json({ error: safeError(err) });
		}
	},
);

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
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req as unknown as Request, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

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
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req as unknown as Request, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

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
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req as unknown as Request, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

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

router.post('/tabs/:tabId/trace/start', async (req, res) => {
	try {
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req as unknown as Request, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		const { tabId } = req.params as { tabId: string };
		const { userId, screenshots, snapshots } = req.body as {
			userId?: unknown;
			screenshots?: unknown;
			snapshots?: unknown;
		};

		if (typeof userId !== 'string' || userId.trim().length === 0) {
			return res.status(400).json({ ok: false, error: 'userId required' });
		}

		const tab = getTab(tabId, userId);
		if (!tab) return res.status(404).json({ ok: false, error: 'Tab not found' });

		await startTracing(userId, tab.page.context(), {
			screenshots: typeof screenshots === 'boolean' ? screenshots : undefined,
			snapshots: typeof snapshots === 'boolean' ? snapshots : undefined,
		});

		return res.json({ ok: true, tracing: true });
	} catch (err) {
		const status = getTracingErrorStatus(err);
		return res.status(status).json({ ok: false, error: safeError(err) });
	}
});

router.post('/tabs/:tabId/trace/stop', async (req, res) => {
	try {
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req as unknown as Request, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		const { tabId } = req.params as { tabId: string };
		const { userId, path } = req.body as {
			userId?: unknown;
			path?: unknown;
		};

		if (typeof userId !== 'string' || userId.trim().length === 0) {
			return res.status(400).json({ ok: false, error: 'userId required' });
		}
		if (path !== undefined && typeof path !== 'string') {
			return res.status(400).json({ ok: false, error: 'path must be a string' });
		}

		const tab = getTab(tabId, userId);
		if (!tab) return res.status(404).json({ ok: false, error: 'Tab not found' });

		const result = await stopTracing(userId, tab.page.context(), path);
		if (result.alreadyStopped) {
			return res.json({
				ok: true,
				path: result.path,
				filename: result.path ? basename(result.path) : undefined,
				size: result.size,
				alreadyStopped: true,
				message: 'Trace was already stopped by chunk stop',
			});
		}
		return res.json({ ok: true, ...result, filename: basename(result.path) });
	} catch (err) {
		const status = getTracingErrorStatus(err);
		return res.status(status).json({ ok: false, error: safeError(err) });
	}
});

router.post('/tabs/:tabId/trace/chunk/start', async (req, res) => {
	try {
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req as unknown as Request, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		const { tabId } = req.params as { tabId: string };
		const { userId } = req.body as { userId?: unknown };

		if (typeof userId !== 'string' || userId.trim().length === 0) {
			return res.status(400).json({ ok: false, error: 'userId required' });
		}

		const tab = getTab(tabId, userId);
		if (!tab) return res.status(404).json({ ok: false, error: 'Tab not found' });

		await startTracingChunk(userId, tab.page.context());
		return res.json({ ok: true, chunkActive: true });
	} catch (err) {
		const status = getTracingErrorStatus(err);
		return res.status(status).json({ ok: false, error: safeError(err) });
	}
});

router.post('/tabs/:tabId/trace/chunk/stop', async (req, res) => {
	try {
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req as unknown as Request, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		const { tabId } = req.params as { tabId: string };
		const { userId, path } = req.body as {
			userId?: unknown;
			path?: unknown;
		};

		if (typeof userId !== 'string' || userId.trim().length === 0) {
			return res.status(400).json({ ok: false, error: 'userId required' });
		}
		if (path !== undefined && typeof path !== 'string') {
			return res.status(400).json({ ok: false, error: 'path must be a string' });
		}

		const tab = getTab(tabId, userId);
		if (!tab) return res.status(404).json({ ok: false, error: 'Tab not found' });

		const result = await stopTracingChunk(userId, tab.page.context(), path);
		return res.json({ ok: true, ...result, filename: basename(result.path) });
	} catch (err) {
		const status = getTracingErrorStatus(err);
		return res.status(status).json({ ok: false, error: safeError(err) });
	}
});

router.get('/tabs/:tabId/trace/status', async (req, res) => {
	try {
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req as unknown as Request, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		const { tabId } = req.params;
		const userId = req.query.userId;

		if (typeof userId !== 'string' || userId.trim().length === 0) {
			return res.status(400).json({ ok: false, error: 'userId required' });
		}

		const tab = getTab(tabId, userId);
		if (!tab) return res.status(404).json({ ok: false, error: 'Tab not found' });

		const state = getTracingState(userId);
		return res.json({ ok: true, ...state });
	} catch (err) {
		return res.status(500).json({ ok: false, error: safeError(err) });
	}
});

router.get('/sessions/:userId/traces', async (req, res) => {
	try {
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req as unknown as Request, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		const userId = normalizeUserId(req.params.userId);
		return res.json({ ok: true, traces: listTraceArtifacts(userId) });
	} catch (err) {
		return res.status(500).json({ ok: false, error: safeError(err) });
	}
});

router.get('/sessions/:userId/traces/:filename', async (req, res) => {
	try {
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req as unknown as Request, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		const userId = normalizeUserId(req.params.userId);
		const filename = req.params.filename;
		const filePath = resolveTraceArtifactPath(userId, filename);

		const safeName = filename.replace(/[\r\n\0"]/g, '');
		res.setHeader('Content-Type', 'application/zip');
		res.setHeader('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`);

		const stream = fs.createReadStream(filePath);
		stream.on('error', (streamErr) => {
			if (!res.headersSent) {
				const status = getTraceArtifactErrorStatus(streamErr);
				res.removeHeader('Content-Disposition');
				res.removeHeader('Content-Type');
				res.status(status).json({ ok: false, error: safeError(streamErr) });
				return;
			}
			res.destroy();
		});
		stream.pipe(res);
	} catch (err) {
		const status = getTraceArtifactErrorStatus(err);
		return res.status(status).json({ ok: false, error: safeError(err) });
	}
});

router.delete('/sessions/:userId/traces/:filename', async (req, res) => {
	try {
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req as unknown as Request, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		const userId = normalizeUserId(req.params.userId);
		const filename = req.params.filename;
		deleteTraceArtifact(userId, filename);
		return res.json({ ok: true });
	} catch (err) {
		const status = getTraceArtifactErrorStatus(err);
		return res.status(status).json({ ok: false, error: safeError(err) });
	}
});

router.get('/tabs/:tabId/console', async (req, res) => {
	try {
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req as unknown as Request, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		const { tabId } = req.params;
		const userId = (req.query.userId as string) || 'default';
		const type = req.query.type as string | undefined;
		const limit = parseInt(req.query.limit as string, 10) || 100;

		const tab = getTab(tabId, userId);
		if (!tab) return res.status(404).json({ ok: false, error: 'Tab not found' });

		let messages = [...tab.consoleMessages];
		if (type) {
			messages = messages.filter((m) => m.type === type);
		}
		if (limit > 0) {
			messages = messages.slice(-limit);
		}

		return res.json({ ok: true, messages, count: messages.length });
	} catch (err) {
		return res.status(500).json({ ok: false, error: safeError(err) });
	}
});

router.get('/tabs/:tabId/errors', async (req, res) => {
	try {
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req as unknown as Request, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		const { tabId } = req.params;
		const userId = (req.query.userId as string) || 'default';
		const limit = parseInt(req.query.limit as string, 10) || 100;

		const tab = getTab(tabId, userId);
		if (!tab) return res.status(404).json({ ok: false, error: 'Tab not found' });

		let errors = [...tab.pageErrors];
		if (limit > 0) {
			errors = errors.slice(-limit);
		}

		return res.json({ ok: true, errors, count: errors.length });
	} catch (err) {
		return res.status(500).json({ ok: false, error: safeError(err) });
	}
});

router.post('/tabs/:tabId/console/clear', async (req, res) => {
	try {
		if (CONFIG.apiKey && !isAuthorizedWithApiKey(req as unknown as Request, CONFIG.apiKey)) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		const { tabId } = req.params;
		const userId = ((req.body as { userId?: string } | undefined)?.userId || (req.query.userId as string)) || 'default';

		const tab = getTab(tabId, userId);
		if (!tab) return res.status(404).json({ ok: false, error: 'Tab not found' });

		const cleared = tab.consoleMessages.length + tab.pageErrors.length;
		tab.consoleMessages.length = 0;
		tab.pageErrors.length = 0;

		return res.json({ ok: true, cleared });
	} catch (err) {
		return res.status(500).json({ ok: false, error: safeError(err) });
	}
});

export default router;
