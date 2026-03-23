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
  /** Handle UserPromptSubmit — always accepted, bypasses completed grace period. */
  handleTurnStart(rawThreadId: string): void;
  handleOutput(rawThreadId: string, data: string): void;
  handleStarted(rawThreadId: string): void;
  handleDormant(rawThreadId: string, reason: "hibernated" | "exited"): void;
  handleInterrupted(rawThreadId: string): void;
  /** Clear all internal tracking state for a single thread (does NOT touch the store). */
  clearThread(rawThreadId: string): void;
  clearAll(): void;
  /** Exposed for testing */
  _completedAt: Map<string, number>;
  /** Exposed for testing */
  _terminalStartedAt: Map<string, number>;
  /** Exposed for testing */
  _workingIdleTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Exposed for testing */
  _workingIdleLastReset: Map<string, number>;
  /** Exposed for testing */
  _turnInProgress: Map<string, boolean>;
  /** Exposed for testing */
  _pendingApprovalAt: Map<string, number>;
  /** Exposed for testing — true once a real hook (PostToolUse/PermissionRequest) confirms the turn. */
  _turnConfirmed: Map<string, boolean>;
}

/**
 * Result from handleHookStatus — tells the caller whether the hook was applied
 * and what the new status is, so the caller can dispatch notifications.
 */
export type HandleHookResult =
  | { applied: true; hookStatus: ClaudeHookStatus }
  | { applied: false };

/** Matches Claude Code API error lines (529 overloaded, 429 rate-limit, 5xx server errors). */
const API_ERROR_RE = /API Error: (?:429|5\d{2})\b/;

export const COMPLETED_GRACE_MS = 8_000;
export const STARTUP_GRACE_MS = 8_000;
export const WORKING_IDLE_TIMEOUT_MS = 90_000;
export const IDLE_TIMER_RESET_THROTTLE_MS = 2_000;
/** After pendingApproval is set, output arriving after this delay transitions to "working". */
export const PENDING_APPROVAL_OUTPUT_DELAY_MS = 1_000;

/** Regex matching the Claude Code interrupt banner ("⏎ Interrupted"), allowing ANSI codes between. */
const INTERRUPT_RE = /⏎[^\n]{0,30}Interrupted/;
/** Number of characters to keep from the tail of each output chunk for cross-chunk matching. */
const PREV_OUTPUT_TAIL_LENGTH = 30;

