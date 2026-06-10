import { describe, expect, it, vi } from "vitest";

import { createTerminalWriteQueue, type TerminalWriteTarget } from "./terminalWriteQueue";

describe("createTerminalWriteQueue", () => {
  it("keeps only one terminal write in flight", () => {
    const callbacks: Array<() => void> = [];
    const writes: string[] = [];
    const target: TerminalWriteTarget = {
      write: (data, callback) => {
        writes.push(data);
        if (callback) callbacks.push(callback);
      },
    };
    const queue = createTerminalWriteQueue(target);
    const firstComplete = vi.fn();
    const secondComplete = vi.fn();

    queue.enqueue("first", firstComplete);
    queue.enqueue("second", secondComplete);

    expect(writes).toEqual(["first"]);
    expect(queue.writing).toBe(true);
    expect(queue.pendingCount).toBe(1);
    expect(firstComplete).not.toHaveBeenCalled();
    expect(secondComplete).not.toHaveBeenCalled();

    callbacks.shift()?.();

    expect(writes).toEqual(["first", "second"]);
    expect(firstComplete).toHaveBeenCalledTimes(1);
    expect(secondComplete).not.toHaveBeenCalled();

    callbacks.shift()?.();

    expect(queue.writing).toBe(false);
    expect(queue.pendingCount).toBe(0);
    expect(secondComplete).toHaveBeenCalledTimes(1);
  });

  it("clears queued writes without interrupting the in-flight write", () => {
    const callbacks: Array<() => void> = [];
    const writes: string[] = [];
    const queue = createTerminalWriteQueue({
      write: (data, callback) => {
        writes.push(data);
        if (callback) callbacks.push(callback);
      },
    });

    queue.enqueue("first");
    queue.enqueue("second");
    queue.clear();
    callbacks.shift()?.();

    expect(writes).toEqual(["first"]);
    expect(queue.pendingCount).toBe(0);
    expect(queue.writing).toBe(false);
  });
});
