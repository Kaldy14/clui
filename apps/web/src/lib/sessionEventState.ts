import type { ClaudeHookStatus, TerminalStatus } from "@clui/contracts";
import type { DormantReason } from "../types";

export interface SessionEventDeps {
  getThreadHookStatus: (rawId: string) => ClaudeHookStatus | null | undefined;
  getThreadTerminalStatus: (rawId: string) => TerminalStatus | undefined;
  setHookStatus: (rawId: string, status: ClaudeHookStatus | null) => void;
  setTerminalStatus: (rawId: string, status: TerminalStatus) => void;
  setTerminalLifecycle: (
    rawId: string,
    status: TerminalStatus,
    hookStatus: ClaudeHookStatus | null,
    dormantReason?: DormantReason,
  ) => void;
  now?: () => number;
}

export interface SessionEventState {
  handleHookStatus(rawThreadId: string, hookStatus: ClaudeHookStatus): HandleHookResult;
  handleOutput(rawThreadId: string, data: string): void;
  handleStarted(rawThreadId: string): void;
  handleDormant(rawThreadId: string, reason: "hibernated" | "exited"): void;
  handleInterrupted(rawThreadId: string): void;
  clearAll(): void;
  /** Exposed for testing */
  _completedAt: Map<string, number>;
  /** Exposed for testing */
  _terminalStartedAt: Map<string, number>;
  /** Exposed for testing */
  _workingIdleTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Exposed for testing */
  _workingIdleLastReset: Map<string, number>;
}

/**
 * Result from handleHookStatus — tells the caller whether the hook was applied
 * and what the new status is, so the caller can dispatch notifications.
 */
export type HandleHookResult =
  | { applied: true; hookStatus: ClaudeHookStatus }
  | { applied: false };

export const COMPLETED_GRACE_MS = 8_000;
export const STARTUP_GRACE_MS = 8_000;
export const WORKING_IDLE_TIMEOUT_MS = 90_000;
export const IDLE_TIMER_RESET_THROTTLE_MS = 2_000;

