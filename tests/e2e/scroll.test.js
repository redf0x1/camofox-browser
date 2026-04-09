const { startServer, stopServer, getServerUrl } = require('../helpers/startServer');
const { startTestSite, stopTestSite, getTestSiteUrl } = require('../helpers/testSite');
const { createClient } = require('../helpers/client');

describe('Scroll', () => {
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
  
  test('scroll down page', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/scroll`);
      
      // Scroll down
      const result = await client.scroll(tabId, {
        direction: 'down',
        amount: 500
      });
      
      expect(result.ok).toBe(true);
    } finally {
      await client.cleanup();
    }
  });
  
  test('scroll to bottom of page', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/scroll`);
      
      // Scroll to bottom
      const result = await client.scroll(tabId, {
        direction: 'down',
        amount: 10000 // Large number to reach bottom
      });
      
      expect(result.ok).toBe(true);
      
      // The snapshot might now include "Bottom of page" text
      // (depending on viewport and scroll behavior)
    } finally {
      await client.cleanup();
    }
  });
  
  test('scroll up page', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/scroll`);
      
      // First scroll down
      await client.scroll(tabId, { direction: 'down', amount: 1000 });
      
      // Then scroll up
      const result = await client.scroll(tabId, {
        direction: 'up',
        amount: 500
      });
      
      expect(result.ok).toBe(true);
    } finally {
      await client.cleanup();
    }
  });

  test('scroll left and right (horizontal)', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/scroll-horizontal`);

      await client.click(tabId, { selector: '#container' });

      const before = await client.request('POST', `/tabs/${tabId}/evaluate`, {
        userId: client.userId,
        expression: 'document.getElementById("container").scrollLeft'
      });
      expect(before.ok).toBe(true);
      expect(before.result).toBe(0);

      const rightResult = await client.scroll(tabId, {
        direction: 'right',
        amount: 300
      });
      expect(rightResult.ok).toBe(true);

      const afterRight = await client.request('POST', `/tabs/${tabId}/evaluate`, {
        userId: client.userId,
        expression: 'document.getElementById("container").scrollLeft'
      });
      expect(afterRight.ok).toBe(true);
      expect(afterRight.result).toBeGreaterThan(before.result);

      const leftResult = await client.scroll(tabId, {
        direction: 'left',
        amount: 200
      });
      expect(leftResult.ok).toBe(true);

      const afterLeft = await client.request('POST', `/tabs/${tabId}/evaluate`, {
        userId: client.userId,
        expression: 'document.getElementById("container").scrollLeft'
      });
      expect(afterLeft.ok).toBe(true);
      expect(afterLeft.result).toBeLessThan(afterRight.result);
      expect(afterLeft.result).toBeGreaterThanOrEqual(0);
    } finally {
      await client.cleanup();
    }
  });
});
