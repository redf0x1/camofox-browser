import path from 'node:path';

export function safeUserDir(rootDir: string, userId: string): string {
	const safe = encodeURIComponent(String(userId));
	return path.join(rootDir, safe);
}

export function sanitizeFilename(name: string): string {
	let base = String(name || 'download');
	base = base.replace(/\0/g, '');
	base = base.replace(/[\\/]/g, '_');
	base = base.trim();
	if (!base) base = 'download';
	if (base.length > 200) base = base.slice(0, 200);
	return base;
}

export function guessMimeType(filename: string): string {
	const ext = path.extname(filename).toLowerCase();
	const map: Record<string, string> = {
		'.pdf': 'application/pdf',
		'.zip': 'application/zip',
		'.gz': 'application/gzip',
		'.json': 'application/json',
		'.csv': 'text/csv',
		'.txt': 'text/plain',
		'.html': 'text/html',
		'.htm': 'text/html',
		'.png': 'image/png',
		'.jpg': 'image/jpeg',
		'.jpeg': 'image/jpeg',
		'.gif': 'image/gif',
		'.webp': 'image/webp',
		'.svg': 'image/svg+xml',
		'.mp4': 'video/mp4',
		'.webm': 'video/webm',
		'.mp3': 'audio/mpeg',
		'.wav': 'audio/wav',
	};
	return map[ext] || 'application/octet-stream';
}

export function normalizeExtensions(exts: string | string[] | undefined): string[] {
	if (!exts) return [];

	const items = Array.isArray(exts) ? exts : String(exts).split(',');
	return items
		.map((e) => String(e).trim().toLowerCase())
		.filter(Boolean)
		.map((e) => (e.startsWith('.') ? e : `.${e}`));
}
