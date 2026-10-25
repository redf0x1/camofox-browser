const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync, execFileSync } = require('node:child_process');
const { installBrowser, installGeoLite, extractZip, download, main } = require('../../bin/install-browser');

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-install-test-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const fetcher = { init: async () => {}, url: 'https://example.invalid/browser.zip', version: '152.0.4', release: 'beta.28' };
function options(extra = {}) {
  return { pkgman: {}, fetcher, installDir: path.join(root, 'cache'), ...extra };
}
function writeExecutable(dir) {
  const relative = process.platform === 'darwin' ? 'Camoufox.app/Contents/MacOS/camoufox'
    : process.platform === 'win32' ? 'camoufox.exe' : 'camoufox-bin';
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'test engine fixture', { mode: 0o755 });
}

test('commits version metadata only after successful extraction and executable verification', async () => {
  await installBrowser(options({ downloadFile: async (_, file) => fs.writeFileSync(file, 'fixture'),
    extract: async (_, dir) => writeExecutable(dir) }));
  expect(JSON.parse(fs.readFileSync(path.join(root, 'cache/version.json')))).toEqual({ version: '152.0.4', release: 'beta.28' });
  expect(fs.readdirSync(root)).toEqual(['cache']);
});

test.each(['download', 'extract', 'missing-executable'])('%s failure rejects and removes only owned staging', async (failure) => {
  fs.mkdirSync(path.join(root, 'profiles'));
  fs.writeFileSync(path.join(root, 'profiles/cookies'), 'keep');
  await expect(installBrowser(options({
    downloadFile: async (_, file) => { if (failure === 'download') throw new Error('network failed'); fs.writeFileSync(file, 'fixture'); },
    extract: async () => { if (failure === 'extract') throw new Error('corrupt zip'); },
  }))).rejects.toThrow();
  expect(fs.readdirSync(root)).toEqual(['profiles']);
  expect(fs.readFileSync(path.join(root, 'profiles/cookies'), 'utf8')).toBe('keep');
});

test('preserves and rejects an existing incomplete cache rather than replacing it', async () => {
  fs.mkdirSync(path.join(root, 'cache'));
  fs.writeFileSync(path.join(root, 'cache/keep'), 'original');
  await expect(installBrowser(options())).rejects.toThrow(/preserved.*CAMOUFOX_INSTALL_DIR/);
  expect(fs.readFileSync(path.join(root, 'cache/keep'), 'utf8')).toBe('original');
});

test('reuses a validated supported cache without network access', async () => {
  const dir = path.join(root, 'cache');
  writeExecutable(dir);
  const init = jest.fn();
  await installBrowser(options({ pkgman: { camoufoxPath: () => dir, installedVerStr: () => '152.0.4-beta.28' }, fetcher: { init } }));
  expect(init).not.toHaveBeenCalled();
});

test('engine failure is fatal, but optional GeoLite rejection is awaited and tolerated', async () => {
  const geo = jest.fn(async () => { throw new Error('GeoLite transient'); });
  await expect(main({ loadPkgman: async () => ({}), install: async () => { throw new Error('engine failed'); }, geo })).rejects.toThrow('engine failed');
  expect(geo).not.toHaveBeenCalled();
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  await main({ loadPkgman: async () => ({}), install: async () => {}, geo });
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('Optional GeoLite download failed'));
  warn.mockRestore();
});

test('optional GeoLite failure leaves no partial database and preserves existing database', async () => {
  class GitHubDownloader { async getAsset() { return 'https://example.invalid/db'; } }
  const pkgman = { INSTALL_DIR: root, GitHubDownloader };
  await expect(installGeoLite(pkgman, async (_, file) => { fs.writeFileSync(file, 'partial'); throw new Error('truncated'); })).rejects.toThrow('truncated');
  expect(fs.readdirSync(root)).toEqual([]);
  fs.writeFileSync(path.join(root, 'GeoLite2-City.mmdb'), 'keep');
  const dl = jest.fn();
  await installGeoLite(pkgman, dl);
  expect(dl).not.toHaveBeenCalled();
});

test('lifecycle skip runs before loading dependencies or touching an existing cache', () => {
  const cache = path.join(root, 'cache');
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../bin/install-browser.js')], {
    env: { PATH: process.env.PATH, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', CAMOUFOX_INSTALL_DIR: cache }, encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/Skipping browser installation/);
  expect(fs.existsSync(cache)).toBe(false);
});

test('streamed download rejects HTTP and truncated bodies, and writes real response bytes', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/fail') { res.writeHead(503); res.end(); }
    else if (req.url === '/truncated') { res.writeHead(200, { 'content-length': '100' }); res.end('short'); }
    else { res.end('real response'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await expect(download(`${url}/fail`, path.join(root, 'fail'))).rejects.toThrow('503');
    await expect(download(`${url}/truncated`, path.join(root, 'truncated'))).rejects.toThrow();
    await download(`${url}/ok`, path.join(root, 'ok'));
    expect(fs.readFileSync(path.join(root, 'ok'), 'utf8')).toBe('real response');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}, 15000);

test('real disk-backed extraction works and corrupt ZIP extraction rejects', () => {
  if (process.platform === 'win32') return; // Fixture generation needs Python; Windows tar is exercised by release CI.
  const archive = path.join(root, 'fixture.zip');
  execFileSync('python3', ['-c', "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1], 'w',zipfile.ZIP_DEFLATED); z.writestr('nested/payload', b'A'*3000000); z.close()", archive]);
  const output = path.join(root, 'output'); fs.mkdirSync(output);
  extractZip(archive, output);
  expect(fs.statSync(path.join(output, 'nested/payload')).size).toBe(3000000);
  fs.writeFileSync(archive, 'corrupt');
  expect(() => extractZip(archive, output)).toThrow();
});
