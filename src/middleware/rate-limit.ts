interface RateLimitEntry {
	count: number;
	resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

const sweepInterval = setInterval(() => {
	const now = Date.now();
	for (const [key, entry] of rateLimitStore) {
		if (entry.resetAt <= now) {
			rateLimitStore.delete(key);
		}
	}
}, 60_000);
sweepInterval.unref();

export function checkRateLimit(
	userId: string,
	maxRequests: number,
	windowMs: number,
): { allowed: boolean; retryAfterMs?: number } {
	const now = Date.now();
	let entry = rateLimitStore.get(userId);

	if (!entry || entry.resetAt <= now) {
		entry = { count: 1, resetAt: now + windowMs };
		rateLimitStore.set(userId, entry);
		return { allowed: true };
	}

	if (entry.count < maxRequests) {
		entry.count++;
		return { allowed: true };
	}

	return { allowed: false, retryAfterMs: entry.resetAt - now };
}
