import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PiSessionJsonlHookWatcher, hookStatusFromSessionJsonlLine } from "./PiSessionJsonlHook";

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "clui-pi-hook-"));
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

describe("PiSessionJsonlHookWatcher", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("maps pi session JSONL lines to hook statuses", () => {
    expect(
      hookStatusFromSessionJsonlLine(
        '{"type":"message","message":{"role":"user","content":"hello"}}',
      ),
    ).toBe("working");
    expect(
      hookStatusFromSessionJsonlLine(
        '{"type":"message","message":{"role":"assistant","stopReason":"toolUse"}}',
      ),
    ).toBe("working");
    expect(
      hookStatusFromSessionJsonlLine(
        '{"type":"message","message":{"role":"assistant","stopReason":"stop"}}',
      ),
    ).toBe("completed");
    expect(
      hookStatusFromSessionJsonlLine(
        '{"type":"message","message":{"role":"assistant","stopReason":"error"}}',
      ),
    ).toBe("error");
  });

  it("switches to the active session file instead of following the newest file in a shared dir", async () => {
    tempDir = await makeTempDir();
    const sessionDir = path.join(tempDir, "sessions");
    await mkdir(sessionDir, { recursive: true });

    const fileA = path.join(sessionDir, "a.jsonl");
    const fileB = path.join(sessionDir, "b.jsonl");
    await writeFile(
      fileA,
      [
        '{"type":"session","version":3,"id":"sess-a","timestamp":"2026-04-19T00:00:00.000Z","cwd":"/tmp/project"}',
        '{"type":"message","message":{"role":"assistant","stopReason":"stop"}}',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      fileB,
      [
        '{"type":"session","version":3,"id":"sess-b","timestamp":"2026-04-19T00:00:00.000Z","cwd":"/tmp/project"}',
        '{"type":"message","message":{"role":"user","content":"hi"}}',
        "",
      ].join("\n"),
      "utf8",
    );

    const statuses: string[] = [];
    const watcher = new PiSessionJsonlHookWatcher({
      threadId: "thread-1",
      logger: { warn: () => {} },
      emitHookStatus: (event) => {
        if (event.type === "hookStatus" && event.hookStatus) {
          statuses.push(event.hookStatus);
        }
      },
    });

    watcher.start(fileA);
    expect(statuses.at(-1)).toBe("completed");

    watcher.setSessionFile(fileB);
    expect(statuses.at(-1)).toBe("working");

    await appendFile(
      fileA,
      '{"type":"message","message":{"role":"assistant","stopReason":"error"}}\n',
      "utf8",
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(statuses.at(-1)).toBe("working");

    await appendFile(
      fileB,
      '{"type":"message","message":{"role":"assistant","stopReason":"stop"}}\n',
      "utf8",
    );
    await waitFor(() => {
      expect(statuses.at(-1)).toBe("completed");
    });

    watcher.stop();
  });
});
