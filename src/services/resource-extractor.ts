import type { Page } from 'playwright-core';

import type { ExtractResourcesParams, ExtractResourcesResult } from '../types';
import { normalizeExtensions } from '../utils/download-helpers';

export async function resolveBlob(page: Page, blobUrl: string): Promise<{ base64: string; mimeType: string } | null> {
	try {
		const result = await page.evaluate(async (url) => {
			const resp = await fetch(url);
			const blob = await resp.blob();
			const mimeType = blob.type || 'application/octet-stream';
			const dataUrl = await new Promise<string>((resolve, reject) => {
				const FileReaderCtor = (globalThis as unknown as { FileReader?: new () => any }).FileReader;
				if (!FileReaderCtor) return reject(new Error('FileReader not available'));
				const reader = new FileReaderCtor();
				reader.onerror = () => reject(new Error('FileReader failed'));
				reader.onloadend = () => resolve(String(reader.result || ''));
				reader.readAsDataURL(blob);
			});
			return { dataUrl, mimeType };
		}, blobUrl);

		if (!result || typeof result.dataUrl !== 'string' || !result.dataUrl.startsWith('data:')) return null;
		return { base64: result.dataUrl, mimeType: String(result.mimeType || 'application/octet-stream') };
	} catch {
		return null;
	}
}

