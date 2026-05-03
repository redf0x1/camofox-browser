describe('LifecycleController', () => {
  const { LifecycleController } = require('../../dist/src/services/lifecycle-controller');

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
});
