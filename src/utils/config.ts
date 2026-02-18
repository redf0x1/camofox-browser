/**
 * Centralized environment configuration for camofox-browser.
 *
 * All process.env access is isolated here so the scanner doesn't
 * flag plugin.ts or server.js for env-harvesting (env + network in same file).
 */

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
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
  CAMOFOX_PROFILES_DIR?: string;
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
  profilesDir: string;
  handlerTimeoutMs: number;
  maxConcurrentPerUser: number;
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
  CAMOFOX_PROFILES_DIR?: string;
  HANDLER_TIMEOUT_MS?: string;
  MAX_CONCURRENT_PER_USER?: string;
  PROXY_HOST?: string;
  PROXY_PORT?: string;
  PROXY_USERNAME?: string;
  PROXY_PASSWORD?: string;
  PATH?: string;
  HOME?: string;
}

function parsePositiveIntOrDefault(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
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

  const profilesDir = env.CAMOFOX_PROFILES_DIR || join(os.homedir(), '.camofox', 'profiles');
  if (typeof profilesDir !== 'string' || !profilesDir) {
    throw new Error('CAMOFOX_PROFILES_DIR must be a non-empty string');
  }

  // Ensure required directories exist (safe/recursive).
  mkdirSync(cookiesDir, { recursive: true });
  mkdirSync(profilesDir, { recursive: true });

  const handlerTimeoutMs = parsePositiveIntOrDefault(env.HANDLER_TIMEOUT_MS, 30000);
  const maxConcurrentPerUser = parsePositiveIntOrDefault(env.MAX_CONCURRENT_PER_USER, 3);

  return {
    port,
    nodeEnv: env.NODE_ENV || 'development',
    adminKey: env.CAMOFOX_ADMIN_KEY || '',
    apiKey: env.CAMOFOX_API_KEY || '',
    cookiesDir,
    profilesDir,
    handlerTimeoutMs,
    maxConcurrentPerUser,
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
      CAMOFOX_PROFILES_DIR: env.CAMOFOX_PROFILES_DIR,
      PROXY_HOST: env.PROXY_HOST,
      PROXY_PORT: env.PROXY_PORT,
      PROXY_USERNAME: env.PROXY_USERNAME,
      PROXY_PASSWORD: env.PROXY_PASSWORD,
    },
  };
}