export function createSessionEventState(deps: SessionEventDeps): SessionEventState {
  const completedAt = new Map<string, number>();
  const terminalStartedAt = new Map<string, number>();
  const workingIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const workingIdleLastReset = new Map<string, number>();

  const now = deps.now ?? Date.now;

  const resetWorkingIdleTimer = (rawThreadId: string, force = false) => {
    if (!force) {
      const lastReset = workingIdleLastReset.get(rawThreadId) ?? 0;
      if (now() - lastReset < IDLE_TIMER_RESET_THROTTLE_MS) return;
    }
    workingIdleLastReset.set(rawThreadId, now());
    const existing = workingIdleTimers.get(rawThreadId);
    if (existing) clearTimeout(existing);
    const hookStatus = deps.getThreadHookStatus(rawThreadId);
    if (hookStatus !== "working") return;
    workingIdleTimers.set(
      rawThreadId,
      setTimeout(() => {
        workingIdleTimers.delete(rawThreadId);
        workingIdleLastReset.delete(rawThreadId);
        const current = deps.getThreadHookStatus(rawThreadId);
        if (current === "working") {
          deps.setHookStatus(rawThreadId, null);
        }
      }, WORKING_IDLE_TIMEOUT_MS),
    );
  };

  const clearWorkingIdleTimer = (rawThreadId: string) => {
    const existing = workingIdleTimers.get(rawThreadId);
    if (existing) {
      clearTimeout(existing);
      workingIdleTimers.delete(rawThreadId);
    }
    workingIdleLastReset.delete(rawThreadId);
  };

  function handleHookStatus(
    rawThreadId: string,
    hookStatus: ClaudeHookStatus,
  ): HandleHookResult {
    if (hookStatus === "completed") {
      completedAt.set(rawThreadId, now());
      clearWorkingIdleTimer(rawThreadId);
      deps.setHookStatus(rawThreadId, "completed");
      return { applied: true, hookStatus: "completed" };
    }

    if (hookStatus === "working") {
      const terminalStatus = deps.getThreadTerminalStatus(rawThreadId);
      if (terminalStatus === "dormant" || terminalStatus === "new") {
        return { applied: false };
      }
      const doneTs = completedAt.get(rawThreadId);
      if (doneTs && now() - doneTs < COMPLETED_GRACE_MS) {
        return { applied: false };
      }
      completedAt.delete(rawThreadId);
      terminalStartedAt.delete(rawThreadId);
      deps.setHookStatus(rawThreadId, hookStatus);
      resetWorkingIdleTimer(rawThreadId, true);
      return { applied: true, hookStatus: "working" };
    }

    // needsInput / pendingApproval / error
    const doneTs = completedAt.get(rawThreadId);
    if (doneTs && now() - doneTs < COMPLETED_GRACE_MS) {
      return { applied: false };
    }
    terminalStartedAt.delete(rawThreadId);
    clearWorkingIdleTimer(rawThreadId);
    deps.setHookStatus(rawThreadId, hookStatus);
    return { applied: true, hookStatus };
  }

  function handleOutput(rawThreadId: string, data: string): void {
    const hookStatus = deps.getThreadHookStatus(rawThreadId);
    const terminalStatus = deps.getThreadTerminalStatus(rawThreadId);

    // Reset idle timer -- output means Claude is still working
    if (hookStatus === "working") {
      resetWorkingIdleTimer(rawThreadId);
    }

    // Recover "Working" badge when output arrives on an active terminal with no hookStatus
    if (terminalStatus === "active" && !hookStatus) {
      const doneTs = completedAt.get(rawThreadId);
      const startTs = terminalStartedAt.get(rawThreadId);
      const inStartupGrace = startTs != null && now() - startTs < STARTUP_GRACE_MS;
      if (!inStartupGrace && (!doneTs || now() - doneTs >= COMPLETED_GRACE_MS)) {
        deps.setHookStatus(rawThreadId, "working");
        resetWorkingIdleTimer(rawThreadId, true);
      }
    }

    // Detect user-initiated interrupts (Escape to cancel)
    if (
      (hookStatus === "working" ||
        hookStatus === "pendingApproval" ||
        hookStatus === "needsInput") &&
      data.includes("Interrupted")
    ) {
      completedAt.set(rawThreadId, now());
      clearWorkingIdleTimer(rawThreadId);
      deps.setHookStatus(rawThreadId, null);
    }
  }

  function handleStarted(rawThreadId: string): void {
    terminalStartedAt.set(rawThreadId, now());
    completedAt.delete(rawThreadId);
    deps.setTerminalStatus(rawThreadId, "active");
  }

  function handleDormant(rawThreadId: string, reason: "hibernated" | "exited"): void {
    completedAt.set(rawThreadId, now());
    clearWorkingIdleTimer(rawThreadId);
    terminalStartedAt.delete(rawThreadId);
    deps.setTerminalLifecycle(rawThreadId, "dormant", null, reason);
  }

  function handleInterrupted(rawThreadId: string): void {
    completedAt.set(rawThreadId, now());
    clearWorkingIdleTimer(rawThreadId);
    deps.setHookStatus(rawThreadId, null);
  }

  function clearAll(): void {
    completedAt.clear();
    for (const timer of workingIdleTimers.values()) clearTimeout(timer);
    workingIdleTimers.clear();
    workingIdleLastReset.clear();
    terminalStartedAt.clear();
  }

  return {
    handleHookStatus,
    handleOutput,
    handleStarted,
    handleDormant,
    handleInterrupted,
    clearAll,
    _completedAt: completedAt,
    _terminalStartedAt: terminalStartedAt,
    _workingIdleTimers: workingIdleTimers,
    _workingIdleLastReset: workingIdleLastReset,
  };
}
