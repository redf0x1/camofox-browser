import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Download, Page } from 'playwright-core';

import type { DownloadInfo, DownloadListFilters } from '../types';
import { loadConfig } from '../utils/config';
import { guessMimeType, normalizeExtensions, safeUserDir, sanitizeFilename } from '../utils/download-helpers';
import { log } from '../middleware/logging';

const CONFIG = loadConfig();

// In-memory registry of downloads
const downloads = new Map<string, DownloadInfo>();

let cleanupInterval: NodeJS.Timeout | null = null;

const pagesWithListener = new WeakSet<Page>();

async function finalizeDownload(id: string, download: Download, filePath: string): Promise<void> {
	const info = downloads.get(id);
	if (!info) return;

	try {
		const failure = await download.failure();
		if (failure) {
			info.status = failure.toLowerCase().includes('canceled') ? 'canceled' : 'failed';
			info.error = failure;
			info.completedAt = Date.now();
			log('warn', 'download failed', { downloadId: id, tabId: info.tabId, userId: info.userId, error: failure });
			return;
		}

		let size = -1;
		try {
			const stat = fs.statSync(filePath);
			size = stat.size;
		} catch {
			size = -1;
		}

		info.size = size;
		info.status = 'completed';
		info.completedAt = Date.now();
		if (!info.mimeType) info.mimeType = guessMimeType(info.suggestedFilename || info.savedFilename);
		log('info', 'download completed', { downloadId: id, tabId: info.tabId, userId: info.userId, size });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		info.status = 'failed';
		info.error = message;
		info.completedAt = Date.now();
		log('error', 'download finalize failed', { downloadId: id, tabId: info.tabId, userId: info.userId, error: message });
	}
}

export function registerDownloadListener(tabId: string, userId: string, page: Page): void {
	if (!page || page.isClosed()) return;
	if (pagesWithListener.has(page)) return;
	pagesWithListener.add(page);

	page.on('download', (download: Download) => {
		const id = crypto.randomUUID();
		const createdAt = Date.now();
		const suggestedFilename = sanitizeFilename(download.suggestedFilename());
		const savedFilename = `${id}_${suggestedFilename}`;
		const dir = safeUserDir(CONFIG.downloadsDir, String(userId));
		fs.mkdirSync(dir, { recursive: true });
		const filePath = path.join(dir, savedFilename);

		const info: DownloadInfo = {
			id,
			tabId: String(tabId),
			userId: String(userId),
			suggestedFilename,
			savedFilename,
			mimeType: guessMimeType(suggestedFilename),
			size: -1,
			status: 'pending',
			url: download.url(),
			createdAt,
		};

		upsertDownload(info);
		log('info', 'download started', { downloadId: id, tabId: info.tabId, userId: info.userId, url: info.url, filename: suggestedFilename });

		void (async () => {
			try {
				await download.saveAs(filePath);

				const maxBytes = CONFIG.maxDownloadSizeMb * 1024 * 1024;
				try {
					const stat = fs.statSync(filePath);
					if (stat.size > maxBytes) {
						try {
							fs.unlinkSync(filePath);
						} catch {
							// ignore
						}
						const entry = downloads.get(id);
						if (entry) {
							entry.status = 'failed';
							entry.error = 'File exceeds maximum download size';
							entry.size = stat.size;
							entry.completedAt = Date.now();
						}
						log('warn', 'download exceeded max size', {
							downloadId: id,
							tabId: String(tabId),
							userId: String(userId),
							size: stat.size,
							maxBytes,
						});
						return;
					}
				} catch {
					// if stat fails, allow finalizeDownload to record failure/unknown size
				}

				await finalizeDownload(id, download, filePath);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const existing = downloads.get(id);
				if (existing) {
					existing.status = message.toLowerCase().includes('canceled') ? 'canceled' : 'failed';
					existing.error = message;
					existing.completedAt = Date.now();
				}
				log('error', 'download saveAs failed', { downloadId: id, tabId: String(tabId), userId: String(userId), error: message });
			}
		})();
	});
}

export function upsertDownload(info: DownloadInfo): void {
	const id = String(info.id);
	const uid = String(info.userId);
	const isNew = !downloads.has(id);

	if (isNew) {
		const cap = Math.max(1, Number(CONFIG.maxDownloadsPerUser) || 500);
		const userEntries = Array.from(downloads.values()).filter((d) => String(d.userId) === uid);
		if (userEntries.length >= cap) {
			const evictable = userEntries.filter((d) => d.status !== 'pending');
			if (evictable.length) {
				evictable.sort((a, b) => {
					const at = Number(a.completedAt ?? a.createdAt ?? 0);
					const bt = Number(b.completedAt ?? b.createdAt ?? 0);
					return at - bt;
				});
				const oldest = evictable[0];
				deleteDownloadEntry(String(oldest.id), oldest);
			}
		}
	}

	downloads.set(id, info);
}

function deleteDownloadEntry(id: string, info: DownloadInfo): void {
	const filePath = path.join(safeUserDir(CONFIG.downloadsDir, String(info.userId)), info.savedFilename);
	try {
		fs.unlinkSync(filePath);
	} catch {
		// ignore
	}
	downloads.delete(String(id));
}

