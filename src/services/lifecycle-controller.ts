/**
 * Lifecycle state machine for idle cleanup and graceful exit.
 */

export interface LifecycleLiveState {
  liveSessions: number;
  liveTabs: number;
  launchingContexts: number;
  stagedCreates: number;
}

export class LifecycleController {
  private lastActivityMs: number;
  private cleanupFinishedMs: number | null = null;
  private liveState: LifecycleLiveState = {
    liveSessions: 0,
    liveTabs: 0,
    launchingContexts: 0,
    stagedCreates: 0,
  };

  constructor(
    private readonly cfg: {
      idleCleanupTimeoutMs: number;
      idleExitTimeoutMs: number;
      now?: () => number;
    },
  ) {
    this.lastActivityMs = this.now();
  }

  private now(): number {
    return this.cfg.now ? this.cfg.now() : Date.now();
  }

  recordRequestStart(): void {
    this.lastActivityMs = this.now();
    this.cleanupFinishedMs = null;
  }

  recordRequestEnd(): void {
    this.lastActivityMs = this.now();
  }

  recordInteractiveActivity(): void {
    this.lastActivityMs = this.now();
    this.cleanupFinishedMs = null;
  }

  syncLiveState(state: LifecycleLiveState): void {
    this.liveState = state;
    if (this.hasLiveActivity()) {
      this.lastActivityMs = this.now();
      this.cleanupFinishedMs = null;
    }
  }

  private hasLiveActivity(): boolean {
    return (
      this.liveState.liveSessions > 0 ||
      this.liveState.liveTabs > 0 ||
      this.liveState.launchingContexts > 0 ||
      this.liveState.stagedCreates > 0
    );
  }

  shouldRunCleanup(now = this.now()): boolean {
    if (this.cleanupFinishedMs !== null) {
      return false;
    }
    const idleMs = now - this.lastActivityMs;
    return idleMs >= this.cfg.idleCleanupTimeoutMs;
  }

  shouldExit(now = this.now()): boolean {
    if (this.cleanupFinishedMs === null) {
      return false;
    }
    const idleSinceCleanupMs = now - this.cleanupFinishedMs;
    return idleSinceCleanupMs >= this.cfg.idleExitTimeoutMs;
  }

  markCleanupStarted(_now = this.now()): void {
    // Reserved for future use
  }

  markCleanupFinished(result: 'success' | 'aborted' | 'failed', now = this.now()): void {
    if (result === 'success') {
      this.cleanupFinishedMs = now;
    }
  }
}
