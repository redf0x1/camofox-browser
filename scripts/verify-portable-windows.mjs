#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import { join, relative, resolve, sep } from 'node:path';

const bundleRoot = resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
  throw new Error('Usage: node scripts/verify-portable-windows.mjs <extracted-bundle-root>');
}
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error(`Portable runtime verification requires Windows x64 (got ${process.platform}/${process.arch})`);
}

const bundledNode = join(bundleRoot, 'node', 'node.exe');
const cliPath = join(bundleRoot, 'camofox.cmd');
const packageJson = JSON.parse(readFileSync(join(bundleRoot, 'app', 'package.json'), 'utf8'));
const impitNativeBinary = join(
  bundleRoot,
  'app',
  'node_modules',
  'impit-win32-x64-msvc',
  'impit-node.win32-x64-msvc.node',
);
const betterSqliteNativeBinary = join(
  bundleRoot,
  'app',
  'node_modules',
  'better-sqlite3',
  'prebuilds',
  'win32-x64.node',
);
const mplLicense = join(bundleRoot, 'licenses', 'MPL-2.0.txt');
const apacheLicense = join(bundleRoot, 'licenses', 'Apache-2.0.txt');
const camoufoxLicense = join(bundleRoot, 'licenses', 'Camoufox-MPL-2.0.txt');
const playwrightCodiconLicense = join(bundleRoot, 'licenses', 'Playwright-VSCode-Codicon-MIT.txt');
const sourceRevisionPath = join(bundleRoot, 'SOURCE-REVISION.txt');
const manifestPath = join(bundleRoot, 'manifest.sha256');
const portableHome = join(bundleRoot, 'data', 'home');
const bundledCamoufoxDir = join(portableHome, 'AppData', 'Local', 'camoufox', 'camoufox', 'Cache');
const bundledFontsDir = join(bundledCamoufoxDir, 'fonts');

if (!existsSync(bundledNode) || !existsSync(cliPath)) {
  throw new Error('Portable bundle is missing the bundled Node runtime or camofox.cmd launcher');
}
if (!existsSync(impitNativeBinary)) {
  throw new Error('Portable bundle is missing impit-win32-x64-msvc native runtime support');
}
if (!existsSync(betterSqliteNativeBinary)) {
  throw new Error('Portable bundle is missing better-sqlite3 Windows x64 native runtime support');
}
if (!existsSync(mplLicense) || !existsSync(apacheLicense) || !existsSync(camoufoxLicense) || !existsSync(playwrightCodiconLicense)) {
  throw new Error('Portable bundle is missing required third-party license texts');
}
if (existsSync(bundledFontsDir)) {
  throw new Error('Portable bundle must not redistribute the upstream Camoufox fonts directory');
}
if (realpathSync.native(process.execPath).toLowerCase() !== realpathSync.native(bundledNode).toLowerCase()) {
  throw new Error(`Verification is not running on bundled Node: ${process.execPath}`);
}

function portableEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const normalized = key.toLowerCase();
    if (normalized === 'path') delete env[key];
    if (normalized === 'camofox_api_key') delete env[key];
    if (normalized === 'camofox_admin_key') delete env[key];
    if (normalized === 'camofox_auth_mode') delete env[key];
  }
  env.Path = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
  env.CAMOFOX_AUTH_MODE = 'disabled';
  env.CAMOFOX_HEADLESS = 'true';
  env.CAMOFOX_HOST = '127.0.0.1';
  env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';
  return { ...env, ...extra };
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function listRelativeFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) files.push(relative(root, fullPath).split('\\').join('/'));
    }
  };
  visit(root);
  return files;
}

