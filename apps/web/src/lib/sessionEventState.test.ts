import type { ClaudeHookStatus, TerminalStatus } from "@clui/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DormantReason } from "../types";
import {
  COMPLETED_GRACE_MS,
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
      // Mark completed, then wait past grace
      state.handleHookStatus("t1", "completed");
      vi.mocked(ctx.deps.setHookStatus).mockClear();

      vi.advanceTimersByTime(COMPLETED_GRACE_MS + 1);
      // hookStatus is currently "completed" — set to null to simulate cleared
      ctx.hookStatusByThread.set("t1", null);

      state.handleOutput("t1", "unexpected output");
      // Should recover to working
      expect(ctx.deps.setHookStatus).toHaveBeenCalledWith("t1", "working");
      // But completedAt should still be set (not deleted)
      expect(state._completedAt.has("t1")).toBe(true);
    });

    it("detects Interrupted in output and clears hookStatus", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      ctx.hookStatusByThread.set("t1", "working");

      state.handleOutput("t1", "⏎ Interrupted");

      expect(ctx.deps.setHookStatus).toHaveBeenCalledWith("t1", null);
      expect(state._completedAt.has("t1")).toBe(true);
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
    it("clears hookStatus after 90s of no output", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      ctx.hookStatusByThread.set("t1", "working");
      state.handleHookStatus("t1", "working");

      expect(state._workingIdleTimers.has("t1")).toBe(true);

      // Advance past idle timeout
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

      // 10 more seconds -> 90s since last output
      vi.advanceTimersByTime(10_001);
      expect(ctx.deps.setHookStatus).toHaveBeenCalledWith("t1", null);
    });
  });

  describe("handleOutput with startup grace ending", () => {
    it("allows working recovery after startup grace expires", () => {
      ctx.terminalStatusByThread.set("t1", "active");
      state.handleStarted("t1");

      // Advance past startup grace
      vi.advanceTimersByTime(STARTUP_GRACE_MS + 1);
      state.handleOutput("t1", "real output");

      expect(ctx.deps.setHookStatus).toHaveBeenCalledWith("t1", "working");
    });
  });
});
