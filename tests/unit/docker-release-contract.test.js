const fs = require('node:fs');
const path = require('node:path');

describe('Docker release contract', () => {
  test('Dockerfile installs the required engine once without masking failures', () => {
    const dockerfile = fs.readFileSync(
      path.join(__dirname, '../../Dockerfile'),
      'utf8',
    );

    expect(dockerfile).toContain('COPY --chown=node:node bin/install-browser.js ./bin/install-browser.js');
    expect(dockerfile).toContain('RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev');
    expect(dockerfile).toContain('RUN npm run browser:install');
    expect(dockerfile).not.toMatch(/camoufox.*\|\| true/);
  });
});
