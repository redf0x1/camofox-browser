import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

import type {
  GeoMode,
  GeolocationConfig,
  ProxyProfileConfig,
  RawProxyOverride,
  ResolvedProxyConfig,
  ResolvedSessionProfile,
  SessionProfileInput,
  ViewportConfig,
} from '../types';
import { resolveContextOptions } from './presets';
import type { ProxyConfig } from './config';

export function getConfiguredServerProxy(proxy: ProxyConfig): ResolvedProxyConfig | null {
  if (!proxy.host || !proxy.port) return null;
  return {
    source: 'server-default',
    server: `http://${proxy.host}:${proxy.port}`,
    username: proxy.username || undefined,
    password: proxy.password || undefined,
  };
}

export function loadProxyProfiles(filePath?: string): Record<string, ProxyProfileConfig> {
  if (!filePath) return {};
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Proxy profiles file must contain a JSON object');
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([name, profile]) => [
        name.toLowerCase(),
        profile as ProxyProfileConfig,
      ]),
    ) as Record<string, ProxyProfileConfig>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Log but don't crash — proxy profiles are optional
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'warn',
        msg: 'failed to load proxy profiles',
        path: filePath,
        error: message,
      }) + '\n',
    );
    return {};
  }
}

export function createSessionProfileSignature(profile: {
  proxy: ResolvedProxyConfig | null;
  geoMode: GeoMode;
  locale?: string;
  timezoneId?: string;
  geolocation?: GeolocationConfig;
  viewport?: ViewportConfig;
}): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(profile))
    .digest('hex')
    .slice(0, 12);
}

export function normalizeRawProxy(proxy: RawProxyOverride): ResolvedProxyConfig {
  if (!proxy.host || !proxy.port) {
    throw new Error('proxy.host and proxy.port are required');
  }
  return {
    source: 'raw-override',
    server: `http://${proxy.host}:${proxy.port}`,
    username: proxy.username || undefined,
    password: proxy.password || undefined,
  };
}

export function resolveSessionProfileInput(
  input: SessionProfileInput,
  deps: {
    serverProxy: ResolvedProxyConfig | null;
    proxyProfiles: Record<string, ProxyProfileConfig>;
  },
): Omit<ResolvedSessionProfile, 'sessionKey'> {
  const geoMode: GeoMode = input.geoMode || 'explicit-wins';
  const named = input.proxyProfile ? deps.proxyProfiles[input.proxyProfile.toLowerCase()] : null;

  // Resolve proxy source
  let proxy: ResolvedProxyConfig | null = null;
  if (input.proxy) {
    proxy = normalizeRawProxy(input.proxy);
  } else if (named) {
    proxy = {
      source: 'named-profile',
      profileName: input.proxyProfile,
      ...named,
    } as ResolvedProxyConfig;
  } else {
    proxy = deps.serverProxy;
  }

  // Validate proxy-locked mode before processing
  if (geoMode === 'proxy-locked' && proxy) {
    if (input.locale) {
      throw new Error('proxy-locked does not allow explicit locale overrides');
    }
    if (input.timezoneId) {
      throw new Error('proxy-locked does not allow explicit timezoneId overrides');
    }
    if (input.geolocation) {
      throw new Error('proxy-locked does not allow explicit geolocation overrides');
    }
  }

  // Resolve context options
  const resolvedContext = resolveContextOptions(input);

  // Merge based on geoMode
  const merged =
    geoMode === 'proxy-locked' && proxy
      ? {
          locale: proxy.locale,
          timezoneId: proxy.timezoneId,
          geolocation: proxy.geolocation,
          viewport: resolvedContext?.viewport,
        }
      : resolvedContext;

  return {
    ...(merged || {}),
    geoMode,
    proxy: proxy || null,
    signature: createSessionProfileSignature({ proxy, geoMode, ...(merged || {}) }),
  };
}
