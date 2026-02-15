/**
 * Cookie file reading and parsing for camofox-browser.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export interface ParsedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly?: boolean;
  secure?: boolean;
}

export interface ReadCookieFileOptions {
  cookiesDir: string;
  cookiesPath: string;
  domainSuffix?: string;
  maxBytes?: number;
}

/**
 * Parse a Netscape-format cookie file into structured cookie objects.
 */
export function parseNetscapeCookieFile(text: string): ParsedCookie[] {
  const cookies: ParsedCookie[] = [];
  const cleaned = text.replace(/^\uFEFF/, '');

  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue;

    let httpOnly = false;
    let working = line;
    if (working.startsWith('#HttpOnly_')) {
      httpOnly = true;
      working = working.replace(/^#HttpOnly_/, '');
    }

    const parts = working.split('\t');
    if (parts.length < 7) continue;

    const domain = parts[0];
    const cookiePath = parts[2];
    const secure = parts[3].toUpperCase() === 'TRUE';
    const expires = Number(parts[4]);
    const name = parts[5];
    const value = parts.slice(6).join('\t');

    cookies.push({ name, value, domain, path: cookiePath, expires, httpOnly, secure });
  }

  return cookies;
}

/**
 * Read and parse cookies from a Netscape cookie file.
 */
export async function readCookieFile({
  cookiesDir,
  cookiesPath,
  domainSuffix,
  maxBytes = 5 * 1024 * 1024,
}: ReadCookieFileOptions): Promise<Array<Required<Pick<ParsedCookie, 'name' | 'value' | 'domain' | 'path' | 'expires'>> & { httpOnly: boolean; secure: boolean }>> {
  const resolved = path.resolve(cookiesDir, cookiesPath);
  if (!resolved.startsWith(cookiesDir + path.sep)) {
    throw new Error('cookiesPath must be a relative path within the cookies directory');
  }

  const stat = await fs.stat(resolved);
  if (stat.size > maxBytes) {
    throw new Error('Cookie file too large (max 5MB)');
  }

  const text = await fs.readFile(resolved, 'utf8');
  let cookies = parseNetscapeCookieFile(text);
  if (domainSuffix) {
    cookies = cookies.filter((c) => c.domain.endsWith(domainSuffix));
  }

  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
  }));
}