function matchFilters(info: DownloadInfo, filters: DownloadListFilters): boolean {
	if (String(info.userId) !== String(filters.userId)) return false;
	if (filters.tabId && String(info.tabId) !== String(filters.tabId)) return false;
	if (filters.status && String(info.status) !== String(filters.status)) return false;

	const extFilters = normalizeExtensions(filters.extension);
	if (extFilters.length) {
		const ext = path.extname(info.suggestedFilename || info.savedFilename).toLowerCase();
		if (!extFilters.includes(ext)) return false;
	}

	if (filters.mimeType) {
		const prefix = String(filters.mimeType);
		if (!String(info.mimeType || '').startsWith(prefix)) return false;
	}

	if (filters.minSize !== undefined && Number.isFinite(filters.minSize)) {
		if (info.size !== -1 && info.size < Number(filters.minSize)) return false;
	}
	if (filters.maxSize !== undefined && Number.isFinite(filters.maxSize)) {
		if (info.size !== -1 && info.size > Number(filters.maxSize)) return false;
	}

	return true;
}

export function listDownloads(filters: DownloadListFilters): {
	downloads: DownloadInfo[];
	pagination: { total: number; offset: number; limit: number; hasMore: boolean };
} {
	const limit = Math.max(1, Math.min(200, Number(filters.limit ?? 50) || 50));
	const offset = Math.max(0, Number(filters.offset ?? 0) || 0);

	const all = Array.from(downloads.values()).filter((d) => matchFilters(d, filters));

	const sort = String(filters.sort || 'createdAt:desc');
	const [field, dir] = sort.split(':');
	const desc = (dir || 'desc').toLowerCase() === 'desc';
	const sorted = all.sort((a, b) => {
		const av = (a as unknown as Record<string, unknown>)[field] as number | string | undefined;
		const bv = (b as unknown as Record<string, unknown>)[field] as number | string | undefined;
		const an = typeof av === 'number' ? av : Number(av ?? 0);
		const bn = typeof bv === 'number' ? bv : Number(bv ?? 0);
		return desc ? bn - an : an - bn;
	});

	const total = sorted.length;
	const paginated = sorted.slice(offset, offset + limit);
	return {
		downloads: paginated,
		pagination: { total, offset, limit, hasMore: offset + limit < total },
	};
}

export function getDownload(id: string, userId: string): DownloadInfo | null {
	const info = downloads.get(String(id));
	if (!info) return null;
	if (String(info.userId) !== String(userId)) return null;
	return info;
}

export function getDownloadPath(id: string, userId: string): string | null {
	const info = getDownload(id, userId);
	if (!info) return null;
	if (info.status !== 'completed') return null;
	const filePath = path.join(safeUserDir(CONFIG.downloadsDir, String(userId)), info.savedFilename);
	try {
		if (!fs.existsSync(filePath)) return null;
		return filePath;
	} catch {
		return null;
	}
}

export function deleteDownload(id: string, userId: string): boolean {
	const info = getDownload(id, userId);
	if (!info) return false;

	const filePath = path.join(safeUserDir(CONFIG.downloadsDir, String(userId)), info.savedFilename);
	try {
		fs.unlinkSync(filePath);
	} catch {
		// ignore
	}
	downloads.delete(String(id));
	log('info', 'download deleted', { downloadId: String(id), userId: String(userId) });
	return true;
}

export function getRecentDownloads(tabId: string, windowMs: number): DownloadInfo[] {
	const now = Date.now();
	return Array.from(downloads.values()).filter((d) => d.tabId === String(tabId) && now - d.createdAt <= windowMs);
}

export function cleanupExpiredDownloads(ttlMs: number): number {
	const now = Date.now();
	let removed = 0;
	for (const [id, info] of downloads) {
		if (info.status === 'pending') continue;
		if (now - info.createdAt <= ttlMs) continue;
		const filePath = path.join(safeUserDir(CONFIG.downloadsDir, info.userId), info.savedFilename);
		try {
			fs.unlinkSync(filePath);
		} catch {
			// ignore
		}
		downloads.delete(id);
		removed++;
	}
	if (removed > 0) log('info', 'expired downloads cleaned', { removed });
	return removed;
}

export function cleanupUserDownloads(userId: string): number {
	const uid = String(userId);
	let removed = 0;
	for (const [id, info] of downloads) {
		if (String(info.userId) !== uid) continue;
		const filePath = path.join(safeUserDir(CONFIG.downloadsDir, uid), info.savedFilename);
		try {
			fs.unlinkSync(filePath);
		} catch {
			// ignore
		}
		downloads.delete(id);
		removed++;
	}
	if (removed > 0) log('info', 'user downloads cleaned', { userId: uid, removed });
	return removed;
}

export function startCleanupInterval(ttlMs: number, intervalMs: number = 60_000): NodeJS.Timeout {
	if (cleanupInterval) return cleanupInterval;
	cleanupInterval = setInterval(() => {
		cleanupExpiredDownloads(ttlMs);
	}, intervalMs);
	cleanupInterval.unref();
	return cleanupInterval;
}

export function stopCleanupInterval(): void {
	if (cleanupInterval) {
		clearInterval(cleanupInterval);
		cleanupInterval = null;
	}
}