function verifySourceRevisionAndManifest() {
  if (!existsSync(sourceRevisionPath) || !existsSync(manifestPath)) {
    throw new Error('Portable bundle is missing source revision or SHA-256 manifest metadata');
  }

  const sourceRevision = readFileSync(sourceRevisionPath, 'utf8').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sourceRevision)) {
    throw new Error(`Portable source revision is invalid: ${sourceRevision}`);
  }
  const expectedRevision = process.env.GITHUB_SHA?.trim().toLowerCase();
  if (expectedRevision && sourceRevision !== expectedRevision) {
    throw new Error(`Portable source revision ${sourceRevision} does not match CI source ${expectedRevision}`);
  }

  const manifestEntries = new Map();
  for (const line of readFileSync(manifestPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`Invalid portable manifest line: ${line}`);
    const [, expectedHash, portablePath] = match;
    if (manifestEntries.has(portablePath)) throw new Error(`Duplicate portable manifest path: ${portablePath}`);
    const fullPath = resolve(bundleRoot, portablePath.split('/').join(sep));
    const relativePath = relative(bundleRoot, fullPath);
    if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === '..' || resolve(fullPath) !== fullPath) {
      throw new Error(`Portable manifest path escapes bundle root: ${portablePath}`);
    }
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      throw new Error(`Portable manifest references a missing file: ${portablePath}`);
    }
    const actualHash = sha256Buffer(readFileSync(fullPath));
    if (actualHash !== expectedHash) {
      throw new Error(`Portable manifest hash mismatch for ${portablePath}: expected ${expectedHash}, got ${actualHash}`);
    }
    manifestEntries.set(portablePath, expectedHash);
  }

  const actualFiles = listRelativeFiles(bundleRoot).filter((portablePath) => portablePath !== 'manifest.sha256');
  const missingFromManifest = actualFiles.filter((portablePath) => !manifestEntries.has(portablePath));
  if (missingFromManifest.length > 0 || manifestEntries.size !== actualFiles.length) {
    throw new Error(`Portable manifest does not exactly cover extracted files: ${missingFromManifest.slice(0, 5).join(', ')}`);
  }

  return sourceRevision;
}

function windowsDefaultProfileDirectoryName(userId) {
  const encodedUserId = Buffer.from(String(userId), 'utf16le').toString('base64url');
  const profileKey = `u:${encodedUserId}`;
  return `profile-${createHash('sha256').update(profileKey, 'utf8').digest('hex')}`;
}

function snapshotTree(root) {
  if (!existsSync(root)) return [];
  const entries = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = join(directory, entry.name);
      const relativePath = fullPath.slice(root.length + 1).split('\\').join('/');
      if (entry.isDirectory()) {
        entries.push(`d:${relativePath}`);
        visit(fullPath);
      } else if (entry.isFile()) {
        const stat = statSync(fullPath);
        entries.push(`f:${relativePath}:${stat.size}:${sha256Buffer(readFileSync(fullPath))}`);
      }
    }
  };
  visit(root);
  return entries;
}

