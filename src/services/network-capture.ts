import { randomBytes } from 'node:crypto';
import type { Page, Request, Response } from 'playwright-core';
import { NetworkInterceptor, type NetworkRule } from './network-interception';

const MAX_CAPTURES = 32;
const MAX_PAGES = 10;
const HARD_MAX_ENTRIES = 256;
const HARD_ACTIVE_MS = 15 * 60_000;
const MAX_ENTRIES = boundedSetting(process.env.CAMOFOX_NETWORK_MAX_ENTRIES, HARD_MAX_ENTRIES);
const ACTIVE_MS = boundedSetting(process.env.CAMOFOX_NETWORK_TTL_MS, HARD_ACTIVE_MS);
const MAX_URL_CHARS = 1024;
const STOPPED_MS = 5 * 60_000;
const MAX_SIZE_READS = 8;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_CAPTURE_BODY_BYTES = 64 * 1024;

type Scope = 'tab' | 'session';
type State = 'ready' | 'recording' | 'stopped';
type BodyState = 'pending' | 'skipped' | 'available' | 'unavailable';

type Header = { name: string; value: string };

type Entry = {
	id: number;
	tabId: string;
	startedAt: number;
	method: string;
	url: string;
	resourceType: string;
	requestHeaders: Header[];
	responseHeaders?: Header[];
	state: 'pending' | 'finished' | 'failed';
	redirectedFrom?: number;
	redirectUrl?: string;
	status?: number;
	mimeType?: string;
	durationMs?: number;
	responseSize?: number;
	failure?: string;
	bodyState?: BodyState;
};

export type NetworkOptions = { scope: Scope; start: boolean; join: boolean; captureBodies: boolean };

export class NetworkError extends Error {
	constructor(readonly statusCode: number, message: string) {
		super(message);
	}
}

export function parseNetworkOptions(value: unknown, userId: unknown, allowBodies = false): NetworkOptions | undefined {
	if (value === undefined) return;
	if (
		typeof userId !== 'string' || !userId.trim() || userId.length > 256 ||
		!value || typeof value !== 'object' || Array.isArray(value)
	) throw new NetworkError(400, 'Invalid network capture options');

	const { scope = 'tab', start = true, join = false, captureBodies = false } = value as Record<string, unknown>;
	if (
		Object.keys(value).some((key) => !['scope', 'start', 'join', 'captureBodies'].includes(key)) ||
		(scope !== 'tab' && scope !== 'session') ||
		typeof start !== 'boolean' || typeof join !== 'boolean' || typeof captureBodies !== 'boolean' ||
		(join && (scope !== 'session' || !start || captureBodies))
	) throw new NetworkError(400, 'Invalid network capture options');

	if (captureBodies && !allowBodies) throw new NetworkError(403, 'Network response body capture is disabled');
	return { scope, start, join, captureBodies };
}

function boundedSetting(value: string | undefined, fallback: number): number {
	const parsed = value && /^\d+$/.test(value) ? Number(value) : 0;
	return parsed > 0 ? Math.min(parsed, fallback) : fallback;
}

const captures = new Map<string, NetworkCapture>();
const attachedTabs = new Map<string, () => void>();

export function clearNetworkCaptures(): void {
	for (const capture of captures.values()) capture.dispose();
}

export function detachNetworkCaptureTab(tabId: string): void {
	attachedTabs.get(tabId)?.();
}
let sizeReads = 0;

export function findNetworkCapture(key: string | undefined, userId: string): NetworkCapture {
	const capture = key && /^[A-Za-z0-9_-]{43}$/.test(key) ? captures.get(key) : undefined;
	if (!capture || capture.userId !== userId) throw new NetworkError(404, 'Network capture not found');
	return capture;
}

export function redactNetworkUrl(raw: string): string | undefined {
	try {
		const url = new URL(raw);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
		url.username = '';
		url.password = '';
		url.search = '';
		url.hash = '';
		// Preserve a valid URL for HAR. An unusually large path falls back to its origin.
		return url.href.length <= MAX_URL_CHARS ? url.href : url.origin;
	} catch {
		return;
	}
}

