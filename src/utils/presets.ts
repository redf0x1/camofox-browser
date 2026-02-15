import * as crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { GeolocationConfig, PresetConfig, ViewportConfig } from '../types';

// Built-in preset definitions
export const BUILT_IN_PRESETS: Record<string, PresetConfig> = {
  'us-east': {
    locale: 'en-US',
    timezoneId: 'America/New_York',
    geolocation: { latitude: 40.7128, longitude: -74.006 },
  },
  'us-west': {
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    geolocation: { latitude: 34.0522, longitude: -118.2437 },
  },
  japan: {
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    geolocation: { latitude: 35.6895, longitude: 139.6917 },
  },
  uk: {
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    geolocation: { latitude: 51.5074, longitude: -0.1278 },
  },
  germany: {
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    geolocation: { latitude: 52.52, longitude: 13.405 },
  },
  vietnam: {
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    geolocation: { latitude: 10.8231, longitude: 106.6297 },
  },
  singapore: {
    locale: 'en-SG',
    timezoneId: 'Asia/Singapore',
    geolocation: { latitude: 1.3521, longitude: 103.8198 },
  },
  australia: {
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney',
    geolocation: { latitude: -33.8688, longitude: 151.2093 },
  },
};

let customPresets: Record<string, unknown> = {};

let _cachedTimezones: string[] | null = null;
function getSupportedTimezones(): string[] {
  if (!_cachedTimezones) {
    try {
      const supportedValuesOf = (Intl as unknown as { supportedValuesOf?: (key: 'timeZone') => string[] }).supportedValuesOf;
      _cachedTimezones = supportedValuesOf ? supportedValuesOf('timeZone') : [];
    } catch {
      _cachedTimezones = [];
    }
  }
  return _cachedTimezones;
}

/**
 * Load custom presets from a JSON file.
 * Custom presets override built-in presets with the same name.
 */
export function loadCustomPresets(filePath?: string): void {
  if (!filePath) return;
  try {
    const resolved = path.resolve(filePath);
    const content = fs.readFileSync(resolved, 'utf8');
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Presets file must contain a JSON object');
    }
    for (const [name, preset] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof preset !== 'object' || preset === null) continue;
      customPresets[name.toLowerCase()] = preset;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Log but don't crash — custom presets are optional
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'warn',
        msg: 'failed to load custom presets',
        path: filePath,
        error: message,
      }) + '\n',
    );
  }
}

/**
 * Get all available presets (built-in + custom, custom overrides built-in).
 */
export function getAllPresets(): Record<string, unknown> {
  return { ...BUILT_IN_PRESETS, ...customPresets };
}

/**
 * Resolve a named preset to context options.
 */
export function resolvePreset(name?: string): unknown | null {
  if (!name) return null;
  const all = getAllPresets();
  return all[name.toLowerCase()] || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Validate context options.
 */
export function validateContextOptions(opts: unknown): string | null {
  if (!isRecord(opts)) return null;

  const locale = opts.locale;
  if (locale !== undefined) {
    if (typeof locale !== 'string') {
      return `Invalid locale: ${String(locale)}. Expected BCP 47 format (e.g., "en-US", "ja-JP")`;
    }
    if (locale.length > 35) return 'locale too long (max 35 characters)';
    if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(locale)) {
      return `Invalid locale: ${locale}. Expected BCP 47 format (e.g., "en-US", "ja-JP")`;
    }
  }

  const timezoneId = opts.timezoneId;
  if (timezoneId !== undefined) {
    if (typeof timezoneId !== 'string' || !timezoneId) {
      return 'Invalid timezoneId: must be a non-empty string';
    }
    // Validate against Intl API (Node 18+)
    try {
      const supported = getSupportedTimezones();
      if (supported.length && !supported.includes(timezoneId)) {
        return `Invalid timezoneId: ${timezoneId}. Not a recognized IANA timezone.`;
      }
    } catch {
      // Intl.supportedValuesOf not available — skip validation
    }
  }

  const geolocation = opts.geolocation;
  if (geolocation !== undefined) {
    if (!isRecord(geolocation)) {
      return 'geolocation must be an object with latitude and longitude';
    }
    const latitude = geolocation.latitude;
    const longitude = geolocation.longitude;
    if (typeof latitude !== 'number' || latitude < -90 || latitude > 90) {
      return `Invalid geolocation.latitude: ${String(latitude)}. Must be a number between -90 and 90.`;
    }
    if (typeof longitude !== 'number' || longitude < -180 || longitude > 180) {
      return `Invalid geolocation.longitude: ${String(longitude)}. Must be a number between -180 and 180.`;
    }
  }

  const viewport = opts.viewport;
  if (viewport !== undefined) {
    if (!isRecord(viewport)) {
      return 'viewport must be an object with width and height';
    }
    const width = viewport.width;
    const height = viewport.height;
    if (typeof width !== 'number' || !Number.isInteger(width) || width < 320 || width > 3840) {
      return `Invalid viewport.width: ${String(width)}. Must be an integer between 320 and 3840.`;
    }
    if (typeof height !== 'number' || !Number.isInteger(height) || height < 240 || height > 2160) {
      return `Invalid viewport.height: ${String(height)}. Must be an integer between 240 and 2160.`;
    }
  }

  return null;
}

export interface ResolvedContextOptions {
  locale?: string;
  timezoneId?: string;
  geolocation?: GeolocationConfig;
  viewport?: ViewportConfig;
}

/**
 * Resolve context options from request params.
 * Priority: individual fields override preset defaults.
 */
export function resolveContextOptions(params: unknown): ResolvedContextOptions | null {
  if (!params) return null;
  const { preset, locale, timezoneId, geolocation, viewport } = params as Record<string, unknown>;

  if (preset !== undefined && typeof preset !== 'string') {
    throw new Error('preset must be a string');
  }

  if (preset !== undefined && typeof preset === 'string' && !preset.trim()) {
    throw new Error('preset must not be empty');
  }

  // If no preset-related params provided, return null (use defaults)
  // Note: this preserves existing truthy/falsy semantics from the JS implementation.
  if (!preset && !locale && !timezoneId && !geolocation && !viewport) {
    return null;
  }

  // Start with preset defaults if named preset provided
  let resolved: Record<string, unknown> = {};
  if (preset) {
    const presetOptions = resolvePreset(preset);
    if (!presetOptions) {
      const available = Object.keys(getAllPresets()).join(', ');
      throw new Error(`Unknown preset: "${preset}". Available presets: ${available}`);
    }
    resolved = { ...(presetOptions as Record<string, unknown>) };
  }

  // Individual fields override preset defaults
  if (locale !== undefined) resolved.locale = locale;
  if (timezoneId !== undefined) resolved.timezoneId = timezoneId;
  if (geolocation !== undefined) resolved.geolocation = geolocation;
  if (viewport !== undefined) resolved.viewport = viewport;

  return resolved as ResolvedContextOptions;
}

/**
 * Generate a deterministic hash for context options.
 * Used as part of the session key to isolate different presets.
 */
export function contextHash(opts: ResolvedContextOptions | null): string {
  if (!opts) return '';
  const canonical = JSON.stringify({
    l: opts.locale,
    t: opts.timezoneId,
    g: opts.geolocation ? `${opts.geolocation.latitude},${opts.geolocation.longitude}` : undefined,
    v: opts.viewport ? `${opts.viewport.width}x${opts.viewport.height}` : undefined,
  });
  return ':' + crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8);
}

// Load custom presets on module load
loadCustomPresets(process.env.CAMOFOX_PRESETS_FILE);
