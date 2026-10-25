const fs = require('node:fs');
const path = require('node:path');

describe('Windows portable build process invocation', () => {
  test('runs npm through its JavaScript CLI instead of spawning npm.cmd directly', () => {
    const script = fs.readFileSync(
      path.join(__dirname, '../../scripts/build-portable-windows.mjs'),
      'utf8',
    );

    expect(script).toContain('process.env.npm_execpath');
    expect(script).not.toContain("process.platform === 'win32' ? 'npm.cmd' : 'npm'");
  });

  test('runs package verification npm commands through the same Windows-safe invocation', () => {
    const verifier = fs.readFileSync(
      path.join(__dirname, '../../scripts/verify-package.mjs'),
      'utf8',
    );

    expect(verifier).toContain('process.env.npm_execpath');
    expect(verifier).not.toContain("process.platform === 'win32' ? 'npm.cmd' : 'npm'");
  });

  test('passes the cmd launcher command line verbatim for paths containing spaces', () => {
    const verifier = fs.readFileSync(
      path.join(__dirname, '../../scripts/verify-portable-windows.mjs'),
      'utf8',
    );

    expect(verifier).toContain('windowsVerbatimArguments: true');
  });

  test('binds the portable artifact to its source revision and verifies its manifest', () => {
    const builder = fs.readFileSync(
      path.join(__dirname, '../../scripts/build-portable-windows.mjs'),
      'utf8',
    );
    const verifier = fs.readFileSync(
      path.join(__dirname, '../../scripts/verify-portable-windows.mjs'),
      'utf8',
    );

    expect(builder).toContain('SOURCE-REVISION.txt');
    expect(builder).toContain('process.env.GITHUB_SHA');
    expect(verifier).toContain('SOURCE-REVISION.txt');
    expect(verifier).toContain('manifest.sha256');
    expect(verifier).toContain('Portable manifest hash mismatch');
  });

  test('bundles the exact upstream Codicon MIT notice redistributed with playwright-core', () => {
    const builder = fs.readFileSync(
      path.join(__dirname, '../../scripts/build-portable-windows.mjs'),
      'utf8',
    );

    expect(builder).toContain('Playwright-VSCode-Codicon-MIT.txt');
    expect(builder).toContain('20535828272932407c2f5172aeb714ac7b374a34e5ecb1825af509f2902cde54');
  });

  test('verifies the Windows x64 prebuild shipped by the locked better-sqlite3 release', () => {
    const builder = fs.readFileSync(
      path.join(__dirname, '../../scripts/build-portable-windows.mjs'),
      'utf8',
    );

    const verifier = fs.readFileSync(
      path.join(__dirname, '../../scripts/verify-portable-windows.mjs'),
      'utf8',
    );
    const lock = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../package-lock.json'), 'utf8'),
    );

    expect(builder).toContain(
      `const BETTER_SQLITE_VERSION = '${lock.packages['node_modules/better-sqlite3'].version}';`,
    );
    expect(builder).toContain("join(betterSqliteDir, 'prebuilds', 'win32-x64.node')");
    expect(verifier).toMatch(/'prebuilds',\s*'win32-x64\.node'/);
    expect(builder).not.toContain('BETTER_SQLITE_URL');
    expect(builder).toContain(
      'await verifySha256(betterSqliteBinary, BETTER_SQLITE_BINARY_SHA256);',
    );
    expect(builder).toContain("assertWindowsX64Pe(betterSqliteBinary, 'better-sqlite3 native module');");
    expect(builder).not.toContain('const prebuildInstall =');
  });

  test('pins the hash of the published better-sqlite3 Windows binary', () => {
    const { createHash } = require('node:crypto');
    const builder = fs.readFileSync(
      path.join(__dirname, '../../scripts/build-portable-windows.mjs'),
      'utf8',
    );
    const binary = fs.readFileSync(
      path.join(__dirname, '../../node_modules/better-sqlite3/prebuilds/win32-x64.node'),
    );
    const hash = createHash('sha256').update(binary).digest('hex');

    expect(builder).toContain(`const BETTER_SQLITE_BINARY_SHA256 = '${hash}';`);
  });
});
