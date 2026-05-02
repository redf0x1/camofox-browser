import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { BrowserContext } from 'playwright-core';
import { loadConfig } from '../utils/config';

const CONFIG = loadConfig();
const TRACES_DIR = CONFIG.tracesDir;
const MAX_TRACE_DURATION = CONFIG.traceMaxDurationMs;
const TRACE_ARTIFACT_FILENAME_PATTERN = /^([A-Za-z0-9_-]+)-\d+\.zip$/;

interface TracingState {
	active: boolean;
	chunkActive: boolean;
	startedAt: number;
	timer?: ReturnType<typeof setTimeout>;
}

const states = new Map<string, TracingState>();

function getTraceArtifactOwnerToken(userId: string): string {
	return Buffer.from(userId, 'utf8').toString('base64url');
}

function buildTraceArtifactFilename(userId: string): string {
	return `${getTraceArtifactOwnerToken(userId)}-${Date.now()}.zip`;
}

function getTraceArtifactFilenameOwnerToken(filename: string): string | null {
	const match = TRACE_ARTIFACT_FILENAME_PATTERN.exec(filename);
	return match ? match[1] : null;
}

function defaultPath(userId: string): string {
	mkdirSync(TRACES_DIR, { recursive: true });
	return join(TRACES_DIR, buildTraceArtifactFilename(userId));
}

function ensureOutputDir(path: string): void {
	mkdirSync(join(path, '..'), { recursive: true });
}

function resolveAndValidateOutputPath(outputPath: string): string {
	const resolvedPath = resolve(outputPath);
	const normalizedTracesDir = TRACES_DIR.endsWith('/') ? TRACES_DIR : `${TRACES_DIR}/`;
	if (!resolvedPath.startsWith(normalizedTracesDir) && resolvedPath !== TRACES_DIR) {
		throw new Error('Invalid trace output path: must be within traces directory');
	}
	return resolvedPath;
}

export function listTraceArtifacts(userId: string): Array<{ filename: string; size: number; createdAt: number }> {
	const ownerToken = getTraceArtifactOwnerToken(userId);
	mkdirSync(TRACES_DIR, { recursive: true });
	return readdirSync(TRACES_DIR, { withFileTypes: true })
		.filter((entry) => entry.isFile() && getTraceArtifactFilenameOwnerToken(entry.name) === ownerToken)
		.map((entry) => {
			const path = join(TRACES_DIR, entry.name);
			const stat = statSync(path);
			return { filename: entry.name, size: stat.size, createdAt: stat.mtimeMs };
		})
		.sort((a, b) => b.createdAt - a.createdAt);
}

export function resolveTraceArtifactPath(userId: string, filename: string): string {
	if (!TRACE_ARTIFACT_FILENAME_PATTERN.test(filename)) {
		throw new Error('Invalid trace filename');
	}
	const ownerToken = getTraceArtifactOwnerToken(userId);
	if (getTraceArtifactFilenameOwnerToken(filename) !== ownerToken) {
		throw new Error('Trace artifact does not belong to this user');
	}
	return resolveAndValidateOutputPath(join(TRACES_DIR, filename));
}

export function deleteTraceArtifact(userId: string, filename: string): boolean {
	const filePath = resolveTraceArtifactPath(userId, filename);
	unlinkSync(filePath);
	return true;
}

export async function startTracing(
	userId: string,
	context: BrowserContext,
	options: { screenshots?: boolean; snapshots?: boolean } = {},
): Promise<void> {
	if (states.get(userId)?.active) {
		throw new Error('Tracing already active for this user');
	}

	await context.tracing.start({
		screenshots: options.screenshots ?? true,
		snapshots: options.snapshots ?? true,
	});

	const state: TracingState = {
		active: true,
		chunkActive: false,
		startedAt: Date.now(),
	};

	if (MAX_TRACE_DURATION > 0) {
		state.timer = setTimeout(async () => {
			try {
				if (states.get(userId)?.active) {
					const path = defaultPath(userId);
					await context.tracing.stop({ path });
				}
			} catch {
				// ignore if context already closed
			} finally {
				states.delete(userId);
			}
		}, MAX_TRACE_DURATION);
	}

	states.set(userId, state);
}

export async function stopTracing(
	userId: string,
	context: BrowserContext,
	outputPath?: string,
): Promise<{ path: string; size: number; alreadyStopped?: boolean }> {
	const state = states.get(userId);
	if (!state?.active) {
		throw new Error('No active tracing for this user');
	}

	if (state.timer) {
		clearTimeout(state.timer);
	}

	const path = outputPath ? resolveAndValidateOutputPath(outputPath) : defaultPath(userId);
	ensureOutputDir(path);
	try {
		await context.tracing.stop({ path });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes('Must start tracing')) {
			if (state.timer) {
				clearTimeout(state.timer);
			}
			states.delete(userId);
			return { path: '', size: 0, alreadyStopped: true };
		}
		throw err;
	}
	states.delete(userId);
	const size = statSync(path).size;
	return { path, size };
}

export async function startTracingChunk(userId: string, context: BrowserContext): Promise<void> {
	const state = states.get(userId);
	if (!state?.active) {
		throw new Error('Tracing not started — call trace start first');
	}
	if (state.chunkActive) {
		throw new Error('Chunk already active');
	}

	await context.tracing.startChunk();
	state.chunkActive = true;
}

export async function stopTracingChunk(
	userId: string,
	context: BrowserContext,
	outputPath?: string,
): Promise<{ path: string; size: number }> {
	const state = states.get(userId);
	if (!state?.chunkActive) {
		throw new Error('No active chunk');
	}

	const path = outputPath ? resolveAndValidateOutputPath(outputPath) : defaultPath(userId);
	ensureOutputDir(path);
	await context.tracing.stopChunk({ path });
	state.chunkActive = false;
	const size = statSync(path).size;
	return { path, size };
}

export function getTracingState(userId: string): { active: boolean; chunkActive: boolean; startedAt: number | null } {
	const state = states.get(userId);
	return {
		active: state?.active ?? false,
		chunkActive: state?.chunkActive ?? false,
		startedAt: state?.startedAt ?? null,
	};
}

export function cleanupTracing(userId: string): void {
	const state = states.get(userId);
	if (state?.timer) {
		clearTimeout(state.timer);
	}
	states.delete(userId);
}
