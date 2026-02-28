import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { log } from '../middleware/logging';

interface VncSession {
	userId: string;
	displayNum: string;
	x11vncProcess: ChildProcess;
	websockifyProcess: ChildProcess;
	token: string;
	vncPort: number;
	wsPort: number;
	startedAt: number;
	timeoutHandle: NodeJS.Timeout;
}

const vncSessions = new Map<string, VncSession>();
const VNC_TIMEOUT_MS = Math.max(10_000, Number.parseInt(process.env.CAMOFOX_VNC_TIMEOUT_MS || '', 10) || 120_000);
const NOVNC_PATH = '/opt/noVNC';
const BASE_WS_PORT = Math.max(1, Number.parseInt(process.env.CAMOFOX_VNC_BASE_PORT || '', 10) || 6080);
const VNC_HOST = process.env.CAMOFOX_VNC_HOST || 'localhost';

export function getVncSession(userId: string): VncSession | undefined {
	return vncSessions.get(String(userId));
}

function normalizeDisplay(displayNum: string): string {
	const cleaned = String(displayNum || '').trim();
	if (!cleaned.startsWith(':')) {
		throw new Error(`Invalid display number: ${cleaned || '(empty)'}`);
	}
	if (!/^:[0-9]+(?:\.[0-9]+)?$/.test(cleaned)) {
		throw new Error(`Invalid display format: ${cleaned}`);
	}
	return cleaned;
}

function parseDisplayIndex(displayNum: string): number {
	const match = /^:([0-9]+)/.exec(displayNum);
	if (!match) throw new Error(`Cannot parse display index from ${displayNum}`);
	return Number.parseInt(match[1], 10);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildVncUrl(wsPort: number, token: string): string {
	return `http://${VNC_HOST}:${wsPort}/vnc.html?autoconnect=true&resize=scale&token=${token}`;
}

export async function startVnc(
	userId: string,
	displayNum: string,
): Promise<{
	token: string;
	vncUrl: string;
	wsPort: number;
}> {
	const normalizedUserId = String(userId);
	const normalizedDisplay = normalizeDisplay(displayNum);

	await stopVnc(normalizedUserId);

	const token = randomBytes(16).toString('hex');
	const wsPort = BASE_WS_PORT;
	const vncPort = 5900 + parseDisplayIndex(normalizedDisplay);

	const x11vncProcess = spawn(
		'x11vnc',
		[
			'-display',
			normalizedDisplay,
			'-rfbport',
			String(vncPort),
			'-nopw',
			'-forever',
			'-shared',
			'-listen',
			'127.0.0.1',
			'-noxdamage',
			'-ncache',
			'10',
		],
		{ stdio: 'pipe' },
	);

	x11vncProcess.on('error', (err) => {
		log('error', 'x11vnc process error', { userId: normalizedUserId, error: err.message });
	});

	await sleep(300);

	const websockifyProcess = spawn('websockify', ['--web', NOVNC_PATH, String(wsPort), `127.0.0.1:${vncPort}`], { stdio: 'pipe' });

	websockifyProcess.on('error', (err) => {
		log('error', 'websockify process error', { userId: normalizedUserId, error: err.message });
	});

	await sleep(500);

	if (x11vncProcess.exitCode !== null) {
		throw new Error(`x11vnc exited early with code ${x11vncProcess.exitCode}`);
	}
	if (websockifyProcess.exitCode !== null) {
		try {
			x11vncProcess.kill('SIGTERM');
		} catch {
			// ignore cleanup errors
		}
		throw new Error(`websockify exited early with code ${websockifyProcess.exitCode}`);
	}

	const timeoutHandle = setTimeout(() => {
		log('info', 'vnc session timed out', { userId: normalizedUserId, timeoutMs: VNC_TIMEOUT_MS });
		void stopVnc(normalizedUserId);
	}, VNC_TIMEOUT_MS);
	timeoutHandle.unref();

	const session: VncSession = {
		userId: normalizedUserId,
		displayNum: normalizedDisplay,
		x11vncProcess,
		websockifyProcess,
		token,
		vncPort,
		wsPort,
		startedAt: Date.now(),
		timeoutHandle,
	};

	vncSessions.set(normalizedUserId, session);

	const vncUrl = buildVncUrl(wsPort, token);
	log('info', 'vnc started', {
		userId: normalizedUserId,
		display: normalizedDisplay,
		vncPort,
		wsPort,
	});

	return { token, vncUrl, wsPort };
}

export async function stopVnc(userId: string): Promise<boolean> {
	const normalizedUserId = String(userId);
	const session = vncSessions.get(normalizedUserId);
	if (!session) return false;

	clearTimeout(session.timeoutHandle);

	try {
		session.websockifyProcess.kill('SIGTERM');
	} catch {
		// ignore cleanup errors
	}
	try {
		session.x11vncProcess.kill('SIGTERM');
	} catch {
		// ignore cleanup errors
	}

	setTimeout(() => {
		try {
			session.websockifyProcess.kill('SIGKILL');
		} catch {
			// ignore cleanup errors
		}
		try {
			session.x11vncProcess.kill('SIGKILL');
		} catch {
			// ignore cleanup errors
		}
	}, 3000).unref();

	vncSessions.delete(normalizedUserId);
	log('info', 'vnc stopped', { userId: normalizedUserId });
	return true;
}

export function stopAllVnc(): void {
	for (const userId of vncSessions.keys()) {
		void stopVnc(userId);
	}
}
