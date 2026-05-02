import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';

import type { BrowserContext } from 'playwright-core';
import { loadConfig } from '../utils/config';

const CONFIG = loadConfig();
const MAX_TRACE_DURATION = CONFIG.traceMaxDurationMs;
const TRACE_ARTIFACT_FILENAME_PATTERN = /^([A-Za-z0-9_-]+)-\d+\.zip$/;

interface TracingState {
	active: boolean;
	chunkActive: boolean;
	startedAt: number;
	timer?: ReturnType<typeof setTimeout>;
	stopPromise?: Promise<void>;
}

const states = new Map<string, TracingState>();

function getTracesDir(): string {
	const configuredTracesDir =
		typeof CONFIG.tracesDir === 'string' && CONFIG.tracesDir.length > 0
			? CONFIG.tracesDir
			: join(os.homedir(), '.camofox', 'traces');
	return resolve(configuredTracesDir);
}

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
	const tracesDir = getTracesDir();
	mkdirSync(tracesDir, { recursive: true });
	return join(tracesDir, buildTraceArtifactFilename(userId));
}

function ensureOutputDir(path: string): void {
	mkdirSync(join(path, '..'), { recursive: true });
}

function resolveAndValidateOutputPath(outputPath: string): string {
	const tracesDir = getTracesDir();
	const resolvedPath = resolve(outputPath);
	const normalizedTracesDir = tracesDir.endsWith('/') ? tracesDir : `${tracesDir}/`;
	if (!resolvedPath.startsWith(normalizedTracesDir) && resolvedPath !== tracesDir) {
		throw new Error('Invalid trace output path: must be within traces directory');
	}
	return resolvedPath;
}

function resolveManagedTraceOutputPath(userId: string, outputPath?: string): string {
	if (!outputPath) {
		return defaultPath(userId);
	}

	resolveAndValidateOutputPath(outputPath);
	return join(getTracesDir(), buildTraceArtifactFilename(userId));
}

export function listTraceArtifacts(userId: string): Array<{ filename: string; size: number; createdAt: number }> {
	const tracesDir = getTracesDir();
	const ownerToken = getTraceArtifactOwnerToken(userId);
	mkdirSync(tracesDir, { recursive: true });
	return readdirSync(tracesDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && getTraceArtifactFilenameOwnerToken(entry.name) === ownerToken)
		.flatMap((entry) => {
			const path = join(tracesDir, entry.name);
			let stat;
			try {
				stat = statSync(path);
			} catch (err) {
				if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
					return [];
				}
				throw err;
			}
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
	return resolveAndValidateOutputPath(join(getTracesDir(), filename));
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
				const activeState = states.get(userId);
				if (activeState?.stopPromise) {
					try {
						await activeState.stopPromise;
					} catch {
						// Manual stop failed; fall through to auto-stop if still active.
					}
				}
				if (states.get(userId)?.active) {
					const path = defaultPath(userId);
					const currentState = states.get(userId);
					if (currentState) {
						const stopPromise = context.tracing.stop({ path });
						currentState.stopPromise = stopPromise;
						try {
							await stopPromise;
						} finally {
							if (currentState.stopPromise === stopPromise) {
								delete currentState.stopPromise;
							}
						}
					}
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
	let state = states.get(userId);
	if (!state?.active) {
		throw new Error('No active tracing for this user');
	}

	if (state.stopPromise) {
		try {
			await state.stopPromise;
		} catch {
			// The in-flight stop failed; continue below if tracing is still active.
		}
		state = states.get(userId);
		if (!state?.active) {
			return { path: '', size: 0, alreadyStopped: true };
		}
	}

	const path = resolveManagedTraceOutputPath(userId, outputPath);
	ensureOutputDir(path);
	const stopPromise = context.tracing.stop({ path });
	state.stopPromise = stopPromise;
	try {
		await stopPromise;
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
	} finally {
		if (state.stopPromise === stopPromise) {
			delete state.stopPromise;
		}
	}
	if (state.timer) {
		clearTimeout(state.timer);
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

	const path = resolveManagedTraceOutputPath(userId, outputPath);
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
