const { startServer, stopServer, getServerUrl } = require('../helpers/startServer');
const { startTestSite, stopTestSite, getTestSiteUrl } = require('../helpers/testSite');
const { createClient } = require('../helpers/client');

describe('Macro Navigation', () => {
  let serverUrl;
  let testSiteUrl;
  
  beforeAll(async () => {
    const port = await startServer();
    serverUrl = getServerUrl();
    
    const testPort = await startTestSite();
    testSiteUrl = getTestSiteUrl();
  }, 120000);
  
  afterAll(async () => {
    await stopTestSite();
    await stopServer();
  }, 30000);
  
  test('unknown macro returns error when no fallback URL', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab();
      
      await expect(client.navigate(tabId, '@nonexistent_macro test query'))
        .rejects.toThrow(/url or macro required/);
    } finally {
      await client.cleanup();
    }
  });
  
  test('client parses @macro syntax correctly', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab();
      
      // Navigate to a real URL first so we have a valid tab
      await client.navigate(tabId, `${testSiteUrl}/pageA`);
      
      // Now try an unknown macro - if client parsing works, 
      // server will receive {macro: "@unknown", query: "with spaces"}
      // and return "url or macro required" error
      await expect(client.navigate(tabId, '@unknown with spaces'))
        .rejects.toThrow(/url or macro required/);
    } finally {
      await client.cleanup();
    }
  });
  
  test('regular URL still works after macro changes', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab();
      
      // Regular URL should still work
      const result = await client.navigate(tabId, `${testSiteUrl}/pageA`);
      
      expect(result.ok).toBe(true);
      expect(result.url).toContain('/pageA');
      
      const snapshot = await client.getSnapshot(tabId);
      expect(snapshot.snapshot).toContain('Page A');
    } finally {
      await client.cleanup();
    }
  });
  
  test('navigate API accepts macro and query params directly', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab();
      
      // Test the raw API with macro param directly (bypass client parsing)
      // Unknown macro should fail
      await expect(
        client.request('POST', `/tabs/${tabId}/navigate`, {
          userId: client.userId,
          macro: '@fake_macro',
          query: 'test'
        })
      ).rejects.toThrow(/url or macro required/);
    } finally {
      await client.cleanup();
    }
  });

  test('macro expansion produces correct URL structure (local deterministic)', () => {
    const { expandMacro, getSupportedMacros } = require('../../dist/src/utils/macros');

    const macros = getSupportedMacros();
    expect(macros.length).toBe(14);

    for (const macro of macros) {
      const url = expandMacro(macro, 'test_value');
      expect(url).toBeTruthy();
      expect(url).toMatch(/^https:\/\//);
    }

    expect(expandMacro('@google_search', 'hello world'))
      .toBe('https://www.google.com/search?q=hello%20world');
    expect(expandMacro('@wikipedia_search', 'Jest'))
      .toBe('https://en.wikipedia.org/wiki/Special:Search?search=Jest');
    expect(expandMacro('@reddit_subreddit', 'programming'))
      .toBe('https://www.reddit.com/r/programming.json?limit=25');

    expect(expandMacro('@nonexistent', 'test')).toBeNull();
  });

  test('CLI Commander navigate exercises real command path', async () => {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);

      const port = new URL(serverUrl).port;

      await execAsync(
        `node bin/camofox.js navigate "${testSiteUrl}/pageB" ${tabId} --user ${client.userId} --port ${port}`,
        { encoding: 'utf8', timeout: 30000 }
      );

      const snapshot = await client.getSnapshot(tabId);
      expect(snapshot.snapshot).toContain('Page B');

      try {
        await execAsync(
          `node bin/camofox.js navigate "@fake_macro test" ${tabId} --user ${client.userId} --port ${port} --format json`,
          { encoding: 'utf8', timeout: 30000 }
        );
        throw new Error('Expected unknown macro to fail');
      } catch (err) {
        const output = (err.stderr || '') + (err.stdout || '');
        expect(output).toMatch(/url or macro required/i);
      }
    } finally {
      await client.cleanup();
    }
  });

   test('openclaw navigate supports macro + query (supplementary networked proof)', async () => {
     const client = createClient(serverUrl);

     try {
       const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);

       const result = await client.request('POST', '/navigate', {
         targetId: tabId,
         userId: client.userId,
         macro: '@google_search',
         query: 'test query',
       });

       expect(result.ok).toBe(true);
       expect(result.url).toContain('google.com');
       expect(result.url).toMatch(/[?&]q=/);
     } finally {
       await client.cleanup();
     }
   });

   test('openclaw navigate returns 400 when neither url nor macro provided', async () => {
     const client = createClient(serverUrl);

     try {
       const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);

       await expect(
         client.request('POST', '/navigate', {
           targetId: tabId,
           userId: client.userId,
         })
       ).rejects.toThrow(/url or macro required/);
     } finally {
       await client.cleanup();
     }
   });

   test('openclaw navigate with unknown macro and no fallback url returns error', async () => {
     const client = createClient(serverUrl);

     try {
       const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);

       await expect(
         client.request('POST', '/navigate', {
           targetId: tabId,
           userId: client.userId,
           macro: '@nonexistent_macro',
         })
       ).rejects.toThrow(/url or macro required/);
     } finally {
       await client.cleanup();
     }
   });

   test('openclaw navigate with unknown macro falls back to url', async () => {
     const client = createClient(serverUrl);

     try {
       const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);

       const result = await client.request('POST', '/navigate', {
         targetId: tabId,
         userId: client.userId,
         macro: '@nonexistent_macro',
         url: `${testSiteUrl}/pageB`,
       });

       expect(result.ok).toBe(true);
       expect(result.url).toContain('/pageB');
     } finally {
       await client.cleanup();
     }
   });

   test('openclaw /tabs/open returns 409 without canonical profile', async () => {
     const freshUserId = `no-profile-${Date.now()}`;
     const headers = { 'Content-Type': 'application/json' };
     if (process.env.CAMOFOX_API_KEY) {
       headers.Authorization = `Bearer ${process.env.CAMOFOX_API_KEY}`;
     }

     try {
       const res = await fetch(`${serverUrl}/tabs/open`, {
         method: 'POST',
         headers,
         body: JSON.stringify({
           userId: freshUserId,
           url: `${testSiteUrl}/pageA`,
           listItemId: 'test',
         }),
       });

       expect(res.status).toBe(409);
       const body = await res.json();
       expect(body.error).toContain('No canonical profile');
     } finally {
       try {
         await fetch(`${serverUrl}/sessions/${encodeURIComponent(freshUserId)}`, {
           method: 'DELETE',
           headers: process.env.CAMOFOX_API_KEY ? { Authorization: `Bearer ${process.env.CAMOFOX_API_KEY}` } : undefined,
         });
       } catch {}
     }
   });

   test('openclaw /tabs/open reuse path inherits canonical overrides (context proof)', async () => {
     const userId = `reuse-ctx-${Date.now()}`;
     const headers = { 'Content-Type': 'application/json' };
     if (process.env.CAMOFOX_API_KEY) {
       headers.Authorization = `Bearer ${process.env.CAMOFOX_API_KEY}`;
     }

     try {
       // Step 1: Create canonical tab via core POST /tabs
       const coreRes = await fetch(`${serverUrl}/tabs`, {
         method: 'POST',
         headers,
         body: JSON.stringify({
           userId,
           sessionKey: 'canonical-ctx-test',
           url: `${testSiteUrl}/pageA`,
         }),
       });
       expect(coreRes.status).toBe(200);
       const coreData = await coreRes.json();
       const tabId1 = coreData.tabId;
       expect(tabId1).toBeTruthy();

       // Step 2: Set a unique marker cookie on tab 1 via evaluate
       await fetch(`${serverUrl}/tabs/${tabId1}/evaluate`, {
         method: 'POST',
         headers,
         body: JSON.stringify({
           userId,
           expression: 'document.cookie = "canonical_ctx_proof=shared_session_marker"',
         }),
       });

       // Step 3: Open second tab via /tabs/open (reuse path)
       const openRes = await fetch(`${serverUrl}/tabs/open`, {
         method: 'POST',
         headers,
         body: JSON.stringify({
           userId,
           url: `${testSiteUrl}/pageB`,
           listItemId: 'reuse-ctx-test',
         }),
       });
       expect(openRes.status).toBe(200);
       const openData = await openRes.json();
       const tabId2 = openData.tabId;
       expect(tabId2).toBeTruthy();

       // Step 4: Read cookie on tab 2 -> proves same browser context
       const cookieRes = await fetch(`${serverUrl}/tabs/${tabId2}/evaluate`, {
         method: 'POST',
         headers,
         body: JSON.stringify({
           userId,
           expression: 'document.cookie',
         }),
       });
       const cookieData = await cookieRes.json();
       expect(cookieData.ok).toBe(true);
       expect(cookieData.result).toContain('canonical_ctx_proof=shared_session_marker');

       // Step 5: Also verify both tabs exist
       const tabsRes = await fetch(`${serverUrl}/tabs?userId=${encodeURIComponent(userId)}`, {
         headers: process.env.CAMOFOX_API_KEY ? { Authorization: `Bearer ${process.env.CAMOFOX_API_KEY}` } : {},
       });
       const tabsData = await tabsRes.json();
       expect(tabsData.tabs.length).toBe(2);
     } finally {
       try {
         await fetch(`${serverUrl}/sessions/${encodeURIComponent(userId)}`, {
           method: 'DELETE',
           headers: process.env.CAMOFOX_API_KEY ? { Authorization: `Bearer ${process.env.CAMOFOX_API_KEY}` } : undefined,
         });
       } catch {}
     }
   });
});
