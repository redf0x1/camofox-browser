/**
 * Tests for parseNetscapeCookieFile (Netscape cookie format parser)
 * 
 * The parser lives in plugin.ts. Since it's TypeScript and not directly
 * importable, we reimplement the same logic here for testing. Any change
 * to the parser in plugin.ts MUST be mirrored here.
 */

function parseNetscapeCookieFile(text) {
  const cookies = [];

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
    const path = parts[2];
    const secure = parts[3].toUpperCase() === 'TRUE';
    const expires = Number(parts[4]);
    const name = parts[5];
    const value = parts.slice(6).join('\t');

    cookies.push({ name, value, domain, path, expires, httpOnly, secure });
  }

  return cookies;
}

describe('Netscape cookie file parser', () => {
  test('parses a basic 7-field line', () => {
    const text = '.example.com\tTRUE\t/\tFALSE\t0\tsession_id\tabc123';
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toEqual({
      name: 'session_id',
      value: 'abc123',
      domain: '.example.com',
      path: '/',
      expires: 0,
      httpOnly: false,
      secure: false,
    });
  });

  test('parses secure cookie', () => {
    const text = '.example.com\tTRUE\t/\tTRUE\t1700000000\ttoken\txyz';
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies[0].secure).toBe(true);
    expect(cookies[0].expires).toBe(1700000000);
  });

  test('detects #HttpOnly_ prefix', () => {
    const text = '#HttpOnly_.example.com\tTRUE\t/\tTRUE\t0\tsid\tval';
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].httpOnly).toBe(true);
    expect(cookies[0].domain).toBe('.example.com');
  });

  test('skips comment lines', () => {
    const text = [
      '# Netscape HTTP Cookie File',
      '# This is a comment',
      '.example.com\tTRUE\t/\tFALSE\t0\tname\tvalue',
    ].join('\n');
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe('name');
  });

  test('skips empty lines', () => {
    const text = [
      '',
      '.example.com\tTRUE\t/\tFALSE\t0\ta\tb',
      '',
      '',
      '.test.com\tFALSE\t/path\tTRUE\t0\tc\td',
      '',
    ].join('\n');
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(2);
  });

  test('skips lines with fewer than 7 tab-separated fields', () => {
    const text = [
      '.example.com\tTRUE\t/\tFALSE\t0\tname',
      'too\tfew\tfields',
      '.example.com\tTRUE\t/\tFALSE\t0\tgood\tvalue',
    ].join('\n');
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe('good');
  });

  test('handles cookie value containing tabs', () => {
    const text = '.example.com\tTRUE\t/\tFALSE\t0\tname\tval\twith\ttabs';
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].value).toBe('val\twith\ttabs');
  });

  test('handles Windows line endings (\\r\\n)', () => {
    const text = '.a.com\tTRUE\t/\tFALSE\t0\tx\t1\r\n.b.com\tTRUE\t/\tFALSE\t0\ty\t2\r\n';
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(2);
    expect(cookies[0].name).toBe('x');
    expect(cookies[1].name).toBe('y');
  });

  test('handles UTF-8 BOM prefix', () => {
    const text = '\uFEFF# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t0\tname\tvalue';
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe('name');
  });

  test('handles BOM before #HttpOnly_ on first line', () => {
    const text = '\uFEFF#HttpOnly_.example.com\tTRUE\t/\tTRUE\t0\tsid\tsecret';
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].httpOnly).toBe(true);
    expect(cookies[0].domain).toBe('.example.com');
  });

  test('handles NaN expires gracefully', () => {
    const text = '.example.com\tTRUE\t/\tFALSE\tgarbage\tname\tvalue';
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].expires).toBeNaN();
  });

  test('parses multiple cookies from a real-format file', () => {
    const text = [
      '# Netscape HTTP Cookie File',
      '# https://curl.se/docs/http-cookies.html',
      '',
      '.linkedin.com\tTRUE\t/\tTRUE\t1700000000\tli_at\tAQEDAT...',
      '#HttpOnly_.linkedin.com\tTRUE\t/\tTRUE\t0\tJSESSIONID\tajax:123',
      '.linkedin.com\tTRUE\t/\tFALSE\t1700000000\tlang\tv=2&lang=en-us',
    ].join('\n');
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(3);
    expect(cookies[0]).toMatchObject({ name: 'li_at', secure: true, httpOnly: false });
    expect(cookies[1]).toMatchObject({ name: 'JSESSIONID', httpOnly: true, secure: true });
    expect(cookies[2]).toMatchObject({ name: 'lang', secure: false });
  });

  test('returns empty array for empty input', () => {
    expect(parseNetscapeCookieFile('')).toEqual([]);
  });

  test('returns empty array for comments-only file', () => {
    const text = '# comment\n# another comment\n';
    expect(parseNetscapeCookieFile(text)).toEqual([]);
  });

  test('skips lines where trailing tab is trimmed (empty value)', () => {
    // trim() strips the trailing tab, reducing field count to 6 — line is skipped
    const text = '.example.com\tTRUE\t/\tFALSE\t0\tname\t';
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(0);
  });

  test('parses empty value when followed by another line', () => {
    // Empty value with content after — not just trailing whitespace
    const text = '.example.com\tTRUE\t/\tFALSE\t0\tempty_val\t\n.b.com\tTRUE\t/\tFALSE\t0\tother\tval';
    const cookies = parseNetscapeCookieFile(text);
    // First line: trim strips trailing tab, falls to 6 fields, skipped
    // Second line: normal
    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe('other');
  });
});
