import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateProxyProfile(name: string, profile: unknown): string | null {
  if (!isRecord(profile)) {
    return `Profile "${name}" must be an object`;
  }

  const server = profile.server;
  if (typeof server !== 'string' || !server.trim()) {
    return `Profile "${name}" must have a non-empty string "server" field`;
  }

  // Validate optional fields if present
  if (profile.username !== undefined && typeof profile.username !== 'string') {
    return `Profile "${name}" username must be a string`;
  }

  if (profile.password !== undefined && typeof profile.password !== 'string') {
    return `Profile "${name}" password must be a string`;
  }

  if (profile.locale !== undefined && typeof profile.locale !== 'string') {
    return `Profile "${name}" locale must be a string`;
  }

  if (profile.timezoneId !== undefined && typeof profile.timezoneId !== 'string') {
    return `Profile "${name}" timezoneId must be a string`;
  }

  if (profile.geolocation !== undefined) {
    if (!isRecord(profile.geolocation)) {
      return `Profile "${name}" geolocation must be an object`;
    }
    const geo = profile.geolocation;
    if (typeof geo.latitude !== 'number' || geo.latitude < -90 || geo.latitude > 90) {
      return `Profile "${name}" geolocation.latitude must be a number between -90 and 90`;
    }
    if (typeof geo.longitude !== 'number' || geo.longitude < -180 || geo.longitude > 180) {
      return `Profile "${name}" geolocation.longitude must be a number between -180 and 180`;
    }
  }

  return null;
}

export function loadProxyProfiles(filePath?: string): Record<string, ProxyProfileConfig> {
  if (!filePath) return {};
  try {
    const resolved = path.resolve(filePath);
    const content = fs.readFileSync(resolved, 'utf8');
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Proxy profiles file must contain a JSON object');
    }

    const validated: Record<string, ProxyProfileConfig> = {};
    for (const [name, profile] of Object.entries(parsed as Record<string, unknown>)) {
      const error = validateProxyProfile(name, profile);
      if (error) {
        throw new Error(error);
      }
      validated[name.toLowerCase()] = profile as ProxyProfileConfig;
    }

    return validated;
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

  // Resolve proxy source
  let proxy: ResolvedProxyConfig | null = null;
  if (input.proxy) {
    proxy = normalizeRawProxy(input.proxy);
  } else if (input.proxyProfile) {
    const named = deps.proxyProfiles[input.proxyProfile.toLowerCase()];
    if (!named) {
      const available = Object.keys(deps.proxyProfiles);
      const availableList = available.length > 0 ? ` Available profiles: ${available.join(', ')}` : '';
      throw new Error(`Unknown proxy profile: "${input.proxyProfile}".${availableList}`);
    }
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
