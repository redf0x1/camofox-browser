const { startServer, stopServer, getServerUrl } = require('../helpers/startServer');
const { createClient } = require('../helpers/client');

// Live macro tests are opt-in due to external site dependencies
const SKIP_LIVE_TESTS = !process.env.RUN_LIVE_TESTS;

describe('Live Macro URL Expansion', () => {
  let serverUrl;
  
  beforeAll(async () => {
    if (SKIP_LIVE_TESTS) return;
    
    const port = await startServer();
    serverUrl = getServerUrl();
  }, 120000);
  
  afterAll(async () => {
    if (SKIP_LIVE_TESTS) return;
    await stopServer();
  }, 30000);
  
  (SKIP_LIVE_TESTS ? test.skip : test)('@google_search expands to correct URL', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab();
      
      const result = await client.navigate(tabId, '@google_search test query');
      
      expect(result.ok).toBe(true);
      expect(result.url).toContain('google.com/search');
      expect(result.url).toContain('q=test');
    } finally {
      await client.cleanup();
    }
  }, 60000);
  
  (SKIP_LIVE_TESTS ? test.skip : test)('@youtube_search expands to correct URL', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab();
      
      const result = await client.navigate(tabId, '@youtube_search funny cats');
      
      expect(result.ok).toBe(true);
      expect(result.url).toContain('youtube.com/results');
      expect(result.url).toContain('search_query=funny');
    } finally {
      await client.cleanup();
    }
  }, 60000);
  
  (SKIP_LIVE_TESTS ? test.skip : test)('@amazon_search expands to correct URL', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab();
      
      const result = await client.navigate(tabId, '@amazon_search laptop stand');
      
      expect(result.ok).toBe(true);
      expect(result.url).toContain('amazon.com/s');
      expect(result.url).toMatch(/k=laptop[\+%20]stand/);
    } finally {
      await client.cleanup();
    }
  }, 60000);
  
  (SKIP_LIVE_TESTS ? test.skip : test)('@wikipedia_search expands to correct URL', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab();
      
      const result = await client.navigate(tabId, '@wikipedia_search JavaScript');
      
      expect(result.ok).toBe(true);
      expect(result.url).toContain('wikipedia.org');
      // Wikipedia may redirect to article or stay on search
      expect(result.url).toMatch(/JavaScript|search/i);
    } finally {
      await client.cleanup();
    }
  }, 60000);
  
  (SKIP_LIVE_TESTS ? test.skip : test)('@reddit_search expands to correct URL', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab();
      
      const result = await client.navigate(tabId, '@reddit_search programming');
      
      expect(result.ok).toBe(true);
      expect(result.url).toContain('reddit.com/search');
      expect(result.url).toContain('q=programming');
    } finally {
      await client.cleanup();
    }
  }, 60000);
  
  (SKIP_LIVE_TESTS ? test.skip : test)('special characters are URL encoded (live)', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab();
      
      const result = await client.navigate(tabId, '@google_search hello & world');
      
      expect(result.ok).toBe(true);
      // & should be encoded as %26
      expect(result.url).toContain('q=hello%20%26%20world');
    } finally {
      await client.cleanup();
    }
  }, 60000);
  
  (SKIP_LIVE_TESTS ? test.skip : test)('unknown macro returns error', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab();
      
      // Unknown macro with no fallback URL should fail
      await expect(client.navigate(tabId, '@unknown_macro test'))
        .rejects.toThrow(/url or macro required/);
    } finally {
      await client.cleanup();
    }
  }, 60000);
});
