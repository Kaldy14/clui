import type { NativeApi, ThreadId } from "@clui/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { requestTerminalRepaint, resolveTerminalRepaintResizeSequence } from "./terminalPtyRepaint";

function makeMockApi(): NativeApi {
  return {
    claude: {
      resize: vi.fn(() => Promise.resolve()),
    },
    pi: {
      resize: vi.fn(() => Promise.resolve()),
    },
  } as unknown as NativeApi;
}

function flushRestoreResize(): void {
  vi.runAllTimers();
}

describe("resolveTerminalRepaintResizeSequence", () => {
  it("returns a one-row shrink followed by the original size", () => {
    expect(resolveTerminalRepaintResizeSequence({ cols: 120, rows: 40 })).toEqual([
      { cols: 120, rows: 39 },
      { cols: 120, rows: 40 },
    ]);
  });

  it("falls back to a one-column shrink when only one row exists", () => {
    expect(resolveTerminalRepaintResizeSequence({ cols: 80, rows: 1 })).toEqual([
      { cols: 79, rows: 1 },
      { cols: 80, rows: 1 },
    ]);
  });

  it("returns no sequence for invalid or non-nudgeable dimensions", () => {
    expect(resolveTerminalRepaintResizeSequence({ cols: 0, rows: 40 })).toEqual([]);
    expect(resolveTerminalRepaintResizeSequence({ cols: 1, rows: 1 })).toEqual([]);
    expect(resolveTerminalRepaintResizeSequence({ cols: Number.NaN, rows: 40 })).toEqual([]);
  });
});

describe("requestTerminalRepaint", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends the repaint sequence through claude resize", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = makeMockApi();
    const threadId = "thread-1" as ThreadId;

    const repaint = requestTerminalRepaint({
      api,
      harness: "claudeCode",
      threadId,
      cols: 120,
      rows: 40,
    });

    expect(repaint.scheduled).toBe(true);
    expect(api.claude.resize).toHaveBeenCalledTimes(1);
    expect(api.claude.resize).toHaveBeenLastCalledWith({ threadId, cols: 120, rows: 39 });
    expect(api.pi.resize).not.toHaveBeenCalled();

    flushRestoreResize();

    expect(api.claude.resize).toHaveBeenCalledTimes(2);
    expect(api.claude.resize).toHaveBeenLastCalledWith({ threadId, cols: 120, rows: 40 });
  });

  it("sends the repaint sequence through pi resize", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = makeMockApi();
    const threadId = "thread-2" as ThreadId;

    const repaint = requestTerminalRepaint({ api, harness: "pi", threadId, cols: 100, rows: 30 });

    expect(repaint.scheduled).toBe(true);
    expect(api.pi.resize).toHaveBeenCalledTimes(1);
    expect(api.pi.resize).toHaveBeenLastCalledWith({ threadId, cols: 100, rows: 29 });
    expect(api.claude.resize).not.toHaveBeenCalled();

    flushRestoreResize();

    expect(api.pi.resize).toHaveBeenCalledTimes(2);
    expect(api.pi.resize).toHaveBeenLastCalledWith({ threadId, cols: 100, rows: 30 });
  });

  it("uses the latest restore size when the terminal resizes before the restore frame", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = makeMockApi();
    const threadId = "thread-3" as ThreadId;
    let restoreSize = { cols: 100, rows: 30 };

    requestTerminalRepaint({
      api,
      harness: "pi",
      threadId,
      cols: 100,
      rows: 30,
      readRestoreSize: () => restoreSize,
    });
    restoreSize = { cols: 140, rows: 45 };

    flushRestoreResize();

    expect(api.pi.resize).toHaveBeenCalledTimes(2);
    expect(api.pi.resize).toHaveBeenLastCalledWith({ threadId, cols: 140, rows: 45 });
  });

  it("returns false and skips resize for invalid dimensions", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = makeMockApi();
    const threadId = "thread-4" as ThreadId;

    const repaint = requestTerminalRepaint({ api, harness: "pi", threadId, cols: 1, rows: 1 });
    flushRestoreResize();

    expect(repaint.scheduled).toBe(false);
    expect(api.pi.resize).not.toHaveBeenCalled();
  });

  it("restores the PTY size when canceling the fallback restore", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = makeMockApi();
    const threadId = "thread-5" as ThreadId;

    const repaint = requestTerminalRepaint({ api, harness: "pi", threadId, cols: 120, rows: 40 });
    repaint.cancel();
    flushRestoreResize();

    expect(api.pi.resize).toHaveBeenCalledTimes(2);
    expect(api.pi.resize).toHaveBeenLastCalledWith({ threadId, cols: 120, rows: 40 });
  });

  it("restores the PTY size when canceling the animation-frame restore", () => {
    const api = makeMockApi();
    const threadId = "thread-6" as ThreadId;
    const frameCallbacks = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      const frameId = nextFrameId++;
      frameCallbacks.set(frameId, callback);
      return frameId;
    });
    const cancelAnimationFrame = vi.fn((frameId: number) => {
      frameCallbacks.delete(frameId);
    });
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

    const repaint = requestTerminalRepaint({ api, harness: "pi", threadId, cols: 120, rows: 40 });
    repaint.cancel();
    frameCallbacks.get(1)?.(0);

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(api.pi.resize).toHaveBeenCalledTimes(2);
    expect(api.pi.resize).toHaveBeenLastCalledWith({ threadId, cols: 120, rows: 40 });
  });

  it("ignores resize rejections", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = makeMockApi();
    const threadId = "thread-7" as ThreadId;

    vi.mocked(api.pi.resize).mockRejectedValueOnce(new Error("resize refused"));

    requestTerminalRepaint({ api, harness: "pi", threadId, cols: 120, rows: 40 });
    flushRestoreResize();

    expect(api.pi.resize).toHaveBeenCalledTimes(2);
  });
});
