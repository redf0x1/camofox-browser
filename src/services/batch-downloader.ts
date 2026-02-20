import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Page } from 'playwright-core';

import type { AppConfig } from '../utils/config';
import type { BatchDownloadParams, BatchDownloadResult, DownloadInfo, ExtractedResource } from '../types';
import { log } from '../middleware/logging';
import { guessMimeType, safeUserDir, sanitizeFilename } from '../utils/download-helpers';
import { extractResources, resolveBlob } from './resource-extractor';
import { buildContentUrl, upsertDownload } from './download';

function createSemaphore(max: number): { acquire: () => Promise<() => void> } {
	let active = 0;
	const queue: Array<() => void> = [];

	const acquire = async (): Promise<() => void> => {
		if (active < max) {
			active++;
			return () => {
				active--;
				const next = queue.shift();
				if (next) next();
			};
		}

		await new Promise<void>((resolve) => queue.push(resolve));
		active++;
		return () => {
			active--;
			const next = queue.shift();
			if (next) next();
		};
	};

	return { acquire };
}

function flattenResources(resources: {
	images: ExtractedResource[];
	links: ExtractedResource[];
	media: ExtractedResource[];
	documents: ExtractedResource[];
}): ExtractedResource[] {
	return [...resources.images, ...resources.links, ...resources.media, ...resources.documents];
}

function bytesFromDataUrl(dataUrl: string): number {
	const idx = dataUrl.indexOf(',');
	if (idx === -1) return 0;
	const meta = dataUrl.slice(0, idx);
	const data = dataUrl.slice(idx + 1);
	if (meta.includes(';base64')) {
		// base64 -> bytes approximation
		return Math.floor((data.length * 3) / 4);
	}
	try {
		const decoded = decodeURIComponent(data);
		return Buffer.byteLength(decoded);
	} catch {
		return Buffer.byteLength(data);
	}
}

