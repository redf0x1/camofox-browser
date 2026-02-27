import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import type { Page } from 'playwright-core';

import type { ContextPool } from './context-pool';
import type { YouTubeTranscriptResult } from '../types';

const execFileAsync = promisify(execFile);

const YT_DLP_CANDIDATES = ['yt-dlp', '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp'];
const SAFE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR'] as const;
const LANG_RE = /^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/;
const ALLOWED_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com'];
export const INTERNAL_TRANSCRIPT_USER_ID = '__yt_transcript__';

let ytDlpPath: string | null = null;

function formatMs(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}]`;
}

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x27;/gi, "'")
		.replace(/&#x2F;/gi, '/');
}

function normalizeTranscriptText(raw: string): string {
	return decodeHtmlEntities(raw)
		.replace(/\s+/g, ' ')
		.trim();
}

function countWords(text: string): number {
	if (!text.trim()) return 0;
	return text.trim().split(/\s+/).length;
}

export function extractVideoId(url: string): string | null {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase();
		if (host === 'youtu.be') {
			const id = parsed.pathname.split('/').filter(Boolean)[0];
			return id || null;
		}
		if (parsed.pathname.startsWith('/shorts/')) {
			const id = parsed.pathname.split('/').filter(Boolean)[1];
			return id || null;
		}
		return parsed.searchParams.get('v') || null;
	} catch {
		return null;
	}
}

function normalizeYoutubeUrl(rawUrl: string): string {
	const trimmed = String(rawUrl || '').trim();
	if (!trimmed) throw new Error('YouTube URL is required');

	const parsed = new URL(trimmed);
	if (!['https:', 'http:'].includes(parsed.protocol)) {
		throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
	}

	const host = parsed.hostname.toLowerCase();
	if (!ALLOWED_HOSTS.includes(host)) {
		throw new Error(`Unsupported host: ${host}`);
	}

	const videoId = extractVideoId(parsed.toString());
	if (!videoId) throw new Error('Invalid YouTube URL: missing video ID');

	if (host === 'youtu.be') {
		return `https://youtu.be/${encodeURIComponent(videoId)}`;
	}

	const out = new URL('https://www.youtube.com/watch');
	out.searchParams.set('v', videoId);
	const time = parsed.searchParams.get('t');
	if (time) out.searchParams.set('t', time);
	return out.toString();
}

function normalizeLanguage(rawLang: string): string {
	const candidate = String(rawLang || '').trim();
	if (!candidate) return 'en';
	if (!LANG_RE.test(candidate)) return 'en';
	return candidate.toLowerCase();
}

function buildSafeEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of SAFE_ENV_KEYS) {
		const value = process.env[key];
		if (typeof value === 'string' && value.length > 0) env[key] = value;
	}
	return env;
}

