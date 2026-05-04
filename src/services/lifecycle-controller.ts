/**
 * Lifecycle state machine for idle cleanup and graceful exit.
 */

import { loadConfig } from '../utils/config';

const CONFIG = loadConfig();

export interface LifecycleLiveState {
  liveSessions: number;
  liveTabs: number;
  launchingContexts: number;
  stagedCreates: number;
}

type CleanupState = 'idle' | 'in_progress' | 'finished';

export class LifecycleController {
  private lastActivityMs: number;
  private cleanupFinishedMs: number | null = null;
  private cleanupState: CleanupState = 'idle';
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
    if (this.cleanupState === 'in_progress') {
      this.cleanupState = 'idle';
    }
  }

  syncLiveState(state: LifecycleLiveState): void {
    this.liveState = state;
    if (this.hasLiveActivity()) {
      this.lastActivityMs = this.now();
      this.cleanupFinishedMs = null;
    } else if (this.liveState.liveSessions > 0) {
      // Empty sessions don't reset cleanup timer but DO disarm pending exit
      this.cleanupFinishedMs = null;
    }
  }

  private hasLiveActivity(): boolean {
    return (
      this.liveState.liveTabs > 0 ||
      this.liveState.launchingContexts > 0 ||
      this.liveState.stagedCreates > 0
    );
  }

  private hasLaunchingOrStagedWork(): boolean {
    return (
      this.liveState.launchingContexts > 0 ||
      this.liveState.stagedCreates > 0
    );
  }

  shouldRunCleanup(now = this.now()): boolean {
    if (this.cleanupState === 'in_progress') {
      return false;
    }
    if (this.cleanupFinishedMs !== null) {
      return false;
    }
    if (this.hasLaunchingOrStagedWork()) {
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
    this.cleanupState = 'in_progress';
  }

  markCleanupFinished(result: 'success' | 'aborted' | 'failed', now = this.now()): void {
    if (result === 'success') {
      this.cleanupFinishedMs = now;
      this.cleanupState = 'finished';
    } else {
      this.cleanupState = 'idle';
    }
  }

  snapshot(): { cleanupState: CleanupState; liveState: LifecycleLiveState } {
    return {
      cleanupState: this.cleanupState,
      liveState: { ...this.liveState },
    };
  }
}

// Singleton instance for server-wide lifecycle management
export const lifecycleController = new LifecycleController({
  idleCleanupTimeoutMs: CONFIG.idleTimeoutMs,
  idleExitTimeoutMs: CONFIG.idleExitTimeoutMs,
});
