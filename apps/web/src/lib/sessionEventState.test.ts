import type { ClaudeHookStatus, TerminalStatus } from "@clui/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DormantReason } from "../types";
import {
  COMPLETED_GRACE_MS,
  PENDING_APPROVAL_OUTPUT_DELAY_MS,
  STARTUP_GRACE_MS,
  WORKING_IDLE_TIMEOUT_MS,
  createSessionEventState,
  type SessionEventDeps,
  type SessionEventState,
} from "./sessionEventState";

function createTestDeps(overrides?: Partial<SessionEventDeps>) {
  const hookStatusByThread = new Map<string, ClaudeHookStatus | null>();
  const terminalStatusByThread = new Map<string, TerminalStatus>();
  const lifecycleCalls: Array<{
    rawId: string;
    status: TerminalStatus;
    hookStatus: ClaudeHookStatus | null;
    dormantReason: DormantReason;
  }> = [];

  const deps: SessionEventDeps = {
    getThreadHookStatus: (rawId) => hookStatusByThread.get(rawId) ?? null,
    getThreadTerminalStatus: (rawId) => terminalStatusByThread.get(rawId),
    setHookStatus: vi.fn((rawId: string, status: ClaudeHookStatus | null) => {
      hookStatusByThread.set(rawId, status);
    }),
    setTerminalStatus: vi.fn((rawId: string, status: TerminalStatus) => {
      terminalStatusByThread.set(rawId, status);
    }),
    setTerminalLifecycle: vi.fn(
      (
        rawId: string,
        status: TerminalStatus,
        hookStatus: ClaudeHookStatus | null,
        dormantReason?: DormantReason,
      ) => {
        terminalStatusByThread.set(rawId, status);
        hookStatusByThread.set(rawId, hookStatus);
        lifecycleCalls.push({ rawId, status, hookStatus, dormantReason: dormantReason ?? null });
      },
    ),
    now: () => Date.now(),
    ...overrides,
  };

  return {
    deps,
    hookStatusByThread,
    terminalStatusByThread,
    lifecycleCalls,
  };
}

