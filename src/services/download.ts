import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Download, Page } from 'playwright-core';

import type { DownloadInfo, DownloadListFilters } from '../types';
import { loadConfig } from '../utils/config';
import { guessMimeType, normalizeExtensions, safeUserDir, sanitizeFilename } from '../utils/download-helpers';
import { log } from '../middleware/logging';

const CONFIG = loadConfig();

// In-memory registry of downloads (persisted to disk)
const downloads = new Map<string, DownloadInfo>();

const REGISTRY_FILE = path.join(CONFIG.downloadsDir, 'registry.json');

let saveTimer: NodeJS.Timeout | null = null;
let registryInitialized = false;

let cleanupInterval: NodeJS.Timeout | null = null;

const pagesWithListener = new WeakSet<Page>();

export function buildContentUrl(id: string, userId: string): string {
	return `/downloads/${String(id)}/content?userId=${encodeURIComponent(String(userId))}`;
}

function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function normalizeDownloadInfo(info: DownloadInfo): void {
	info.id = String(info.id);
	info.tabId = String(info.tabId);
	info.userId = String(info.userId);
	info.suggestedFilename = String(info.suggestedFilename || 'download');
	info.savedFilename = String(info.savedFilename || `${info.id}_${sanitizeFilename(info.suggestedFilename)}`);
	info.mimeType = String(info.mimeType || guessMimeType(info.suggestedFilename || info.savedFilename));
	info.url = String(info.url || '');
	if (typeof info.size !== 'number' || !Number.isFinite(info.size)) info.size = -1;
	if (typeof info.createdAt !== 'number' || !Number.isFinite(info.createdAt)) info.createdAt = Date.now();
	if (info.completedAt !== undefined && (typeof info.completedAt !== 'number' || !Number.isFinite(info.completedAt))) {
		delete info.completedAt;
	}
	info.contentUrl = buildContentUrl(info.id, info.userId);
}

