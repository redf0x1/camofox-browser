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
  lastSnapshot?: string | null;
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

export interface DownloadInfo {
  id: string;
  contentUrl: string;
  tabId: string;
  userId: string;
  suggestedFilename: string;
  savedFilename: string;
  mimeType: string;
  size: number;
  status: 'pending' | 'completed' | 'failed' | 'canceled';
  error?: string;
  url: string;
  createdAt: number;
  completedAt?: number;
}

export interface DownloadListFilters {
  tabId?: string;
  userId: string;
  status?: string;
  extension?: string;
  mimeType?: string;
  minSize?: number;
  maxSize?: number;
  sort?: string;
  limit?: number;
  offset?: number;
}

export interface ExtractedResource {
  url: string;
  filename: string | null;
  mimeType: string | null;
  tagName: string;
  type: 'image' | 'link' | 'media' | 'document';
  alt: string | null;
  width: number | null;
  height: number | null;
  isBlob: boolean;
  isDataUri: boolean;
  hasDownloadAttr: boolean;
  text: string | null;
  ref: string | null;
  parentSelector: string | null;
}

export interface ContainerInfo {
  selector: string;
  tagName: string;
  childCount: number;
}

export interface ExtractionMetadata {
  extractionTimeMs: number;
  lazyLoadsTriggered: number;
  blobsResolved: number;
}

export interface ExtractResourcesParams {
  userId: string;
  selector?: string;
  types?: ('images' | 'links' | 'media' | 'documents')[];
  extensions?: string[];
  resolveBlobs?: boolean;
  triggerLazyLoad?: boolean;
}

export interface ExtractResourcesResult {
  ok: boolean;
  container: ContainerInfo;
  resources: {
    images: ExtractedResource[];
    links: ExtractedResource[];
    media: ExtractedResource[];
    documents: ExtractedResource[];
  };
  totals: { images: number; links: number; media: number; documents: number; total: number };
  metadata: ExtractionMetadata;
}

export interface BatchDownloadParams {
  userId: string;
  selector?: string;
  types?: ('images' | 'links' | 'media' | 'documents')[];
  extensions?: string[];
  resolveBlobs?: boolean;
  concurrency?: number;
  maxFiles?: number;
}

export interface BatchDownloadResult {
  ok: boolean;
  batchId: string;
  downloads: DownloadInfo[];
  errors: { url: string; error: string }[];
  totals: { completed: number; failed: number; total: number };
}

export interface YouTubeTranscriptResult {
  status: 'ok' | 'error';
  code?: number;
  message?: string;
  transcript?: string;
  video_url: string;
  video_id: string;
  video_title?: string;
  title?: string;
  language?: string;
  total_words?: number;
  available_languages?: Array<{ code: string; name: string; kind: string }>;
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