function validNumber(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

function safeMethod(method: string): string {
	return /^(GET|HEAD|POST|PUT|DELETE|CONNECT|OPTIONS|TRACE|PATCH)$/.test(method) ? method : 'OTHER';
}

function safeMimeType(value: string | undefined): string | undefined {
	const mimeType = value?.slice(0, 128).split(';', 1)[0].trim().toLowerCase();
	return mimeType && /^[a-z0-9!#$&^_.+-]{1,40}\/[a-z0-9!#$&^_.+-]{1,60}$/.test(mimeType) ? mimeType : undefined;
}

function safeHeaders(headers: Record<string, string>): Header[] {
	const result: Header[] = [];
	const mimeType = safeMimeType(headers['content-type']);
	if (mimeType) result.push({ name: 'content-type', value: mimeType });
	const length = headers['content-length'];
	if (length && /^\d{1,12}$/.test(length)) result.push({ name: 'content-length', value: length });
	const encoding = headers['content-encoding'];
	if (encoding && /^(?:br|gzip|deflate|identity|zstd)$/.test(encoding)) {
		result.push({ name: 'content-encoding', value: encoding });
	}
	return result;
}

function bodyLength(response: Response, headers: Record<string, string>, mimeType?: string): number | undefined {
	// Compare the unencoded, framed length with the browser's finished byte
	// count before invoking the whole-buffer Playwright body API.
	const value = headers['content-length'];
	if (!value || !/^\d{1,5}$/.test(value) || headers['content-encoding'] !== undefined ||
		headers['transfer-encoding'] !== undefined || response.fromServiceWorker() ||
		response.status() < 200 || response.status() >= 300 ||
		!mimeType || !/^(?:text\/(?:plain|html|csv)|application\/(?:json|[a-z0-9.+-]+\+json))$/.test(mimeType)) return;
	const length = Number(value);
	return length > 0 && length <= MAX_BODY_BYTES ? length : undefined;
}

function safeFailure(value: string | undefined): string {
	return value && /^(NS_(?:ERROR|BINDING)_[A-Z0-9_]{1,60}|net::ERR_[A-Z0-9_]{1,60})$/.test(value)
		? value : 'REQUEST_FAILED';
}

class NetworkCapture {
	state: State = 'ready';
	private timer?: NodeJS.Timeout;
	private interceptor?: NetworkInterceptor;
	private nextId = 1;
	private dropped = 0;
	private readonly entries = new Map<number, Entry>();
	private readonly requestIds = new WeakMap<Request, number>();
	private readonly eligibleLengths = new WeakMap<Entry, number>();
	private readonly bodies = new Map<number, { text: string; bytes: number }>();
	private bodyBytes = 0;
	private readonly pages = new Map<Page, { stop: () => void; dispose: () => void }>();

	constructor(
		readonly key: string,
		readonly userId: string,
		readonly scope: Scope,
		readonly group: object,
		private readonly captureBodies: boolean,
	) {
		this.expireIn(ACTIVE_MS);
	}

	private expireIn(ms: number): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.dispose(), ms);
		this.timer.unref();
	}

	attach(page: Page, tabId: string): () => void {
		if (this.state === 'stopped') throw new NetworkError(409, 'Network capture has stopped');
		if (this.pages.size >= MAX_PAGES) throw new NetworkError(429, 'Network capture tab limit reached');
		if (attachedTabs.has(tabId) || page.isClosed?.()) throw new NetworkError(409, 'Tab unavailable for network capture');

		const onRequest = (request: Request) => {
			if (this.state !== 'recording') return;
			const url = redactNetworkUrl(request.url());
			if (!url) return;

			const timing = request.timing();
			const from = request.redirectedFrom();
			const redirectedFrom = from ? this.requestIds.get(from) : undefined;
			const entry: Entry = {
				id: this.nextId++,
				tabId,
				startedAt: timing.startTime > 0 && timing.startTime < 8.64e15 ? timing.startTime : Date.now(),
				method: safeMethod(request.method()),
				url,
				resourceType: request.resourceType().slice(0, 32),
				requestHeaders: safeHeaders(request.headers()),
				state: 'pending',
				redirectedFrom,
			};
			if (this.entries.size >= MAX_ENTRIES) {
				const oldest = this.entries.keys().next().value;
				if (oldest !== undefined) this.deleteEntry(oldest);
				this.dropped++;
			}
			this.entries.set(entry.id, entry);
			this.requestIds.set(request, entry.id);
		};
		const entryFor = (request: Request) => {
			const id = this.requestIds.get(request);
			return this.state === 'recording' && id !== undefined ? this.entries.get(id) : undefined;
		};
		const onResponse = (response: Response) => {
			const entry = entryFor(response.request());
			if (!entry) return;
			entry.status = response.status();
			const headers = response.headers();
			entry.responseHeaders = safeHeaders(headers);
			entry.mimeType = safeMimeType(headers['content-type']);
			if (this.captureBodies) {
				const length = bodyLength(response, headers, entry.mimeType);
				entry.bodyState = length === undefined ? 'skipped' : 'pending';
				if (length !== undefined) this.eligibleLengths.set(entry, length);
			}
			if (entry.status >= 300 && entry.status < 400 && headers.location) {
				try {
					entry.redirectUrl = redactNetworkUrl(new URL(headers.location, response.url()).href);
				} catch {
					// Malformed Location headers do not identify a redirect target.
				}
			}
		};
		const onFinished = (request: Request) => {
			const entry = entryFor(request);
			if (!entry) return;
			entry.state = 'finished';
			const { responseEnd } = request.timing();
			if (validNumber(responseEnd)) entry.durationMs = responseEnd;
			if (sizeReads >= MAX_SIZE_READS) {
				if (entry.bodyState === 'pending') entry.bodyState = 'skipped';
				return;
			}
			sizeReads++;
			void request.sizes().then(async ({ responseBodySize }) => {
				if (entryFor(request) !== entry) return;
				if (validNumber(responseBodySize)) entry.responseSize = responseBodySize;
				if (entry.bodyState !== 'pending') return;

				const expected = this.eligibleLengths.get(entry);
				if (expected === undefined || expected !== responseBodySize ||
					this.bodyBytes + expected > MAX_CAPTURE_BODY_BYTES) {
					entry.bodyState = 'skipped';
					return;
				}
				const response = await request.response();
				if (entryFor(request) !== entry) return;
				if (!response) {
					entry.bodyState = 'unavailable';
					return;
				}
				const body = await response.body();
				if (entryFor(request) !== entry) return;
				if (body.length !== expected || this.bodyBytes + body.length > MAX_CAPTURE_BODY_BYTES) {
					entry.bodyState = 'skipped';
					return;
				}
				const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
				this.bodies.set(entry.id, { text, bytes: body.length });
				this.bodyBytes += body.length;
				entry.bodyState = 'available';
			}).catch(() => {
				if (entryFor(request) === entry && entry.bodyState === 'pending') entry.bodyState = 'unavailable';
			}).finally(() => { sizeReads--; });
		};
		const onFailed = (request: Request) => {
			const entry = entryFor(request);
			if (!entry) return;
			entry.state = 'failed';
			if (entry.bodyState === 'pending') entry.bodyState = 'unavailable';
			entry.failure = safeFailure(request.failure()?.errorText);
			const { responseEnd } = request.timing();
			if (validNumber(responseEnd)) entry.durationMs = responseEnd;
		};
		const detach = () => {
			page.off('request', onRequest);
			page.off('response', onResponse);
			page.off('requestfinished', onFinished);
			page.off('requestfailed', onFailed);
		};
		const remove = () => {
			detach();
			page.off('close', remove);
			this.pages.delete(page);
			if (attachedTabs.get(tabId) === remove) attachedTabs.delete(tabId);
			if (!this.pages.size) this.dispose();
		};

		page.on('request', onRequest);
		page.on('response', onResponse);
		page.on('requestfinished', onFinished);
		page.on('requestfailed', onFailed);
		page.once('close', remove);
		attachedTabs.set(tabId, remove);
		this.pages.set(page, {
			stop: detach,
			dispose: () => {
				detach();
				page.off('close', remove);
				if (attachedTabs.get(tabId) === remove) attachedTabs.delete(tabId);
			},
		});
		return () => {
			remove();
			for (const [id, entry] of this.entries) {
				if (entry.tabId === tabId) this.deleteEntry(id);
			}
		};
	}

	start(): State {
		if (this.state === 'stopped') throw new NetworkError(409, 'Network capture has stopped');
		if (this.state === 'ready') {
			this.state = 'recording';
			this.expireIn(ACTIVE_MS);
		}
		return this.state;
	}

	stop(): State {
		if (this.state !== 'stopped') {
			this.state = 'stopped';
			this.interceptor?.close();
			for (const entry of this.entries.values()) {
				if (entry.bodyState === 'pending') entry.bodyState = 'unavailable';
			}
			for (const listeners of this.pages.values()) listeners.stop();
			this.expireIn(STOPPED_MS);
		}
		return this.state;
	}

	async setInterception(rules: NetworkRule[]): Promise<void> {
		const page = this.pages.keys().next().value;
		if (this.scope !== 'tab' || this.state !== 'recording' || !page) {
			throw new NetworkError(409, 'Interception requires an active tab capture');
		}
		this.interceptor ??= new NetworkInterceptor(page);
		if (!(await this.interceptor.replace(rules))) {
			throw new NetworkError(409, 'Interception update was superseded or the capture closed');
		}
	}

	list(after: number, limit: number) {
		const available = [...this.entries.values()].filter((entry) => entry.id > after);
		const requests = available.slice(0, limit);
		return {
			state: this.state,
			dropped: this.dropped,
			requests,
			nextCursor: available.length > limit ? requests.at(-1)?.id ?? null : null,
		};
	}

	private deleteEntry(id: number): void {
		this.entries.delete(id);
		const body = this.bodies.get(id);
		if (body) {
			this.bodyBytes -= body.bytes;
			this.bodies.delete(id);
		}
	}

	get(id: number, includeBody = false): Entry & { body?: string } {
		const entry = this.entries.get(id);
		if (!entry) throw new NetworkError(404, 'Network request not found');
		const body = includeBody ? this.bodies.get(id) : undefined;
		return body ? { ...entry, body: body.text } : entry;
	}

	har() {
		const entries = Array.from(this.entries.values(), (entry) => {
			const duration = entry.durationMs ?? -1;
			return {
				startedDateTime: new Date(entry.startedAt).toISOString(),
				time: Math.max(duration, 0),
				request: {
					method: entry.method, url: entry.url, httpVersion: '',
					cookies: [], headers: entry.requestHeaders, queryString: [], headersSize: -1, bodySize: -1,
				},
				response: {
					status: entry.status ?? 0, statusText: '', httpVersion: '', cookies: [],
					headers: entry.responseHeaders ?? [],
					content: { size: -1, mimeType: entry.mimeType ?? '' },
					redirectURL: entry.redirectUrl ?? '', headersSize: -1, bodySize: entry.responseSize ?? -1,
				},
				cache: {},
				timings: { send: 0, wait: Math.max(duration, 0), receive: 0 },
				_camofox: {
					tabId: entry.tabId, requestId: entry.id, redirectedFrom: entry.redirectedFrom,
					state: entry.state, failure: entry.failure,
				},
			};
		});
		return { log: { version: '1.2', creator: { name: 'CamoFox Browser', version: '1' }, entries, _dropped: this.dropped } };
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.state = 'stopped';
		this.interceptor?.close();
		for (const listeners of this.pages.values()) listeners.dispose();
		this.pages.clear();
		this.entries.clear();
		this.bodies.clear();
		this.bodyBytes = 0;
		captures.delete(this.key);
	}
}

export function attachNetworkCapture(
	options: NetworkOptions,
	userId: string,
	group: object,
	tabId: string,
	page: Page,
	key?: string,
): { key?: string; rollback: () => void } {
	if (options.join) {
		const capture = findNetworkCapture(key, userId);
		if (capture.scope !== 'session' || capture.group !== group) {
			throw new NetworkError(404, 'Network capture not found');
		}
		return { rollback: capture.attach(page, tabId) };
	}
	if (captures.size >= MAX_CAPTURES) throw new NetworkError(429, 'Network capture capacity reached');

	const capture = new NetworkCapture(randomBytes(32).toString('base64url'), userId, options.scope, group, options.captureBodies);
	captures.set(capture.key, capture);
	try {
		capture.attach(page, tabId);
		if (options.start) capture.start();
		return { key: capture.key, rollback: () => capture.dispose() };
	} catch (error) {
		capture.dispose();
		throw error;
	}
}
