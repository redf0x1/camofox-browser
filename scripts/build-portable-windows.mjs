#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const NODE_VERSION = 'v22.23.2';
const NODE_ARCHIVE = `node-${NODE_VERSION}-win-x64.zip`;
const NODE_URL = `https://nodejs.org/download/release/${NODE_VERSION}/${NODE_ARCHIVE}`;
const NODE_SHA256 = '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97';

const BETTER_SQLITE_VERSION = '13.0.3';
const BETTER_SQLITE_BINARY_SHA256 = 'e21e5efd71fba66578e95b62554d9028064a80dafd7221bf8a8ef155de8d240a';

const CAMOUFOX_VERSION = '152.0.4';
const CAMOUFOX_RELEASE = 'beta.28';
const CAMOUFOX_TAG = `v${CAMOUFOX_VERSION}-${CAMOUFOX_RELEASE}`;
const CAMOUFOX_ARCHIVE = `camoufox-${CAMOUFOX_VERSION}-${CAMOUFOX_RELEASE}-win.x86_64.zip`;
const CAMOUFOX_URL = `https://github.com/daijro/camoufox/releases/download/${CAMOUFOX_TAG}/${CAMOUFOX_ARCHIVE}`;
const CAMOUFOX_SHA256 = '386fc2f41139685f9a1a9cef0d024bc041d899c315ea538d561171b5b282e57d';
const CAMOUFOX_LICENSE_URL = `https://raw.githubusercontent.com/daijro/camoufox/${CAMOUFOX_TAG}/LICENSE`;
const CAMOUFOX_LICENSE_SHA256 = '1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5';

const APACHE_LICENSE_URL = 'https://www.apache.org/licenses/LICENSE-2.0.txt';
const APACHE_LICENSE_SHA256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';
const PLAYWRIGHT_VERSION = '1.58.1';
const PLAYWRIGHT_CODICON_LICENSE_URL = `https://raw.githubusercontent.com/microsoft/playwright/v${PLAYWRIGHT_VERSION}/packages/web/src/third_party/vscode/LICENSE.txt`;
const PLAYWRIGHT_CODICON_LICENSE_SHA256 = '20535828272932407c2f5172aeb714ac7b374a34e5ecb1825af509f2902cde54';

const OUTPUT_DIR = join(ROOT, 'build', 'portable-windows');
const CACHE_DIR = join(OUTPUT_DIR, '.cache');
const BUNDLE_NAME = `camofox-browser-${PACKAGE.version}-windows-x64`;
const BUNDLE_DIR = join(OUTPUT_DIR, BUNDLE_NAME);
const ZIP_PATH = join(OUTPUT_DIR, `${BUNDLE_NAME}.zip`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = options.capture
      ? `\nstdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`
      : '';
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}${details}`);
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

function sourceRevision() {
  const ciRevision = process.env.GITHUB_SHA?.trim();
  const localRevision = run('git', ['rev-parse', 'HEAD'], { capture: true }).trim();
  if (!/^[0-9a-f]{40}$/i.test(localRevision)) {
    throw new Error(`Unable to determine source revision for portable bundle: ${localRevision}`);
  }
  if (ciRevision && !/^[0-9a-f]{40}$/i.test(ciRevision)) {
    throw new Error(`Invalid GITHUB_SHA for portable bundle: ${ciRevision}`);
  }
  if (ciRevision && ciRevision.toLowerCase() !== localRevision.toLowerCase()) {
    throw new Error(`Portable checkout ${localRevision} does not match CI source ${ciRevision}`);
  }
  return localRevision.toLowerCase();
}

function assertWindowsX64Pe(filePath, label) {
  const bytes = readFileSync(filePath);
  if (bytes.length < 0x40 || bytes.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`${label} is not a Windows PE binary: ${filePath}`);
  }

  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 6 > bytes.length || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\u0000\u0000') {
    throw new Error(`${label} has an invalid PE header: ${filePath}`);
  }

  const machine = bytes.readUInt16LE(peOffset + 4);
  if (machine !== 0x8664) {
    throw new Error(`${label} is not Windows x64 (PE machine=0x${machine.toString(16)}): ${filePath}`);
  }
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function verifySha256(filePath, expected) {
  const actual = await sha256File(filePath);
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${filePath}: expected ${expected}, got ${actual}`);
  }
}

