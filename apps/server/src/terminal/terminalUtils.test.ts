import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertValidCwd,
  capHistory,
  createSpawnEnv,
  runWithThreadLock,
  shouldExcludeEnvKey,
} from "./terminalUtils.ts";

// ---------------------------------------------------------------------------
// capHistory
// ---------------------------------------------------------------------------

describe("capHistory", () => {
  it("returns empty string unchanged", () => {
    expect(capHistory("", 10)).toBe("");
  });

  it("returns history unchanged when under limit", () => {
    const history = "line1\nline2\nline3\n";
    expect(capHistory(history, 10)).toBe(history);
  });

  it("returns history unchanged when at exact limit", () => {
    const history = "line1\nline2\nline3\n";
    expect(capHistory(history, 3)).toBe(history);
  });

  it("caps from the end keeping the most recent lines", () => {
    const history = "line1\nline2\nline3\nline4\nline5\n";
    expect(capHistory(history, 3)).toBe("line3\nline4\nline5\n");
  });

  it("preserves trailing newline when present", () => {
    const history = "a\nb\nc\nd\n";
    const result = capHistory(history, 2);
    expect(result.endsWith("\n")).toBe(true);
    expect(result).toBe("c\nd\n");
  });

  it("does not add trailing newline when absent", () => {
    const history = "a\nb\nc\nd";
    const result = capHistory(history, 2);
    expect(result.endsWith("\n")).toBe(false);
    expect(result).toBe("c\nd");
  });
});

// ---------------------------------------------------------------------------
// shouldExcludeEnvKey
// ---------------------------------------------------------------------------