export async function extractResources(page: Page, params: ExtractResourcesParams): Promise<ExtractResourcesResult> {
	const start = Date.now();
	const selector = params.selector || 'body';
	const requestedTypes = (params.types || ['images', 'links', 'media', 'documents']).map((t) => String(t));
	const extFilters = normalizeExtensions(params.extensions);

	let lazyLoadsTriggered = 0;
	if (params.triggerLazyLoad) {
		try {
			lazyLoadsTriggered = await page.evaluate((sel) => {
				const doc = (globalThis as unknown as { document: any }).document;
				const container = doc.querySelector(sel) as any;
				if (!container) return 0;

				let triggered = 0;
				const imgs = Array.from(container.querySelectorAll('img')) as any[];
				for (const img of imgs.slice(0, 50)) {
					try {
						img.scrollIntoView({ block: 'center', inline: 'nearest' });
						triggered++;
					} catch {
						// ignore
					}
				}
				return triggered;
			}, selector);
			await page.waitForTimeout(150);
		} catch {
			lazyLoadsTriggered = 0;
		}
	}

	const result = await page.evaluate(
		({ selector: sel, requestedTypes: rt, extFilters: exts }) => {
			const doc = (globalThis as unknown as { document: any }).document;
			const win = (globalThis as unknown as { window: any }).window;
			const container = doc.querySelector(sel) as any;
			if (!container) {
				return {
					ok: false,
					container: { selector: sel, tagName: 'none', childCount: 0 },
					resources: { images: [], links: [], media: [], documents: [] },
					metadata: { blobs: [] as string[] },
				};
			}

			const include = (key: string): boolean => rt.includes(key);
			const normalizeUrl = (raw: string): string | null => {
				try {
					if (!raw) return null;
					if (raw.startsWith('data:') || raw.startsWith('blob:')) return raw;
					const u = new URL(raw, win.location.href);
					return u.toString();
				} catch {
					return null;
				}
			};

			const extOk = (url: string, filename: string | null): boolean => {
				if (!exts || exts.length === 0) return true;
				const name = filename || '';
				const dot = name.lastIndexOf('.');
				const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
				if (ext && exts.includes(ext)) return true;

				try {
					const u = new URL(url, win.location.href);
					const base = u.pathname.split('/').pop() || '';
					const dot2 = base.lastIndexOf('.');
					const ext2 = dot2 >= 0 ? base.slice(dot2).toLowerCase() : '';
					return !!ext2 && exts.includes(ext2);
				} catch {
					return false;
				}
			};

			type Resource = {
				url: string;
				filename: string | null;
				mimeType: string | null;
				tagName: string;
				type: 'image' | 'link' | 'media' | 'document';
				alt: string | null;
				width: number | null;
				height: number | null;
				isBlob: boolean;
				isDataUri: boolean;
				hasDownloadAttr: boolean;
				text: string | null;
				ref: string | null;
				parentSelector: string | null;
			};

			const out: { images: Resource[]; links: Resource[]; media: Resource[]; documents: Resource[] } = {
				images: [],
				links: [],
				media: [],
				documents: [],
			};

			const blobs: string[] = [];

			const push = (bucket: keyof typeof out, r: Resource): void => {
				if (!extOk(r.url, r.filename)) return;
				out[bucket].push(r);
				if (r.isBlob) blobs.push(r.url);
			};

			if (include('images')) {
				const imgs = Array.from(container.querySelectorAll('img')) as any[];
				for (const img of imgs) {
					const raw = (img.currentSrc || img.src || img.getAttribute('data-src') || '').trim();
					const url = normalizeUrl(raw);
					if (!url) continue;
					const filename = (() => {
						try {
							const u = new URL(url, win.location.href);
							return (u.pathname.split('/').pop() || null) as string | null;
						} catch {
							return null;
						}
					})();
					push('images', {
						url,
						filename,
						mimeType: img.getAttribute('type'),
						tagName: 'IMG',
						type: 'image',
						alt: img.getAttribute('alt'),
						width: img.naturalWidth || (img.getAttribute('width') ? Number(img.getAttribute('width')) : null),
						height: img.naturalHeight || (img.getAttribute('height') ? Number(img.getAttribute('height')) : null),
						isBlob: url.startsWith('blob:'),
						isDataUri: url.startsWith('data:'),
						hasDownloadAttr: false,
						text: null,
						ref: null,
						parentSelector: img.parentElement ? img.parentElement.tagName.toLowerCase() : null,
					});
				}
			}

			if (include('links')) {
				const anchors = Array.from(container.querySelectorAll('a[href]')) as any[];
				for (const a of anchors) {
					const raw = (a.href || a.getAttribute('href') || '').trim();
					const url = normalizeUrl(raw);
					if (!url) continue;
					const filename = (() => {
						try {
							const u = new URL(url, win.location.href);
							return (u.pathname.split('/').pop() || null) as string | null;
						} catch {
							return null;
						}
					})();

					push('links', {
						url,
						filename,
						mimeType: null,
						tagName: 'A',
						type: 'link',
						alt: null,
						width: null,
						height: null,
						isBlob: url.startsWith('blob:'),
						isDataUri: url.startsWith('data:'),
						hasDownloadAttr: a.hasAttribute('download'),
						text: (a.textContent || '').trim().slice(0, 200) || null,
						ref: null,
						parentSelector: a.parentElement ? a.parentElement.tagName.toLowerCase() : null,
					});
				}
			}

			if (include('media')) {
				const nodes = Array.from(container.querySelectorAll('video[src],audio[src],source[src]')) as Array<
					any
				>;
				for (const n of nodes) {
					const raw = (n.getAttribute('src') || '').trim();
					const url = normalizeUrl(raw);
					if (!url) continue;
					const filename = (() => {
						try {
							const u = new URL(url, win.location.href);
							return (u.pathname.split('/').pop() || null) as string | null;
						} catch {
							return null;
						}
					})();
					push('media', {
						url,
						filename,
						mimeType: (n as any).type || null,
						tagName: n.tagName,
						type: 'media',
						alt: null,
						width: null,
						height: null,
						isBlob: url.startsWith('blob:'),
						isDataUri: url.startsWith('data:'),
						hasDownloadAttr: false,
						text: null,
						ref: null,
						parentSelector: n.parentElement ? n.parentElement.tagName.toLowerCase() : null,
					});
				}
			}

			if (include('documents')) {
				const embeds = Array.from(container.querySelectorAll('embed[src],object[data]')) as any[];
				for (const n of embeds) {
					const raw = (n && typeof n.tagName === 'string' && n.tagName.toLowerCase() === 'embed' ? n.getAttribute('src') : n.getAttribute('data')) || '';
					const url = normalizeUrl(String(raw).trim());
					if (!url) continue;
					const filename = (() => {
						try {
							const u = new URL(url, win.location.href);
							return (u.pathname.split('/').pop() || null) as string | null;
						} catch {
							return null;
						}
					})();
					push('documents', {
						url,
						filename,
						mimeType: n.getAttribute('type'),
						tagName: n.tagName,
						type: 'document',
						alt: null,
						width: null,
						height: null,
						isBlob: url.startsWith('blob:'),
						isDataUri: url.startsWith('data:'),
						hasDownloadAttr: false,
						text: null,
						ref: null,
						parentSelector: n.parentElement ? n.parentElement.tagName.toLowerCase() : null,
					});
				}
			}

			return {
				ok: true,
				container: { selector: sel, tagName: container.tagName.toLowerCase(), childCount: container.children.length },
				resources: out,
				metadata: { blobs },
			};
		},
		{ selector, requestedTypes, extFilters },
	);

	let blobsResolved = 0;
	const blobReplacements = new Map<string, { dataUrl: string; mimeType: string }>();
	if (params.resolveBlobs && result?.metadata?.blobs && Array.isArray(result.metadata.blobs)) {
		const unique = Array.from(new Set(result.metadata.blobs)).slice(0, 25);
		for (const blobUrl of unique) {
			const resolved = await resolveBlob(page, blobUrl);
			if (!resolved) continue;
			blobReplacements.set(blobUrl, { dataUrl: resolved.base64, mimeType: resolved.mimeType });
			blobsResolved++;
		}
	}

	if (result?.ok && blobReplacements.size > 0) {
		const apply = (resources: Array<{ url: string; mimeType: string | null; isBlob: boolean; isDataUri: boolean }>): void => {
			for (const r of resources) {
				const repl = blobReplacements.get(r.url);
				if (!repl) continue;
				r.url = repl.dataUrl;
				r.isBlob = false;
				r.isDataUri = true;
				if (!r.mimeType) r.mimeType = repl.mimeType;
			}
		};
		apply(result.resources.images);
		apply(result.resources.links);
		apply(result.resources.media);
		apply(result.resources.documents);
	}

	const images = result.ok ? result.resources.images : [];
	const links = result.ok ? result.resources.links : [];
	const media = result.ok ? result.resources.media : [];
	const documents = result.ok ? result.resources.documents : [];

	const totals = {
		images: images.length,
		links: links.length,
		media: media.length,
		documents: documents.length,
		total: images.length + links.length + media.length + documents.length,
	};

	return {
		ok: !!result.ok,
		container: result.container,
		resources: { images, links, media, documents },
		totals,
		metadata: {
			extractionTimeMs: Date.now() - start,
			lazyLoadsTriggered,
			blobsResolved,
		},
	};
}
