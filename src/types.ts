import type { BrowserContext, Page } from 'playwright-core';

export interface GeolocationConfig {
  latitude: number;
  longitude: number;
}

export interface ViewportConfig {
  width: number;
  height: number;
}

export interface PresetConfig {
  locale: string;
  timezoneId: string;
  geolocation: GeolocationConfig;
  viewport?: ViewportConfig;
}

export interface ContextOverrides {
  preset?: string;
  locale?: string;
  timezoneId?: string;
  geolocation?: GeolocationConfig;
  viewport?: ViewportConfig;
}

export interface LinkInfo {
  text: string;
  url: string;
}

export interface RefInfo {
  role: string;
  name: string;
  nth: number;
}

export interface TabState {
  page: Page;
  // Map of refId (e.g. "e1") -> role/name/nth tuple used to reconstruct a Locator.
  // This matches the runtime structure used by the legacy server.js implementation.
  refs: Map<string, RefInfo>;
  visitedUrls: Set<string>;
  toolCalls: number;
}

export interface SessionData {
  context: BrowserContext;
  tabGroups: Map<string, Map<string, TabState>>;
  lastAccess: number;
}

export interface WaitForPageReadyOptions {
  timeout?: number;
  waitForNetwork?: boolean;
}

export type AllowedUrlScheme = 'http:' | 'https:';

export interface CookieInput {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface ScrollElementParams {
  selector?: string;
  ref?: string;
  deltaX?: number;
  deltaY?: number;
  scrollTo?: { top?: number; left?: number };
}

export interface ScrollPosition {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  clientHeight: number;
  scrollWidth: number;
  clientWidth: number;
}

export interface EvaluateParams {
  expression: string;
  timeout?: number;
}

export interface EvaluateResult {
  ok: boolean;
  result?: unknown;
  resultType?: string;
  truncated?: boolean;
  error?: string;
  errorType?: 'js_error' | 'timeout' | 'validation';
}

declare global {
  namespace Express {
    // Attached by logging middleware for correlation + timing.
    interface Request {
      reqId?: string;
      startTime?: number;
    }
  }
}
