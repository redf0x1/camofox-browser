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

export interface FingerprintDefaults {
  os?: 'windows' | 'macos' | 'linux' | Array<'windows' | 'macos' | 'linux'>;
  allowWebgl?: boolean;
  screen?: { width: number; height: number };
  humanize?: boolean;
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
  CAMOFOX_HOST?: string;
  CAMOFOX_ALLOW_PRIVATE_NETWORK?: string;
  CAMOFOX_CONSOLE_BUFFER_SIZE?: string;
  CAMOFOX_COOKIES_DIR?: string;
  CAMOFOX_PROFILES_DIR?: string;
  CAMOFOX_DOWNLOADS_DIR?: string;
  CAMOFOX_DOWNLOAD_TTL_MS?: string;
  CAMOFOX_MAX_DOWNLOAD_SIZE_MB?: string;
  CAMOFOX_IDLE_TIMEOUT_MS?: string;
  CAMOFOX_IDLE_EXIT_TIMEOUT_MS?: string;
  CAMOFOX_SERVER_PID_FILE?: string;
  CAMOFOX_MAX_BATCH_CONCURRENCY?: string;
  CAMOFOX_MAX_BLOB_SIZE_MB?: string;
  CAMOFOX_MAX_DOWNLOADS_PER_USER?: string;
  CAMOFOX_MAX_SESSIONS?: string;
  CAMOFOX_MAX_SNAPSHOT_CHARS?: string;
  CAMOFOX_MAX_SNAPSHOT_NODES?: string;
  CAMOFOX_MAX_TABS?: string;
  CAMOFOX_PRESETS_FILE?: string;
  CAMOFOX_PROXY_PROFILES_FILE?: string;
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
  host: string;
  nodeEnv: string;
  adminKey: string;
  apiKey: string;
  allowPrivateNetworkTargets: boolean;
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
  proxyProfilesFile: string | undefined;
  idleTimeoutMs: number;
  idleExitTimeoutMs: number;
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
  proxy: ProxyConfig;
  serverEnv: ServerEnv;
  fingerprintDefaults: FingerprintDefaults;
}

export interface ConfigEnv extends NodeJS.ProcessEnv {
  CAMOFOX_PORT?: string;
  PORT?: string;
  NODE_ENV?: string;
  CAMOFOX_ADMIN_KEY?: string;
  CAMOFOX_API_KEY?: string;
  CAMOFOX_HOST?: string;
  CAMOFOX_ALLOW_PRIVATE_NETWORK?: string;
  CAMOFOX_CONSOLE_BUFFER_SIZE?: string;
  CAMOFOX_COOKIES_DIR?: string;
  CAMOFOX_PROFILES_DIR?: string;
  CAMOFOX_DOWNLOADS_DIR?: string;
  CAMOFOX_DOWNLOAD_TTL_MS?: string;
  CAMOFOX_MAX_DOWNLOAD_SIZE_MB?: string;
  CAMOFOX_IDLE_TIMEOUT_MS?: string;
  CAMOFOX_IDLE_EXIT_TIMEOUT_MS?: string;
  CAMOFOX_SERVER_PID_FILE?: string;
  CAMOFOX_MAX_BATCH_CONCURRENCY?: string;
  CAMOFOX_MAX_BLOB_SIZE_MB?: string;
  CAMOFOX_MAX_DOWNLOADS_PER_USER?: string;
  CAMOFOX_MAX_SESSIONS?: string;
  CAMOFOX_MAX_SNAPSHOT_CHARS?: string;
  CAMOFOX_MAX_SNAPSHOT_NODES?: string;
  CAMOFOX_MAX_TABS?: string;
  CAMOFOX_PRESETS_FILE?: string;
  CAMOFOX_PROXY_PROFILES_FILE?: string;
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

type FingerprintOs = 'windows' | 'macos' | 'linux';

function parseFingerprintOs(raw: string | undefined): FingerprintDefaults['os'] {
  if (raw === undefined) return undefined;
  const parts = raw.split(',').map((part) => part.trim().toLowerCase());
  // Reject empty tokens: trailing commas, consecutive commas, etc.
  if (parts.some((p) => !p)) {
    throw new Error('CAMOFOX_OS must not contain empty tokens (check for trailing or consecutive commas)');
  }
  if (!parts.length) {
    throw new Error('CAMOFOX_OS must contain at least one value');
  }
  const allowed = new Set<FingerprintOs>(['windows', 'macos', 'linux']);
  for (const part of parts) {
    if (!allowed.has(part as FingerprintOs)) {
      throw new Error(`CAMOFOX_OS contains unsupported value: ${JSON.stringify(part)}`);
    }
  }
  return parts.length === 1 ? (parts[0] as FingerprintOs) : (parts as FingerprintOs[]);
}

function parseOptionalPositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  // Reject anything that isn't a bare integer string (no decimals, no units, no leading signs beyond digits)
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${name} must be a positive integer (got: ${JSON.stringify(raw)})`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer (got: ${JSON.stringify(raw)})`);
  }
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

function parseOptionalBoolean(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  throw new Error(`Expected boolean value (true/false) but got: ${JSON.stringify(raw)}`);
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') return true;

  const ipv4Parts = normalized.split('.');
  if (ipv4Parts.length === 4) {
    const octets = ipv4Parts.map((part) => Number.parseInt(part, 10));
    if (octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
      return octets[0] === 127;
    }
  }

  return false;
}

function hasConfiguredProxy(proxy: Pick<ProxyConfig, 'host' | 'port'>): boolean {
  return Boolean(proxy.host && proxy.port);
}