async function downloadPinned(url, destination, expectedSha256) {
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) {
    try {
      await verifySha256(destination, expectedSha256);
      console.log(`Using verified cache: ${destination}`);
      return;
    } catch {
      rmSync(destination, { force: true });
    }
  }

  const partial = `${destination}.part`;
  rmSync(partial, { force: true });
  console.log(`Downloading ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  renameSync(partial, destination);
  await verifySha256(destination, expectedSha256);
}

function extractZip(archivePath, destination) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  run('tar', ['-xf', archivePath, '-C', destination]);
}

function copyAppRuntime(appDir) {
  const paths = [
    'dist',
    'bin',
    'plugin.ts',
    'openclaw.plugin.json',
    'package.json',
    'package-lock.json',
    'README.md',
    'CHANGELOG.md',
    'LICENSE',
    'THIRD-PARTY-NOTICES.md',
  ];

  mkdirSync(appDir, { recursive: true });
  for (const item of paths) {
    const source = join(ROOT, item);
    if (!existsSync(source)) throw new Error(`Required application runtime path is missing: ${item}`);
    cpSync(source, join(appDir, item), {
      recursive: true,
      ...(item === 'dist'
        ? {
            filter: (candidate) => {
              const generatedPortableOutput = join(ROOT, 'dist', 'portable-windows');
              return candidate !== generatedPortableOutput
                && !candidate.startsWith(`${generatedPortableOutput}${sep}`);
            },
          }
        : {}),
    });
  }
}

function writePortableLaunchers(bundleDir) {
  const environment = [
    '@echo off',
    'setlocal',
    'set "CAMOFOX_PORTABLE_ROOT=%~dp0"',
    'set "USERPROFILE=%CAMOFOX_PORTABLE_ROOT%data\\home"',
    'set "HOME=%USERPROFILE%"',
    'set "APPDATA=%USERPROFILE%\\AppData\\Roaming"',
    'set "LOCALAPPDATA=%USERPROFILE%\\AppData\\Local"',
    'if not exist "%USERPROFILE%" mkdir "%USERPROFILE%" >nul 2>&1',
  ];

  const cli = [
    ...environment,
    '"%CAMOFOX_PORTABLE_ROOT%node\\node.exe" "%CAMOFOX_PORTABLE_ROOT%app\\bin\\camofox.js" %*',
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
  const server = [
    ...environment,
    '"%CAMOFOX_PORTABLE_ROOT%node\\node.exe" "%CAMOFOX_PORTABLE_ROOT%app\\bin\\camofox-browser.js" %*',
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');

  writeFileSync(join(bundleDir, 'camofox.cmd'), cli, 'utf8');
  writeFileSync(join(bundleDir, 'camofox-browser.cmd'), server, 'utf8');
}

function listFiles(root) {
  const files = [];
  const visit = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  };
  visit(root);
  return files;
}

async function writeManifest(bundleDir) {
  const manifestPath = join(bundleDir, 'manifest.sha256');
  const lines = [];
  for (const filePath of listFiles(bundleDir)) {
    if (filePath === manifestPath) continue;
    const digest = await sha256File(filePath);
    const portablePath = relative(bundleDir, filePath).split('\\').join('/');
    lines.push(`${digest}  ${portablePath}`);
  }
  writeFileSync(manifestPath, `${lines.join('\n')}\n`, 'utf8');
}

function createZip(bundleName, zipPath) {
  rmSync(zipPath, { force: true });
  run(
    'tar',
    ['-a', '-cf', zipPath, '--options', 'zip:compression=deflate', bundleName],
    { cwd: OUTPUT_DIR },
  );
  if (!existsSync(zipPath) || statSync(zipPath).size === 0) {
    throw new Error(`Portable ZIP was not created: ${zipPath}`);
  }
}

async function main() {
  const notices = readFileSync(join(ROOT, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  if (
    !notices.includes(NODE_VERSION.slice(1))
    || !notices.includes(`${CAMOUFOX_VERSION}-${CAMOUFOX_RELEASE}`)
    || !notices.includes(`playwright-core ${PLAYWRIGHT_VERSION}`)
  ) {
    throw new Error('THIRD-PARTY-NOTICES.md is out of sync with pinned portable runtime versions');
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });

  console.log('=== Build application ===');
  runNpm(['run', 'build']);

  const nodeArchivePath = join(CACHE_DIR, NODE_ARCHIVE);
  const camoufoxArchivePath = join(CACHE_DIR, CAMOUFOX_ARCHIVE);
  await downloadPinned(NODE_URL, nodeArchivePath, NODE_SHA256);
  await downloadPinned(CAMOUFOX_URL, camoufoxArchivePath, CAMOUFOX_SHA256);

  console.log('=== Compose portable bundle ===');
  rmSync(BUNDLE_DIR, { recursive: true, force: true });
  mkdirSync(BUNDLE_DIR, { recursive: true });

  const nodeExtractDir = join(OUTPUT_DIR, '.node-extract');
  extractZip(nodeArchivePath, nodeExtractDir);
  const nodeSourceDir = join(nodeExtractDir, `node-${NODE_VERSION}-win-x64`);
  if (!existsSync(join(nodeSourceDir, 'node.exe'))) {
    throw new Error(`Pinned Node archive did not contain node.exe at ${nodeSourceDir}`);
  }
  cpSync(nodeSourceDir, join(BUNDLE_DIR, 'node'), { recursive: true });
  rmSync(nodeExtractDir, { recursive: true, force: true });

  const appDir = join(BUNDLE_DIR, 'app');
  copyAppRuntime(appDir);
  runNpm(
    [
      'ci',
      '--omit=dev',
      '--include=optional',
      '--ignore-scripts',
      '--no-bin-links',
      '--no-audit',
      '--no-fund',
      '--os=win32',
      '--cpu=x64',
    ], {
      cwd: appDir,
      env: {
        ...process.env,
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
      },
    },
  );

  const impitNativeBinary = join(
    appDir,
    'node_modules',
    'impit-win32-x64-msvc',
    'impit-node.win32-x64-msvc.node',
  );
  if (!existsSync(impitNativeBinary)) {
    throw new Error('Portable runtime is missing required impit-win32-x64-msvc native binary');
  }
  assertWindowsX64Pe(impitNativeBinary, 'impit native module');

  const betterSqliteDir = join(appDir, 'node_modules', 'better-sqlite3');
  const betterSqlitePackage = JSON.parse(readFileSync(join(betterSqliteDir, 'package.json'), 'utf8'));
  if (betterSqlitePackage.version !== BETTER_SQLITE_VERSION) {
    throw new Error(
      `Portable runtime better-sqlite3 version ${betterSqlitePackage.version} does not match pinned prebuild ${BETTER_SQLITE_VERSION}`,
    );
  }
  const betterSqliteBinary = join(betterSqliteDir, 'prebuilds', 'win32-x64.node');
  if (!existsSync(betterSqliteBinary)) {
    throw new Error('Portable runtime is missing better-sqlite3 Windows x64 native binary');
  }
  await verifySha256(betterSqliteBinary, BETTER_SQLITE_BINARY_SHA256);
  assertWindowsX64Pe(betterSqliteBinary, 'better-sqlite3 native module');

  const licensesDir = join(BUNDLE_DIR, 'licenses');
  mkdirSync(licensesDir, { recursive: true });
  const mplLicense = join(appDir, 'node_modules', 'camoufox-js', 'LICENSE.md');
  if (!existsSync(mplLicense)) {
    throw new Error('camoufox-js MPL-2.0 license is missing from the installed runtime');
  }
  cpSync(mplLicense, join(licensesDir, 'MPL-2.0.txt'));

  const apacheLicenseCache = join(CACHE_DIR, 'Apache-2.0.txt');
  await downloadPinned(APACHE_LICENSE_URL, apacheLicenseCache, APACHE_LICENSE_SHA256);
  cpSync(apacheLicenseCache, join(licensesDir, 'Apache-2.0.txt'));

  const camoufoxLicenseCache = join(CACHE_DIR, 'Camoufox-MPL-2.0.txt');
  await downloadPinned(CAMOUFOX_LICENSE_URL, camoufoxLicenseCache, CAMOUFOX_LICENSE_SHA256);
  cpSync(camoufoxLicenseCache, join(licensesDir, 'Camoufox-MPL-2.0.txt'));

  const playwrightCodiconLicenseCache = join(CACHE_DIR, 'Playwright-VSCode-Codicon-MIT.txt');
  await downloadPinned(
    PLAYWRIGHT_CODICON_LICENSE_URL,
    playwrightCodiconLicenseCache,
    PLAYWRIGHT_CODICON_LICENSE_SHA256,
  );
  cpSync(playwrightCodiconLicenseCache, join(licensesDir, 'Playwright-VSCode-Codicon-MIT.txt'));

  const portableHome = join(BUNDLE_DIR, 'data', 'home');
  const browserDir = join(portableHome, 'AppData', 'Local', 'camoufox', 'camoufox', 'Cache');
  extractZip(camoufoxArchivePath, browserDir);
  const upstreamFontsDir = join(browserDir, 'fonts');
  if (existsSync(upstreamFontsDir)) {
    // The exact upstream tag states that bundled Windows/macOS fonts are
    // copyrighted and are not intended or permitted for redistribution.
    // A portable Windows build uses the host's installed fonts instead.
    rmSync(upstreamFontsDir, { recursive: true, force: true });
  }
  if (existsSync(upstreamFontsDir)) {
    throw new Error('Portable bundle still contains upstream fonts that are not approved for redistribution');
  }
  writeFileSync(
    join(browserDir, 'version.json'),
    `${JSON.stringify({ version: CAMOUFOX_VERSION, release: CAMOUFOX_RELEASE })}\n`,
    'utf8',
  );
  if (!existsSync(join(browserDir, 'camoufox.exe'))) {
    throw new Error(`Pinned Camoufox archive did not contain camoufox.exe at ${browserDir}`);
  }

  writePortableLaunchers(BUNDLE_DIR);
  writeFileSync(
    join(BUNDLE_DIR, 'PORTABLE-README.txt'),
    [
      `camofox-browser ${PACKAGE.version} portable Windows x64`,
      '',
      'Run CLI commands with camofox.cmd. Run the server entrypoint directly with camofox-browser.cmd.',
      'No global Node.js installation is required.',
      '',
      'Runtime state is kept below data\\home, including .camofox profiles/logs and the bundled Camoufox cache.',
      'The verified Windows contract is headless-only. Headed and virtual/Xvfb/VNC modes are unsupported.',
      'The upstream Camoufox fonts directory is intentionally excluded; the portable Windows build uses host-installed Windows fonts.',
      '',
      'Third-party licensing information is available in app\\THIRD-PARTY-NOTICES.md, licenses\\, and bundled component license files.',
      '',
    ].join('\r\n'),
    'utf8',
  );
  writeFileSync(join(BUNDLE_DIR, 'SOURCE-REVISION.txt'), `${sourceRevision()}\n`, 'utf8');

  await writeManifest(BUNDLE_DIR);

  console.log('=== Create portable ZIP ===');
  createZip(BUNDLE_NAME, ZIP_PATH);
  const zipSha256 = await sha256File(ZIP_PATH);
  console.log(`Portable bundle: ${BUNDLE_DIR}`);
  console.log(`Portable ZIP: ${ZIP_PATH}`);
  console.log(`Portable ZIP SHA-256: ${zipSha256}`);
  console.log(`PORTABLE_ARTIFACT=${ZIP_PATH}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
