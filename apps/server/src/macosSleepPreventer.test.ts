import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it } from "vitest";

import { MacosSleepPreventerRuntime } from "./macosSleepPreventer";

class FakeChildProcess extends EventEmitter {
  killedWith: NodeJS.Signals | null = null;
  readonly pid = 1234;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killedWith = typeof signal === "string" ? signal : null;
    return true;
  }

  unref(): void {
    // no-op
  }
}

function asChildProcess(child: FakeChildProcess): ChildProcess {
  return child as unknown as ChildProcess;
}

describe("MacosSleepPreventerRuntime", () => {
  it("starts caffeinate on macOS when a thread starts working", () => {
    const spawned: FakeChildProcess[] = [];
    const runtime = new MacosSleepPreventerRuntime({
      enabled: true,
      platform: "darwin",
      spawnCaffeinate: () => {
        const child = new FakeChildProcess();
        spawned.push(child);
        return asChildProcess(child);
      },
    });

    runtime.setThreadInProgress("thread-1", true);

    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.killedWith).toBeNull();
  });

  it("keeps one caffeinate process until all working threads are cleared", () => {
    const spawned: FakeChildProcess[] = [];
    const runtime = new MacosSleepPreventerRuntime({
      enabled: true,
      platform: "darwin",
      spawnCaffeinate: () => {
        const child = new FakeChildProcess();
        spawned.push(child);
        return asChildProcess(child);
      },
    });

    runtime.setThreadInProgress("thread-1", true);
    runtime.setThreadInProgress("thread-2", true);
    runtime.clearThread("thread-1");

    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.killedWith).toBeNull();

    runtime.setThreadInProgress("thread-2", false);

    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.killedWith).toBe("SIGTERM");
  });

  it("does not spawn when disabled or off macOS", () => {
    let spawnCount = 0;
    const runtime = new MacosSleepPreventerRuntime({
      enabled: false,
      platform: "darwin",
      spawnCaffeinate: () => {
        spawnCount += 1;
        return asChildProcess(new FakeChildProcess());
      },
    });

    runtime.setThreadInProgress("thread-1", true);
    expect(spawnCount).toBe(0);

    runtime.setEnabled(true);
    expect(spawnCount).toBe(1);

    runtime.setEnabled(false);
    runtime.setThreadInProgress("thread-2", true);
    expect(spawnCount).toBe(1);

    const linuxRuntime = new MacosSleepPreventerRuntime({
      enabled: true,
      platform: "linux",
      spawnCaffeinate: () => {
        spawnCount += 1;
        return asChildProcess(new FakeChildProcess());
      },
    });
    linuxRuntime.setThreadInProgress("thread-3", true);

    expect(spawnCount).toBe(1);
  });
});
