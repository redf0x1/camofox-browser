#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const EXPECTED_NODE_FLOOR = '22';
const EXPECTED_PLAYWRIGHT_CORE = '1.58.1';
const EXPECTED_ADM_ZIP = '0.6.1';
const EXPECTED_BINS = ['camofox', 'camofox-browser'];
const EXPECTED_FILES = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'THIRD-PARTY-NOTICES.md',
  'plugin.ts',
  'openclaw.plugin.json',
  'bin/install-browser.js',
];
const EXPECTED_DIRS = ['dist', 'bin'];

let failures = 0;
const pass = (message) => console.log(`PASS: ${message}`);
const fail = (message) => {
  failures += 1;
  console.error(`FAIL: ${message}`);
};

function run(command, args, { cwd = ROOT, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status}${capture ? `\n${result.stdout ?? ''}\n${result.stderr ?? ''}` : ''}`,
    );
  }
  return result.stdout ?? '';
}

function runNpm(args, options = {}) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return run(process.execPath, [npmExecPath, ...args], options);
  }

  if (process.platform === 'win32') {
    return run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], options);
  }

  return run('npm', args, options);
}

function runInstalledBin(binPath, cwd) {
  if (process.platform === 'win32') {
    const command = `call "${binPath}.cmd" --help`;
    return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], {
      cwd,
      encoding: 'utf8',
      windowsVerbatimArguments: true,
    });
  }
  return spawnSync(binPath, ['--help'], { cwd, encoding: 'utf8' });
}

const tempRoot = mkdtempSync(join(os.tmpdir(), 'camofox-package-verify-'));

try {
  console.log('=== CamoFox Package Contract Verification ===\n');

  console.log('--- Step 1: Build ---');
  runNpm(['run', 'build']);

  console.log('\n--- Step 2: Pack ---');
  const packJson = runNpm(['pack', '--json', '--pack-destination', tempRoot], { capture: true });
  const packResult = JSON.parse(packJson);
  const packed = packResult[0];
  if (!packed?.filename) throw new Error('npm pack did not report a tarball filename');
  const tarballPath = join(tempRoot, packed.filename);
  if (!existsSync(tarballPath)) throw new Error(`npm pack did not create ${tarballPath}`);
  pass(`Tarball created: ${packed.filename}`);

  const contents = new Set((packed.files ?? []).map((entry) => entry.path));
  console.log('\n--- Step 3: Tarball Contents ---');
  for (const file of EXPECTED_FILES) {
    if (contents.has(file)) pass(`Tarball contains ${file}`);
    else fail(`Tarball missing ${file}`);
  }
  for (const dir of EXPECTED_DIRS) {
    if ([...contents].some((file) => file.startsWith(`${dir}/`))) pass(`Tarball contains ${dir}/`);
    else fail(`Tarball missing ${dir}/`);
  }
  for (const bin of EXPECTED_BINS) {
    const file = `bin/${bin}.js`;
    if (contents.has(file)) pass(`Tarball contains ${file}`);
    else fail(`Tarball missing ${file}`);
  }

  console.log('\n--- Step 4: Clean Install + Manifest Metadata ---');
  writeFileSync(join(tempRoot, 'package.json'), '{"private":true}\n', 'utf8');
  runNpm(
    ['install', tarballPath, '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund'],
    { cwd: tempRoot },
  );

  const installedRoot = join(tempRoot, 'node_modules', 'camofox-browser');
  const manifest = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'));
  const pluginManifest = JSON.parse(readFileSync(join(installedRoot, 'openclaw.plugin.json'), 'utf8'));

  // Exercise the shipped lifecycle entry without touching the user's browser cache.
  const isolatedCache = join(tempRoot, 'browser-cache');
  const installer = join(installedRoot, 'bin', 'install-browser.js');
  const skippedInstall = spawnSync(process.execPath, [installer], {
    cwd: installedRoot,
    env: { PATH: process.env.PATH, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', CAMOUFOX_INSTALL_DIR: isolatedCache },
    encoding: 'utf8',
  });
  if (skippedInstall.status === 0 && skippedInstall.stdout.includes('Skipping browser installation') && !existsSync(isolatedCache)) {
    pass('Shipped installer explicitly skips without modifying browser cache');
  } else fail(`Shipped installer skip failed: ${skippedInstall.stderr}`);
  mkdirSync(isolatedCache);
  writeFileSync(join(isolatedCache, 'preserve.txt'), 'existing-cache');
  const rejectedInstall = spawnSync(process.execPath, [installer], {
    cwd: installedRoot,
    env: { PATH: process.env.PATH, CAMOUFOX_INSTALL_DIR: isolatedCache },
    encoding: 'utf8',
  });
  if (rejectedInstall.status === 1 && rejectedInstall.stderr.includes('has been preserved') &&
      readFileSync(join(isolatedCache, 'preserve.txt'), 'utf8') === 'existing-cache') {
    pass('Shipped installer exits nonzero and preserves an incomplete existing cache');
  } else fail(`Shipped installer validation failed: ${rejectedInstall.stderr}`);

  if (String(manifest.engines?.node ?? '').includes(`>=${EXPECTED_NODE_FLOOR}`)) {
    pass(`Node floor: ${manifest.engines.node}`);
  } else {
    fail(`Node floor mismatch: got ${manifest.engines?.node}, expected >=${EXPECTED_NODE_FLOOR}`);
  }
  if (typeof manifest.main === 'string' && existsSync(join(installedRoot, manifest.main))) {
    pass(`Main entry ${manifest.main} exists in installed package`);
  } else {
    fail(`Main entry ${manifest.main} missing from installed package`);
  }
  if (manifest.dependencies?.commander) pass('commander listed in dependencies');
  else fail('commander missing from dependencies');
  if (manifest.optionalDependencies?.argon2) pass('argon2 listed in optionalDependencies');
  else fail('argon2 missing from optionalDependencies');

  console.log('\n--- Step 5: Plugin Manifest ---');
  if (manifest.version === pluginManifest.version) pass(`Plugin version matches package version: ${manifest.version}`);
  else fail(`Version mismatch: package=${manifest.version}, plugin=${pluginManifest.version}`);
  for (const extension of manifest.openclaw?.extensions ?? []) {
    if (existsSync(join(installedRoot, extension))) pass(`openclaw extension ${extension} exists in installed package`);
    else fail(`openclaw extension ${extension} missing from installed package`);
  }

  console.log('\n--- Step 6: Installed Package Smoke ---');
  const binDir = join(tempRoot, 'node_modules', '.bin');
  for (const bin of EXPECTED_BINS) {
    const basePath = join(binDir, bin);
    const installed = process.platform === 'win32'
      ? existsSync(`${basePath}.cmd`)
      : existsSync(basePath);
    if (installed) pass(`Bin ${bin} installed`);
    else fail(`Bin ${bin} not found after install`);

    if (installed) {
      const result = runInstalledBin(basePath, tempRoot);
      if (!result.error && result.status === 0) pass(`Bin ${bin} executes (--help)`);
      else fail(`Bin ${bin} exists but does not execute`);
    }
  }

  const mainResolve = spawnSync(
    process.execPath,
    ['-e', "require.resolve('camofox-browser')"],
    { cwd: tempRoot, encoding: 'utf8' },
  );
  if (!mainResolve.error && mainResolve.status === 0) pass("Main entry resolves via require('camofox-browser')");
  else fail('Main entry does not resolve');

  const installedPlaywright = JSON.parse(
    readFileSync(join(tempRoot, 'node_modules', 'playwright-core', 'package.json'), 'utf8'),
  ).version;
  if (installedPlaywright === EXPECTED_PLAYWRIGHT_CORE) pass(`playwright-core resolved to ${EXPECTED_PLAYWRIGHT_CORE}`);
  else fail(`playwright-core resolved to ${installedPlaywright}, expected ${EXPECTED_PLAYWRIGHT_CORE}`);

  const dependencyTree = JSON.parse(
    runNpm(['ls', 'adm-zip', '--all', '--json'], { cwd: tempRoot, capture: true }),
  );
  const admZipVersions = [];
  const collectAdmZipVersions = (node) => {
    for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
      if (name === 'adm-zip' && dependency.version) admZipVersions.push(dependency.version);
      collectAdmZipVersions(dependency);
    }
  };
  collectAdmZipVersions(dependencyTree);
  const uniqueAdmZipVersions = [...new Set(admZipVersions)];
  if (uniqueAdmZipVersions.length === 1 && uniqueAdmZipVersions[0] === EXPECTED_ADM_ZIP) {
    pass(`adm-zip dependency tree resolved to ${EXPECTED_ADM_ZIP}`);
  } else {
    fail(`adm-zip dependency tree resolved to ${uniqueAdmZipVersions.join(', ') || 'nothing'}, expected only ${EXPECTED_ADM_ZIP}`);
  }

  if (existsSync(join(installedRoot, 'plugin.ts'))) pass('plugin.ts accessible in installed package');
  else fail('plugin.ts not found in installed package');
  if (existsSync(join(installedRoot, 'openclaw.plugin.json'))) pass('openclaw.plugin.json accessible in installed package');
  else fail('openclaw.plugin.json not found in installed package');
  if (existsSync(join(installedRoot, 'THIRD-PARTY-NOTICES.md'))) pass('third-party notices accessible in installed package');
  else fail('THIRD-PARTY-NOTICES.md not found in installed package');

  console.log('\n=== Summary ===');
  if (failures === 0) console.log('ALL CHECKS PASSED');
  else console.error(`${failures} CHECK(S) FAILED`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

if (failures > 0) process.exitCode = 1;
