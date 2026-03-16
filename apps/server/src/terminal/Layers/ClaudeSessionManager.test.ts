import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

import type { ClaudeSessionEvent } from "@clui/contracts";
import {
  PtySpawnError,
  type PtyAdapterShape,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnInput,
} from "../Services/PTY";
import { ClaudeSessionManagerRuntime } from "./ClaudeSessionManager";

// ── Test doubles (same pattern as Manager.test.ts) ──────────────────

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  readonly killSignals: Array<string | undefined> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  killed = false;

  constructor(readonly pid: number) {}

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.killed = true;
    this.killSignals.push(signal);
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(event: PtyExitEvent): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

class FakePtyAdapter implements PtyAdapterShape {
  readonly spawnInputs: PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  readonly spawnFailures: Error[] = [];
  private nextPid = 9000;

  spawn(input: PtySpawnInput): Effect.Effect<PtyProcess, PtySpawnError> {
    this.spawnInputs.push(input);
    const failure = this.spawnFailures.shift();
    if (failure) {
      return Effect.fail(
        new PtySpawnError({
          adapter: "fake",
          message: "Failed to spawn PTY process",
          cause: failure,
        }),
      );
    }
    const process = new FakePtyProcess(this.nextPid++);
    this.processes.push(process);
    return Effect.succeed(process);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function makeRuntime(options: {
  processKillGraceMs?: number;
  historyLineLimit?: number;
  maxActiveSessions?: number;
  ptyAdapter?: FakePtyAdapter;
} = {}) {
  const ptyAdapter = options.ptyAdapter ?? new FakePtyAdapter();
  const runtime = new ClaudeSessionManagerRuntime({
    ptyAdapter,
    ...(options.processKillGraceMs !== undefined && { processKillGraceMs: options.processKillGraceMs }),
    ...(options.historyLineLimit !== undefined && { historyLineLimit: options.historyLineLimit }),
    ...(options.maxActiveSessions !== undefined && { maxActiveSessions: options.maxActiveSessions }),
  });
  return { ptyAdapter, runtime };
}

function defaultInput(overrides: Partial<{
  threadId: string;
  cwd: string;
  resumeSessionId: string;
  cols: number;
  rows: number;
}> = {}) {
  return {
    threadId: "thread-1",
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

function collectEvents(runtime: ClaudeSessionManagerRuntime): ClaudeSessionEvent[] {
  const events: ClaudeSessionEvent[] = [];
  runtime.on("event", (e) => events.push(e));
  return events;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("ClaudeSessionManagerRuntime", () => {
  let runtime: ClaudeSessionManagerRuntime;

  afterEach(() => {
    runtime?.dispose();
  });

  // ── startSession ────────────────────────────────────────────────

  describe("startSession", () => {
    it("spawns process with correct args and emits started event", async () => {
      const result = makeRuntime();
      runtime = result.runtime;
      const events = collectEvents(runtime);

      await runtime.startSession(defaultInput());

      expect(result.ptyAdapter.spawnInputs).toHaveLength(1);
      const spawnInput = result.ptyAdapter.spawnInputs[0]!;
      expect(spawnInput.shell).toBe("claude");
      expect(spawnInput.cwd).toBe(process.cwd());
      expect(spawnInput.cols).toBe(100);
      expect(spawnInput.rows).toBe(24);

      expect(events.some((e) => e.type === "started" && e.threadId === "thread-1")).toBe(true);
      expect(runtime.getSessionStatus("thread-1")).toBe("active");
    });

    it("passes --resume flag when resumeSessionId is provided", async () => {
      const result = makeRuntime();
      runtime = result.runtime;

      await runtime.startSession(defaultInput({ resumeSessionId: "sess-abc-123" }));

      const spawnInput = result.ptyAdapter.spawnInputs[0]!;
      expect(spawnInput.args).toEqual(["--resume", "sess-abc-123"]);
    });

    it("emits error event and reverts status on spawn failure", async () => {
      const ptyAdapter = new FakePtyAdapter();
      ptyAdapter.spawnFailures.push(new Error("spawn failed"));
      const result = makeRuntime({ ptyAdapter });
      runtime = result.runtime;
      const events = collectEvents(runtime);

      await expect(runtime.startSession(defaultInput())).rejects.toThrow();

      expect(events.some((e) => e.type === "error")).toBe(true);
      expect(runtime.getSessionStatus("thread-1")).toBe("new");
    });

    it("kills old process when replacing existing session", async () => {
      const result = makeRuntime({ maxActiveSessions: 100 });
      runtime = result.runtime;
      const events = collectEvents(runtime);

      await runtime.startSession(defaultInput());
      const oldProcess = result.ptyAdapter.processes[0]!;

      await runtime.startSession(defaultInput());

      expect(oldProcess.killed).toBe(true);
      expect(oldProcess.killSignals).toContain("SIGTERM");
      expect(result.ptyAdapter.processes).toHaveLength(2);
      const startedEvents = events.filter((e) => e.type === "started");
      expect(startedEvents).toHaveLength(2);
    });
  });

  // ── Stale exit closure safety (P0 bug fix) ─────────────────────

  describe("stale exit closure safety", () => {
    it("does not corrupt status when old process fires exit after replacement", async () => {
      const result = makeRuntime({ maxActiveSessions: 100 });
      runtime = result.runtime;

      await runtime.startSession(defaultInput());
      const oldProcess = result.ptyAdapter.processes[0]!;

      await runtime.startSession(defaultInput());

      // Old process exit fires after replacement — should be ignored
      oldProcess.emitExit({ exitCode: 0, signal: null });

      expect(runtime.getSessionStatus("thread-1")).toBe("active");
    });
  });

  // ── hibernateSession ───────────────────────────────────────────

  describe("hibernateSession", () => {
    it("kills process, emits hibernated event, and returns scrollback", async () => {
      const result = makeRuntime();
      runtime = result.runtime;
      const events = collectEvents(runtime);

      await runtime.startSession(defaultInput());
      const ptyProcess = result.ptyAdapter.processes[0]!;
      ptyProcess.emitData("hello world\n");

      const scrollback = await runtime.hibernateSession("thread-1");

      expect(ptyProcess.killed).toBe(true);
      expect(events.some((e) => e.type === "hibernated" && e.threadId === "thread-1")).toBe(true);
      expect(runtime.getSessionStatus("thread-1")).toBe("dormant");
      expect(scrollback).toContain("hello world");
    });

    it("throws when no session exists", async () => {
      const result = makeRuntime();
      runtime = result.runtime;

      await expect(runtime.hibernateSession("nonexistent")).rejects.toThrow();
    });
  });

  // ── writeToSession ─────────────────────────────────────────────

  describe("writeToSession", () => {
    it("forwards data to the pty process", async () => {
      const result = makeRuntime();
      runtime = result.runtime;

      await runtime.startSession(defaultInput());
      runtime.writeToSession("thread-1", "ls -la\n");

      const ptyProcess = result.ptyAdapter.processes[0]!;
      expect(ptyProcess.writes).toEqual(["ls -la\n"]);
    });

    it("throws when no active session exists", () => {
      const result = makeRuntime();
      runtime = result.runtime;

      expect(() => runtime.writeToSession("thread-1", "data")).toThrow();
    });
  });

  // ── resizeSession ──────────────────────────────────────────────

  describe("resizeSession", () => {
    it("forwards resize to the pty process", async () => {
      const result = makeRuntime();
      runtime = result.runtime;

      await runtime.startSession(defaultInput());
      runtime.resizeSession("thread-1", 200, 50);

      const ptyProcess = result.ptyAdapter.processes[0]!;
      expect(ptyProcess.resizeCalls).toEqual([{ cols: 200, rows: 50 }]);
    });

    it("throws when no active session exists", () => {
      const result = makeRuntime();
      runtime = result.runtime;

      expect(() => runtime.resizeSession("thread-1", 80, 24)).toThrow();
    });
  });

  // ── getScrollback ──────────────────────────────────────────────

  describe("getScrollback", () => {
    it("returns null scrollback for unknown thread", () => {
      const result = makeRuntime();
      runtime = result.runtime;

      const { scrollback } = runtime.getScrollback("unknown");
      expect(scrollback).toBeNull();
    });

    it("returns accumulated output data", async () => {
      const result = makeRuntime();
      runtime = result.runtime;

      await runtime.startSession(defaultInput());
      const ptyProcess = result.ptyAdapter.processes[0]!;
      ptyProcess.emitData("line1\n");
      ptyProcess.emitData("line2\n");

      const { scrollback } = runtime.getScrollback("thread-1");
      expect(scrollback).toContain("line1");
      expect(scrollback).toContain("line2");
    });
  });

  // ── getSessionStatus ───────────────────────────────────────────

  describe("getSessionStatus", () => {
    it("returns 'new' for unknown thread", () => {
      const result = makeRuntime();
      runtime = result.runtime;

      expect(runtime.getSessionStatus("unknown")).toBe("new");
    });

    it("returns 'active' after start", async () => {
      const result = makeRuntime();
      runtime = result.runtime;

      await runtime.startSession(defaultInput());
      expect(runtime.getSessionStatus("thread-1")).toBe("active");
    });

    it("returns 'dormant' after process exit", async () => {
      const result = makeRuntime();
      runtime = result.runtime;

      await runtime.startSession(defaultInput());
      result.ptyAdapter.processes[0]!.emitExit({ exitCode: 0, signal: null });

      expect(runtime.getSessionStatus("thread-1")).toBe("dormant");
    });
  });

  // ── reconcileActiveSessions ────────────────────────────────────

  describe("reconcileActiveSessions", () => {
    it("hibernates oldest sessions when over maxActive limit", async () => {
      const result = makeRuntime({ maxActiveSessions: 100 });
      runtime = result.runtime;

      // Start 3 sessions with staggered timestamps
      await runtime.startSession(defaultInput({ threadId: "thread-1" }));
      await runtime.startSession(defaultInput({ threadId: "thread-2" }));
      await runtime.startSession(defaultInput({ threadId: "thread-3" }));

      await runtime.reconcileActiveSessions(1);

      // Oldest 2 should be hibernated, most recent stays active
      expect(runtime.getSessionStatus("thread-1")).toBe("dormant");
      expect(runtime.getSessionStatus("thread-2")).toBe("dormant");
      expect(runtime.getSessionStatus("thread-3")).toBe("active");
    });

    it("does nothing when under the limit", async () => {
      const result = makeRuntime({ maxActiveSessions: 100 });
      runtime = result.runtime;

      await runtime.startSession(defaultInput({ threadId: "thread-1" }));

      await runtime.reconcileActiveSessions(5);

      expect(runtime.getSessionStatus("thread-1")).toBe("active");
    });
  });

  // ── hibernateAll ───────────────────────────────────────────────

  describe("hibernateAll", () => {
    it("hibernates all active sessions", async () => {
      const result = makeRuntime({ maxActiveSessions: 100 });
      runtime = result.runtime;

      await runtime.startSession(defaultInput({ threadId: "thread-1" }));
      await runtime.startSession(defaultInput({ threadId: "thread-2" }));

      await runtime.hibernateAll();

      expect(runtime.getSessionStatus("thread-1")).toBe("dormant");
      expect(runtime.getSessionStatus("thread-2")).toBe("dormant");
      expect(result.ptyAdapter.processes[0]!.killed).toBe(true);
      expect(result.ptyAdapter.processes[1]!.killed).toBe(true);
    });
  });

  // ── destroySession ─────────────────────────────────────────────

  describe("destroySession", () => {
    it("kills process and removes session without emitting lifecycle events", async () => {
      const result = makeRuntime({ maxActiveSessions: 100 });
      runtime = result.runtime;
      const events = collectEvents(runtime);

      await runtime.startSession(defaultInput());
      const ptyProcess = result.ptyAdapter.processes[0]!;

      // Clear events from startSession
      events.length = 0;

      await runtime.destroySession("thread-1");

      expect(ptyProcess.killed).toBe(true);
      // No hibernated/exited events emitted
      expect(events.filter((e) => e.type === "hibernated" || e.type === "exited")).toHaveLength(0);
      // Session completely removed — status returns "new"
      expect(runtime.getSessionStatus("thread-1")).toBe("new");
    });

    it("is a no-op for unknown thread", async () => {
      const result = makeRuntime();
      runtime = result.runtime;

      // Should not throw
      await runtime.destroySession("nonexistent");
    });

    it("handles dormant session (no process)", async () => {
      const result = makeRuntime();
      runtime = result.runtime;

      await runtime.startSession(defaultInput());
      result.ptyAdapter.processes[0]!.emitExit({ exitCode: 0, signal: null });
      expect(runtime.getSessionStatus("thread-1")).toBe("dormant");

      await runtime.destroySession("thread-1");
      expect(runtime.getSessionStatus("thread-1")).toBe("new");
    });
  });

  // ── dispose ────────────────────────────────────────────────────

  describe("dispose", () => {
    it("kills all processes and clears sessions", async () => {
      const result = makeRuntime({ maxActiveSessions: 100 });
      runtime = result.runtime;

      await runtime.startSession(defaultInput({ threadId: "thread-1" }));
      await runtime.startSession(defaultInput({ threadId: "thread-2" }));

      runtime.dispose();

      expect(result.ptyAdapter.processes[0]!.killed).toBe(true);
      expect(result.ptyAdapter.processes[1]!.killed).toBe(true);
      // After dispose, status returns "new" since sessions are cleared
      expect(runtime.getSessionStatus("thread-1")).toBe("new");
      expect(runtime.getSessionStatus("thread-2")).toBe("new");
    });
  });

  // ── Session ID assignment ─────────────────────────────────────

  describe("session ID assignment", () => {
    it("generates a session ID and passes --session-id for new sessions", async () => {
      const result = makeRuntime();
      runtime = result.runtime;
      const events = collectEvents(runtime);

      await runtime.startSession(defaultInput());

      // Should emit sessionId event immediately on start
      const sessionIdEvents = events.filter((e) => e.type === "sessionId");
      expect(sessionIdEvents).toHaveLength(1);
      const emittedId =
        sessionIdEvents[0]!.type === "sessionId" ? sessionIdEvents[0]!.claudeSessionId : null;
      expect(emittedId).toMatch(/^[a-f0-9-]+$/);

      // Should pass --session-id to the CLI
      const spawnInput = result.ptyAdapter.spawnInputs[0]!;
      expect(spawnInput.args).toContain("--session-id");
      expect(spawnInput.args).toContain(emittedId);
    });

    it("passes --resume for resumed sessions", async () => {
      const result = makeRuntime();
      runtime = result.runtime;
      const events = collectEvents(runtime);

      await runtime.startSession(defaultInput({ resumeSessionId: "existing-session-abc" }));

      // Should emit sessionId event with the provided resume ID
      const sessionIdEvents = events.filter((e) => e.type === "sessionId");
      expect(sessionIdEvents).toHaveLength(1);
      expect(
        sessionIdEvents[0]!.type === "sessionId" && sessionIdEvents[0]!.claudeSessionId,
      ).toBe("existing-session-abc");

      // Should pass --resume (not --session-id) to the CLI
      const spawnInput = result.ptyAdapter.spawnInputs[0]!;
      expect(spawnInput.args).toContain("--resume");
      expect(spawnInput.args).toContain("existing-session-abc");
      expect(spawnInput.args).not.toContain("--session-id");
    });
  });

  // ── getClaudeSessionId ─────────────────────────────────────────

  describe("getClaudeSessionId", () => {
    it("returns null for unknown thread", () => {
      const result = makeRuntime();
      runtime = result.runtime;

      expect(runtime.getClaudeSessionId("unknown")).toBeNull();
    });

    it("returns the assigned session ID", async () => {
      const result = makeRuntime();
      runtime = result.runtime;

      await runtime.startSession(defaultInput());

      const sessionId = runtime.getClaudeSessionId("thread-1");
      expect(sessionId).toMatch(/^[a-f0-9-]+$/);
    });
  });

  // ── Kill escalation ────────────────────────────────────────────

  describe("kill escalation", () => {
    it("sends SIGTERM then escalates to SIGKILL after grace period", async () => {
      vi.useFakeTimers();
      try {
        const result = makeRuntime({ processKillGraceMs: 50 });
        runtime = result.runtime;

        await runtime.startSession(defaultInput());
        const ptyProcess = result.ptyAdapter.processes[0]!;

        await runtime.hibernateSession("thread-1");

        expect(ptyProcess.killSignals[0]).toBe("SIGTERM");

        vi.advanceTimersByTime(60);

        expect(ptyProcess.killSignals).toContain("SIGKILL");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Thread lock serialization ──────────────────────────────────

  describe("thread lock serialization", () => {
    it("serializes concurrent startSession calls on same thread", async () => {
      const result = makeRuntime({ maxActiveSessions: 100 });
      runtime = result.runtime;

      await Promise.all([
        runtime.startSession(defaultInput()),
        runtime.startSession(defaultInput()),
      ]);

      // Both should complete without error; second replaces first
      expect(result.ptyAdapter.spawnInputs).toHaveLength(2);
      expect(runtime.getSessionStatus("thread-1")).toBe("active");
    });
  });

  // ── Environment filtering ──────────────────────────────────────

  describe("environment filtering", () => {
    it("excludes VITE_, CLUI_, CLAUDE_CODE_, and sensitive env vars from spawn", async () => {
      const originalValues = new Map<string, string | undefined>();
      const setEnv = (key: string, value: string) => {
        if (!originalValues.has(key)) {
          originalValues.set(key, process.env[key]);
        }
        process.env[key] = value;
      };
      const restoreEnv = () => {
        for (const [key, value] of originalValues) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      };

      setEnv("VITE_DEV_URL", "http://localhost:5173");
      setEnv("CLUI_PORT", "3773");
      setEnv("CLAUDE_CODE_TEST_VAR", "should-be-excluded");
      setEnv("ANTHROPIC_API_KEY", "sk-test");
      setEnv("MY_SECRET", "secret-value");
      setEnv("MY_TOKEN", "token-value");
      setEnv("MY_KEY", "key-value");
      setEnv("TEST_KEEP_ME", "keep");

      try {
        const result = makeRuntime();
        runtime = result.runtime;

        await runtime.startSession(defaultInput());

        const spawnInput = result.ptyAdapter.spawnInputs[0]!;
        expect(spawnInput.env.VITE_DEV_URL).toBeUndefined();
        expect(spawnInput.env.CLUI_PORT).toBeUndefined();
        expect(spawnInput.env.CLAUDE_CODE_TEST_VAR).toBeUndefined();
        expect(spawnInput.env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(spawnInput.env.MY_SECRET).toBeUndefined();
        expect(spawnInput.env.MY_TOKEN).toBeUndefined();
        expect(spawnInput.env.MY_KEY).toBeUndefined();
        expect(spawnInput.env.TEST_KEEP_ME).toBe("keep");
      } finally {
        restoreEnv();
      }
    });
  });

  // ── Scrollback line limit ──────────────────────────────────────

  describe("scrollback line limit", () => {
    it("caps scrollback buffer to configured line limit", async () => {
      const result = makeRuntime({ historyLineLimit: 3 });
      runtime = result.runtime;

      await runtime.startSession(defaultInput());
      const ptyProcess = result.ptyAdapter.processes[0]!;
      ptyProcess.emitData("line1\nline2\nline3\nline4\nline5\n");

      const { scrollback } = runtime.getScrollback("thread-1");
      const lines = scrollback!.split("\n").filter((l: string) => l.length > 0);
      expect(lines.length).toBeLessThanOrEqual(3);
      expect(lines).toContain("line5");
    });
  });

  // ── Output event emission ──────────────────────────────────────

  describe("output events", () => {
    it("emits output event for each data chunk", async () => {
      const result = makeRuntime();
      runtime = result.runtime;
      const events = collectEvents(runtime);

      await runtime.startSession(defaultInput());
      const ptyProcess = result.ptyAdapter.processes[0]!;
      ptyProcess.emitData("chunk1");
      ptyProcess.emitData("chunk2");

      const outputEvents = events.filter((e) => e.type === "output");
      expect(outputEvents).toHaveLength(2);
      expect(outputEvents[0]!.type === "output" && outputEvents[0]!.data).toBe("chunk1");
      expect(outputEvents[1]!.type === "output" && outputEvents[1]!.data).toBe("chunk2");
    });
  });

  // ── Exit event emission ────────────────────────────────────────

  describe("exit events", () => {
    it("emits exited event with exit code on process exit", async () => {
      const result = makeRuntime();
      runtime = result.runtime;
      const events = collectEvents(runtime);

      await runtime.startSession(defaultInput());
      result.ptyAdapter.processes[0]!.emitExit({ exitCode: 1, signal: null });

      const exitEvents = events.filter((e) => e.type === "exited");
      expect(exitEvents).toHaveLength(1);
      expect(exitEvents[0]!.type === "exited" && exitEvents[0]!.exitCode).toBe(1);
    });
  });
});
