import os from 'node:os';

import { launchOptions } from 'camoufox-js';
import { firefox, type Browser } from 'playwright-core';

import { loadConfig } from '../utils/config';
import { log } from '../middleware/logging';

const CONFIG = loadConfig();

let browser: Browser | null = null;

function getHostOS(): 'macos' | 'windows' | 'linux' {
	const platform = os.platform();
	if (platform === 'darwin') return 'macos';
	if (platform === 'win32') return 'windows';
	return 'linux';
}

function buildProxyConfig(): { server: string; username?: string; password?: string } | null {
	const { host, port, username, password } = CONFIG.proxy;
	if (!host || !port) {
		log('info', 'no proxy configured');
		return null;
	}
	log('info', 'proxy configured', { host, port });
	return {
		server: `http://${host}:${port}`,
		username: username || undefined,
		password: password || undefined,
	};
}

export async function ensureBrowser(): Promise<Browser> {
	if (!browser) {
		const hostOS = getHostOS();
		const proxy = buildProxyConfig();

		log('info', 'launching camoufox', { hostOS, geoip: !!proxy });

		const options = await launchOptions({
			headless: true,
			os: hostOS,
			humanize: true,
			enable_cache: true,
			proxy: proxy ?? undefined,
			geoip: !!proxy,
		});

		browser = await firefox.launch(options);
		log('info', 'camoufox launched');
	}
	return browser;
}

export function getBrowser(): Browser | null {
	return browser;
}

export async function closeBrowser(): Promise<void> {
	if (!browser) return;
	await browser.close().catch(() => {});
	browser = null;
}
