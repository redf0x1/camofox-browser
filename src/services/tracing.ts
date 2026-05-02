import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { BrowserContext } from 'playwright-core';
import { loadConfig } from '../utils/config';

const CONFIG = loadConfig();
const TRACES_DIR = CONFIG.tracesDir;
const MAX_TRACE_DURATION = CONFIG.traceMaxDurationMs;

interface TracingState {
	active: boolean;
	chunkActive: boolean;
	startedAt: number;
	timer?: ReturnType<typeof setTimeout>;
}

const states = new Map<string, TracingState>();

function defaultPath(userId: string): string {
	mkdirSync(TRACES_DIR, { recursive: true });
	const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
	return join(TRACES_DIR, `${safeUserId}-${Date.now()}.zip`);
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

export function listTraceArtifacts(userId: string): Array<{ filename: string; path: string; size: number; createdAt: number }> {
	const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
	mkdirSync(TRACES_DIR, { recursive: true });
	return readdirSync(TRACES_DIR, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.startsWith(`${safeUserId}-`) && entry.name.endsWith('.zip'))
		.map((entry) => {
			const path = join(TRACES_DIR, entry.name);
			const stat = statSync(path);
			return { filename: entry.name, path, size: stat.size, createdAt: stat.mtimeMs };
		})
		.sort((a, b) => b.createdAt - a.createdAt);
}

export function resolveTraceArtifactPath(userId: string, filename: string): string {
	if (!/^[a-zA-Z0-9_.-]+\.zip$/.test(filename) || filename.includes('..') || filename.includes('/')) {
		throw new Error('Invalid trace filename');
	}
	const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
	if (!filename.startsWith(`${safeUserId}-`)) {
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