export function createSessionEventState(deps: SessionEventDeps): SessionEventState {
  const completedAt = new Map<string, number>();
  const terminalStartedAt = new Map<string, number>();
  const workingIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const workingIdleLastReset = new Map<string, number>();
  // Tracks whether a turn is in progress per thread.  Set to true when a real
  // hook fires (UserPromptSubmit / PostToolUse → "working"), set to false when
  // the turn ends (Stop → "completed", interrupt, or terminal exit).
  // The output→"working" recovery heuristic is ONLY allowed when this is true,
  // preventing false "Working" badges from startup output or keystroke echo.
  const turnInProgress = new Map<string, boolean>();
  // Records when "pendingApproval" was set, so handleOutput can transition
  // to "working" when output arrives after a short delay (user approved).
  const pendingApprovalAt = new Map<string, number>();
  // True once a real hook (PostToolUse → "working", PermissionRequest →
  // "pendingApproval"/"needsInput") fires — confirms the agent loop started.
  // handleTurnStart alone does NOT confirm, since the user can press Esc
  // before the agent loop begins, leaving no Stop hook or "⏎ Interrupted".
  const turnConfirmed = new Map<string, boolean>();
  // Tail of the previous output chunk per thread, used to detect the
  // interrupt banner ("⏎ Interrupted") when it spans two PTY chunks.
  const prevOutputTail = new Map<string, string>();

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
          const terminalStatus = deps.getThreadTerminalStatus(rawThreadId);
          if (turnInProgress.get(rawThreadId) && terminalStatus === "active") {
            // Only re-arm if a real hook (PostToolUse, PermissionRequest)
            // confirmed the agent loop started. Without confirmation the
            // turn was likely cancelled before Claude began processing
            // (e.g. user pressed Esc right after sending a message), so
            // neither the Stop hook nor "⏎ Interrupted" ever fires.
            if (turnConfirmed.get(rawThreadId)) {
              resetWorkingIdleTimer(rawThreadId, true);
              return;
            }
            // Unconfirmed turn — clear turnInProgress so output recovery
            // doesn't immediately re-set the "Working" badge.
            turnInProgress.delete(rawThreadId);
            completedAt.set(rawThreadId, now());
            pendingApprovalAt.delete(rawThreadId);
            turnConfirmed.delete(rawThreadId);
          }
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
      turnInProgress.delete(rawThreadId);
      pendingApprovalAt.delete(rawThreadId);
      turnConfirmed.delete(rawThreadId);
      clearWorkingIdleTimer(rawThreadId);
      deps.setHookStatus(rawThreadId, "completed");
      return { applied: true, hookStatus: "completed" };
    }

    // Reject any non-completed hook for dormant/new terminals — these are
    // stale events that would pollute hookStatus and sort order.
    const terminalStatus = deps.getThreadTerminalStatus(rawThreadId);
    if (terminalStatus === "dormant" || terminalStatus === "new") {
      return { applied: false };
    }

    if (hookStatus === "working") {
      // Reject stale PostToolUse "working" that arrives out-of-order after
      // PermissionRequest already set "pendingApproval" or "needsInput".
      // Both hooks fire near-simultaneously via async curl, so arrival
      // order is non-deterministic.  A "working" arriving within the
      // protection window is almost certainly from the *previous* tool,
      // not the one the user just approved.
      const currentHookStatus = deps.getThreadHookStatus(rawThreadId);
      if (currentHookStatus === "pendingApproval" || currentHookStatus === "needsInput") {
        const actionTs = pendingApprovalAt.get(rawThreadId);
        if (actionTs != null && now() - actionTs < PENDING_APPROVAL_OUTPUT_DELAY_MS) {
          return { applied: false };
        }
      }

      const doneTs = completedAt.get(rawThreadId);
      if (doneTs && now() - doneTs < COMPLETED_GRACE_MS) {
        return { applied: false };
      }
      completedAt.delete(rawThreadId);
      terminalStartedAt.delete(rawThreadId);
      pendingApprovalAt.delete(rawThreadId);
      turnInProgress.set(rawThreadId, true);
      turnConfirmed.set(rawThreadId, true);
      deps.setHookStatus(rawThreadId, hookStatus);
      resetWorkingIdleTimer(rawThreadId, true);
      return { applied: true, hookStatus: "working" };
    }

    // needsInput / pendingApproval / error — these also indicate a turn is active
    const doneTs = completedAt.get(rawThreadId);
    if (doneTs && now() - doneTs < COMPLETED_GRACE_MS) {
      return { applied: false };
    }
    terminalStartedAt.delete(rawThreadId);
    turnInProgress.set(rawThreadId, true);
    turnConfirmed.set(rawThreadId, true);
    clearWorkingIdleTimer(rawThreadId);
    if (hookStatus === "pendingApproval" || hookStatus === "needsInput") {
      pendingApprovalAt.set(rawThreadId, now());
    } else {
      pendingApprovalAt.delete(rawThreadId);
    }
    deps.setHookStatus(rawThreadId, hookStatus);
    return { applied: true, hookStatus };
  }

  /** UserPromptSubmit — always accepted, bypasses completed grace period. */
  function handleTurnStart(rawThreadId: string): void {
    completedAt.delete(rawThreadId);
    terminalStartedAt.delete(rawThreadId);
    pendingApprovalAt.delete(rawThreadId);
    turnInProgress.set(rawThreadId, true);
    turnConfirmed.delete(rawThreadId);
    clearWorkingIdleTimer(rawThreadId);
    deps.setHookStatus(rawThreadId, "working");
    resetWorkingIdleTimer(rawThreadId, true);
  }

  function handleOutput(rawThreadId: string, data: string): void {
    const hookStatus = deps.getThreadHookStatus(rawThreadId);
    const terminalStatus = deps.getThreadTerminalStatus(rawThreadId);

    // Reset idle timer -- output means Claude is still working
    if (hookStatus === "working") {
      resetWorkingIdleTimer(rawThreadId);
    }

    // Transition pendingApproval → working when output arrives after a short
    // delay.  When the user approves a permission prompt, Claude starts
    // executing the tool and produces output — but PostToolUse only fires
    // after the tool finishes.  This bridges the gap so the badge shows
    // "Working" instead of stale "Pending Approval" during tool execution.
    if (hookStatus === "pendingApproval" && terminalStatus === "active") {
      const approvalTs = pendingApprovalAt.get(rawThreadId);
      if (approvalTs != null && now() - approvalTs >= PENDING_APPROVAL_OUTPUT_DELAY_MS) {
        pendingApprovalAt.delete(rawThreadId);
        deps.setHookStatus(rawThreadId, "working");
        resetWorkingIdleTimer(rawThreadId, true);
        return; // Skip other output checks — we just transitioned
      }
    }

    // Recover "Working" badge when output arrives on an active terminal with no
    // hookStatus — but ONLY if we know a turn is in progress (we saw a real
    // hook like UserPromptSubmit or PostToolUse).  Without this guard, any PTY
    // output (keystroke echo, TUI redraws, startup banner) would falsely set
    // "Working" on idle terminals.
    if (terminalStatus === "active" && !hookStatus && turnInProgress.get(rawThreadId)) {
      const doneTs = completedAt.get(rawThreadId);
      const startTs = terminalStartedAt.get(rawThreadId);
      const inStartupGrace = startTs != null && now() - startTs < STARTUP_GRACE_MS;
      if (!inStartupGrace && (!doneTs || now() - doneTs >= COMPLETED_GRACE_MS)) {
        deps.setHookStatus(rawThreadId, "working");
        resetWorkingIdleTimer(rawThreadId, true);
      }
    }

    // Detect user-initiated interrupts (Escape to cancel).
    // The interrupt banner "⏎ Interrupted" may be split across two PTY
    // output chunks, so we bridge the tail of the previous chunk with the
    // head of the current one and check both with a proximity regex.
    if (
      hookStatus === "working" ||
      hookStatus === "pendingApproval" ||
      hookStatus === "needsInput"
    ) {
      const tail = prevOutputTail.get(rawThreadId) ?? "";
      const bridge = tail + data.slice(0, 40);
      if (INTERRUPT_RE.test(data) || INTERRUPT_RE.test(bridge)) {
        completedAt.set(rawThreadId, now());
        turnInProgress.delete(rawThreadId);
        pendingApprovalAt.delete(rawThreadId);
        turnConfirmed.delete(rawThreadId);
        prevOutputTail.delete(rawThreadId);
        clearWorkingIdleTimer(rawThreadId);
        deps.setHookStatus(rawThreadId, null);
      }
    }

    // Detect API errors (e.g. 529 overloaded, 429 rate limit, 500 server error)
    // that don't trigger a /hooks/stop callback, leaving hookStatus stuck on "working".
    if (hookStatus === "working" && API_ERROR_RE.test(data)) {
      completedAt.set(rawThreadId, now());
      turnInProgress.delete(rawThreadId);
      turnConfirmed.delete(rawThreadId);
      prevOutputTail.delete(rawThreadId);
      clearWorkingIdleTimer(rawThreadId);
      deps.setHookStatus(rawThreadId, "error");
    }

    // Store tail for cross-chunk interrupt detection on next output event.
    prevOutputTail.set(rawThreadId, data.slice(-PREV_OUTPUT_TAIL_LENGTH));
  }

  function handleStarted(rawThreadId: string): void {
    terminalStartedAt.set(rawThreadId, now());
    completedAt.delete(rawThreadId);
    deps.setTerminalStatus(rawThreadId, "active");
  }

  function handleDormant(rawThreadId: string, reason: "hibernated" | "exited"): void {
    completedAt.set(rawThreadId, now());
    turnInProgress.delete(rawThreadId);
    pendingApprovalAt.delete(rawThreadId);
    turnConfirmed.delete(rawThreadId);
    prevOutputTail.delete(rawThreadId);
    clearWorkingIdleTimer(rawThreadId);
    terminalStartedAt.delete(rawThreadId);
    deps.setTerminalLifecycle(rawThreadId, "dormant", null, reason);
  }

  function handleInterrupted(rawThreadId: string): void {
    completedAt.set(rawThreadId, now());
    turnInProgress.delete(rawThreadId);
    pendingApprovalAt.delete(rawThreadId);
    turnConfirmed.delete(rawThreadId);
    prevOutputTail.delete(rawThreadId);
    clearWorkingIdleTimer(rawThreadId);
    deps.setHookStatus(rawThreadId, null);
  }

  function clearThread(rawThreadId: string): void {
    completedAt.delete(rawThreadId);
    turnInProgress.delete(rawThreadId);
    pendingApprovalAt.delete(rawThreadId);
    turnConfirmed.delete(rawThreadId);
    prevOutputTail.delete(rawThreadId);
    clearWorkingIdleTimer(rawThreadId);
    terminalStartedAt.delete(rawThreadId);
  }

  function clearAll(): void {
    completedAt.clear();
    turnInProgress.clear();
    pendingApprovalAt.clear();
    turnConfirmed.clear();
    prevOutputTail.clear();
    for (const timer of workingIdleTimers.values()) clearTimeout(timer);
    workingIdleTimers.clear();
    workingIdleLastReset.clear();
    terminalStartedAt.clear();
  }

  return {
    handleHookStatus,
    handleTurnStart,
    handleOutput,
    handleStarted,
    handleDormant,
    handleInterrupted,
    clearThread,
    clearAll,
    _completedAt: completedAt,
    _terminalStartedAt: terminalStartedAt,
    _workingIdleTimers: workingIdleTimers,
    _workingIdleLastReset: workingIdleLastReset,
    _turnInProgress: turnInProgress,
    _pendingApprovalAt: pendingApprovalAt,
    _turnConfirmed: turnConfirmed,
  };
}

// ── Global instance accessor ─────────────────────────────────────────
// Set once from __root.tsx after createSessionEventState(); consumed by
// components that need to reset per-thread tracking (e.g. Sidebar).

let _globalInstance: SessionEventState | null = null;

export function setGlobalSessionEventState(instance: SessionEventState): void {
  _globalInstance = instance;
}

export function getGlobalSessionEventState(): SessionEventState | null {
  return _globalInstance;
}
