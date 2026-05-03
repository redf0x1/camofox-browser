describe('LifecycleController', () => {
  const { LifecycleController } = require('../../dist/src/services/lifecycle-controller');
  const { loadConfig } = require('../../dist/src/utils/config');

  test('requests and activity block cleanup until quiet window elapses', () => {
    const controller = new LifecycleController({
      idleCleanupTimeoutMs: 1000,
      idleExitTimeoutMs: 1000,
      now: () => 5000,
    });

    controller.recordRequestStart();
    controller.recordRequestEnd();
    controller.recordInteractiveActivity();
    controller.syncLiveState({ liveSessions: 1, liveTabs: 1, launchingContexts: 0, stagedCreates: 0 });

    expect(controller.shouldRunCleanup(5500)).toBe(false);
    expect(controller.shouldRunCleanup(7001)).toBe(true);
  });

  test('new activity after cleanup resets exit eligibility', () => {
    const controller = new LifecycleController({
      idleCleanupTimeoutMs: 1000,
      idleExitTimeoutMs: 1000,
      now: () => 10000,
    });

    controller.syncLiveState({ liveSessions: 1, liveTabs: 0, launchingContexts: 0, stagedCreates: 0 });
    controller.markCleanupFinished('success', 10000);
    controller.recordRequestStart();
    controller.recordRequestEnd();

    expect(controller.shouldExit(10050)).toBe(false);
  });

  test('exit becomes true after idleExitTimeoutMs following successful cleanup', () => {
    const controller = new LifecycleController({
      idleCleanupTimeoutMs: 1000,
      idleExitTimeoutMs: 2000,
      now: () => 10000,
    });

    controller.syncLiveState({ liveSessions: 0, liveTabs: 0, launchingContexts: 0, stagedCreates: 0 });
    controller.markCleanupFinished('success', 10000);

    expect(controller.shouldExit(11999)).toBe(false);
    expect(controller.shouldExit(12000)).toBe(true);
  });

  test('aborted cleanup does not arm exit', () => {
    const controller = new LifecycleController({
      idleCleanupTimeoutMs: 1000,
      idleExitTimeoutMs: 1000,
      now: () => 10000,
    });

    controller.syncLiveState({ liveSessions: 0, liveTabs: 0, launchingContexts: 0, stagedCreates: 0 });
    controller.markCleanupFinished('aborted', 10000);

    expect(controller.shouldExit(11001)).toBe(false);
  });

  test('failed cleanup does not arm exit', () => {
    const controller = new LifecycleController({
      idleCleanupTimeoutMs: 1000,
      idleExitTimeoutMs: 1000,
      now: () => 10000,
    });

    controller.syncLiveState({ liveSessions: 0, liveTabs: 0, launchingContexts: 0, stagedCreates: 0 });
    controller.markCleanupFinished('failed', 10000);

    expect(controller.shouldExit(11001)).toBe(false);
  });

  test('live-state activity after cleanup disarms pending exit', () => {
    const controller = new LifecycleController({
      idleCleanupTimeoutMs: 1000,
      idleExitTimeoutMs: 2000,
      now: () => 10000,
    });

    controller.syncLiveState({ liveSessions: 0, liveTabs: 0, launchingContexts: 0, stagedCreates: 0 });
    controller.markCleanupFinished('success', 10000);

    // Exit would be armed at 12000
    expect(controller.shouldExit(11500)).toBe(false);

    // New live state arrives
    controller.syncLiveState({ liveSessions: 1, liveTabs: 0, launchingContexts: 0, stagedCreates: 0 });

    // Exit should be disarmed even after timeout would have passed
    expect(controller.shouldExit(12001)).toBe(false);
  });

  test('config fallback for CAMOFOX_IDLE_EXIT_TIMEOUT_MS to idleTimeoutMs', () => {
    // When CAMOFOX_IDLE_EXIT_TIMEOUT_MS is not set, should default to idleTimeoutMs
    const config1 = loadConfig({
      CAMOFOX_IDLE_TIMEOUT_MS: '5000',
    });
    expect(config1.idleExitTimeoutMs).toBe(5000);

    // When CAMOFOX_IDLE_EXIT_TIMEOUT_MS is set, should use that value
    const config2 = loadConfig({
      CAMOFOX_IDLE_TIMEOUT_MS: '5000',
      CAMOFOX_IDLE_EXIT_TIMEOUT_MS: '3000',
    });
    expect(config2.idleExitTimeoutMs).toBe(3000);
  });
});
