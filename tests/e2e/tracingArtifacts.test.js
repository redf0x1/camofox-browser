const path = require('node:path');

const { startServer, stopServer, getServerUrl } = require('../helpers/startServer');
const { startTestSite, stopTestSite, getTestSiteUrl } = require('../helpers/testSite');
const { createClient } = require('../helpers/client');

function buildAuthHeaders() {
  if (!process.env.CAMOFOX_API_KEY) return {};
  return { Authorization: `Bearer ${process.env.CAMOFOX_API_KEY}` };
}

describe('Tracing artifacts', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(async () => {
    await startServer(9380);
    serverUrl = getServerUrl();

    await startTestSite();
    testSiteUrl = getTestSiteUrl();
  }, 120000);

  afterAll(async () => {
    await stopTestSite();
    await stopServer();
  }, 30000);

  test('stopped traces can be listed, downloaded, and deleted by the owning user', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);

      await client.request('POST', `/tabs/${tabId}/trace/start`, { userId: client.userId });
      await client.navigate(tabId, `${testSiteUrl}/pageB`);

      const stopped = await client.request('POST', `/tabs/${tabId}/trace/stop`, { userId: client.userId });
      expect(stopped.ok).toBe(true);
      expect(stopped.filename).toBe(path.basename(stopped.path));
      const filename = stopped.filename;

      expect(filename).toMatch(/\.zip$/);

      const listed = await client.listTraces();
      expect(listed.ok).toBe(true);
      expect(listed.traces[0]).not.toHaveProperty('path');
      expect(listed.traces).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filename,
          }),
        ]),
      );

      const downloadResponse = await fetch(
        `${serverUrl}/sessions/${client.userId}/traces/${encodeURIComponent(filename)}`,
        { headers: buildAuthHeaders() },
      );

      expect(downloadResponse.ok).toBe(true);
      expect(downloadResponse.headers.get('content-type')).toBe('application/zip');
      expect(downloadResponse.headers.get('content-disposition')).toContain(filename);

      const artifact = await downloadResponse.arrayBuffer();
      expect(artifact.byteLength).toBeGreaterThan(0);

      const deleted = await client.deleteTrace(filename);
      expect(deleted).toEqual({ ok: true });

      const afterDelete = await client.listTraces();
      expect(afterDelete.traces.map((trace) => trace.filename)).not.toContain(filename);
    } finally {
      await client.cleanup();
    }
  }, 120000);
});
