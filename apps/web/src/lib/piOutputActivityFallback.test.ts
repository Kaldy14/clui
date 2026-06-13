import type { ClaudeHookStatus, TerminalStatus } from "@clui/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PI_OUTPUT_ACTIVITY_IDLE_MS,
  createPiOutputActivityFallback,
  hasVisiblePiOutput,
} from "./piOutputActivityFallback";

function createHarness() {
  const hookStatusByThread = new Map<string, ClaudeHookStatus | null>();
  const terminalStatusByThread = new Map<string, TerminalStatus>();
  const onStatusChanged = vi.fn();
  const fallback = createPiOutputActivityFallback({
    getThreadState: (rawThreadId) => ({
      hookStatus: hookStatusByThread.get(rawThreadId) ?? null,
      terminalStatus: terminalStatusByThread.get(rawThreadId),
    }),
    setHookStatus: (rawThreadId, status) => {
      hookStatusByThread.set(rawThreadId, status);
    },
    onStatusChanged,
  });

  return { fallback, hookStatusByThread, terminalStatusByThread, onStatusChanged };
}

describe("piOutputActivityFallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores control-only terminal output", () => {
    expect(hasVisiblePiOutput("\x1b[2K\r\x1b[?25l")).toBe(false);
    expect(hasVisiblePiOutput("\x1b[2K\rRendering tool")).toBe(true);
  });

  it("marks an active pi thread working while visible output is arriving", () => {
    const ctx = createHarness();
    ctx.terminalStatusByThread.set("t1", "active");
    ctx.hookStatusByThread.set("t1", "completed");

    expect(ctx.fallback.handleOutput("t1", "new assistant text")).toBe(true);
    expect(ctx.hookStatusByThread.get("t1")).toBe("working");
    expect(ctx.onStatusChanged).toHaveBeenCalledTimes(1);
  });

  it("restores the prior status after output goes quiet", () => {
    const ctx = createHarness();
    ctx.terminalStatusByThread.set("t1", "active");
    ctx.hookStatusByThread.set("t1", "completed");

    ctx.fallback.handleOutput("t1", "new assistant text");
    vi.advanceTimersByTime(PI_OUTPUT_ACTIVITY_IDLE_MS - 1);
    expect(ctx.hookStatusByThread.get("t1")).toBe("working");

    vi.advanceTimersByTime(1);
    expect(ctx.hookStatusByThread.get("t1")).toBe("completed");
  });

  it("keeps attention statuses instead of overriding them with working", () => {
    const ctx = createHarness();
    ctx.terminalStatusByThread.set("t1", "active");
    ctx.hookStatusByThread.set("t1", "needsInput");

    expect(ctx.fallback.handleOutput("t1", "tool dialog redraw")).toBe(false);
    expect(ctx.hookStatusByThread.get("t1")).toBe("needsInput");
  });

  it("does not schedule a fallback for real working status", () => {
    const ctx = createHarness();
    ctx.terminalStatusByThread.set("t1", "active");
    ctx.hookStatusByThread.set("t1", "working");

    expect(ctx.fallback.handleOutput("t1", "streaming text")).toBe(false);
    vi.advanceTimersByTime(PI_OUTPUT_ACTIVITY_IDLE_MS);
    expect(ctx.hookStatusByThread.get("t1")).toBe("working");
  });

  it("clears output-derived state when a real hook status arrives", () => {
    const ctx = createHarness();
    ctx.terminalStatusByThread.set("t1", "active");
    ctx.hookStatusByThread.set("t1", "completed");

    ctx.fallback.handleOutput("t1", "late rendered text");
    ctx.hookStatusByThread.set("t1", "completed");
    ctx.fallback.handleRealHookStatus("t1");

    vi.advanceTimersByTime(PI_OUTPUT_ACTIVITY_IDLE_MS);
    expect(ctx.hookStatusByThread.get("t1")).toBe("completed");
  });
});