describe("createSessionEventState", () => {
  let state: SessionEventState;
  let ctx: ReturnType<typeof createTestDeps>;

  beforeEach(() => {
    vi.useFakeTimers();
    ctx = createTestDeps();
    state = createSessionEventState(ctx.deps);
  });

  afterEach(() => {
    state.clearAll();
    vi.useRealTimers();
  });

  describe("handleOutput", () => {
    it("suppresses 'working' recovery during startup grace period", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      // hookStatus is null, terminal just started
      state.handleStarted("t1");

      // Output arrives within startup grace
      vi.advanceTimersByTime(3_000);
      state.handleOutput("t1", "Loading conversation...");

      expect(ctx.deps.setHookStatus).not.toHaveBeenCalledWith("t1", "working");
    });

    it("suppresses 'working' recovery during completion grace period", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      // Complete the thread
      state.handleHookStatus("t1", "completed");
      vi.mocked(ctx.deps.setHookStatus).mockClear();

      // Output arrives within completion grace
      vi.advanceTimersByTime(3_000);
      state.handleOutput("t1", "some output");

      expect(ctx.deps.setHookStatus).not.toHaveBeenCalledWith("t1", "working");
    });

    it("does NOT delete completedAt on recovery", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      // Set up: turnInProgress is true, hookStatus is null (idle timer cleared it),
      // and there's a stale completedAt from a prior turn.
      state._turnInProgress.set("t1", true);
      // Set a completedAt timestamp far in the past (outside grace)
      state._completedAt.set("t1", Date.now() - COMPLETED_GRACE_MS - 1);

      state.handleOutput("t1", "unexpected output");
      // Should recover to working
      expect(ctx.deps.setHookStatus).toHaveBeenCalledWith("t1", "working");
      // But completedAt should still be set (not deleted by recovery)
      expect(state._completedAt.has("t1")).toBe(true);
    });

    it("detects Interrupted in output and clears hookStatus", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      ctx.hookStatusByThread.set("t1", "working");

      state.handleOutput("t1", "⏎ Interrupted");

      expect(ctx.deps.setHookStatus).toHaveBeenCalledWith("t1", null);
      expect(state._completedAt.has("t1")).toBe(true);
    });

    it("detects Interrupted split across two output chunks", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      ctx.hookStatusByThread.set("t1", "working");

      // First chunk ends with "⏎", second chunk starts with " Interrupted"
      state.handleOutput("t1", "some output ⏎");
      expect(ctx.deps.setHookStatus).not.toHaveBeenCalledWith("t1", null);

      state.handleOutput("t1", " Interrupted");
      expect(ctx.deps.setHookStatus).toHaveBeenCalledWith("t1", null);
      expect(state._completedAt.has("t1")).toBe(true);
      expect(state._turnInProgress.has("t1")).toBe(false);
    });

    it("detects Interrupted with ANSI codes between ⏎ and Interrupted across chunks", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      ctx.hookStatusByThread.set("t1", "working");

      // ⏎ at end of first chunk, ANSI + Interrupted at start of second
      state.handleOutput("t1", "⏎");
      state.handleOutput("t1", "\x1b[1;31mInterrupted\x1b[0m");

      expect(ctx.deps.setHookStatus).toHaveBeenCalledWith("t1", null);
    });

    it("does not false-positive on 'Interrupted' embedded in prose", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      ctx.hookStatusByThread.set("t1", "working");

      state.handleOutput("t1", "The process was Interrupted by the user");

      // Should NOT clear hookStatus — no "⏎" in this chunk or the previous one
      expect(ctx.deps.setHookStatus).not.toHaveBeenCalledWith("t1", null);
    });

    it("does not false-positive when ⏎ in status bar and Interrupted in distant prose", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      ctx.hookStatusByThread.set("t1", "working");

      // Status bar chunk contains ⏎ but it's far from any "Interrupted"
      state.handleOutput("t1", "⏎ to send, esc to cancel -- lots of padding text here");
      // Next chunk has prose with "Interrupted" but ⏎ is >30 chars away in prev tail
      state.handleOutput("t1", "The operation was Interrupted by a timeout");

      expect(ctx.deps.setHookStatus).not.toHaveBeenCalledWith("t1", null);
    });

    it("detects 529 API error and sets hookStatus to 'error'", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      ctx.hookStatusByThread.set("t1", "working");

      state.handleOutput(
        "t1",
        '  API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}   ',
      );

      expect(ctx.deps.setHookStatus).toHaveBeenCalledWith("t1", "error");
      expect(state._completedAt.has("t1")).toBe(true);
      expect(state._turnInProgress.has("t1")).toBe(false);
    });

    it("detects 429 rate-limit API error", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      ctx.hookStatusByThread.set("t1", "working");

      state.handleOutput("t1", "API Error: 429 Rate limited");

      expect(ctx.deps.setHookStatus).toHaveBeenCalledWith("t1", "error");
    });

    it("does not trigger API error detection when not working", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      ctx.hookStatusByThread.set("t1", null);

      state.handleOutput("t1", "API Error: 529 overloaded");

      expect(ctx.deps.setHookStatus).not.toHaveBeenCalledWith("t1", "error");
    });

    it("clears turnInProgress on Interrupted so output recovery doesn't re-trigger", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      state.handleHookStatus("t1", "working");
      expect(state._turnInProgress.get("t1")).toBe(true);

      state.handleOutput("t1", "⏎ Interrupted");

      expect(state._turnInProgress.has("t1")).toBe(false);
      // Subsequent output should NOT recover to "working"
      vi.mocked(ctx.deps.setHookStatus).mockClear();
      state.handleOutput("t1", "What would you like to do?");
      expect(ctx.deps.setHookStatus).not.toHaveBeenCalledWith("t1", "working");
    });
  });

  describe("handleHookStatus", () => {
    it("'working' clears terminalStartedAt (ends startup grace)", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      state.handleStarted("t1");
      expect(state._terminalStartedAt.has("t1")).toBe(true);

      state.handleHookStatus("t1", "working");
      expect(state._terminalStartedAt.has("t1")).toBe(false);
    });

    it("'working' is ignored within completion grace period", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      state.handleHookStatus("t1", "completed");
      vi.mocked(ctx.deps.setHookStatus).mockClear();

      vi.advanceTimersByTime(3_000);
      const result = state.handleHookStatus("t1", "working");

      expect(result).toEqual({ applied: false });
      expect(ctx.deps.setHookStatus).not.toHaveBeenCalled();
    });

    it("'needsInput' clears terminalStartedAt", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      state.handleStarted("t1");
      expect(state._terminalStartedAt.has("t1")).toBe(true);

      state.handleHookStatus("t1", "needsInput");
      expect(state._terminalStartedAt.has("t1")).toBe(false);
    });

    it("'completed' sets completedAt and updates hookStatus", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      const result = state.handleHookStatus("t1", "completed");

      expect(result).toEqual({ applied: true, hookStatus: "completed" });
      expect(ctx.deps.setHookStatus).toHaveBeenCalledWith("t1", "completed");
      expect(state._completedAt.has("t1")).toBe(true);
    });

    it("'working' is ignored when terminal is dormant", () => {
      ctx.terminalStatusByThread.set("t1", "dormant");
      const result = state.handleHookStatus("t1", "working");

      expect(result).toEqual({ applied: false });
    });

    it("'pendingApproval' is ignored when terminal is dormant", () => {
      ctx.terminalStatusByThread.set("t1", "dormant");
      const result = state.handleHookStatus("t1", "pendingApproval");

      expect(result).toEqual({ applied: false });
    });

    it("'needsInput' is ignored when terminal is dormant", () => {
      ctx.terminalStatusByThread.set("t1", "dormant");
      const result = state.handleHookStatus("t1", "needsInput");

      expect(result).toEqual({ applied: false });
    });

    it("'completed' is still accepted when terminal is dormant", () => {
      ctx.terminalStatusByThread.set("t1", "dormant");
      const result = state.handleHookStatus("t1", "completed");

      expect(result).toEqual({ applied: true, hookStatus: "completed" });
    });
  });

  describe("handleStarted", () => {
    it("records terminalStartedAt and clears completedAt", () => {
      // Set a prior completedAt
      state.handleHookStatus("t1", "completed");
      expect(state._completedAt.has("t1")).toBe(true);

      state.handleStarted("t1");
      expect(state._terminalStartedAt.has("t1")).toBe(true);
      expect(state._completedAt.has("t1")).toBe(false);
      expect(ctx.deps.setTerminalStatus).toHaveBeenCalledWith("t1", "active");
    });
  });

  describe("handleDormant", () => {
    it("sets dormantReason 'hibernated'", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      state.handleDormant("t1", "hibernated");

      expect(ctx.deps.setTerminalLifecycle).toHaveBeenCalledWith(
        "t1",
        "dormant",
        null,
        "hibernated",
      );
      expect(state._completedAt.has("t1")).toBe(true);
      expect(state._terminalStartedAt.has("t1")).toBe(false);
    });

    it("sets dormantReason 'exited'", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      state.handleDormant("t1", "exited");

      expect(ctx.deps.setTerminalLifecycle).toHaveBeenCalledWith(
        "t1",
        "dormant",
        null,
        "exited",
      );
    });
  });

  describe("clearAll", () => {
    it("clears all maps and cancels timers", () => {
      // Set up state across all maps
      state.handleStarted("t1");
      state.handleHookStatus("t1", "completed");
      ctx.hookStatusByThread.set("t2", "working");
      ctx.terminalStatusByThread.set("t2", "active");
      state.handleHookStatus("t2", "working");
      // t2 now has an idle timer

      expect(state._completedAt.size).toBeGreaterThan(0);
      expect(state._workingIdleTimers.size).toBeGreaterThan(0);

      state.clearAll();

      expect(state._completedAt.size).toBe(0);
      expect(state._terminalStartedAt.size).toBe(0);
      expect(state._workingIdleTimers.size).toBe(0);
      expect(state._workingIdleLastReset.size).toBe(0);
    });
  });

  describe("working idle timer", () => {
    it("clears hookStatus after 90s when terminal is no longer active", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      ctx.hookStatusByThread.set("t1", "working");
      state.handleHookStatus("t1", "working");

      expect(state._workingIdleTimers.has("t1")).toBe(true);

      // Terminal becomes dormant — simulates PTY gone but hookStatus stuck
      ctx.terminalStatusByThread.set("t1", "dormant");

      // Advance past idle timeout
      vi.advanceTimersByTime(WORKING_IDLE_TIMEOUT_MS);

      expect(ctx.deps.setHookStatus).toHaveBeenCalledWith("t1", null);
      expect(state._workingIdleTimers.has("t1")).toBe(false);
    });

    it("re-arms idle timer when turn is confirmed and terminal is active", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      ctx.hookStatusByThread.set("t1", "working");
      // handleHookStatus("working") simulates PostToolUse → confirms the turn
      state.handleHookStatus("t1", "working");

      expect(state._workingIdleTimers.has("t1")).toBe(true);
      expect(state._turnConfirmed.get("t1")).toBe(true);

      // First timeout fires — turn confirmed + active → re-arm
      vi.advanceTimersByTime(WORKING_IDLE_TIMEOUT_MS);
      expect(ctx.hookStatusByThread.get("t1")).toBe("working");
      expect(state._workingIdleTimers.has("t1")).toBe(true); // re-armed

      // Second timeout fires — still confirmed → re-arm again
      vi.advanceTimersByTime(WORKING_IDLE_TIMEOUT_MS);
      expect(ctx.hookStatusByThread.get("t1")).toBe("working");
      expect(state._workingIdleTimers.has("t1")).toBe(true);
    });

    it("clears hookStatus after idle timeout for unconfirmed turn (quick Esc cancel)", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      // handleTurnStart simulates UserPromptSubmit — does NOT confirm the turn
      state.handleTurnStart("t1");

      expect(ctx.hookStatusByThread.get("t1")).toBe("working");
      expect(state._turnInProgress.get("t1")).toBe(true);
      expect(state._turnConfirmed.has("t1")).toBe(false);

      // Idle timer fires — unconfirmed turn + active → clear instead of re-arm
      vi.advanceTimersByTime(WORKING_IDLE_TIMEOUT_MS);
      expect(ctx.deps.setHookStatus).toHaveBeenCalledWith("t1", null);
      expect(state._turnInProgress.has("t1")).toBe(false);
      expect(state._workingIdleTimers.has("t1")).toBe(false);
    });

    it("prevents output recovery after unconfirmed turn idle timeout", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      state.handleTurnStart("t1");

      // Idle timer clears the unconfirmed turn
      vi.advanceTimersByTime(WORKING_IDLE_TIMEOUT_MS);
      expect(ctx.hookStatusByThread.get("t1")).toBeNull();
      vi.mocked(ctx.deps.setHookStatus).mockClear();

      // Subsequent output should NOT recover to "working" since turnInProgress was cleared
      state.handleOutput("t1", "keystroke echo after cancel");
      expect(ctx.deps.setHookStatus).not.toHaveBeenCalledWith("t1", "working");
    });

    it("clears hookStatus after idle timeout when turnInProgress is false", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      ctx.hookStatusByThread.set("t1", "working");
      state.handleHookStatus("t1", "working");

      // Manually clear turnInProgress to simulate a stale state
      // (e.g. hookStatus stuck at "working" after turn ended)
      state._turnInProgress.delete("t1");

      vi.advanceTimersByTime(WORKING_IDLE_TIMEOUT_MS);
      expect(ctx.deps.setHookStatus).toHaveBeenCalledWith("t1", null);
      expect(state._workingIdleTimers.has("t1")).toBe(false);
    });

    it("resets when output arrives during working state", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      ctx.hookStatusByThread.set("t1", "working");
      state.handleHookStatus("t1", "working");

      // Advance 80s, then output arrives (force reset via handleHookStatus or direct)
      vi.advanceTimersByTime(80_000);
      // Output resets the timer (throttled, but we advanced enough)
      state.handleOutput("t1", "some output");

      // The original 90s hasn't elapsed since last reset, so hookStatus should still be working
      vi.advanceTimersByTime(80_000);
      // At this point it's 80s since last output reset -- still within 90s
      expect(ctx.hookStatusByThread.get("t1")).toBe("working");
    });
  });

  describe("turnInProgress gating", () => {
    it("blocks output recovery when no turn is in progress (new thread, user typing)", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      state.handleStarted("t1");

      // Advance past startup grace — but no hook has fired, so turnInProgress is false
      vi.advanceTimersByTime(STARTUP_GRACE_MS + 1);
      state.handleOutput("t1", "keystroke echo");

      expect(ctx.deps.setHookStatus).not.toHaveBeenCalledWith("t1", "working");
    });

    it("keeps hookStatus 'working' through idle timeout when turn is in progress", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      state.handleStarted("t1");

      // Simulate a real turn: UserPromptSubmit fires → hookStatus = "working"
      state.handleHookStatus("t1", "working");
      vi.mocked(ctx.deps.setHookStatus).mockClear();

      // Idle timer fires (90s) — turn is still in progress, so badge stays
      vi.advanceTimersByTime(WORKING_IDLE_TIMEOUT_MS);
      expect(ctx.hookStatusByThread.get("t1")).toBe("working");
      expect(state._workingIdleTimers.has("t1")).toBe(true); // re-armed
    });

    it("sets turnInProgress and turnConfirmed on 'working' hook, clears on 'completed'", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      state.handleHookStatus("t1", "working");
      expect(state._turnInProgress.get("t1")).toBe(true);
      expect(state._turnConfirmed.get("t1")).toBe(true);

      state.handleHookStatus("t1", "completed");
      expect(state._turnInProgress.has("t1")).toBe(false);
      expect(state._turnConfirmed.has("t1")).toBe(false);
    });

    it("sets turnInProgress on 'needsInput' hook", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      state.handleHookStatus("t1", "needsInput");
      expect(state._turnInProgress.get("t1")).toBe(true);
    });

    it("clears turnInProgress on handleDormant", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      state.handleHookStatus("t1", "working");
      expect(state._turnInProgress.get("t1")).toBe(true);

      state.handleDormant("t1", "exited");
      expect(state._turnInProgress.has("t1")).toBe(false);
    });

    it("clears turnInProgress on handleInterrupted", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      state.handleHookStatus("t1", "working");
      expect(state._turnInProgress.get("t1")).toBe(true);

      state.handleInterrupted("t1");
      expect(state._turnInProgress.has("t1")).toBe(false);
    });

    it("clears turnInProgress on clearAll", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      state.handleHookStatus("t1", "working");
      expect(state._turnInProgress.size).toBe(1);

      state.clearAll();
      expect(state._turnInProgress.size).toBe(0);
    });

    it("clears pendingApprovalAt on clearAll", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      state.handleHookStatus("t1", "pendingApproval");
      expect(state._pendingApprovalAt.size).toBe(1);

      state.clearAll();
      expect(state._pendingApprovalAt.size).toBe(0);
    });

    it("blocks output recovery on resumed thread startup output", () => {
      // Simulate a resumed thread: started event but no hooks yet
      ctx.terminalStatusByThread.set("t1", "active");
      state.handleStarted("t1");

      // Even past both startup and completion grace, no turn is in progress
      vi.advanceTimersByTime(STARTUP_GRACE_MS + COMPLETED_GRACE_MS + 1);
      state.handleOutput("t1", "Claude Code banner loading...");

      expect(ctx.deps.setHookStatus).not.toHaveBeenCalledWith("t1", "working");
    });
  });

  describe("handleTurnStart", () => {
    it("bypasses completed grace period", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      // Complete the thread
      state.handleHookStatus("t1", "completed");
      vi.mocked(ctx.deps.setHookStatus).mockClear();

      // Within grace period — handleHookStatus("working") would be rejected
      vi.advanceTimersByTime(3_000);
      const result = state.handleHookStatus("t1", "working");
      expect(result).toEqual({ applied: false });

      // But handleTurnStart always works
      state.handleTurnStart("t1");
      expect(ctx.deps.setHookStatus).toHaveBeenCalledWith("t1", "working");
    });

    it("clears completedAt so subsequent hooks are not blocked", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      state.handleHookStatus("t1", "completed");

      vi.advanceTimersByTime(2_000);
      state.handleTurnStart("t1");
      vi.mocked(ctx.deps.setHookStatus).mockClear();

      // A subsequent pendingApproval should now be accepted
      const result = state.handleHookStatus("t1", "pendingApproval");
      expect(result).toEqual({ applied: true, hookStatus: "pendingApproval" });
    });

    it("sets turnInProgress but not turnConfirmed", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      state.handleTurnStart("t1");
      expect(state._turnInProgress.get("t1")).toBe(true);
      expect(state._turnConfirmed.has("t1")).toBe(false);
    });
  });

  describe("PostToolUse race protection", () => {
    it("rejects stale 'working' from PostToolUse when pendingApproval was just set", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      // PermissionRequest arrives first
      state.handleHookStatus("t1", "pendingApproval");
      vi.mocked(ctx.deps.setHookStatus).mockClear();

      // Stale PostToolUse arrives ~50ms later (out-of-order)
      vi.advanceTimersByTime(50);
      const result = state.handleHookStatus("t1", "working");

      expect(result).toEqual({ applied: false });
      expect(ctx.deps.setHookStatus).not.toHaveBeenCalled();
      // pendingApproval should still be set
      expect(ctx.hookStatusByThread.get("t1")).toBe("pendingApproval");
    });

    it("rejects stale 'working' from PostToolUse when needsInput was just set", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      state.handleHookStatus("t1", "needsInput");
      vi.mocked(ctx.deps.setHookStatus).mockClear();

      vi.advanceTimersByTime(50);
      const result = state.handleHookStatus("t1", "working");

      expect(result).toEqual({ applied: false });
      expect(ctx.hookStatusByThread.get("t1")).toBe("needsInput");
    });

    it("allows 'working' after protection window expires", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      state.handleHookStatus("t1", "pendingApproval");
      vi.mocked(ctx.deps.setHookStatus).mockClear();

      // Past the protection window — legitimate PostToolUse after user approved
      vi.advanceTimersByTime(PENDING_APPROVAL_OUTPUT_DELAY_MS + 1);
      const result = state.handleHookStatus("t1", "working");

      expect(result).toEqual({ applied: true, hookStatus: "working" });
      expect(ctx.deps.setHookStatus).toHaveBeenCalledWith("t1", "working");
    });
  });

  describe("pendingApproval output transition", () => {
    it("does NOT transition pendingApproval to working on output (waits for PostToolUse)", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      state.handleHookStatus("t1", "pendingApproval");
      vi.mocked(ctx.deps.setHookStatus).mockClear();

      // Output within delay — should NOT transition
      vi.advanceTimersByTime(500);
      state.handleOutput("t1", "prompt rendering");
      expect(ctx.deps.setHookStatus).not.toHaveBeenCalledWith("t1", "working");

      // Output after delay — should still NOT transition (PTY redraws are not approval)
      vi.advanceTimersByTime(PENDING_APPROVAL_OUTPUT_DELAY_MS + 1);
      state.handleOutput("t1", "cursor redraw output");
      expect(ctx.deps.setHookStatus).not.toHaveBeenCalledWith("t1", "working");

      // Only PostToolUse "working" hook should transition
      const result = state.handleHookStatus("t1", "working");
      expect(result).toEqual({ applied: true, hookStatus: "working" });
    });

    it("does not transition if interrupted before delay", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      state.handleHookStatus("t1", "pendingApproval");
      vi.mocked(ctx.deps.setHookStatus).mockClear();

      // User interrupts (⏎ prefix required for interrupt detection)
      state.handleOutput("t1", "⏎ Interrupted");
      expect(ctx.deps.setHookStatus).toHaveBeenCalledWith("t1", null);
      expect(ctx.deps.setHookStatus).not.toHaveBeenCalledWith("t1", "working");
    });
  });
});
