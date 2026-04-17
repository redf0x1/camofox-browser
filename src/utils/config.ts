/**
 * Primary environment registry for camofox-browser.
 *
 * Server-side env reads are centralized here. CLI-only reads (CAMOFOX_API_KEY,
 * CAMOFOX_CLI_USER) and ambient host reads (DISPLAY) remain at their call sites.
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

export interface FingerprintConfig {
  os?: 'windows' | 'macos' | 'linux' | Array<'windows' | 'macos' | 'linux'>;
  allowWebgl: boolean;
  humanize: boolean;
  screen?: {
    width: number;
    height: number;
  };
}

export interface ServerEnv {
  PATH?: string;
  HOME?: string;
  NODE_ENV?: string;
  DISPLAY?: string;
  HANDLER_TIMEOUT_MS?: string;
  MAX_CONCURRENT_PER_USER?: string;
  CAMOFOX_ADMIN_KEY?: string;
  CAMOFOX_API_KEY?: string;
  CAMOFOX_CONSOLE_BUFFER_SIZE?: string;
  CAMOFOX_COOKIES_DIR?: string;
  CAMOFOX_PROFILES_DIR?: string;
  CAMOFOX_DOWNLOADS_DIR?: string;
  CAMOFOX_DOWNLOAD_TTL_MS?: string;
  CAMOFOX_MAX_DOWNLOAD_SIZE_MB?: string;
  CAMOFOX_IDLE_TIMEOUT_MS?: string;
  CAMOFOX_MAX_BATCH_CONCURRENCY?: string;
  CAMOFOX_MAX_BLOB_SIZE_MB?: string;
  CAMOFOX_MAX_DOWNLOADS_PER_USER?: string;
  CAMOFOX_MAX_SESSIONS?: string;
  CAMOFOX_MAX_SNAPSHOT_CHARS?: string;
  CAMOFOX_MAX_SNAPSHOT_NODES?: string;
  CAMOFOX_MAX_TABS?: string;
  CAMOFOX_PRESETS_FILE?: string;
  CAMOFOX_SESSION_TIMEOUT?: string;
  CAMOFOX_SNAPSHOT_TAIL_CHARS?: string;
  CAMOFOX_BUILDREFS_TIMEOUT_MS?: string;
  CAMOFOX_TAB_LOCK_TIMEOUT_MS?: string;
  CAMOFOX_TRACES_DIR?: string;
  CAMOFOX_TRACE_MAX_DURATION_MS?: string;
  CAMOFOX_HEALTH_PROBE_INTERVAL_MS?: string;
  CAMOFOX_FAILURE_THRESHOLD?: string;
  CAMOFOX_VNC_BASE_PORT?: string;
  CAMOFOX_VNC_HOST?: string;
  CAMOFOX_YT_DLP_TIMEOUT_MS?: string;
  CAMOFOX_YT_BROWSER_TIMEOUT_MS?: string;
  CAMOFOX_VNC_RESOLUTION?: string;
  CAMOFOX_VNC_TIMEOUT_MS?: string;
  CAMOFOX_HEADLESS?: string;
  CAMOFOX_EVAL_EXTENDED_RATE_LIMIT_MAX?: string;
  CAMOFOX_EVAL_EXTENDED_RATE_LIMIT_WINDOW_MS?: string;
  CAMOFOX_OS?: string;
  CAMOFOX_ALLOW_WEBGL?: string;
  CAMOFOX_SCREEN_WIDTH?: string;
  CAMOFOX_SCREEN_HEIGHT?: string;
  CAMOFOX_HUMANIZE?: string;
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
  tracesDir: string;
  traceMaxDurationMs: number;
  maxSnapshotNodes: number;
  consoleBufferSize: number;
  sessionTimeoutMs: number;
  maxSessions: number;
  maxTabsPerSession: number;
  vncTimeoutMs: number;
  vncBasePort: number;
  vncHost: string;
  presetsFile: string | undefined;
  idleTimeoutMs: number;
  buildRefsTimeoutMs: number;
  tabLockTimeoutMs: number;
  healthProbeIntervalMs: number;
  failureThreshold: number;
  ytDlpTimeoutMs: number;
  ytBrowserTimeoutMs: number;
  vncResolution: string;
  headless: boolean | 'virtual';
  evalExtendedRateLimitMax: number;
  evalExtendedRateLimitWindowMs: number;
  fingerprint: FingerprintConfig;
  proxy: ProxyConfig;
  serverEnv: ServerEnv;
}

export interface ConfigEnv extends NodeJS.ProcessEnv {
  CAMOFOX_PORT?: string;
  PORT?: string;
  NODE_ENV?: string;
  CAMOFOX_ADMIN_KEY?: string;
  CAMOFOX_API_KEY?: string;
  CAMOFOX_CONSOLE_BUFFER_SIZE?: string;
  CAMOFOX_COOKIES_DIR?: string;
  CAMOFOX_PROFILES_DIR?: string;
  CAMOFOX_DOWNLOADS_DIR?: string;
  CAMOFOX_DOWNLOAD_TTL_MS?: string;
  CAMOFOX_MAX_DOWNLOAD_SIZE_MB?: string;
  CAMOFOX_IDLE_TIMEOUT_MS?: string;
  CAMOFOX_MAX_BATCH_CONCURRENCY?: string;
  CAMOFOX_MAX_BLOB_SIZE_MB?: string;
  CAMOFOX_MAX_DOWNLOADS_PER_USER?: string;
  CAMOFOX_MAX_SESSIONS?: string;
  CAMOFOX_MAX_SNAPSHOT_CHARS?: string;
  CAMOFOX_MAX_SNAPSHOT_NODES?: string;
  CAMOFOX_MAX_TABS?: string;
  CAMOFOX_PRESETS_FILE?: string;
  CAMOFOX_SNAPSHOT_TAIL_CHARS?: string;
  CAMOFOX_SESSION_TIMEOUT?: string;
  HANDLER_TIMEOUT_MS?: string;
  MAX_CONCURRENT_PER_USER?: string;
  CAMOFOX_BUILDREFS_TIMEOUT_MS?: string;
  CAMOFOX_TAB_LOCK_TIMEOUT_MS?: string;
  CAMOFOX_TRACES_DIR?: string;
  CAMOFOX_TRACE_MAX_DURATION_MS?: string;
  CAMOFOX_HEALTH_PROBE_INTERVAL_MS?: string;
  CAMOFOX_FAILURE_THRESHOLD?: string;
  CAMOFOX_YT_DLP_TIMEOUT_MS?: string;
  CAMOFOX_YT_BROWSER_TIMEOUT_MS?: string;
  CAMOFOX_VNC_BASE_PORT?: string;
  CAMOFOX_VNC_HOST?: string;
  CAMOFOX_VNC_RESOLUTION?: string;
  CAMOFOX_VNC_TIMEOUT_MS?: string;
  CAMOFOX_HEADLESS?: string;
  CAMOFOX_EVAL_EXTENDED_RATE_LIMIT_MAX?: string;
  CAMOFOX_EVAL_EXTENDED_RATE_LIMIT_WINDOW_MS?: string;
  CAMOFOX_OS?: string;
  CAMOFOX_ALLOW_WEBGL?: string;
  CAMOFOX_SCREEN_WIDTH?: string;
  CAMOFOX_SCREEN_HEIGHT?: string;
  CAMOFOX_HUMANIZE?: string;
  PROXY_HOST?: string;
  PROXY_PORT?: string;
  PROXY_USERNAME?: string;
  PROXY_PASSWORD?: string;
  PATH?: string;
  HOME?: string;
  DISPLAY?: string;
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

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return fallback;
}

function parseCamoufoxOs(raw: string | undefined): FingerprintConfig['os'] {
  if (!raw) return undefined;
  const allowed = new Set(['windows', 'macos', 'linux']);
  const values = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  if (values.length === 0) return undefined;
  if (values.some((value) => !allowed.has(value))) {
    throw new Error('CAMOFOX_OS must contain only windows, macos, linux, or a comma-separated combination of them');
  }

  return values.length === 1
    ? (values[0] as 'windows' | 'macos' | 'linux')
    : (values as Array<'windows' | 'macos' | 'linux'>);
}

function parseScreen(widthRaw: string | undefined, heightRaw: string | undefined): FingerprintConfig['screen'] {
  if (!widthRaw && !heightRaw) return undefined;
  if (!widthRaw || !heightRaw) {
    throw new Error('CAMOFOX_SCREEN_WIDTH and CAMOFOX_SCREEN_HEIGHT must be provided together');
  }
  const width = parsePositiveIntOrDefault(widthRaw, -1);
  const height = parsePositiveIntOrDefault(heightRaw, -1);
  if (width <= 0 || height <= 0) {
    throw new Error('CAMOFOX_SCREEN_WIDTH and CAMOFOX_SCREEN_HEIGHT must be positive integers');
  }
  return { width, height };
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
  const vncResolution = env.CAMOFOX_VNC_RESOLUTION || '1920x1080x24';
  const headless = env.CAMOFOX_HEADLESS === 'false' || env.CAMOFOX_HEADLESS === '0'
    ? false
    : env.CAMOFOX_HEADLESS === 'virtual'
      ? 'virtual'
      : true;
  const evalExtendedRateLimitMax = parsePositiveIntOrDefault(env.CAMOFOX_EVAL_EXTENDED_RATE_LIMIT_MAX, 20);
  const evalExtendedRateLimitWindowMs = parsePositiveIntOrDefault(env.CAMOFOX_EVAL_EXTENDED_RATE_LIMIT_WINDOW_MS, 60000);

  const downloadTtlMs = parsePositiveIntOrDefault(env.CAMOFOX_DOWNLOAD_TTL_MS, 86_400_000);
  const maxDownloadSizeMb = parsePositiveIntOrDefault(env.CAMOFOX_MAX_DOWNLOAD_SIZE_MB, 100);
  const maxBatchConcurrency = parsePositiveIntOrDefault(env.CAMOFOX_MAX_BATCH_CONCURRENCY, 5);
  const maxBlobSizeMb = parsePositiveIntOrDefault(env.CAMOFOX_MAX_BLOB_SIZE_MB, 5);
  const maxDownloadsPerUser = parsePositiveIntOrDefault(env.CAMOFOX_MAX_DOWNLOADS_PER_USER, 500);
  const tracesDir = env.CAMOFOX_TRACES_DIR || join(os.homedir(), '.camofox', 'traces');
  const traceMaxDurationMs = parsePositiveIntOrDefault(env.CAMOFOX_TRACE_MAX_DURATION_MS, 300000);
  const maxSnapshotNodes = parsePositiveIntOrDefault(env.CAMOFOX_MAX_SNAPSHOT_NODES, 2000);
  const consoleBufferSize = Math.max(100, parsePositiveIntOrDefault(env.CAMOFOX_CONSOLE_BUFFER_SIZE, 1000));
  const sessionTimeoutMs = Math.max(60000, parsePositiveIntOrDefault(env.CAMOFOX_SESSION_TIMEOUT, 1800000));
  const maxSessions = Math.max(1, parsePositiveIntOrDefault(env.CAMOFOX_MAX_SESSIONS, 50));
  const maxTabsPerSession = Math.max(1, parsePositiveIntOrDefault(env.CAMOFOX_MAX_TABS, 10));
  const vncTimeoutMs = Math.max(10000, parsePositiveIntOrDefault(env.CAMOFOX_VNC_TIMEOUT_MS, 120000));
  const vncBasePort = Math.max(1, parsePositiveIntOrDefault(env.CAMOFOX_VNC_BASE_PORT, 6080));
  const vncHost = env.CAMOFOX_VNC_HOST || 'localhost';
  const presetsFile = env.CAMOFOX_PRESETS_FILE || undefined;
  const idleTimeoutMs = parsePositiveIntOrDefault(env.CAMOFOX_IDLE_TIMEOUT_MS, 1800000);
  const fingerprint: FingerprintConfig = {
    os: parseCamoufoxOs(env.CAMOFOX_OS),
    allowWebgl: parseBoolean(env.CAMOFOX_ALLOW_WEBGL, false),
    humanize: parseBoolean(env.CAMOFOX_HUMANIZE, true),
    screen: parseScreen(env.CAMOFOX_SCREEN_WIDTH, env.CAMOFOX_SCREEN_HEIGHT),
  };

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
    tracesDir,
    traceMaxDurationMs,
    maxSnapshotNodes,
    consoleBufferSize,
    sessionTimeoutMs,
    maxSessions,
    maxTabsPerSession,
    vncTimeoutMs,
    vncBasePort,
    vncHost,
    presetsFile,
    idleTimeoutMs,
    buildRefsTimeoutMs,
    tabLockTimeoutMs,
    healthProbeIntervalMs,
    failureThreshold,
    ytDlpTimeoutMs,
    ytBrowserTimeoutMs,
    vncResolution,
    headless,
    evalExtendedRateLimitMax,
    evalExtendedRateLimitWindowMs,
    fingerprint,
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
      DISPLAY: env.DISPLAY,
      HANDLER_TIMEOUT_MS: env.HANDLER_TIMEOUT_MS,
      MAX_CONCURRENT_PER_USER: env.MAX_CONCURRENT_PER_USER,
      CAMOFOX_ADMIN_KEY: env.CAMOFOX_ADMIN_KEY,
      CAMOFOX_API_KEY: env.CAMOFOX_API_KEY,
      CAMOFOX_CONSOLE_BUFFER_SIZE: env.CAMOFOX_CONSOLE_BUFFER_SIZE,
      CAMOFOX_COOKIES_DIR: env.CAMOFOX_COOKIES_DIR,
      CAMOFOX_PROFILES_DIR: env.CAMOFOX_PROFILES_DIR,
      CAMOFOX_DOWNLOADS_DIR: env.CAMOFOX_DOWNLOADS_DIR,
      CAMOFOX_DOWNLOAD_TTL_MS: env.CAMOFOX_DOWNLOAD_TTL_MS,
      CAMOFOX_MAX_DOWNLOAD_SIZE_MB: env.CAMOFOX_MAX_DOWNLOAD_SIZE_MB,
      CAMOFOX_IDLE_TIMEOUT_MS: env.CAMOFOX_IDLE_TIMEOUT_MS,
      CAMOFOX_MAX_BATCH_CONCURRENCY: env.CAMOFOX_MAX_BATCH_CONCURRENCY,
      CAMOFOX_MAX_BLOB_SIZE_MB: env.CAMOFOX_MAX_BLOB_SIZE_MB,
      CAMOFOX_MAX_DOWNLOADS_PER_USER: env.CAMOFOX_MAX_DOWNLOADS_PER_USER,
      CAMOFOX_MAX_SESSIONS: env.CAMOFOX_MAX_SESSIONS,
      CAMOFOX_MAX_SNAPSHOT_CHARS: env.CAMOFOX_MAX_SNAPSHOT_CHARS,
      CAMOFOX_MAX_SNAPSHOT_NODES: env.CAMOFOX_MAX_SNAPSHOT_NODES,
      CAMOFOX_MAX_TABS: env.CAMOFOX_MAX_TABS,
      CAMOFOX_PRESETS_FILE: env.CAMOFOX_PRESETS_FILE,
      CAMOFOX_SESSION_TIMEOUT: env.CAMOFOX_SESSION_TIMEOUT,
      CAMOFOX_SNAPSHOT_TAIL_CHARS: env.CAMOFOX_SNAPSHOT_TAIL_CHARS,
      CAMOFOX_BUILDREFS_TIMEOUT_MS: env.CAMOFOX_BUILDREFS_TIMEOUT_MS,
      CAMOFOX_TAB_LOCK_TIMEOUT_MS: env.CAMOFOX_TAB_LOCK_TIMEOUT_MS,
      CAMOFOX_TRACES_DIR: env.CAMOFOX_TRACES_DIR,
      CAMOFOX_TRACE_MAX_DURATION_MS: env.CAMOFOX_TRACE_MAX_DURATION_MS,
      CAMOFOX_HEALTH_PROBE_INTERVAL_MS: env.CAMOFOX_HEALTH_PROBE_INTERVAL_MS,
      CAMOFOX_FAILURE_THRESHOLD: env.CAMOFOX_FAILURE_THRESHOLD,
      CAMOFOX_VNC_BASE_PORT: env.CAMOFOX_VNC_BASE_PORT,
      CAMOFOX_VNC_HOST: env.CAMOFOX_VNC_HOST,
      CAMOFOX_YT_DLP_TIMEOUT_MS: env.CAMOFOX_YT_DLP_TIMEOUT_MS,
      CAMOFOX_YT_BROWSER_TIMEOUT_MS: env.CAMOFOX_YT_BROWSER_TIMEOUT_MS,
      CAMOFOX_VNC_RESOLUTION: env.CAMOFOX_VNC_RESOLUTION,
      CAMOFOX_VNC_TIMEOUT_MS: env.CAMOFOX_VNC_TIMEOUT_MS,
      CAMOFOX_HEADLESS: env.CAMOFOX_HEADLESS,
      CAMOFOX_EVAL_EXTENDED_RATE_LIMIT_MAX: env.CAMOFOX_EVAL_EXTENDED_RATE_LIMIT_MAX,
      CAMOFOX_EVAL_EXTENDED_RATE_LIMIT_WINDOW_MS: env.CAMOFOX_EVAL_EXTENDED_RATE_LIMIT_WINDOW_MS,
      CAMOFOX_OS: env.CAMOFOX_OS,
      CAMOFOX_ALLOW_WEBGL: env.CAMOFOX_ALLOW_WEBGL,
      CAMOFOX_SCREEN_WIDTH: env.CAMOFOX_SCREEN_WIDTH,
      CAMOFOX_SCREEN_HEIGHT: env.CAMOFOX_SCREEN_HEIGHT,
      CAMOFOX_HUMANIZE: env.CAMOFOX_HUMANIZE,
      PROXY_HOST: env.PROXY_HOST,
      PROXY_PORT: env.PROXY_PORT,
      PROXY_USERNAME: env.PROXY_USERNAME,
      PROXY_PASSWORD: env.PROXY_PASSWORD,
    },
  };
}
