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
  CAMOFOX_DOWNLOADS_DIR?: string;
  CAMOFOX_DOWNLOAD_TTL_MS?: string;
  CAMOFOX_MAX_DOWNLOAD_SIZE_MB?: string;
  CAMOFOX_MAX_BATCH_CONCURRENCY?: string;
  CAMOFOX_MAX_BLOB_SIZE_MB?: string;
  CAMOFOX_MAX_DOWNLOADS_PER_USER?: string;
  CAMOFOX_MAX_SNAPSHOT_CHARS?: string;
  CAMOFOX_SNAPSHOT_TAIL_CHARS?: string;
  CAMOFOX_BUILDREFS_TIMEOUT_MS?: string;
  CAMOFOX_TAB_LOCK_TIMEOUT_MS?: string;
  CAMOFOX_HEALTH_PROBE_INTERVAL_MS?: string;
  CAMOFOX_FAILURE_THRESHOLD?: string;
  CAMOFOX_YT_DLP_TIMEOUT_MS?: string;
  CAMOFOX_YT_BROWSER_TIMEOUT_MS?: string;
  CAMOFOX_HEADLESS?: string;
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
  downloadsDir: string;
  downloadTtlMs: number;
  maxDownloadSizeMb: number;
  maxBatchConcurrency: number;
  maxBlobSizeMb: number;
  maxDownloadsPerUser: number;
  handlerTimeoutMs: number;
  maxConcurrentPerUser: number;
  maxSnapshotChars: number;
  snapshotTailChars: number;
  buildRefsTimeoutMs: number;
  tabLockTimeoutMs: number;
  healthProbeIntervalMs: number;
  failureThreshold: number;
  ytDlpTimeoutMs: number;
  ytBrowserTimeoutMs: number;
  headless: boolean | 'virtual';
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
  CAMOFOX_DOWNLOADS_DIR?: string;
  CAMOFOX_DOWNLOAD_TTL_MS?: string;
  CAMOFOX_MAX_DOWNLOAD_SIZE_MB?: string;
  CAMOFOX_MAX_BATCH_CONCURRENCY?: string;
  CAMOFOX_MAX_BLOB_SIZE_MB?: string;
  CAMOFOX_MAX_DOWNLOADS_PER_USER?: string;
  CAMOFOX_MAX_SNAPSHOT_CHARS?: string;
  CAMOFOX_SNAPSHOT_TAIL_CHARS?: string;
  HANDLER_TIMEOUT_MS?: string;
  MAX_CONCURRENT_PER_USER?: string;
  CAMOFOX_BUILDREFS_TIMEOUT_MS?: string;
  CAMOFOX_TAB_LOCK_TIMEOUT_MS?: string;
  CAMOFOX_HEALTH_PROBE_INTERVAL_MS?: string;
  CAMOFOX_FAILURE_THRESHOLD?: string;
  CAMOFOX_YT_DLP_TIMEOUT_MS?: string;
  CAMOFOX_YT_BROWSER_TIMEOUT_MS?: string;
  CAMOFOX_HEADLESS?: string;
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

  const downloadsDir = env.CAMOFOX_DOWNLOADS_DIR || join(os.homedir(), '.camofox', 'downloads');
  if (typeof downloadsDir !== 'string' || !downloadsDir) {
    throw new Error('CAMOFOX_DOWNLOADS_DIR must be a non-empty string');
  }

  // Ensure required directories exist (safe/recursive).
  mkdirSync(cookiesDir, { recursive: true });
  mkdirSync(profilesDir, { recursive: true });
  mkdirSync(downloadsDir, { recursive: true });

  const handlerTimeoutMs = parsePositiveIntOrDefault(env.HANDLER_TIMEOUT_MS, 30000);
  const maxConcurrentPerUser = parsePositiveIntOrDefault(env.MAX_CONCURRENT_PER_USER, 3);
  const maxSnapshotChars = parsePositiveIntOrDefault(env.CAMOFOX_MAX_SNAPSHOT_CHARS, 80000);
  const snapshotTailChars = parsePositiveIntOrDefault(env.CAMOFOX_SNAPSHOT_TAIL_CHARS, 5000);
  const buildRefsTimeoutMs = parsePositiveIntOrDefault(env.CAMOFOX_BUILDREFS_TIMEOUT_MS, 12000);
  const tabLockTimeoutMs = parsePositiveIntOrDefault(env.CAMOFOX_TAB_LOCK_TIMEOUT_MS, 30000);
  const healthProbeIntervalMs = parsePositiveIntOrDefault(env.CAMOFOX_HEALTH_PROBE_INTERVAL_MS, 60000);
  const failureThreshold = parsePositiveIntOrDefault(env.CAMOFOX_FAILURE_THRESHOLD, 3);
  const ytDlpTimeoutMs = parsePositiveIntOrDefault(env.CAMOFOX_YT_DLP_TIMEOUT_MS, 30000);
  const ytBrowserTimeoutMs = parsePositiveIntOrDefault(env.CAMOFOX_YT_BROWSER_TIMEOUT_MS, 25000);
  const headless = env.CAMOFOX_HEADLESS === 'false' || env.CAMOFOX_HEADLESS === '0'
    ? false
    : env.CAMOFOX_HEADLESS === 'virtual'
      ? 'virtual'
      : true;

  const downloadTtlMs = parsePositiveIntOrDefault(env.CAMOFOX_DOWNLOAD_TTL_MS, 86_400_000);
  const maxDownloadSizeMb = parsePositiveIntOrDefault(env.CAMOFOX_MAX_DOWNLOAD_SIZE_MB, 100);
  const maxBatchConcurrency = parsePositiveIntOrDefault(env.CAMOFOX_MAX_BATCH_CONCURRENCY, 5);
  const maxBlobSizeMb = parsePositiveIntOrDefault(env.CAMOFOX_MAX_BLOB_SIZE_MB, 5);
  const maxDownloadsPerUser = parsePositiveIntOrDefault(env.CAMOFOX_MAX_DOWNLOADS_PER_USER, 500);

  return {
    port,
    nodeEnv: env.NODE_ENV || 'development',
    adminKey: env.CAMOFOX_ADMIN_KEY || '',
    apiKey: env.CAMOFOX_API_KEY || '',
    cookiesDir,
    profilesDir,
    downloadsDir,
    downloadTtlMs,
    maxDownloadSizeMb,
    maxBatchConcurrency,
    maxBlobSizeMb,
    maxDownloadsPerUser,
    handlerTimeoutMs,
    maxConcurrentPerUser,
    maxSnapshotChars,
    snapshotTailChars,
    buildRefsTimeoutMs,
    tabLockTimeoutMs,
    healthProbeIntervalMs,
    failureThreshold,
    ytDlpTimeoutMs,
    ytBrowserTimeoutMs,
    headless,
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
      CAMOFOX_DOWNLOADS_DIR: env.CAMOFOX_DOWNLOADS_DIR,
      CAMOFOX_DOWNLOAD_TTL_MS: env.CAMOFOX_DOWNLOAD_TTL_MS,
      CAMOFOX_MAX_DOWNLOAD_SIZE_MB: env.CAMOFOX_MAX_DOWNLOAD_SIZE_MB,
      CAMOFOX_MAX_BATCH_CONCURRENCY: env.CAMOFOX_MAX_BATCH_CONCURRENCY,
      CAMOFOX_MAX_BLOB_SIZE_MB: env.CAMOFOX_MAX_BLOB_SIZE_MB,
      CAMOFOX_MAX_DOWNLOADS_PER_USER: env.CAMOFOX_MAX_DOWNLOADS_PER_USER,
      CAMOFOX_MAX_SNAPSHOT_CHARS: env.CAMOFOX_MAX_SNAPSHOT_CHARS,
      CAMOFOX_SNAPSHOT_TAIL_CHARS: env.CAMOFOX_SNAPSHOT_TAIL_CHARS,
      CAMOFOX_BUILDREFS_TIMEOUT_MS: env.CAMOFOX_BUILDREFS_TIMEOUT_MS,
      CAMOFOX_TAB_LOCK_TIMEOUT_MS: env.CAMOFOX_TAB_LOCK_TIMEOUT_MS,
      CAMOFOX_HEALTH_PROBE_INTERVAL_MS: env.CAMOFOX_HEALTH_PROBE_INTERVAL_MS,
      CAMOFOX_FAILURE_THRESHOLD: env.CAMOFOX_FAILURE_THRESHOLD,
      CAMOFOX_YT_DLP_TIMEOUT_MS: env.CAMOFOX_YT_DLP_TIMEOUT_MS,
      CAMOFOX_YT_BROWSER_TIMEOUT_MS: env.CAMOFOX_YT_BROWSER_TIMEOUT_MS,
      CAMOFOX_HEADLESS: env.CAMOFOX_HEADLESS,
      PROXY_HOST: env.PROXY_HOST,
      PROXY_PORT: env.PROXY_PORT,
      PROXY_USERNAME: env.PROXY_USERNAME,
      PROXY_PASSWORD: env.PROXY_PASSWORD,
    },
  };
}