async function runYtDlp(binary: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
	const result = await execFileAsync(binary, args, {
		env: buildSafeEnv(),
		timeout: Math.max(1000, timeoutMs),
		maxBuffer: 4 * 1024 * 1024,
		windowsHide: true,
	});
	return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export async function detectYtDlp(log: (...args: unknown[]) => void): Promise<void> {
	for (const candidate of YT_DLP_CANDIDATES) {
		try {
			const { stdout } = await runYtDlp(candidate, ['--version'], 5000);
			ytDlpPath = candidate;
			log(`yt-dlp detected at ${candidate} (version: ${stdout.trim() || 'unknown'})`);
			return;
		} catch {
			continue;
		}
	}
	ytDlpPath = null;
	log('yt-dlp not detected; browser fallback will be used for YouTube transcripts');
}

export function hasYtDlp(): boolean {
	return ytDlpPath !== null;
}

function pickSubtitleFile(files: string[], lang: string): string | null {
	const exts = ['.json3', '.vtt', '.srv3', '.xml'];
	let best: { file: string; score: number } | null = null;
	for (const file of files) {
		const lower = file.toLowerCase();
		const extIndex = exts.findIndex((ext) => lower.endsWith(ext));
		if (extIndex === -1) continue;
		let score = 100 - extIndex;
		if (lower.includes(`.${lang.toLowerCase()}.`)) score += 20;
		if (lower.includes('.en.')) score += 5;
		if (!best || score > best.score) best = { file, score };
	}
	return best?.file ?? null;
}

export async function ytDlpTranscript(
	reqId: string,
	url: string,
	videoId: string,
	lang: string,
	timeoutMs: number,
): Promise<YouTubeTranscriptResult> {
	void reqId;
	if (!ytDlpPath) throw new Error('yt-dlp is not available');

	const normalizedUrl = normalizeYoutubeUrl(url);
	const normalizedLang = normalizeLanguage(lang);
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-yt-'));

	try {
		const outputTemplate = path.join(tempDir, 'subtitle.%(ext)s');
		const subLangs = normalizedLang === 'en' ? 'en' : `${normalizedLang},en`;

		await runYtDlp(
			ytDlpPath,
			[
				normalizedUrl,
				'--js-runtimes',
				'node',
				'--skip-download',
				'--write-sub',
				'--write-auto-sub',
				'--no-abort-on-error',
				'--sub-langs',
				subLangs,
				'--sub-format',
				'json3/vtt/srv3',
				'--output',
				outputTemplate,
			],
			timeoutMs,
		);

		const titleResult = await runYtDlp(
			ytDlpPath,
			[normalizedUrl, '--js-runtimes', 'node', '--skip-download', '--print', 'title'],
			Math.min(timeoutMs, 15000),
		);
		const videoTitle = titleResult.stdout.trim().split('\n').filter(Boolean)[0] || '';

		const files = await fs.readdir(tempDir);
		const subtitleFile = pickSubtitleFile(files, normalizedLang);
		if (!subtitleFile) {
			throw new Error('No subtitle file produced by yt-dlp');
		}

		const fullPath = path.join(tempDir, subtitleFile);
		const content = await fs.readFile(fullPath, 'utf8');
		let transcript = '';
		if (subtitleFile.endsWith('.json3')) {
			transcript = parseJson3(content) || '';
		} else if (subtitleFile.endsWith('.vtt')) {
			transcript = parseVtt(content);
		} else {
			transcript = parseXml(content);
		}

		if (!transcript.trim()) {
			throw new Error('Subtitle file was parsed but transcript is empty');
		}

		return {
			status: 'ok',
			transcript,
			video_url: normalizedUrl,
			video_id: videoId,
			video_title: videoTitle,
			title: videoTitle,
			language: normalizedLang,
			total_words: countWords(transcript),
		};
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	}
}

async function setupTimedTextCapture(page: Page): Promise<Promise<string>> {
	let settled = false;
	let resolver: ((value: string) => void) | null = null;
	let rejecter: ((reason?: unknown) => void) | null = null;

	const timedTextPromise = new Promise<string>((resolve, reject) => {
		resolver = resolve;
		rejecter = reject;
	});

	const listener = async (resp: { url: () => string; text: () => Promise<string> }): Promise<void> => {
		if (settled) return;
		const respUrl = resp.url();
		if (!respUrl.includes('/api/timedtext')) return;
		try {
			const body = await resp.text();
			if (!body) return;
			settled = true;
			page.off('response', listener as never);
			resolver?.(body);
		} catch (err) {
			settled = true;
			page.off('response', listener as never);
			rejecter?.(err);
		}
	};

	page.on('response', listener as never);
	return timedTextPromise;
}

export async function browserTranscript(
	reqId: string,
	url: string,
	videoId: string,
	lang: string,
	contextPool: ContextPool,
	timeoutMs: number,
): Promise<YouTubeTranscriptResult> {
	void reqId;
	const normalizedUrl = normalizeYoutubeUrl(url);
	const normalizedLang = normalizeLanguage(lang);

	const entry = await contextPool.ensureContext(INTERNAL_TRANSCRIPT_USER_ID);
	const page = await entry.context.newPage();
	let hardTimeoutTimer: NodeJS.Timeout | undefined;

	try {
		return await Promise.race<YouTubeTranscriptResult>([
			(async () => {
				await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,css}', (route) => route.abort());
				const timedTextPromise = await setupTimedTextCapture(page);

				await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

				const meta = await page.evaluate(
					async ({ preferredLang }) => {
						const doc = (globalThis as unknown as { document?: { querySelector: (selector: string) => { innerText?: string } | null; title?: string } }).document;
						const video = doc?.querySelector('video') as { muted?: boolean; play?: () => Promise<void> } | null;
						if (video) {
							video.muted = true;
							try {
								await video.play?.();
							} catch {
								// ignore autoplay failures
							}
						}

						const title = doc?.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.innerText
							|| doc?.title
							|| '';

						const player = (globalThis as unknown as {
							ytInitialPlayerResponse?: {
								captions?: {
									playerCaptionsTracklistRenderer?: {
										captionTracks?: Array<{
											baseUrl?: string;
											languageCode?: string;
											kind?: string;
											name?: { simpleText?: string; runs?: Array<{ text?: string }> };
										}>;
									};
								};
							};
						}).ytInitialPlayerResponse;
						const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
						const availableLanguages = tracks.map((track) => ({
							code: track.languageCode || '',
							name:
								track.name?.simpleText
								|| (track.name?.runs || []).map((run) => run.text || '').join('')
								|| track.languageCode
								|| 'unknown',
							kind: track.kind || 'subtitles',
						}));

						const selected =
							tracks.find((track) => track.languageCode === preferredLang)
							|| tracks.find((track) => (track.languageCode || '').startsWith(preferredLang.split('-')[0]))
							|| tracks[0]
							|| null;

						if (selected?.baseUrl) {
							const timedTextUrl = selected.baseUrl.includes('fmt=')
								? selected.baseUrl
								: `${selected.baseUrl}${selected.baseUrl.includes('?') ? '&' : '?'}fmt=json3`;
							try {
								await fetch(timedTextUrl, { credentials: 'include' });
							} catch {
								// network listener may still capture player request
							}
						}

						return { title, availableLanguages };
					},
					{ preferredLang: normalizedLang },
				);

				let timer: NodeJS.Timeout | undefined;
				const timedTextResponse = await Promise.race<string>([
					timedTextPromise,
					new Promise<string>((_resolve, reject) => {
						timer = setTimeout(() => reject(new Error('Timedtext response timeout')), timeoutMs);
					}),
				]).finally(() => {
					if (timer) clearTimeout(timer);
				});

				const transcript = parseJson3(timedTextResponse);
				if (!transcript || !transcript.trim()) {
					throw new Error('Failed to parse transcript from browser fallback');
				}

				return {
					status: 'ok',
					transcript,
					video_url: normalizedUrl,
					video_id: videoId,
					video_title: meta.title,
					title: meta.title,
					language: normalizedLang,
					total_words: countWords(transcript),
					available_languages: (meta.availableLanguages || []).map((item: { code?: string; name?: string; kind?: string }) => ({
						code: item.code || '',
						name: item.name || 'unknown',
						kind: item.kind || 'subtitles',
					})),
				};
			})(),
			new Promise<YouTubeTranscriptResult>((_resolve, reject) => {
				hardTimeoutTimer = setTimeout(() => reject(new Error('Browser transcript timed out')), timeoutMs);
			}),
		]);
	} finally {
		if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer);
		await page.close().catch(() => {});
	}
}

