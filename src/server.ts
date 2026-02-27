import type { Server } from 'node:http';

import express from 'express';

import coreRoutes from './routes/core';
import openclawRoutes from './routes/openclaw';
import { installCrashHandlers, safeError } from './middleware/errors';
import { loggingMiddleware, log, startStatsBeacon } from './middleware/logging';
import { loadConfig } from './utils/config';
import { closeBrowser } from './services/browser';
import { contextPool } from './services/context-pool';
import {
	closeAllSessions,
	countTotalTabsForSessions,
	getAllSessions,
	startCleanupInterval as startSessionCleanupInterval,
	stopCleanupInterval as stopSessionCleanupInterval,
} from './services/session';
import {
	startCleanupInterval as startDownloadCleanupInterval,
	stopCleanupInterval as stopDownloadCleanupInterval,
} from './services/download';
import { getHealthState, resetHealth, setRecovering } from './services/health';
import { detectYtDlp } from './services/youtube';

const CONFIG = loadConfig();

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(loggingMiddleware);

app.use(coreRoutes);
app.use(openclawRoutes);

// Fallback error middleware (routes largely handle their own errors to preserve legacy behavior)
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
	const anyErr = err as { status?: number; statusCode?: number };
	const status = anyErr.statusCode || anyErr.status || 500;
	res.status(status).json({ error: safeError(err) });
});

installCrashHandlers();

startSessionCleanupInterval();
startDownloadCleanupInterval(CONFIG.downloadTtlMs);

startStatsBeacon(() => {
	const sessions = getAllSessions().size;
	const tabs = countTotalTabsForSessions();
	const browserConnected = contextPool.size() > 0;
	return { sessions, tabs, rssBytes: 0, heapUsedBytes: 0, uptimeSeconds: 0, browserConnected };
});

const PORT = CONFIG.port;
let server: Server;
let healthProbeInterval: NodeJS.Timeout | null = null;

void detectYtDlp((message: unknown) => {
	log('info', 'yt-dlp detection', { message: String(message) });
});

let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	setRecovering(true);
	log('info', 'shutting down', { signal });

	const forceTimeout = setTimeout(() => {
		log('error', 'shutdown timed out, forcing exit');
		process.exit(1);
	}, 10000);
	forceTimeout.unref();

	try {
		server.close();
	} catch {
		// ignore
	}

	await closeAllSessions().catch(() => {});
	stopSessionCleanupInterval();
	stopDownloadCleanupInterval();
	if (healthProbeInterval) {
		clearInterval(healthProbeInterval);
		healthProbeInterval = null;
	}
	await closeBrowser().catch(() => {});
	process.exit(0);
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

server = app.listen(PORT, () => {
	log('info', 'server started', { port: PORT, pid: process.pid, nodeVersion: process.version });
	log('info', 'using persistent profiles', { profilesDir: CONFIG.profilesDir });
	resetHealth();
	healthProbeInterval = setInterval(() => {
		const health = getHealthState();
		if (health.isRecovering || health.activeOps > 0) return;

		const timeSinceSuccess = Date.now() - health.lastSuccessfulNav;
		if (timeSinceSuccess < 120_000) return;

		log('warn', 'health probe: no successful navigation in 2+ minutes', {
			timeSinceSuccessMs: timeSinceSuccess,
			consecutiveFailures: health.consecutiveNavFailures,
		});
	}, CONFIG.healthProbeIntervalMs);
	healthProbeInterval.unref();
	if (!CONFIG.apiKey) {
		console.warn('[camofox] ⚠️  CAMOFOX_API_KEY not set — all endpoints are open without authentication.');
		console.warn('[camofox] Set CAMOFOX_API_KEY for production/network-exposed deployments.');
	}
});

server.on('error', (err: NodeJS.ErrnoException) => {
	if (err.code === 'EADDRINUSE') {
		log('error', 'port in use', { port: PORT });
		process.exit(1);
	}
	log('error', 'server error', { error: err.message });
	process.exit(1);
});
