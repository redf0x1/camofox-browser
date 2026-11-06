import { Router, type Request, type Response } from 'express';

import { isAuthorizedWithApiKey } from '../middleware/auth';
import { findNetworkCapture, NetworkError } from '../services/network-capture';
import type { NetworkRule } from '../services/network-interception';
import { loadConfig } from '../utils/config';

const router = Router();
const config = loadConfig();
const bodyCapture = Boolean(config.apiKey && process.env.CAMOFOX_NETWORK_BODY_CAPTURE === 'true');
const interception = Boolean(config.apiKey && process.env.CAMOFOX_NETWORK_INTERCEPTION === 'true');
type Capture = ReturnType<typeof findNetworkCapture>;

function captureRoute(action: (capture: Capture, req: Request, res: Response) => void | Promise<void>) {
	return async (req: Request, res: Response): Promise<void> => {
		res.setHeader('Cache-Control', 'no-store');
		if (config.apiKey && !isAuthorizedWithApiKey(req, config.apiKey)) {
			res.status(403).json({ error: 'Forbidden' });
			return;
		}
		try {
			const userId = req.query.userId;
			if (typeof userId !== 'string' || !userId.trim() || userId.length > 256) {
				throw new NetworkError(400, 'userId is required');
			}
			const capture = findNetworkCapture(req.get('X-Camofox-Network-Key'), userId);
			await action(capture, req, res);
		} catch (error) {
			if (error instanceof NetworkError) {
				res.status(error.statusCode).json({ error: error.message });
				return;
			}
			res.status(500).json({ error: 'Network capture operation failed' });
		}
	};
}

function number(value: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
	if (value === undefined) return fallback;
	if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) {
		throw new NetworkError(400, 'Invalid network capture pagination or request ID');
	}
	const parsed = Number(value);
	if (parsed < min || parsed > max) throw new NetworkError(400, 'Network capture parameter out of range');
	return parsed;
}

router.get('/network/capabilities', (_req, res) => {
	res.json({ captureVersion: 1, har: true, interception, bodyCapture });
});

router.post('/network/capture/start', captureRoute((capture, _req, res) => {
	res.json({ state: capture.start() });
}));

router.post('/network/capture/stop', captureRoute((capture, _req, res) => {
	res.json({ state: capture.stop() });
}));

router.get('/network/requests', captureRoute((capture, req, res) => {
	res.json(capture.list(number(req.query.after, 0, 0), number(req.query.limit, 25, 1, 50)));
}));

router.get('/network/requests/:id', captureRoute((capture, req, res) => {
	const includeBody = req.query.includeBody;
	if (includeBody !== undefined && includeBody !== 'true' && includeBody !== 'false') {
		throw new NetworkError(400, 'includeBody must be true or false');
	}
	res.json(capture.get(number(req.params.id, 0, 1), includeBody === 'true'));
}));

router.get('/network/har', captureRoute((capture, _req, res) => {
	res.setHeader('Content-Disposition', 'attachment; filename="camofox-network.har"');
	res.json(capture.har());
}));

function parseRules(input: unknown): NetworkRule[] {
	const rules = (input as { rules?: unknown } | null)?.rules;
	if (!Array.isArray(rules) || rules.length > 4) {
		throw new NetworkError(400, 'Provide an array of up to four interception rules');
	}
	const keys = new Set<string>();
	return rules.map((value: unknown) => {
		const invalid = () => new NetworkError(400, 'Invalid interception rule');
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
		const { url, method, action, body, status, contentType } = value as Record<string, unknown>;
		if (typeof url !== 'string' || url.length > 1024 ||
			typeof method !== 'string' || !/^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) throw invalid();
		let target: URL;
		try {
			target = new URL(url);
		} catch {
			throw invalid();
		}
		if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash) throw invalid();
		const key = method + ' ' + target.href;
		if (keys.has(key)) throw new NetworkError(400, 'Duplicate interception rule');
		keys.add(key);
		if (action === 'abort' && Object.keys(value).every((field) => ['url', 'method', 'action'].includes(field))) {
			return { url: target.href, method, action };
		}
		if (action !== 'fulfill' || typeof body !== 'string' || Buffer.byteLength(body) > 16 * 1024 ||
			typeof status !== 'number' || !Number.isInteger(status) ||
			!((status >= 200 && status <= 299 && status !== 204 && status !== 205) || (status >= 400 && status <= 599)) ||
			(contentType !== 'application/json' && contentType !== 'text/plain') ||
			Object.keys(value).some((field) => !['url', 'method', 'action', 'body', 'status', 'contentType'].includes(field))) throw invalid();

		return { url: target.href, method, action, body, status, contentType };
	});
}

router.put('/network/intercept', captureRoute(async (capture, req, res) => {
	if (!interception) throw new NetworkError(403, 'Network interception is disabled');
	const rules = parseRules(req.body);
	await capture.setInterception(rules);
	res.json({ ruleCount: rules.length });
}));

export default router;
