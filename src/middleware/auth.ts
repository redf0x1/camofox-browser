import crypto from 'node:crypto';
import type { Request } from 'express';

export function timingSafeCompare(a: unknown, b: unknown): boolean {
	if (typeof a !== 'string' || typeof b !== 'string') return false;
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) {
		// Keep timing similar even for length mismatch.
		crypto.timingSafeEqual(bufA, bufA);
		return false;
	}
	return crypto.timingSafeEqual(bufA, bufB);
}

export function getBearerToken(req: Request): string | null {
	const auth = String(req.headers['authorization'] || '');
	const match = auth.match(/^Bearer\s+(.+)$/i);
	return match ? match[1] : null;
}

export function isAuthorizedWithApiKey(req: Request, apiKey: string): boolean {
	const token = getBearerToken(req);
	if (!token) return false;
	return timingSafeCompare(token, apiKey);
}

export function isAuthorizedWithAdminKey(req: Request, adminKey: string): boolean {
	const header = req.headers['x-admin-key'];
	if (!header) return false;
	const value = Array.isArray(header) ? header[0] : String(header);
	return timingSafeCompare(value, adminKey);
}
