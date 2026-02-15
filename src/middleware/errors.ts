import type { NextFunction, Request, Response } from 'express';

import { loadConfig } from '../utils/config';
import { log } from './logging';

const CONFIG = loadConfig();

export function safeError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	const stack = err instanceof Error ? err.stack : undefined;

	if (CONFIG.nodeEnv === 'production') {
		log('error', 'internal error', { error: message, stack });
		return 'Internal server error';
	}
	return message;
}

export function errorMiddleware(err: unknown, req: Request, res: Response, _next: NextFunction): void {
	log('error', 'request error', { reqId: req.reqId, path: req.path, error: safeError(err) });
	if (res.headersSent) return;
	res.status(500).json({ error: safeError(err) });
}

export function installCrashHandlers(): void {
	process.on('uncaughtException', (err: Error) => {
		log('error', 'uncaughtException', { error: err.message, stack: err.stack });
		process.exit(1);
	});
	process.on('unhandledRejection', (reason: unknown) => {
		log('error', 'unhandledRejection', { reason: String(reason) });
	});
}
