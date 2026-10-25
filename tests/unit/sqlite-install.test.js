const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// npm ci's Arborist reads gypfile from the lock, not the extracted package.json.
// npm 10 drops gypfile:false when generating a lock, then invents node-gyp rebuild
// for this prebuilt package on the next ci. Keep upstream's explicit opt-out.
test('SQLite clean ci uses the bundled prebuild with lifecycle scripts enabled', () => {
  const lock = require('../../package-lock.json');
  const sqlite = lock.packages['node_modules/better-sqlite3'];
  expect(sqlite.gypfile).toBe(false);
  const upstream = require('better-sqlite3/package.json');
  expect(upstream.version).toBe(sqlite.version);
  expect(upstream.gypfile).toBe(false);
  expect(upstream.scripts.install).toBeUndefined();
  expect(upstream.scripts.preinstall).toBeUndefined();

  // npm test supplies npm_execpath; invoke its JS entry point on Windows too.
  expect(process.env.npm_execpath).toBeTruthy();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-sqlite-install-'));
  const marker = path.join(root, 'node-gyp-called');
  const guard = path.join(root, 'deny-node-gyp.cjs');
  fs.writeFileSync(guard, `
    if (/[/\\\\]node-gyp(?:\\.js)?$/.test(process.argv[1] || '')) {
      require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');
      process.exit(86);
    }
  `);
  const env = {};
  for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'npm_config_cache']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.NODE_OPTIONS = `--require=${JSON.stringify(guard)}`;
  env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';
  const manifest = {
    name: 'camofox-sqlite-install-test', version: '1.0.0', private: true,
    dependencies: { 'better-sqlite3': sqlite.version },
    scripts: { postinstall: 'node -e "require(\'node:fs\').writeFileSync(\'lifecycle-ran\', \'yes\')"' },
  };
  const runNpm = (command) => spawnSync(process.execPath, [process.env.npm_execpath,
    command, '--offline', '--ignore-scripts=false', '--foreground-scripts', '--no-audit', '--no-fund'],
  { cwd: root, env, encoding: 'utf8', timeout: 60000 });
  const checkSuccess = (result) => {
    expect({ status: result.status, error: result.error, output: result.status === 0 ? '' : result.stdout + result.stderr })
      .toEqual({ status: 0, error: undefined, output: '' });
    expect(fs.readFileSync(path.join(root, 'lifecycle-ran'), 'utf8')).toBe('yes');
    fs.unlinkSync(path.join(root, 'lifecycle-ran'));
    expect(fs.existsSync(marker)).toBe(false);
    const prebuild = path.join('better-sqlite3', 'prebuilds', `${process.platform}-${process.arch}.node`);
    const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    expect(hash(path.join(root, 'node_modules', prebuild)))
      .toBe(hash(path.join(__dirname, '../../node_modules', prebuild)));
    expect(fs.existsSync(path.join(root, 'node_modules/better-sqlite3/build'))).toBe(false);
    const query = spawnSync(process.execPath, ['-e', `
      const db = new (require('better-sqlite3'))(':memory:');
      const row = db.prepare('select 42 as answer, sqlite_version() as version').get();
      if (row.answer !== 42 || !row.version) process.exit(1);
      db.close();
    `], { cwd: root, env, encoding: 'utf8' });
    expect({ status: query.status, stderr: query.stderr }).toEqual({ status: 0, stderr: '' });
  };
  try {
    // The repository's npm ci populated tarballs, not necessarily registry indexes.
    // Exercise ci directly with the committed resolved/integrity metadata; requiring
    // a fresh offline install first would depend on an unrelated packument cache.
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
    const fixtureLock = {
      name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true,
      packages: {
        '': { ...manifest, hasInstallScript: true },
        'node_modules/better-sqlite3': { ...sqlite },
        'node_modules/node-addon-api': lock.packages['node_modules/node-addon-api'],
      },
    };
    const saveLock = () => fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(fixtureLock));
    // Negative control: prove the guard observes npm's unwanted default lifecycle.
    delete fixtureLock.packages['node_modules/better-sqlite3'].gypfile;
    saveLock();
    const control = runNpm('ci');
    expect(control.status).not.toBe(0);
    expect(fs.readFileSync(marker, 'utf8')).toBe('called');
    fs.unlinkSync(marker);
    fixtureLock.packages['node_modules/better-sqlite3'].gypfile = sqlite.gypfile;
    saveLock();
    checkSuccess(runNpm('ci'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180000);
