import { mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { BrowserContext } from 'playwright-core';

const TRACES_DIR = process.env.CAMOFOX_TRACES_DIR || join(homedir(), '.camofox', 'traces');

const MAX_TRACE_DURATION = Number.parseInt(process.env.CAMOFOX_TRACE_MAX_DURATION_MS || '300000', 10);

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
