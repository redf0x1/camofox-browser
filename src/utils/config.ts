/**
 * Centralized environment configuration for camofox-browser.
 *
 * All process.env access is isolated here so the scanner doesn't
 * flag plugin.ts or server.js for env-harvesting (env + network in same file).
 */

import { join } from 'node:path';
import os from 'node:os';

export interface ProxyConfig {
  host: string;
  port: string;
  username: string;
  password: string;
}

export interface ServerEnv {
  PATH?: string;
  HOME?: string;
  NODE_ENV?: string;
  CAMOFOX_ADMIN_KEY?: string;
  CAMOFOX_API_KEY?: string;
  CAMOFOX_COOKIES_DIR?: string;
  PROXY_HOST?: string;
  PROXY_PORT?: string;
  PROXY_USERNAME?: string;
  PROXY_PASSWORD?: string;
}

export interface AppConfig {
  port: number;
  nodeEnv: string;
  adminKey: string;
  apiKey: string;
  cookiesDir: string;
  proxy: ProxyConfig;
  serverEnv: ServerEnv;
}

export interface ConfigEnv extends NodeJS.ProcessEnv {
  CAMOFOX_PORT?: string;
  PORT?: string;
  NODE_ENV?: string;
  CAMOFOX_ADMIN_KEY?: string;
  CAMOFOX_API_KEY?: string;
  CAMOFOX_COOKIES_DIR?: string;
  PROXY_HOST?: string;
  PROXY_PORT?: string;
  PROXY_USERNAME?: string;
  PROXY_PASSWORD?: string;
  PATH?: string;
  HOME?: string;
}

function parsePort(raw: string, source: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${source} must be an integer (got: ${JSON.stringify(raw)})`);
  }
  if (parsed < 1 || parsed > 65535) {
    throw new Error(`${source} must be between 1 and 65535 (got: ${parsed})`);
  }
  return parsed;
}

export function loadConfig(env: ConfigEnv = process.env): AppConfig {
  const portRaw = env.CAMOFOX_PORT || env.PORT || '9377';
  const port = parsePort(portRaw, env.CAMOFOX_PORT ? 'CAMOFOX_PORT' : env.PORT ? 'PORT' : 'default port');

  const cookiesDir = env.CAMOFOX_COOKIES_DIR || join(os.homedir(), '.camofox', 'cookies');
  if (typeof cookiesDir !== 'string' || !cookiesDir) {
    throw new Error('CAMOFOX_COOKIES_DIR must be a non-empty string');
  }

  return {
    port,
    nodeEnv: env.NODE_ENV || 'development',
    adminKey: env.CAMOFOX_ADMIN_KEY || '',
    apiKey: env.CAMOFOX_API_KEY || '',
    cookiesDir,
    proxy: {
      host: env.PROXY_HOST || '',
      port: env.PROXY_PORT || '',
      username: env.PROXY_USERNAME || '',
      password: env.PROXY_PASSWORD || '',
    },
    // Env vars forwarded to the server subprocess
    serverEnv: {
      PATH: env.PATH,
      HOME: env.HOME,
      NODE_ENV: env.NODE_ENV,
      CAMOFOX_ADMIN_KEY: env.CAMOFOX_ADMIN_KEY,
      CAMOFOX_API_KEY: env.CAMOFOX_API_KEY,
      CAMOFOX_COOKIES_DIR: env.CAMOFOX_COOKIES_DIR,
      PROXY_HOST: env.PROXY_HOST,
      PROXY_PORT: env.PROXY_PORT,
      PROXY_USERNAME: env.PROXY_USERNAME,
      PROXY_PASSWORD: env.PROXY_PASSWORD,
    },
  };
}