describe("shouldExcludeEnvKey", () => {
  it("excludes VITE_ prefix", () => {
    expect(shouldExcludeEnvKey("VITE_API_URL")).toBe(true);
    expect(shouldExcludeEnvKey("vite_something")).toBe(true);
  });

  it("excludes CLUI_ prefix", () => {
    expect(shouldExcludeEnvKey("CLUI_PORT")).toBe(true);
    expect(shouldExcludeEnvKey("clui_mode")).toBe(true);
  });

  it("excludes CLAUDE_CODE_ prefix", () => {
    expect(shouldExcludeEnvKey("CLAUDE_CODE_ENTRYPOINT")).toBe(true);
    expect(shouldExcludeEnvKey("claude_code_foo")).toBe(true);
  });

  it("excludes CMUX_ prefix", () => {
    expect(shouldExcludeEnvKey("CMUX_WRAPPER")).toBe(true);
    expect(shouldExcludeEnvKey("cmux_debug")).toBe(true);
  });

  it("excludes exact match CLAUDECODE", () => {
    expect(shouldExcludeEnvKey("CLAUDECODE")).toBe(true);
    expect(shouldExcludeEnvKey("claudecode")).toBe(true);
  });

  it("excludes blocklist items", () => {
    expect(shouldExcludeEnvKey("PORT")).toBe(true);
    expect(shouldExcludeEnvKey("ANTHROPIC_API_KEY")).toBe(true);
    expect(shouldExcludeEnvKey("OPENAI_API_KEY")).toBe(true);
    expect(shouldExcludeEnvKey("DATABASE_URL")).toBe(true);
    expect(shouldExcludeEnvKey("ELECTRON_RENDERER_PORT")).toBe(true);
    expect(shouldExcludeEnvKey("ELECTRON_RUN_AS_NODE")).toBe(true);
  });

  it("excludes keys with _SECRET suffix", () => {
    expect(shouldExcludeEnvKey("MY_SECRET")).toBe(true);
    expect(shouldExcludeEnvKey("my_secret")).toBe(true);
    expect(shouldExcludeEnvKey("APP_SECRET")).toBe(true);
  });

  it("excludes keys with _TOKEN suffix", () => {
    expect(shouldExcludeEnvKey("GITHUB_TOKEN")).toBe(true);
    expect(shouldExcludeEnvKey("github_token")).toBe(true);
  });

  it("excludes keys with _KEY suffix", () => {
    expect(shouldExcludeEnvKey("API_KEY")).toBe(true);
    expect(shouldExcludeEnvKey("stripe_key")).toBe(true);
  });

  it("allows normal env vars through", () => {
    expect(shouldExcludeEnvKey("HOME")).toBe(false);
    expect(shouldExcludeEnvKey("PATH")).toBe(false);
    expect(shouldExcludeEnvKey("USER")).toBe(false);
    expect(shouldExcludeEnvKey("SHELL")).toBe(false);
    expect(shouldExcludeEnvKey("TERM")).toBe(false);
    expect(shouldExcludeEnvKey("LANG")).toBe(false);
  });

  it("is case insensitive", () => {
    expect(shouldExcludeEnvKey("vItE_foo")).toBe(true);
    expect(shouldExcludeEnvKey("Clui_bar")).toBe(true);
    expect(shouldExcludeEnvKey("port")).toBe(true);
    expect(shouldExcludeEnvKey("My_Key")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createSpawnEnv
// ---------------------------------------------------------------------------

describe("createSpawnEnv", () => {
  it("filters excluded keys from baseEnv", () => {
    const base = {
      HOME: "/home/user",
      VITE_SECRET: "should-be-gone",
      CLUI_PORT: "4100",
      PORT: "3000",
    };
    const result = createSpawnEnv(base);
    expect(result).toHaveProperty("HOME", "/home/user");
    expect(result).not.toHaveProperty("VITE_SECRET");
    expect(result).not.toHaveProperty("CLUI_PORT");
    expect(result).not.toHaveProperty("PORT");
  });

  it("passes through allowed keys", () => {
    const base = { HOME: "/home/user", PATH: "/usr/bin", USER: "alice" };
    const result = createSpawnEnv(base);
    expect(result).toEqual({ HOME: "/home/user", PATH: "/usr/bin", USER: "alice", COLORTERM: "truecolor" });
  });

  it("skips undefined values", () => {
    const base: NodeJS.ProcessEnv = { HOME: "/home/user", UNDEFINED_KEY: undefined };
    const result = createSpawnEnv(base);
    expect(result).toHaveProperty("HOME");
    expect(result).not.toHaveProperty("UNDEFINED_KEY");
  });

  it("runtimeEnv overrides baseEnv values", () => {
    const base = { HOME: "/home/user", PATH: "/usr/bin" };
    const runtime = { PATH: "/custom/bin", EXTRA: "value" };
    const result = createSpawnEnv(base, runtime);
    expect(result.PATH).toBe("/custom/bin");
    expect(result.EXTRA).toBe("value");
    expect(result.HOME).toBe("/home/user");
  });

  it("works with no runtimeEnv argument", () => {
    const base = { HOME: "/home/user" };
    const result = createSpawnEnv(base);
    expect(result).toEqual({ HOME: "/home/user", COLORTERM: "truecolor" });
  });

  it("works with null runtimeEnv", () => {
    const base = { HOME: "/home/user" };
    const result = createSpawnEnv(base, null);
    expect(result).toEqual({ HOME: "/home/user", COLORTERM: "truecolor" });
  });
});

// ---------------------------------------------------------------------------
// runWithThreadLock
// ---------------------------------------------------------------------------

describe("runWithThreadLock", () => {
  it("serializes concurrent tasks on the same threadId", async () => {
    const locks = new Map<string, Promise<void>>();
    const order: number[] = [];

    const task1 = runWithThreadLock(locks, "thread-1", async () => {
      order.push(1);
      await Promise.resolve();
      order.push(2);
    });

    const task2 = runWithThreadLock(locks, "thread-1", async () => {
      order.push(3);
    });

    await Promise.all([task1, task2]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("allows parallel tasks on different threadIds", async () => {
    const locks = new Map<string, Promise<void>>();
    const started: string[] = [];

    let resolveA!: () => void;
    const blockerA = new Promise<void>((r) => (resolveA = r));

    const task1 = runWithThreadLock(locks, "thread-A", async () => {
      started.push("A");
      await blockerA;
    });

    const task2 = runWithThreadLock(locks, "thread-B", async () => {
      started.push("B");
    });

    await task2;
    expect(started).toContain("B");
    expect(started).toContain("A");

    resolveA();
    await task1;
  });

  it("cleans up lock after successful completion", async () => {
    const locks = new Map<string, Promise<void>>();
    await runWithThreadLock(locks, "thread-1", async () => {});
    expect(locks.has("thread-1")).toBe(false);
  });

  it("cleans up lock after task error", async () => {
    const locks = new Map<string, Promise<void>>();
    await expect(
      runWithThreadLock(locks, "thread-1", async () => {
        throw new Error("task failed");
      }),
    ).rejects.toThrow("task failed");
    expect(locks.has("thread-1")).toBe(false);
  });

  it("propagates errors from task", async () => {
    const locks = new Map<string, Promise<void>>();
    const err = new Error("boom");
    await expect(
      runWithThreadLock(locks, "thread-1", async () => {
        throw err;
      }),
    ).rejects.toBe(err);
  });
});

// ---------------------------------------------------------------------------
// assertValidCwd
// ---------------------------------------------------------------------------

describe("assertValidCwd", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    tempDirs.length = 0;
  });

  it("resolves for a valid existing directory", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clui-test-"));
    tempDirs.push(dir);
    await expect(assertValidCwd(dir)).resolves.toBeUndefined();
  });

  it("throws for a non-existent path", async () => {
    const nonExistent = path.join(os.tmpdir(), "clui-test-does-not-exist-" + Date.now());
    await expect(assertValidCwd(nonExistent)).rejects.toThrow("Terminal cwd does not exist");
  });

  it("throws for a file path instead of a directory", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clui-test-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "file.txt");
    fs.writeFileSync(filePath, "hello");
    await expect(assertValidCwd(filePath)).rejects.toThrow("Terminal cwd is not a directory");
  });
});