function runCli(args, env, { allowFailure = false } = {}) {
  const commandShell = process.env.ComSpec
    ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const commandLine = `call ${quote(cliPath)} ${args.map(quote).join(' ')}`;
  const result = spawnSync(commandShell, ['/d', '/s', '/c', commandLine], {
    cwd: bundleRoot,
    env,
    encoding: 'utf8',
    timeout: 90_000,
    windowsVerbatimArguments: true,
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(
      `camofox.cmd ${args.join(' ')} failed: ${result.error?.message ?? `exit ${result.status}`}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
  return result;
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (!port) throw new Error('Unable to allocate a local verification port');
  return port;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(90_000),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${url} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function waitUntilStopped(url) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(750) });
    } catch {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error('Server remained reachable after stop command');
}

const localPagePort = await getFreePort();
const serverPort = await getFreePort();
const verifiedSourceRevision = verifySourceRevisionAndManifest();
const localPageServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head><title>Welcome</title></head><body><main><h1>Welcome</h1><p>Ready.</p></main></body></html>');
});
await new Promise((resolvePromise, reject) => {
  localPageServer.once('error', reject);
  localPageServer.listen(localPagePort, '127.0.0.1', resolvePromise);
});

const env = portableEnvironment({ PORT: String(serverPort) });
const baseUrl = `http://127.0.0.1:${serverPort}`;
let daemonStarted = false;
const externalHome = process.env.USERPROFILE ? resolve(process.env.USERPROFILE) : '';
if (!externalHome) throw new Error('Windows USERPROFILE is required for portable-state escape verification');
if (externalHome.toLowerCase() === portableHome.toLowerCase()) {
  throw new Error('Portable-state verification requires an external runner profile distinct from the bundle data directory');
}
const externalStateRoots = [
  join(externalHome, '.camofox'),
  join(externalHome, 'AppData', 'Local', 'camoufox'),
];
const externalStateBefore = externalStateRoots.map((root) => snapshotTree(root));

try {
  const requireFromApp = createRequire(join(bundleRoot, 'app', 'package.json'));
  const Database = requireFromApp('better-sqlite3');
  const database = new Database(':memory:');
  database.close();
  requireFromApp('impit');

  const versionResult = runCli(['--version'], env);
  if (versionResult.stdout.trim() !== packageJson.version) {
    throw new Error(`Portable CLI version mismatch: expected ${packageJson.version}, got ${versionResult.stdout.trim()}`);
  }

  runCli(['server', 'start', '--background'], env);
  daemonStarted = true;

  const health = await fetchJson(`${baseUrl}/health`);
  if (health.ok !== true || health.running !== true) {
    throw new Error(`Unexpected health payload: ${JSON.stringify(health)}`);
  }

  const userId = 'visitor';
  const sessionKey = 'main';
  const created = await fetchJson(`${baseUrl}/tabs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, sessionKey }),
  });
  if (typeof created.tabId !== 'string' || !created.tabId) {
    throw new Error(`Tab creation did not return a tabId: ${JSON.stringify(created)}`);
  }

  const localUrl = `http://127.0.0.1:${localPagePort}/`;
  const navigated = await fetchJson(`${baseUrl}/tabs/${encodeURIComponent(created.tabId)}/navigate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, url: localUrl }),
  });
  if (navigated.ok !== true || !String(navigated.url).startsWith(localUrl)) {
    throw new Error(`Navigation did not reach the local page: ${JSON.stringify(navigated)}`);
  }

  const snapshot = await fetchJson(
    `${baseUrl}/tabs/${encodeURIComponent(created.tabId)}/snapshot?userId=${encodeURIComponent(userId)}`,
  );
  if (typeof snapshot.snapshot !== 'string' || snapshot.snapshot.length === 0) {
    throw new Error(`Snapshot payload was empty: ${JSON.stringify(snapshot)}`);
  }

  const closed = await fetchJson(`${baseUrl}/tabs/${encodeURIComponent(created.tabId)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (closed.ok !== true) throw new Error(`Tab close failed: ${JSON.stringify(closed)}`);

  runCli(['server', 'stop'], env);
  daemonStarted = false;
  await waitUntilStopped(`${baseUrl}/health`);

  const portableStateDir = join(portableHome, '.camofox');
  const portableProfileDir = join(
    portableStateDir,
    'profiles',
    windowsDefaultProfileDirectoryName(userId),
  );
  const portableServerLog = join(portableStateDir, 'logs', 'server.log');
  const camoufoxExe = join(
    portableHome,
    'AppData',
    'Local',
    'camoufox',
    'camoufox',
    'Cache',
    'camoufox.exe',
  );
  if (!existsSync(portableStateDir) || !existsSync(portableProfileDir) || !existsSync(portableServerLog) || !existsSync(camoufoxExe)) {
    throw new Error('Portable state or bundled Camoufox engine escaped the expected data directory');
  }
  const externalStateAfter = externalStateRoots.map((root) => snapshotTree(root));
  if (JSON.stringify(externalStateAfter) !== JSON.stringify(externalStateBefore)) {
    throw new Error('Portable smoke modified Camoufox state outside the bundle data directory');
  }

  console.log(`PASS bundled Node: ${process.execPath}`);
  console.log('PASS Windows x64 native dependencies load with bundled Node');
  console.log('PASS third-party license bundle');
  console.log(`PASS source revision and manifest: ${verifiedSourceRevision}`);
  console.log(`PASS CLI version: ${packageJson.version}`);
  console.log(`PASS health: ${baseUrl}/health`);
  console.log('PASS local browser flow: create -> navigate -> snapshot -> close');
  console.log('PASS server stop, portable profile/log placement, and no external state mutation');
} finally {
  if (daemonStarted) runCli(['server', 'stop'], env, { allowFailure: true });
  await new Promise((resolvePromise) => localPageServer.close(resolvePromise));
}