export function parseJson3(content: string): string | null {
	try {
		const parsed = JSON.parse(content) as {
			events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }>;
		};
		const events = Array.isArray(parsed.events) ? parsed.events : [];
		const lines: string[] = [];

		for (const event of events) {
			if (!Array.isArray(event.segs) || event.segs.length === 0) continue;
			const text = normalizeTranscriptText(event.segs.map((segment) => segment.utf8 || '').join(''));
			if (!text) continue;
			const ts = formatMs(Number(event.tStartMs || 0));
			lines.push(`${ts} ${text}`);
		}

		return lines.length ? `${lines.join('\n')}\n` : null;
	} catch {
		return null;
	}
}

export function formatVttTs(ts: string): string {
	const raw = ts.trim();
	const parts = raw.split(':');
	let minutes = 0;
	let seconds = 0;

	if (parts.length === 3) {
		minutes = Number(parts[0]) * 60 + Number(parts[1]);
		seconds = Number(parts[2].split('.')[0]);
	} else if (parts.length === 2) {
		minutes = Number(parts[0]);
		seconds = Number(parts[1].split('.')[0]);
	}

	if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return '[00:00]';
	return `[${String(Math.max(0, minutes)).padStart(2, '0')}:${String(Math.max(0, seconds)).padStart(2, '0')}]`;
}

export function parseVtt(content: string): string {
	const lines = content.split(/\r?\n/);
	const output: string[] = [];
	let currentTs = '[00:00]';
	let cueText: string[] = [];

	const flush = (): void => {
		if (!cueText.length) return;
		const text = normalizeTranscriptText(cueText.join(' '));
		if (text) output.push(`${currentTs} ${text}`);
		cueText = [];
	};

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			flush();
			continue;
		}
		if (trimmed === 'WEBVTT' || trimmed.startsWith('NOTE') || /^\d+$/.test(trimmed)) {
			continue;
		}
		if (trimmed.includes('-->')) {
			flush();
			currentTs = formatVttTs(trimmed.split('-->')[0]);
			continue;
		}
		if (/^(Kind|Language):/i.test(trimmed)) continue;
		cueText.push(trimmed.replace(/<[^>]+>/g, ''));
	}
	flush();

	return output.length ? `${output.join('\n')}\n` : '';
}

export function parseXml(content: string): string {
	const output: string[] = [];
	const regex = /<text[^>]*start="([0-9.]+)"[^>]*>([\s\S]*?)<\/text>/g;
	let match: RegExpExecArray | null;

	while ((match = regex.exec(content)) !== null) {
		const seconds = Number(match[1]);
		const text = normalizeTranscriptText(match[2].replace(/<[^>]+>/g, ''));
		if (!Number.isFinite(seconds) || !text) continue;
		output.push(`${formatMs(seconds * 1000)} ${text}`);
	}

	return output.length ? `${output.join('\n')}\n` : '';
}
