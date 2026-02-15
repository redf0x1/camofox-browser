import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export type LogLevel = 'info' | 'warn' | 'error';

export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
	const entry = {
		ts: new Date().toISOString(),
		level,
		msg,
		...fields,
	};
	const line = JSON.stringify(entry);
	if (level === 'error') {
		process.stderr.write(line + '\n');
	} else {
		process.stdout.write(line + '\n');
	}
}

export function loggingMiddleware(req: Request, res: Response, next: NextFunction): void {
	if (req.path === '/health') return next();

	const reqId = crypto.randomUUID().slice(0, 8);
	req.reqId = reqId;
	req.startTime = Date.now();

	const bodyUserId = (req.body as unknown as { userId?: unknown } | undefined)?.userId;
	const queryUserId = (req.query as unknown as { userId?: unknown } | undefined)?.userId;
	const userId = (bodyUserId ?? queryUserId ?? '-') as unknown;

	log('info', 'req', { reqId, method: req.method, path: req.path, userId });

	const origEnd = res.end.bind(res);
	res.end = function patchedEnd(...args: unknown[]): Response {
		const ms = Date.now() - (req.startTime ?? Date.now());
		log('info', 'res', { reqId, status: res.statusCode, ms });
		return origEnd(...(args as Parameters<Response['end']>));
	};

	next();
}

export interface StatsBeaconFields {
	sessions: number;
	tabs: number;
	rssBytes: number;
	heapUsedBytes: number;
	uptimeSeconds: number;
	browserConnected: boolean;
}

export function startStatsBeacon(getFields: () => StatsBeaconFields): NodeJS.Timeout {
	return setInterval(() => {
		const mem = process.memoryUsage();
		const fields = getFields();
		log('info', 'stats', {
			sessions: fields.sessions,
			tabs: fields.tabs,
			rssBytes: mem.rss,
			heapUsedBytes: mem.heapUsed,
			uptimeSeconds: Math.floor(process.uptime()),
			browserConnected: fields.browserConnected,
		});
	}, 5 * 60_000);
}