function saveRegistryToDisk(): void {
	try {
		const obj: Record<string, DownloadInfo> = {};
		for (const [id, info] of downloads) {
			normalizeDownloadInfo(info);
			obj[String(id)] = info;
		}

		const tmp = `${REGISTRY_FILE}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
		fs.renameSync(tmp, REGISTRY_FILE);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('warn', 'download registry save failed', { error: message });
	}
}

function scheduleSaveRegistry(): void {
	if (saveTimer) return;
	saveTimer = setTimeout(() => {
		saveTimer = null;
		saveRegistryToDisk();
	}, 1000);
	// Don't keep the process alive just to flush registry.
	saveTimer.unref();
}

function loadRegistryFromDisk(): { loaded: number; removed: number } {
	let loaded = 0;
	let removed = 0;
	try {
		if (!fs.existsSync(REGISTRY_FILE)) return { loaded: 0, removed: 0 };
		const raw = fs.readFileSync(REGISTRY_FILE, 'utf-8');
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== 'object') return { loaded: 0, removed: 0 };
		const record = parsed as Record<string, unknown>;

		for (const [idKey, value] of Object.entries(record)) {
			if (!value || typeof value !== 'object') {
				removed++;
				continue;
			}
			const anyInfo = value as Record<string, unknown>;
			const id = String(anyInfo.id ?? idKey);
			const userId = String(anyInfo.userId ?? '');
			const savedFilename = String(anyInfo.savedFilename ?? '');
			if (!id || !userId || !savedFilename) {
				removed++;
				continue;
			}

			const filePath = path.join(safeUserDir(CONFIG.downloadsDir, userId), savedFilename);
			if (!fs.existsSync(filePath)) {
				removed++;
				continue;
			}

			let statSize = -1;
			let statMtime = Date.now();
			try {
				const stat = fs.statSync(filePath);
				statSize = stat.size;
				statMtime = typeof stat.mtimeMs === 'number' ? stat.mtimeMs : Date.now();
			} catch {
				// ignore
			}

			const suggested = String(anyInfo.suggestedFilename ?? savedFilename.replace(/^([0-9a-f-]{36})_/, '')) || 'download';
			const mimeType = String(anyInfo.mimeType ?? guessMimeType(suggested));
			const size = typeof anyInfo.size === 'number' && Number.isFinite(anyInfo.size) ? (anyInfo.size as number) : statSize;
			const createdAt =
				typeof anyInfo.createdAt === 'number' && Number.isFinite(anyInfo.createdAt) ? (anyInfo.createdAt as number) : statMtime;
			const completedAt =
				typeof anyInfo.completedAt === 'number' && Number.isFinite(anyInfo.completedAt) ? (anyInfo.completedAt as number) : statMtime;
			const statusRaw = String(anyInfo.status ?? 'completed');
			const status = (['pending', 'completed', 'failed', 'canceled'] as const).includes(statusRaw as any)
				? (statusRaw as DownloadInfo['status'])
				: 'completed';
			const error = typeof anyInfo.error === 'string' ? (anyInfo.error as string) : undefined;
			const url = typeof anyInfo.url === 'string' ? (anyInfo.url as string) : '';
			const tabId = typeof anyInfo.tabId === 'string' ? (anyInfo.tabId as string) : 'unknown';

			const info: DownloadInfo = {
				id,
				contentUrl: buildContentUrl(id, userId),
				tabId,
				userId,
				suggestedFilename: suggested,
				savedFilename,
				mimeType,
				size,
				status,
				error,
				url,
				createdAt,
				completedAt,
			};
			normalizeDownloadInfo(info);
			downloads.set(String(info.id), info);
			loaded++;
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('warn', 'download registry load failed', { error: message });
		return { loaded: 0, removed: 0 };
	}
	return { loaded, removed };
}

function scanOrphanedFiles(): number {
	let added = 0;
	let dirents: fs.Dirent[] = [];
	try {
		dirents = fs.readdirSync(CONFIG.downloadsDir, { withFileTypes: true });
	} catch {
		return 0;
	}

	for (const d of dirents) {
		if (!d.isDirectory()) continue;
		const encodedUserId = d.name;
		const userId = safeDecodeURIComponent(encodedUserId);
		const userDir = path.join(CONFIG.downloadsDir, encodedUserId);
		let files: string[] = [];
		try {
			files = fs.readdirSync(userDir);
		} catch {
			continue;
		}
		for (const file of files) {
			const uuidMatch = file.match(/^([0-9a-f-]{36})_(.+)$/i);
			if (!uuidMatch) continue;
			const id = uuidMatch[1];
			if (downloads.has(id)) continue;
			const filePath = path.join(userDir, file);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(filePath);
				if (!stat.isFile()) continue;
			} catch {
				continue;
			}

			const mtimeMs = typeof stat.mtimeMs === 'number' ? stat.mtimeMs : Date.now();
			const suggestedFilename = uuidMatch[2];
			const info: DownloadInfo = {
				id,
				contentUrl: buildContentUrl(id, userId),
				tabId: 'unknown',
				userId,
				suggestedFilename,
				savedFilename: file,
				size: stat.size,
				status: 'completed',
				mimeType: guessMimeType(suggestedFilename),
				url: '',
				createdAt: mtimeMs,
				completedAt: mtimeMs,
			};
			normalizeDownloadInfo(info);
			downloads.set(String(id), info);
			added++;
		}
	}

	return added;
}

function initializeRegistry(): void {
	if (registryInitialized) return;
	registryInitialized = true;

	const { loaded, removed } = loadRegistryFromDisk();
	const added = scanOrphanedFiles();
	if (loaded || removed || added) {
		log('info', 'download registry initialized', { loaded, removed, added });
		// Persist cleaned/rebuilt registry immediately.
		saveRegistryToDisk();
	}
}

initializeRegistry();

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
			normalizeDownloadInfo(info);
			scheduleSaveRegistry();
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
		normalizeDownloadInfo(info);
		scheduleSaveRegistry();
		log('info', 'download completed', { downloadId: id, tabId: info.tabId, userId: info.userId, size });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		info.status = 'failed';
		info.error = message;
		info.completedAt = Date.now();
		normalizeDownloadInfo(info);
		scheduleSaveRegistry();
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
			contentUrl: buildContentUrl(id, String(userId)),
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
							normalizeDownloadInfo(entry);
							scheduleSaveRegistry();
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
					normalizeDownloadInfo(existing);
					scheduleSaveRegistry();
				}
				log('error', 'download saveAs failed', { downloadId: id, tabId: String(tabId), userId: String(userId), error: message });
			}
		})();
	});
}

export function upsertDownload(info: DownloadInfo): void {
	normalizeDownloadInfo(info);
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
	scheduleSaveRegistry();
}

function deleteDownloadEntry(id: string, info: DownloadInfo): void {
	const filePath = path.join(safeUserDir(CONFIG.downloadsDir, String(info.userId)), info.savedFilename);
	try {
		fs.unlinkSync(filePath);
	} catch {
		// ignore
	}
	downloads.delete(String(id));
	scheduleSaveRegistry();
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
	scheduleSaveRegistry();
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
		const referenceTime = info.completedAt || info.createdAt;
		if (now - referenceTime <= ttlMs) continue;
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
	if (removed > 0) scheduleSaveRegistry();
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
	if (removed > 0) scheduleSaveRegistry();
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
