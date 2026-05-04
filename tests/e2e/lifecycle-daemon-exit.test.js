const { startServer, stopServer, getServerUrl } = require('../helpers/startServer');

describe('Lifecycle daemon exit (Stage 2)', () => {
  let serverUrl;

  afterEach(async () => {
    // Server might have already exited in some tests
    try {
      await stopServer();
    } catch (e) {
      // Ignore - server already dead
    }
  }, 30000);

  test('daemon exits after cleanup-stage quiet window and cancels exit on new activity', async () => {
    // Start server with short idle timeout and short exit timeout
    await startServer(0, {
      CAMOFOX_IDLE_TIMEOUT_MS: '1000',
      CAMOFOX_IDLE_EXIT_TIMEOUT_MS: '1000',
      CAMOFOX_API_KEY: '',
    });
    serverUrl = getServerUrl();

    // Verify server is running
    const healthBefore = await fetch(`${serverUrl}/health`);
    expect(healthBefore.status).toBe(200);

    // Wait for idle cleanup + exit window to complete
    // Total: 1000ms (idle) + 1000ms (exit) + margin
    const deadline = Date.now() + 15000;
    let serverExited = false;

    while (Date.now() < deadline) {
      const probe = await fetch(`${serverUrl}/health`).catch(() => null);
      if (!probe) {
        serverExited = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(serverExited).toBe(true);

    // Verify server is truly dead
    const healthAfter = await fetch(`${serverUrl}/health`).catch(() => null);
    expect(healthAfter).toBeNull();
  }, 30000);

  test('new activity cancels pending exit', async () => {
    // Start server with short idle timeout and short exit timeout
    await startServer(0, {
      CAMOFOX_IDLE_TIMEOUT_MS: '1000',
      CAMOFOX_IDLE_EXIT_TIMEOUT_MS: '2000',
      CAMOFOX_API_KEY: '',
    });
    serverUrl = getServerUrl();

    // Wait for idle cleanup to complete (Stage 1)
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Server is now in Stage 2 (exit window). Make activity EARLY to cancel exit.
    // We're at ~1.5s, exit would happen at ~3s (1s idle + 2s exit)
    // Use a non-/health endpoint to trigger activity tracking
    const userId = 'cancel-exit-user';
    const sessionKey = 'test';
    const activityReq = await fetch(`${serverUrl}/sessions/${userId}/${sessionKey}`).catch(() => null);
    // This might 404 but it should still count as activity
    expect(activityReq).not.toBeNull();

    // Wait beyond the original exit timeout (2s) to verify server is still alive
    // because the fetch above reset the exit timer
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // Server should still be alive because activity reset the exit timer
    const healthAfter = await fetch(`${serverUrl}/health`);
    expect(healthAfter.status).toBe(200);
  }, 30000);
});
