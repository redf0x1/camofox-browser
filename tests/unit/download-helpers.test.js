const path = require('node:path');

const {
  sanitizeFilename,
  guessMimeType,
  safeUserDir,
  normalizeExtensions,
} = require('../../dist/src/utils/download-helpers');

describe('download-helpers.ts (unit)', () => {
  describe('sanitizeFilename()', () => {
    test('returns safe name as-is', () => {
      expect(sanitizeFilename('report.pdf')).toBe('report.pdf');
    });

    test('replaces slashes with underscores', () => {
      expect(sanitizeFilename('a/b/c.txt')).toBe('a_b_c.txt');
      expect(sanitizeFilename('a\\b\\c.txt')).toBe('a_b_c.txt');
    });

    test('strips NUL bytes', () => {
      expect(sanitizeFilename('ab\0cd.txt')).toBe('abcd.txt');
    });

    test('truncates at 200 chars', () => {
      const long = 'a'.repeat(250);
      const out = sanitizeFilename(long);
      expect(out.length).toBe(200);
      expect(out).toBe('a'.repeat(200));
    });

    test('returns "download" for empty/null/undefined input', () => {
      expect(sanitizeFilename('')).toBe('download');
      expect(sanitizeFilename('   ')).toBe('download');
      expect(sanitizeFilename(null)).toBe('download');
      expect(sanitizeFilename(undefined)).toBe('download');
    });

    test('handles path traversal attempts (../)', () => {
      const out = sanitizeFilename('../secrets.txt');
      expect(out).toContain('..');
      expect(out).not.toContain('/');
      expect(out).not.toContain('\\');
    });

    test('handles special characters (keeps them unless unsafe)', () => {
      expect(sanitizeFilename('my:fi*le?name|ok.txt')).toBe('my:fi*le?name|ok.txt');
    });
  });

  describe('guessMimeType()', () => {
    test('each known extension returns correct MIME type', () => {
      expect(guessMimeType('a.pdf')).toBe('application/pdf');
      expect(guessMimeType('a.zip')).toBe('application/zip');
      expect(guessMimeType('a.gz')).toBe('application/gzip');
      expect(guessMimeType('a.json')).toBe('application/json');
      expect(guessMimeType('a.csv')).toBe('text/csv');
      expect(guessMimeType('a.txt')).toBe('text/plain');
      expect(guessMimeType('a.html')).toBe('text/html');
      expect(guessMimeType('a.htm')).toBe('text/html');
      expect(guessMimeType('a.png')).toBe('image/png');
      expect(guessMimeType('a.jpg')).toBe('image/jpeg');
      expect(guessMimeType('a.jpeg')).toBe('image/jpeg');
      expect(guessMimeType('a.gif')).toBe('image/gif');
      expect(guessMimeType('a.webp')).toBe('image/webp');
      expect(guessMimeType('a.svg')).toBe('image/svg+xml');
      expect(guessMimeType('a.mp4')).toBe('video/mp4');
      expect(guessMimeType('a.webm')).toBe('video/webm');
      expect(guessMimeType('a.mp3')).toBe('audio/mpeg');
      expect(guessMimeType('a.wav')).toBe('audio/wav');
    });

    test('unknown extension returns application/octet-stream', () => {
      expect(guessMimeType('file.unknownext')).toBe('application/octet-stream');
      expect(guessMimeType('noext')).toBe('application/octet-stream');
    });

    test('case insensitive', () => {
      expect(guessMimeType('PHOTO.JPG')).toBe('image/jpeg');
      expect(guessMimeType('video.MP4')).toBe('video/mp4');
    });

    test('handles filenames with multiple dots', () => {
      expect(guessMimeType('photo.profile.jpeg')).toBe('image/jpeg');
      expect(guessMimeType('archive.tar.gz')).toBe('application/gzip');
    });
  });

  describe('safeUserDir()', () => {
    test('creates valid directory path', () => {
      expect(safeUserDir('/tmp/root', 'userA')).toBe(path.join('/tmp/root', 'userA'));
    });

    test('encodeURIComponent for special chars in userId', () => {
      expect(safeUserDir('/tmp/root', 'a b/../c')).toBe(path.join('/tmp/root', encodeURIComponent('a b/../c')));
    });

    test('handles empty userId', () => {
      expect(safeUserDir('/tmp/root', '')).toBe(path.join('/tmp/root', encodeURIComponent('')));
    });
  });

  describe('normalizeExtensions()', () => {
    test('undefined returns empty array', () => {
      expect(normalizeExtensions(undefined)).toEqual([]);
    });

    test('string input split by comma', () => {
      expect(normalizeExtensions('png,jpg')).toEqual(['.png', '.jpg']);
    });

    test('array input passed through (normalized)', () => {
      expect(normalizeExtensions(['png', '.JPG', '  gif '])).toEqual(['.png', '.jpg', '.gif']);
    });

    test('dot prefix added if missing; trimmed and lowercased', () => {
      expect(normalizeExtensions(' PNG , .JpG ,  ')).toEqual(['.png', '.jpg']);
    });
  });
});
