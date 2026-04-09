import fs from 'node:fs';
import path from 'node:path';

import { log } from '../middleware/logging';

export interface VersionedEnvelope<T> {
	version: number;
	data: T;
}

export interface SidecarReadOptions<T> {
	currentVersion: number;
	migrations: Record<number, (raw: unknown) => T>;
	label: string;
}

export function readVersionedSidecar<T>(filePath: string, options: SidecarReadOptions<T>): T | null {
	if (!fs.existsSync(filePath)) return null;

	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Corrupt ${options.label} at ${filePath}: ${msg}. Delete the file to reset, or restore from backup.`,
		);
	}

	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error(
			`Invalid ${options.label} at ${filePath}: expected JSON object. Delete the file to reset.`,
		);
	}

	const envelope = raw as Record<string, unknown>;
	const version = typeof envelope.version === 'number' ? envelope.version : 0;

	if (version > options.currentVersion) {
		throw new Error(
			`${options.label} at ${filePath} uses version ${version}, but this build only supports up to version ${options.currentVersion}. Upgrade camofox-browser or delete the file to reset.`,
		);
	}

	if (version === options.currentVersion) {
		if (envelope.data === undefined) {
			throw new Error(
				`${options.label} at ${filePath} uses version ${version} but has no data section. Delete the file to reset.`,
			);
		}
		return envelope.data as T;
	}

	const migrateFn = options.migrations[version];
	if (!migrateFn) {
		throw new Error(
			`${options.label} at ${filePath} uses version ${version}, which has no migration path. Delete the file to reset.`,
		);
	}

	log('info', `migrating ${options.label} from v${version} to v${options.currentVersion}`, { filePath });
	return migrateFn(raw);
}

export function writeVersionedSidecar<T>(filePath: string, version: number, data: T): void {
	const envelope: VersionedEnvelope<T> = { version, data };
	const content = JSON.stringify(envelope, null, 2);
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });

	const tmp = `${filePath}.tmp.${process.pid}`;
	try {
		fs.writeFileSync(tmp, content, { encoding: 'utf-8' });
		fs.renameSync(tmp, filePath);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// ignore cleanup errors
		}
		throw err;
	}
}