export function assertServerExposureSafety(
  config: Pick<AppConfig, 'host' | 'apiKey' | 'allowPrivateNetworkTargets' | 'proxy'>,
): void {
  if (!isLoopbackHost(config.host) && !config.apiKey) {
    throw new Error('CAMOFOX_API_KEY is required when CAMOFOX_HOST exposes the server beyond loopback');
  }
  if (!isLoopbackHost(config.host) && !config.allowPrivateNetworkTargets && hasConfiguredProxy(config.proxy)) {
    throw new Error(
      'Proxy-enabled non-loopback deployments must set CAMOFOX_ALLOW_PRIVATE_NETWORK=true until proxy-side private-target validation is supported',
    );
  }
}

export function loadConfig(env: ConfigEnv = process.env): AppConfig {
  const portRaw = env.CAMOFOX_PORT || env.PORT || '9377';
  const port = parsePort(portRaw, env.CAMOFOX_PORT ? 'CAMOFOX_PORT' : env.PORT ? 'PORT' : 'default port');
  const host = (env.CAMOFOX_HOST || '127.0.0.1').trim();
  if (!host) {
    throw new Error('CAMOFOX_HOST must be a non-empty string');
  }

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
  const allowPrivateNetworkOverride = parseOptionalBoolean(env.CAMOFOX_ALLOW_PRIVATE_NETWORK);
  const allowPrivateNetworkTargets = allowPrivateNetworkOverride ?? isLoopbackHost(host);
  const evalExtendedRateLimitMax = parsePositiveIntOrDefault(env.CAMOFOX_EVAL_EXTENDED_RATE_LIMIT_MAX, 20);
  const evalExtendedRateLimitWindowMs = parsePositiveIntOrDefault(env.CAMOFOX_EVAL_EXTENDED_RATE_LIMIT_WINDOW_MS, 60000);

  const fingerprintOs = parseFingerprintOs(env.CAMOFOX_OS);
  const fingerprintAllowWebgl = parseOptionalBoolean(env.CAMOFOX_ALLOW_WEBGL) ?? undefined;
  const fingerprintHumanize = parseOptionalBoolean(env.CAMOFOX_HUMANIZE) ?? undefined;
  const fingerprintScreenWidth = parseOptionalPositiveInt(env.CAMOFOX_SCREEN_WIDTH, 'CAMOFOX_SCREEN_WIDTH');
  const fingerprintScreenHeight = parseOptionalPositiveInt(env.CAMOFOX_SCREEN_HEIGHT, 'CAMOFOX_SCREEN_HEIGHT');

  const fingerprintDefaults: FingerprintDefaults = {};
  if (fingerprintOs !== undefined) fingerprintDefaults.os = fingerprintOs;
  if (fingerprintAllowWebgl !== undefined) fingerprintDefaults.allowWebgl = fingerprintAllowWebgl;
  if (fingerprintHumanize !== undefined) fingerprintDefaults.humanize = fingerprintHumanize;
  if (fingerprintScreenWidth !== undefined && fingerprintScreenHeight !== undefined) {
    fingerprintDefaults.screen = { width: fingerprintScreenWidth, height: fingerprintScreenHeight };
  }

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
  const proxyProfilesFile = env.CAMOFOX_PROXY_PROFILES_FILE || undefined;
  const idleTimeoutMs = parsePositiveIntOrDefault(env.CAMOFOX_IDLE_TIMEOUT_MS, 1800000);
  const idleExitTimeoutMs = parsePositiveIntOrDefault(env.CAMOFOX_IDLE_EXIT_TIMEOUT_MS, idleTimeoutMs);

  return {
    port,
    host,
    nodeEnv: env.NODE_ENV || 'development',
    adminKey: env.CAMOFOX_ADMIN_KEY || '',
    apiKey: env.CAMOFOX_API_KEY || '',
    allowPrivateNetworkTargets,
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
    proxyProfilesFile,
    idleTimeoutMs,
    idleExitTimeoutMs,
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
      CAMOFOX_HOST: env.CAMOFOX_HOST,
      CAMOFOX_ALLOW_PRIVATE_NETWORK: env.CAMOFOX_ALLOW_PRIVATE_NETWORK,
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
      CAMOFOX_IDLE_EXIT_TIMEOUT_MS: env.CAMOFOX_IDLE_EXIT_TIMEOUT_MS,
      CAMOFOX_MAX_BATCH_CONCURRENCY: env.CAMOFOX_MAX_BATCH_CONCURRENCY,
      CAMOFOX_MAX_BLOB_SIZE_MB: env.CAMOFOX_MAX_BLOB_SIZE_MB,
      CAMOFOX_MAX_DOWNLOADS_PER_USER: env.CAMOFOX_MAX_DOWNLOADS_PER_USER,
      CAMOFOX_MAX_SESSIONS: env.CAMOFOX_MAX_SESSIONS,
      CAMOFOX_MAX_SNAPSHOT_CHARS: env.CAMOFOX_MAX_SNAPSHOT_CHARS,
      CAMOFOX_MAX_SNAPSHOT_NODES: env.CAMOFOX_MAX_SNAPSHOT_NODES,
      CAMOFOX_MAX_TABS: env.CAMOFOX_MAX_TABS,
      CAMOFOX_PRESETS_FILE: env.CAMOFOX_PRESETS_FILE,
      CAMOFOX_PROXY_PROFILES_FILE: env.CAMOFOX_PROXY_PROFILES_FILE,
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
    fingerprintDefaults,
  };
}