export async function batchDownload(page: Page, params: BatchDownloadParams, config: AppConfig): Promise<BatchDownloadResult> {
	const batchId = crypto.randomUUID();
	const tabId = String((page as unknown as { __camofox_tabId?: string }).__camofox_tabId || 'unknown');
	if (page.isClosed()) throw new Error('Page is closed');

	const concurrency = Math.max(
		1,
		Math.min(config.maxBatchConcurrency, Number(params.concurrency ?? config.maxBatchConcurrency) || config.maxBatchConcurrency),
	);
	const maxFiles = Math.max(1, Math.min(500, Number(params.maxFiles ?? 50) || 50));

	const downloads: DownloadInfo[] = [];
	const errors: { url: string; error: string }[] = [];
	const created: DownloadInfo[] = [];
	const included = new Set<string>();

	const userDir = safeUserDir(config.downloadsDir, params.userId);
	fs.mkdirSync(userDir, { recursive: true });

	const maxDownloadBytes = config.maxDownloadSizeMb * 1024 * 1024;
	const maxBlobBytes = config.maxBlobSizeMb * 1024 * 1024;

	try {
		const extraction = await extractResources(page, {
			userId: params.userId,
			selector: params.selector,
			types: params.types,
			extensions: params.extensions,
			resolveBlobs: false,
			triggerLazyLoad: true,
		});

		const all = extraction.ok ? flattenResources(extraction.resources) : [];
		const candidates = all
			.filter((r) => typeof r.url === 'string' && !!r.url)
			.filter((r) => r.url.startsWith('http:') || r.url.startsWith('https:') || r.url.startsWith('blob:') || r.url.startsWith('data:'))
			.slice(0, maxFiles);

		const sem = createSemaphore(concurrency);

		await Promise.all(
			candidates.map(async (r) => {
				const release = await sem.acquire();
				let info: DownloadInfo | null = null;
				try {
					const id = crypto.randomUUID();
					const suggested = sanitizeFilename(r.filename || 'resource');
					const savedFilename = `${id}_${suggested}`;
					const filePath = path.join(userDir, savedFilename);

					info = {
						id,
						contentUrl: buildContentUrl(id, String(params.userId)),
						tabId,
						userId: String(params.userId),
						suggestedFilename: suggested,
						savedFilename,
						mimeType: r.mimeType || guessMimeType(suggested),
						size: -1,
						status: 'pending',
						url: r.url,
						createdAt: Date.now(),
					};
					upsertDownload(info);
					created.push(info);

				if (r.url.startsWith('blob:')) {
					if (!params.resolveBlobs) {
						info.status = 'failed';
						info.error = 'Blob URL requires resolveBlobs=true';
						info.completedAt = Date.now();
						upsertDownload(info);
						errors.push({ url: r.url, error: info.error });
						downloads.push(info);
						return;
					}

					const resolved = await resolveBlob(page, r.url);
					if (!resolved) {
						info.status = 'failed';
						info.error = 'Failed to resolve blob';
						info.completedAt = Date.now();
						upsertDownload(info);
						errors.push({ url: r.url, error: info.error });
						downloads.push(info);
						return;
					}

					const bytes = bytesFromDataUrl(resolved.base64);
					if (bytes > maxBlobBytes) {
						info.status = 'failed';
						info.error = `Blob exceeds maxBlobSizeMb (${config.maxBlobSizeMb}MB)`;
						info.completedAt = Date.now();
						upsertDownload(info);
						errors.push({ url: r.url, error: info.error });
						downloads.push(info);
						return;
					}

					const comma = resolved.base64.indexOf(',');
					const b64 = comma >= 0 ? resolved.base64.slice(comma + 1) : resolved.base64;
					fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));

					info.mimeType = resolved.mimeType;
					info.size = bytes;
					info.status = 'completed';
					info.completedAt = Date.now();
					upsertDownload(info);
					downloads.push(info);
					return;
				}

				if (r.url.startsWith('data:')) {
					const bytes = bytesFromDataUrl(r.url);
					if (bytes > maxBlobBytes) {
						info.status = 'failed';
						info.error = `Data URI exceeds maxBlobSizeMb (${config.maxBlobSizeMb}MB)`;
						info.completedAt = Date.now();
						upsertDownload(info);
						errors.push({ url: r.url, error: info.error });
						downloads.push(info);
						included.add(String(info.id));
						return;
					}

					const commaIdx = r.url.indexOf(',');
					const meta = r.url.substring(5, commaIdx); // after "data:"
					const data = r.url.substring(commaIdx + 1);
					let buf: Buffer;
					if (meta.includes(';base64')) {
						buf = Buffer.from(data, 'base64');
					} else {
						buf = Buffer.from(decodeURIComponent(data));
					}

					if (buf.length > maxBlobBytes) {
						info.status = 'failed';
						info.error = `Data URI exceeds maxBlobSizeMb (${config.maxBlobSizeMb}MB)`;
						info.completedAt = Date.now();
						upsertDownload(info);
						errors.push({ url: r.url, error: info.error });
						downloads.push(info);
						included.add(String(info.id));
						return;
					}

					const mime = meta.split(';')[0] || info.mimeType;
					fs.writeFileSync(filePath, buf);

					info.mimeType = mime;
					info.size = buf.length;
					info.status = 'completed';
					info.completedAt = Date.now();
					upsertDownload(info);
					downloads.push(info);
					included.add(String(info.id));
					return;
				}

				// http(s)
				const resp = await page.context().request.get(r.url, { timeout: 30_000 });
				if (!resp.ok()) {
					info.status = 'failed';
					info.error = `HTTP ${resp.status()}`;
					info.completedAt = Date.now();
					upsertDownload(info);
					errors.push({ url: r.url, error: info.error });
					downloads.push(info);
					return;
				}

				const body = await resp.body();
				if (body.length > maxDownloadBytes) {
					info.status = 'failed';
					info.error = `File exceeds maxDownloadSizeMb (${config.maxDownloadSizeMb}MB)`;
					info.completedAt = Date.now();
					upsertDownload(info);
					errors.push({ url: r.url, error: info.error });
					downloads.push(info);
					return;
				}

				fs.writeFileSync(filePath, body);
				info.size = body.length;
				info.mimeType = resp.headers()['content-type'] || info.mimeType;
				info.status = 'completed';
				info.completedAt = Date.now();
				upsertDownload(info);
				downloads.push(info);
				included.add(String(info.id));
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				errors.push({ url: r.url, error: message });
				log('warn', 'batch download item failed', { batchId, url: r.url, error: message });
				if (info && info.status === 'pending') {
					info.status = 'failed';
					info.error = message;
					info.completedAt = Date.now();
					upsertDownload(info);
					if (!included.has(String(info.id))) {
						downloads.push(info);
						included.add(String(info.id));
					}
				}
			} finally {
				release();
			}
			}),
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', 'batch download failed', { batchId, tabId, userId: String(params.userId), error: message });
		for (const info of created) {
			if (info.status !== 'pending') continue;
			info.status = 'failed';
			info.error = message;
			info.completedAt = Date.now();
			upsertDownload(info);
			errors.push({ url: info.url, error: message });
			if (!included.has(String(info.id))) {
				downloads.push(info);
				included.add(String(info.id));
			}
		}
		const completed = downloads.filter((d) => d.status === 'completed').length;
		const failed = downloads.filter((d) => d.status !== 'completed').length;
		return {
			ok: false,
			batchId,
			downloads,
			errors,
			totals: { completed, failed, total: downloads.length },
		};
	}

	const completed = downloads.filter((d) => d.status === 'completed').length;
	const failed = downloads.filter((d) => d.status !== 'completed').length;

	log('info', 'batch download finished', { batchId, tabId, userId: String(params.userId), completed, failed, total: downloads.length });

	return {
		ok: true,
		batchId,
		downloads,
		errors,
		totals: { completed, failed, total: downloads.length },
	};
}
