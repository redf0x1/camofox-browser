#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFileSync } = require('node:child_process');

// Extraction tools need platform paths and locale only, never npm/GitHub credentials.
function extractionEnv() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'LANG', 'LC_ALL', 'LC_CTYPE']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

// Use disk-backed platform tools, never AdmZip's whole-archive buffers.
// Python is already a Docker dependency; macOS ships bsdtar and Windows ships PowerShell/.NET ZIP support.
function extractZip(archive, destination, platform = process.platform) {
  const options = { stdio: 'inherit', env: extractionEnv() };
  if (platform === 'linux') {
    execFileSync('python3', ['-m', 'zipfile', '-e', archive, destination], options);
    // zipfile does not restore Unix executable bits. Match upstream's permissions.
    execFileSync('chmod', ['-R', '755', destination], options);
  } else if (platform === 'darwin') {
    execFileSync('tar', ['-xf', archive, '-C', destination], options);
  } else if (platform === 'win32') {
    // Native tar rejects some filenames in newer upstream Windows archives.
    // Keep paths out of the PowerShell program so quotes/metacharacters remain data.
    execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
        '[System.IO.Compression.ZipFile]::ExtractToDirectory($env:CAMOFOX_ARCHIVE_PATH, $env:CAMOFOX_EXTRACT_DIR)',
    ], { ...options, env: { ...options.env, CAMOFOX_ARCHIVE_PATH: archive, CAMOFOX_EXTRACT_DIR: destination } });
  } else {
    throw new Error(`Unsupported browser installation platform: ${platform}`);
  }
}

function executablePath(directory, platform = process.platform) {
  return path.join(directory, platform === 'darwin'
    ? 'Camoufox.app/Contents/MacOS/camoufox'
    : platform === 'win32' ? 'camoufox.exe' : 'camoufox-bin');
}

function verifyExecutable(directory, platform = process.platform) {
  const executable = executablePath(directory, platform);
  const stat = fs.statSync(executable);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Missing or empty browser executable: ${executable}`);
  fs.accessSync(executable, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
}

async function download(url, destination) {
  const host = new URL(url).hostname;
  const headers = process.env.GITHUB_TOKEN && ['github.com', 'api.github.com'].includes(host)
    ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  const response = await fetch(url, { headers });
  if (!response.ok || !response.body) throw new Error(`Browser download failed: HTTP ${response.status}`);
  // pipeline handles backpressure, truncated responses and disk write failures.
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination, { flags: 'wx' }));
}

async function installBrowser({ pkgman, fetcher, installDir, downloadFile = download, extract = extractZip } = {}) {
  pkgman ??= await import('camoufox-js/dist/pkgman.js');
  installDir ??= pkgman.INSTALL_DIR;
  if (fs.existsSync(installDir)) {
    try {
      pkgman.camoufoxPath(false); // Also rejects unsupported/corrupt version metadata.
      verifyExecutable(installDir);
      console.log(`Using installed Camoufox ${pkgman.installedVerStr()} at ${installDir}`);
      return;
    } catch (error) {
      throw new Error(`Existing Camoufox cache at ${installDir} is incomplete or unsupported. ` +
        'It has been preserved. Set CAMOUFOX_INSTALL_DIR to a new empty path and rerun npm run browser:install. ' +
        `Do not delete browser profiles. Cause: ${error.message}`);
    }
  }
  fetcher ??= new pkgman.CamoufoxFetcher();
  await fetcher.init(); // Keep upstream platform, architecture and supported-release selection.
  fs.mkdirSync(path.dirname(installDir), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(installDir), '.camoufox-install-'));
  const unpacked = path.join(staging, 'browser');
  try {
    fs.mkdirSync(unpacked);
    const archive = path.join(staging, 'browser.zip');
    console.log(`Downloading Camoufox ${fetcher.version}-${fetcher.release}`);
    await downloadFile(fetcher.url, archive);
    await extract(archive, unpacked);
    verifyExecutable(unpacked);
    fs.writeFileSync(path.join(unpacked, 'version.json'), JSON.stringify({
      version: fetcher.version, release: fetcher.release,
    }));
    // Never replace a cache created by another installer while we were downloading.
    if (fs.existsSync(installDir)) throw new Error(`Camoufox cache appeared during installation: ${installDir}`);
    fs.renameSync(unpacked, installDir);
    console.log(`Camoufox successfully installed at ${installDir}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function installGeoLite(pkgman, downloadFile = download) {
  const destination = path.join(pkgman.INSTALL_DIR, 'GeoLite2-City.mmdb');
  if (fs.existsSync(destination)) return; // Never truncate an existing database.
  const staging = fs.mkdtempSync(path.join(pkgman.INSTALL_DIR, '.geolite-install-'));
  try {
    class GeoLiteDownloader extends pkgman.GitHubDownloader {
      checkAsset(asset) {
        return asset.name.endsWith('-City.mmdb') ? asset.browser_download_url : null;
      }
    }
    const url = await new GeoLiteDownloader('P3TERX/GeoLite.mmdb').getAsset();
    const temporary = path.join(staging, 'GeoLite2-City.mmdb');
    await downloadFile(url, temporary);
    if (fs.statSync(temporary).size === 0) throw new Error('Empty GeoLite database');
    fs.copyFileSync(temporary, destination, fs.constants.COPYFILE_EXCL);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function main({ install = installBrowser, geo = installGeoLite, loadPkgman = () => import('camoufox-js/dist/pkgman.js') } = {}) {
  if (/^(1|true|yes|on)$/i.test(process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD || '')) {
    console.log('Skipping browser installation (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD). Provision Camoufox before launching.');
    return;
  }
  const pkgman = await loadPkgman();
  await install({ pkgman }); // Required: failures must reach npm/Docker.
  try {
    await geo(pkgman);
  } catch (error) {
    console.warn(`Optional GeoLite download failed; browser installation is complete: ${error.message}`);
  }
}

module.exports = { extractZip, verifyExecutable, download, installBrowser, installGeoLite, main };
if (require.main === module) {
  main().catch((error) => {
    console.error(`Camoufox installation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
