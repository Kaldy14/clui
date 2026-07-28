import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PiSessionEvent } from "@clui/contracts";
import {
  PtySpawnError,
  type PtyAdapterShape,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnInput,
} from "../Services/PTY";
import { normalizeRpcProcessExit, PiSessionManagerRuntime } from "./PiSessionManager";
import {
  CLUI_SESSION_PROCESS_REGISTRY_DIR_ENV,
  CLUI_SESSION_PROCESS_REGISTRY_OWNER_PID_ENV,
  getSessionProcessRegistryDir,
  readSessionProcessRegistryEntries,
} from "../sessionProcessRegistry";

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  readonly killSignals: Array<string | undefined> = [];
  writeError: Error | null = null;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();

  constructor(readonly pid: number) {}

  write(data: string): void {
    if (this.writeError) throw this.writeError;
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  kill(signal?: string): void {
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

  emitExit(event: PtyExitEvent = { exitCode: 0, signal: null }): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

class FakePtyAdapter implements PtyAdapterShape {
  readonly spawnInputs: PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  private nextPid = 9100;

  spawn(input: PtySpawnInput): Effect.Effect<PtyProcess, PtySpawnError> {
    this.spawnInputs.push(input);
    const process = new FakePtyProcess(this.nextPid++);
    this.processes.push(process);
    return Effect.succeed(process);
  }
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "clui-pi-session-manager-"));
}

async function makeProjectCwd(stateDir: string): Promise<string> {
  const cwd = path.join(stateDir, "project");
  await mkdir(cwd, { recursive: true });
  return cwd;
}

function encodedCwdDir(stateDir: string, cwd: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(stateDir, "pi-agent", "sessions", safePath);
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function sessionSyncIdentity(spawnInput: PtySpawnInput): {
  threadId: string;
  sessionSyncNonce: string;
} {
  const threadId = spawnInput.env.CLUI_PI_THREAD_ID;
  const sessionSyncNonce = spawnInput.env.CLUI_PI_SESSION_SYNC_NONCE;
  if (typeof threadId !== "string" || typeof sessionSyncNonce !== "string") {
    throw new Error("Expected pi session sync identity in spawn env");
  }
  return { threadId, sessionSyncNonce };
}

function sessionSyncFilePath(stateDir: string, spawnInput: PtySpawnInput): string {
  const { sessionSyncNonce } = sessionSyncIdentity(spawnInput);
  return path.join(stateDir, "pi-session-sync", `${sessionSyncNonce}.json`);
}

async function writeSessionSync(
  stateDir: string,
  spawnInput: PtySpawnInput,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { threadId, sessionSyncNonce } = sessionSyncIdentity(spawnInput);
  await writeFile(
    sessionSyncFilePath(stateDir, spawnInput),
    JSON.stringify({
      threadId,
      sessionSyncNonce,
      sessionFile: null,
      timestamp: new Date().toISOString(),
      reason: "new",
      ...payload,
    }),
    "utf8",
  );
}

function collectEvents(runtime: PiSessionManagerRuntime): PiSessionEvent[] {
  const events: PiSessionEvent[] = [];
  runtime.on("event", (event) => events.push(event));
  return events;
}

interface FakeRpcProcess {
  readonly pid: number;
  readonly stdin: {
    writable: boolean;
    write: (data: string, callback?: (error?: Error | null) => void) => boolean;
  };
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  readonly kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals) => boolean>>;
}

function makeFakeRpcProcess(): FakeRpcProcess {
  return {
    pid: 9200,
    stdin: {
      writable: true,
      write: (_data, callback) => {
        callback?.(null);
        return true;
      },
    },
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  };
}

describe("PiSessionManagerRuntime", () => {
  let runtime: PiSessionManagerRuntime | null = null;
  let stateDir: string | null = null;

  afterEach(async () => {
    runtime?.dispose();
    runtime = null;
    vi.restoreAllMocks();
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true });
      stateDir = null;
    }
  });

  it("spawns pi with a shared per-cwd session dir without overriding the user's pi agent dir", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(stateDir, "user-agent-dir");

    try {
      await runtime.startSession({
        threadId: "thread-1",
        cwd,
        cols: 100,
        rows: 30,
      });
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }

    const spawnInput = ptyAdapter.spawnInputs[0]!;
    expect(spawnInput.shell).toBe("pi");
    expect(spawnInput.args).toEqual([
      "--session-dir",
      encodedCwdDir(stateDir, cwd),
      "--extension",
      path.join(stateDir, "pi-runtime", "clui-pi-session-sync.js"),
    ]);
    expect(spawnInput.env.PI_CODING_AGENT_DIR).toBe(path.join(stateDir, "user-agent-dir"));
    expect(spawnInput.env.CLUI_PI_THREAD_ID).toBe("thread-1");
    expect(spawnInput.env.CLUI_PI_SESSION_SYNC_DIR).toBe(path.join(stateDir, "pi-session-sync"));
    expect(spawnInput.env.CLUI_PI_SESSION_SYNC_NONCE).toEqual(expect.any(String));
    expect(spawnInput.env[CLUI_SESSION_PROCESS_REGISTRY_DIR_ENV]).toBe(
      getSessionProcessRegistryDir(stateDir),
    );
    expect(spawnInput.env[CLUI_SESSION_PROCESS_REGISTRY_OWNER_PID_ENV]).toBe(String(process.pid));
    expect(readSessionProcessRegistryEntries(getSessionProcessRegistryDir(stateDir))).toEqual([
      expect.objectContaining({ harness: "pi", threadId: "thread-1", pid: 9100 }),
    ]);

    const extensionSource = await readFile(
      path.join(stateDir, "pi-runtime", "clui-pi-session-sync.js"),
      "utf8",
    );
    expect(extensionSource).toContain("session_start");
    expect(extensionSource).toContain("tool_execution_start");
    expect(extensionSource).toContain("planreview");
    expect(extensionSource).toContain("questionnaire");
    expect(extensionSource).toContain("protectedSessionKillReason");
    expect(extensionSource).toContain("args.matchAll(/\\b\\d{2,}\\b/g)");
  });

  it("enables per-process OpenAI fast mode through the runtime extension", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });

    await runtime.startSession({
      threadId: "thread-fast",
      cwd,
      cols: 100,
      rows: 24,
      fastMode: true,
    });

    const spawnInput = ptyAdapter.spawnInputs[0]!;
    expect(spawnInput.env.CLUI_PI_FAST_MODE).toBe("1");

    const extensionSource = await readFile(
      path.join(stateDir, "pi-runtime", "clui-pi-session-sync.js"),
      "utf8",
    );
    expect(extensionSource).toContain("before_provider_request");
    expect(extensionSource).toContain("service_tier");
    expect(extensionSource).toContain("openai-codex-responses");
    expect(extensionSource).toContain("ctx.modelRegistry?.isUsingOAuth");
  });

  it("kills a live RPC child when startup fails after spawn", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });
    const fakeRpcProcess = {
      pid: 9200,
      killed: false,
      kill: vi.fn(),
    };
    const internals = runtime as unknown as {
      startRpcProcess: (entry: { rpcProcess: typeof fakeRpcProcess }) => Promise<void>;
    };
    vi.spyOn(internals, "startRpcProcess").mockImplementation(async (entry) => {
      entry.rpcProcess = fakeRpcProcess;
      throw new Error("RPC startup failed after spawn");
    });

    await expect(
      runtime.startSession({
        threadId: "thread-rpc-failure",
        cwd,
        cols: 100,
        rows: 24,
        htmlMode: true,
      }),
    ).rejects.toThrow("RPC startup failed after spawn");

    expect(fakeRpcProcess.kill).toHaveBeenCalledWith("SIGTERM");
    expect(runtime.getSessionStatus("thread-rpc-failure")).toBe("new");
  });

  it("preserves signal details when an RPC child exits from a signal", () => {
    expect(normalizeRpcProcessExit(null, "SIGTERM")).toEqual({
      exitCode: 143,
      signal: 15,
    });
    expect(normalizeRpcProcessExit(7, null)).toEqual({
      exitCode: 7,
      signal: null,
    });
  });

  it("bounds the lifetime of pending RPC requests", async () => {
    stateDir = await makeTempDir();
    runtime = new PiSessionManagerRuntime({
      ptyAdapter: new FakePtyAdapter(),
      stateDir,
      rpcRequestTimeoutMs: 10,
    });
    const rpcProcess = makeFakeRpcProcess();
    const pendingRequests = new Map<string, unknown>();
    const entry = {
      threadId: "thread-rpc-timeout",
      rpcProcess,
      rpcRequestSeq: 0,
      rpcPendingRequests: pendingRequests,
    };
    const internals = runtime as unknown as {
      sendRpcCommand: (
        rpcEntry: typeof entry,
        command: Record<string, unknown>,
      ) => Promise<unknown>;
    };

    await expect(internals.sendRpcCommand(entry, { type: "get_state" })).rejects.toThrow(
      "Pi RPC command timed out after 10ms: get_state",
    );
    expect(pendingRequests.size).toBe(0);
  });

  it("force-kills an RPC child that has not exited after SIGTERM", async () => {
    stateDir = await makeTempDir();
    runtime = new PiSessionManagerRuntime({
      ptyAdapter: new FakePtyAdapter(),
      stateDir,
      processKillGraceMs: 10,
    });
    const rpcProcess = makeFakeRpcProcess();
    const internals = runtime as unknown as {
      killRpcProcess: (process: FakeRpcProcess, threadId: string) => void;
    };

    internals.killRpcProcess(rpcProcess, "thread-rpc-kill");
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(rpcProcess.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(rpcProcess.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("uses only the launch nonce as the traversal-safe session sync basename", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });

    const start = runtime.startSession({
      threadId: "../../outside-sync-dir",
      cwd,
      cols: 100,
      rows: 24,
      initialPrompt: "safe basename",
    });
    await waitFor(() => expect(ptyAdapter.spawnInputs).toHaveLength(1));
    const spawnInput = ptyAdapter.spawnInputs[0]!;
    const { sessionSyncNonce } = sessionSyncIdentity(spawnInput);
    const syncFilePath = sessionSyncFilePath(stateDir, spawnInput);
    expect(path.dirname(syncFilePath)).toBe(path.join(stateDir, "pi-session-sync"));
    expect(path.basename(syncFilePath)).toBe(`${sessionSyncNonce}.json`);
    expect(path.basename(syncFilePath)).not.toContain("outside-sync-dir");

    const extensionSource = await readFile(
      path.join(stateDir, "pi-runtime", "clui-pi-session-sync.js"),
      "utf8",
    );
    expect(extensionSource).toContain('path.join(syncDir, sessionSyncNonce + ".json")');

    await writeSessionSync(stateDir, spawnInput);
    await start;
    expect(ptyAdapter.processes[0]!.writes).toEqual(["safe basename\x1b[13u"]);
  });

  it("removes only strict stale nonce artifacts at runtime startup", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const syncDir = path.join(stateDir, "pi-session-sync");
    await mkdir(syncDir, { recursive: true });
    const staleJson = path.join(syncDir, "00000000-0000-4000-8000-000000000001.json");
    const staleTmp = path.join(syncDir, "00000000-0000-4000-8000-000000000002.json.tmp");
    const nonStrictArtifact = path.join(
      syncDir,
      "thread.00000000-0000-4000-8000-000000000003.json",
    );
    await writeFile(staleJson, "stale", "utf8");
    await writeFile(staleTmp, "stale", "utf8");
    await writeFile(nonStrictArtifact, "keep", "utf8");

    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });
    await runtime.startSession({ threadId: "thread-1", cwd, cols: 100, rows: 24 });

    await expect(readFile(staleJson, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(staleTmp, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(nonStrictArtifact, "utf8")).resolves.toBe("keep");

    const activeSyncFile = sessionSyncFilePath(stateDir, ptyAdapter.spawnInputs[0]!);
    await writeSessionSync(stateDir, ptyAdapter.spawnInputs[0]!);
    const laterStale = path.join(syncDir, "00000000-0000-4000-8000-000000000004.json");
    await writeFile(laterStale, "stale", "utf8");
    await (
      runtime as unknown as { cleanupStaleSessionSyncArtifacts: () => Promise<void> }
    ).cleanupStaleSessionSyncArtifacts();

    await expect(readFile(laterStale, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(activeSyncFile, "utf8")).resolves.toContain('"threadId":"thread-1"');
  });

  it("resolves a terminal start without an initial prompt immediately after spawn", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });
    const events = collectEvents(runtime);

    await runtime.startSession({
      threadId: "thread-no-prompt",
      cwd,
      cols: 100,
      rows: 24,
    });

    expect(ptyAdapter.processes).toHaveLength(1);
    expect(ptyAdapter.processes[0]!.writes).toEqual([]);
    expect(events.filter((event) => event.type === "started")).toHaveLength(1);
  });

  it("waits for the exact pi launch and writes the initial prompt as CSI-u TUI input", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });
    const events = collectEvents(runtime);

    let settled = false;
    const start = runtime.startSession({
      threadId: "thread-1",
      cwd,
      cols: 100,
      rows: 24,
      initialPrompt: "/tmp/clui-images/first image.png\n/tmp/clui-images/second.png\r\n",
    });
    void start.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await waitFor(() => expect(ptyAdapter.spawnInputs).toHaveLength(1));
    const spawnInput = ptyAdapter.spawnInputs[0]!;
    expect(spawnInput.env.CLUI_PI_INITIAL_PROMPT_FILE).toBeUndefined();
    expect(spawnInput.env.CLUI_PI_SESSION_SYNC_NONCE).toEqual(expect.any(String));
    expect(ptyAdapter.processes[0]!.writes).toEqual([]);
    expect(events.filter((event) => event.type === "started")).toHaveLength(0);
    expect(() => runtime!.writeToSession("thread-1", "user input")).toThrow(
      "Initial pi prompt is still pending",
    );
    expect(ptyAdapter.processes[0]!.writes).toEqual([]);
    expect(settled).toBe(false);

    await writeSessionSync(stateDir, spawnInput);
    await start;

    expect(ptyAdapter.processes[0]!.writes).toEqual([
      "/tmp/clui-images/first image.png\x1b[13;2u/tmp/clui-images/second.png\x1b[13u",
    ]);
    expect(runtime.getSessionHookStatus("thread-1")).toBe("working");
    const workingIndex = events.findIndex(
      (event) => event.type === "hookStatus" && event.hookStatus === "working",
    );
    const startedIndex = events.findIndex((event) => event.type === "started");
    expect(workingIndex).toBeGreaterThanOrEqual(0);
    expect(startedIndex).toBeGreaterThan(workingIndex);
    expect(events.filter((event) => event.type === "started")).toHaveLength(1);

    await writeSessionSync(stateDir, spawnInput, { reason: "duplicate" });
    await new Promise((resolve) => setTimeout(resolve, 125));
    expect(ptyAdapter.processes[0]!.writes).toEqual([
      "/tmp/clui-images/first image.png\x1b[13;2u/tmp/clui-images/second.png\x1b[13u",
    ]);

    const extensionSource = await readFile(
      path.join(stateDir, "pi-runtime", "clui-pi-session-sync.js"),
      "utf8",
    );
    expect(extensionSource).not.toContain("CLUI_PI_INITIAL_PROMPT_FILE");
    expect(extensionSource).not.toContain("sendUserMessage");
  });

  it("ignores readiness payloads that do not match the launch nonce", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });

    let settled = false;
    const start = runtime.startSession({
      threadId: "thread-1",
      cwd,
      cols: 100,
      rows: 24,
      initialPrompt: "nonce-bound prompt",
    });
    void start.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await waitFor(() => expect(ptyAdapter.spawnInputs).toHaveLength(1));
    const spawnInput = ptyAdapter.spawnInputs[0]!;

    await writeSessionSync(stateDir, spawnInput, { sessionSyncNonce: undefined });
    await new Promise((resolve) => setTimeout(resolve, 125));
    expect(settled).toBe(false);
    expect(ptyAdapter.processes[0]!.writes).toEqual([]);

    await writeSessionSync(stateDir, spawnInput, { sessionSyncNonce: "stale-launch" });
    await new Promise((resolve) => setTimeout(resolve, 125));
    expect(settled).toBe(false);
    expect(ptyAdapter.processes[0]!.writes).toEqual([]);

    await writeSessionSync(stateDir, spawnInput);
    await start;
    expect(ptyAdapter.processes[0]!.writes).toEqual(["nonce-bound prompt\x1b[13u"]);
  });

  it("allows at most one readiness poll lock refresh in flight", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });

    const start = runtime.startSession({
      threadId: "thread-poll",
      cwd,
      cols: 100,
      rows: 24,
      initialPrompt: "poll once",
    });
    await waitFor(() => expect(ptyAdapter.spawnInputs).toHaveLength(1));

    let releaseRefresh!: () => void;
    const blockedRefresh = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const internals = runtime as unknown as {
      runWithThreadLock: (...args: unknown[]) => Promise<unknown>;
      refreshSessionSyncFile: (...args: unknown[]) => Promise<void>;
    };
    const lockSpy = vi.spyOn(internals, "runWithThreadLock");
    const refreshSpy = vi
      .spyOn(internals, "refreshSessionSyncFile")
      .mockImplementation(() => blockedRefresh);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(lockSpy).toHaveBeenCalledTimes(1);

    refreshSpy.mockRestore();
    lockSpy.mockRestore();
    releaseRefresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await writeSessionSync(stateDir, ptyAdapter.spawnInputs[0]!);
    await start;
    expect(ptyAdapter.processes[0]!.writes).toEqual(["poll once\x1b[13u"]);
  });

  it("keeps the readiness wait outside the thread lock so hibernate can cancel it", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });

    const start = runtime.startSession({
      threadId: "thread-1",
      cwd,
      cols: 100,
      rows: 24,
      initialPrompt: "cancel me",
    });
    const startResult = start.then(
      () => null,
      (error: unknown) => error,
    );
    await waitFor(() => expect(ptyAdapter.processes).toHaveLength(1));

    await runtime.hibernateSession("thread-1");

    const error = await startResult;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("hibernated");
    expect(runtime.getSessionStatus("thread-1")).toBe("dormant");
    expect(ptyAdapter.processes[0]!.writes).toEqual([]);
    expect(ptyAdapter.processes[0]!.killSignals).toContain("SIGTERM");
  });

  it("rejects a replaced launch without writing to or cleaning up the replacement", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({
      ptyAdapter,
      stateDir,
      initialPromptReadyTimeoutMs: 30,
    });

    const firstStart = runtime.startSession({
      threadId: "thread-1",
      cwd,
      cols: 100,
      rows: 24,
      initialPrompt: "old prompt",
    });
    const firstResult = firstStart.then(
      () => null,
      (error: unknown) => error,
    );
    await waitFor(() => expect(ptyAdapter.processes).toHaveLength(1));
    const oldSpawnInput = ptyAdapter.spawnInputs[0]!;

    await runtime.startSession({ threadId: "thread-1", cwd, cols: 100, rows: 24 });
    await writeSessionSync(stateDir, oldSpawnInput);
    await new Promise((resolve) => setTimeout(resolve, 125));

    const error = await firstResult;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("replaced");
    expect(ptyAdapter.processes[0]!.killSignals).toContain("SIGTERM");
    expect(ptyAdapter.processes[1]!.killSignals).toEqual([]);
    expect(ptyAdapter.processes[1]!.writes).toEqual([]);
    expect(runtime.getSessionStatus("thread-1")).toBe("active");
  });

  it("rejects readiness when the exact spawned process exits", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });

    const start = runtime.startSession({
      threadId: "thread-1",
      cwd,
      cols: 100,
      rows: 24,
      initialPrompt: "never written",
    });
    const startResult = start.then(
      () => null,
      (error: unknown) => error,
    );
    await waitFor(() => expect(ptyAdapter.processes).toHaveLength(1));
    const syncFilePath = sessionSyncFilePath(stateDir, ptyAdapter.spawnInputs[0]!);

    ptyAdapter.processes[0]!.emitExit({ exitCode: 17, signal: null });

    const error = await startResult;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("exited");
    expect(ptyAdapter.processes[0]!.writes).toEqual([]);
    expect(runtime.getSessionStatus("thread-1")).toBe("dormant");
    await waitFor(async () => {
      await expect(readFile(syncFilePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("times out and stops a launch that never becomes ready", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({
      ptyAdapter,
      stateDir,
      initialPromptReadyTimeoutMs: 30,
    });
    const events = collectEvents(runtime);

    await expect(
      runtime.startSession({
        threadId: "thread-1",
        cwd,
        cols: 100,
        rows: 24,
        initialPrompt: "time out",
      }),
    ).rejects.toThrow("Timed out waiting for pi terminal readiness");

    expect(ptyAdapter.processes[0]!.writes).toEqual([]);
    expect(ptyAdapter.processes[0]!.killSignals).toContain("SIGTERM");
    expect(runtime.getSessionStatus("thread-1")).toBe("new");
    expect(events.filter((event) => event.type === "started")).toHaveLength(0);
  });

  it("stops the exact launch when the initial prompt PTY write throws", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });
    const events = collectEvents(runtime);

    const start = runtime.startSession({
      threadId: "thread-1",
      cwd,
      cols: 100,
      rows: 24,
      initialPrompt: "write failure",
    });
    await waitFor(() => expect(ptyAdapter.spawnInputs).toHaveLength(1));
    ptyAdapter.processes[0]!.writeError = new Error("PTY write failed");
    const syncFilePath = sessionSyncFilePath(stateDir, ptyAdapter.spawnInputs[0]!);
    await writeSessionSync(stateDir, ptyAdapter.spawnInputs[0]!);

    await expect(start).rejects.toThrow("PTY write failed");
    expect(ptyAdapter.processes[0]!.writes).toEqual([]);
    expect(ptyAdapter.processes[0]!.killSignals).toContain("SIGTERM");
    expect(runtime.getSessionStatus("thread-1")).toBe("new");
    expect(events.filter((event) => event.type === "started")).toHaveLength(0);
    await waitFor(async () => {
      await expect(readFile(syncFilePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects pending readiness on destroy and dispose", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });

    const destroyedStart = runtime.startSession({
      threadId: "destroyed",
      cwd,
      cols: 100,
      rows: 24,
      initialPrompt: "destroy me",
    });
    const destroyedResult = destroyedStart.then(
      () => null,
      (error: unknown) => error,
    );
    await waitFor(() => expect(ptyAdapter.processes).toHaveLength(1));
    await runtime.destroySession("destroyed");
    expect((await destroyedResult) as Error).toMatchObject({
      message: expect.stringContaining("destroyed"),
    });
    expect(ptyAdapter.processes[0]!.killSignals).toContain("SIGTERM");

    const disposedStart = runtime.startSession({
      threadId: "disposed",
      cwd,
      cols: 100,
      rows: 24,
      initialPrompt: "dispose me",
    });
    const disposedResult = disposedStart.then(
      () => null,
      (error: unknown) => error,
    );
    await waitFor(() => expect(ptyAdapter.processes).toHaveLength(2));
    runtime.dispose();
    expect((await disposedResult) as Error).toMatchObject({
      message: expect.stringContaining("disposed"),
    });
    expect(ptyAdapter.processes[1]!.killSignals).toContain("SIGTERM");
  });

  it("reopens an explicit pi session file with --session", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });

    const sessionFile = path.join(stateDir, "imported", "existing.jsonl");
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(
      sessionFile,
      `{"type":"session","version":3,"id":"sess-1","timestamp":"2026-04-19T00:00:00.000Z","cwd":${JSON.stringify(cwd)}}\n`,
      "utf8",
    );

    await runtime.startSession({
      threadId: "thread-1",
      cwd,
      cols: 80,
      rows: 24,
      resumeSessionFile: sessionFile,
    });

    expect(ptyAdapter.spawnInputs[0]!.args).toEqual([
      "--session-dir",
      encodedCwdDir(stateDir, cwd),
      "--extension",
      path.join(stateDir, "pi-runtime", "clui-pi-session-sync.js"),
      "--session",
      sessionFile,
    ]);
    expect(runtime.getSessionFile("thread-1")).toBe(sessionFile);
  });

  it("does not implicitly continue another cwd session when starting a brand new pi thread", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });

    const existingSessionFile = path.join(encodedCwdDir(stateDir, cwd), "existing.jsonl");
    await mkdir(path.dirname(existingSessionFile), { recursive: true });
    await writeFile(
      existingSessionFile,
      `{"type":"session","version":3,"id":"sess-existing","timestamp":"2026-04-19T00:00:00.000Z","cwd":${JSON.stringify(cwd)}}\n`,
      "utf8",
    );

    await runtime.startSession({
      threadId: "thread-2",
      cwd,
      cols: 120,
      rows: 40,
    });

    expect(ptyAdapter.spawnInputs[0]!.args).toEqual([
      "--session-dir",
      encodedCwdDir(stateDir, cwd),
      "--extension",
      path.join(stateDir, "pi-runtime", "clui-pi-session-sync.js"),
    ]);
    expect(runtime.getSessionFile("thread-2")).toBeNull();
  });

  it("migrates legacy thread-scoped sessions into the shared per-cwd store", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });

    const legacyDir = path.join(stateDir, "pi-sessions", "thread-1");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      path.join(legacyDir, "old-session.jsonl"),
      `{"type":"session","version":3,"id":"sess-legacy","timestamp":"2026-04-19T00:00:00.000Z","cwd":${JSON.stringify(cwd)}}\n`,
      "utf8",
    );
    await writeFile(
      path.join(legacyDir, "other-project.jsonl"),
      '{"type":"session","version":3,"id":"sess-other","timestamp":"2026-04-19T00:00:00.000Z","cwd":"/tmp/other-project"}\n',
      "utf8",
    );

    await runtime.startSession({
      threadId: "thread-1",
      cwd,
      cols: 120,
      rows: 40,
    });

    const migratedFile = path.join(encodedCwdDir(stateDir, cwd), "old-session.jsonl");
    expect(ptyAdapter.spawnInputs[0]!.args).toEqual([
      "--session-dir",
      encodedCwdDir(stateDir, cwd),
      "--extension",
      path.join(stateDir, "pi-runtime", "clui-pi-session-sync.js"),
      "--session",
      migratedFile,
    ]);
    expect(await readFile(migratedFile, "utf8")).toContain('"sess-legacy"');
    expect(runtime.getSessionFile("thread-1")).toBe(migratedFile);
  });

  it("treats resize from a visible terminal as LRU interaction", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir, maxActiveSessions: 100 });
    const now = vi.spyOn(Date, "now");

    now.mockReturnValue(1_000);
    await runtime.startSession({ threadId: "thread-1", cwd, cols: 100, rows: 24 });
    now.mockReturnValue(2_000);
    await runtime.startSession({ threadId: "thread-2", cwd, cols: 100, rows: 24 });
    now.mockReturnValue(3_000);
    await runtime.startSession({ threadId: "thread-3", cwd, cols: 100, rows: 24 });

    now.mockReturnValue(4_000);
    runtime.resizeSession("thread-1", 120, 40);
    runtime.resizeSession("thread-1", 120, 40);
    expect(ptyAdapter.processes[0]!.resizeCalls).toEqual([{ cols: 120, rows: 40 }]);
    await runtime.reconcileActiveSessions(1);

    expect(runtime.getSessionStatus("thread-1")).toBe("active");
    expect(runtime.getSessionStatus("thread-2")).toBe("dormant");
    expect(runtime.getSessionStatus("thread-3")).toBe("dormant");
  });

  it("does not treat background output as LRU interaction", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir, maxActiveSessions: 100 });
    const now = vi.spyOn(Date, "now");

    now.mockReturnValue(1_000);
    await runtime.startSession({ threadId: "thread-1", cwd, cols: 100, rows: 24 });
    now.mockReturnValue(2_000);
    await runtime.startSession({ threadId: "thread-2", cwd, cols: 100, rows: 24 });
    now.mockReturnValue(3_000);
    await runtime.startSession({ threadId: "thread-3", cwd, cols: 100, rows: 24 });

    now.mockReturnValue(4_000);
    ptyAdapter.processes[0]!.emitData("background output");
    await runtime.reconcileActiveSessions(2);

    expect(runtime.getSessionStatus("thread-1")).toBe("dormant");
    expect(runtime.getSessionStatus("thread-2")).toBe("active");
    expect(runtime.getSessionStatus("thread-3")).toBe("active");
  });

  it("infers working hook status from the pi terminal status line", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });
    const events = collectEvents(runtime);

    await runtime.startSession({ threadId: "thread-1", cwd, cols: 100, rows: 24 });
    ptyAdapter.processes[0]!.emitData("\x1b[2K\rWorking....");

    const hookIndex = events.findIndex(
      (event) => event.type === "hookStatus" && event.hookStatus === "working",
    );
    const outputIndex = events.findIndex(
      (event) => event.type === "output" && event.data.includes("Working"),
    );

    expect(hookIndex).toBeGreaterThanOrEqual(0);
    expect(outputIndex).toBeGreaterThanOrEqual(0);
    expect(hookIndex).toBeLessThan(outputIndex);
  });

  it("infers working hook status from pi's spinner status line", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });
    const events = collectEvents(runtime);

    await runtime.startSession({ threadId: "thread-1", cwd, cols: 100, rows: 24 });
    ptyAdapter.processes[0]!.emitData(
      "\x1b[?2026h\r\x1b[2K ⠧ \x1b[38;2;128;128;128mWorking...\x1b[39m",
    );

    const hookIndex = events.findIndex(
      (event) => event.type === "hookStatus" && event.hookStatus === "working",
    );
    const outputIndex = events.findIndex(
      (event) => event.type === "output" && event.data.includes("Working"),
    );

    expect(hookIndex).toBeGreaterThanOrEqual(0);
    expect(outputIndex).toBeGreaterThanOrEqual(0);
    expect(hookIndex).toBeLessThan(outputIndex);
  });

  it("does not infer working hook status from ordinary text", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });
    const events = collectEvents(runtime);

    await runtime.startSession({ threadId: "thread-1", cwd, cols: 100, rows: 24 });
    ptyAdapter.processes[0]!.emitData("Working...\nWorking through the plan\n");

    expect(events.some((event) => event.type === "hookStatus")).toBe(false);
  });

  it("does not let stale terminal output revive a completed pi turn", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });
    const events = collectEvents(runtime);

    await runtime.startSession({ threadId: "thread-1", cwd, cols: 100, rows: 24 });
    ptyAdapter.processes[0]!.emitData("\x1b[2K\rWorking....");

    const runtimeInternals = runtime as unknown as {
      sessions: Map<string, unknown>;
      handleRpcEvent: (entry: unknown, event: Record<string, unknown>) => void;
    };
    const entry = runtimeInternals.sessions.get("thread-1");
    expect(entry).toBeDefined();

    runtimeInternals.handleRpcEvent(entry, { type: "agent_end" });
    ptyAdapter.processes[0]!.emitData("Final answer\n");

    const statuses = events
      .filter((event) => event.type === "hookStatus")
      .map((event) => event.hookStatus);
    expect(statuses).toEqual(["working", "completed"]);
  });

  it("keeps scrollback readable after hibernation", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });

    await runtime.startSession({ threadId: "thread-1", cwd, cols: 100, rows: 24 });
    ptyAdapter.processes[0]!.emitData("hello pi\n");

    await runtime.hibernateSession("thread-1");

    expect(runtime.getSessionStatus("thread-1")).toBe("dormant");
    expect(runtime.getScrollback("thread-1").scrollback).toContain("hello pi");
  });

  it("tracks active session file updates from the pi sync sidecar", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });
    const events = collectEvents(runtime);

    await runtime.startSession({
      threadId: "thread-1",
      cwd,
      cols: 100,
      rows: 24,
    });

    const sessionFile = path.join(encodedCwdDir(stateDir, cwd), "picked.jsonl");
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(
      sessionFile,
      `{"type":"session","version":3,"id":"sess-picked","timestamp":"2026-04-19T00:00:00.000Z","cwd":${JSON.stringify(cwd)}}\n`,
      "utf8",
    );
    await writeSessionSync(stateDir, ptyAdapter.spawnInputs[0]!, {
      sessionFile,
      reason: "resume",
    });

    await waitFor(() => {
      expect(runtime!.getSessionFile("thread-1")).toBe(sessionFile);
      expect(
        events.some((event) => event.type === "sessionFile" && event.sessionFile === sessionFile),
      ).toBe(true);
    });
  });

  it("tracks activity updates from the pi sync sidecar", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });
    const events = collectEvents(runtime);

    await runtime.startSession({
      threadId: "thread-1",
      cwd,
      cols: 100,
      rows: 24,
    });

    await writeSessionSync(stateDir, ptyAdapter.spawnInputs[0]!, {
      reason: "tool_call:Bash",
      toolName: "Bash",
      toolInputCommand: "git commit -m test",
    });

    await waitFor(() => {
      expect(
        events.some(
          (event) => event.type === "activityStatus" && event.activityStatus === "committing",
        ),
      ).toBe(true);
    });

    await writeSessionSync(stateDir, ptyAdapter.spawnInputs[0]!, {
      reason: "tool_call:subagent",
      toolName: "subagent",
      toolInputAgent: "reviewer",
    });

    await waitFor(() => {
      expect(
        events.some(
          (event) => event.type === "activityStatus" && event.activityStatus === "reviewing",
        ),
      ).toBe(true);
    });

    await writeSessionSync(stateDir, ptyAdapter.spawnInputs[0]!, {
      reason: "provider_request",
    });

    await waitFor(() => {
      expect(
        events.some(
          (event) => event.type === "activityStatus" && event.activityStatus === "thinking",
        ),
      ).toBe(true);
    });
  });

  it("tracks hook status updates from the pi sync sidecar without a session-file change", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });
    const events = collectEvents(runtime);

    await runtime.startSession({
      threadId: "thread-1",
      cwd,
      cols: 100,
      rows: 24,
    });

    await writeSessionSync(stateDir, ptyAdapter.spawnInputs[0]!, {
      reason: "tool_input:questionnaire",
      hookStatus: "needsInput",
    });

    await waitFor(() => {
      const statuses = events
        .filter((event) => event.type === "hookStatus")
        .map((event) => event.hookStatus);
      expect(statuses).toContain("needsInput");
    });

    ptyAdapter.processes[0]!.emitData(
      "\x1b[?2026h\r\x1b[2K ⠧ \x1b[38;2;128;128;128mWorking...\x1b[39m",
    );
    expect(runtime.getSessionHookStatus("thread-1")).toBe("needsInput");

    await writeSessionSync(stateDir, ptyAdapter.spawnInputs[0]!, {
      reason: "tool_input_resolved:questionnaire",
      hookStatus: "working",
    });

    await waitFor(() => {
      const statuses = events
        .filter((event) => event.type === "hookStatus")
        .map((event) => event.hookStatus);
      expect(statuses.at(-1)).toBe("working");
    });
  });

  it("keeps RPC extension status and widget updates separate from pending dialogs", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });
    const events = collectEvents(runtime);

    await runtime.startSession({
      threadId: "thread-1",
      cwd,
      cols: 100,
      rows: 24,
    });

    const runtimeInternals = runtime as unknown as {
      sessions: Map<
        string,
        {
          mode: "terminal" | "rpc";
          rpcProcess: object | null;
        }
      >;
      handleRpcEvent: (entry: unknown, event: Record<string, unknown>) => void;
      sendRpcNotification: (entry: unknown, payload: Record<string, unknown>) => void;
    };
    const entry = runtimeInternals.sessions.get("thread-1");
    expect(entry).toBeDefined();

    runtimeInternals.handleRpcEvent(entry, {
      type: "extension_ui_request",
      id: "status-1",
      method: "setStatus",
      statusKey: "codex-usage",
      statusText: "Codex ok",
    });
    runtimeInternals.handleRpcEvent(entry, {
      type: "extension_ui_request",
      id: "widget-1",
      method: "setWidget",
      widgetKey: "subagent-async",
      widgetLines: ["Async subagents", "- abc running"],
      widgetPlacement: "belowEditor",
    });

    expect(runtime.getPendingExtensionUiRequest("thread-1")).toBeNull();
    expect(runtime.getExtensionUiState("thread-1")).toEqual({
      statuses: { "codex-usage": "Codex ok" },
      widgets: [
        {
          key: "subagent-async",
          lines: ["Async subagents", "- abc running"],
          placement: "belowEditor",
        },
      ],
    });

    runtimeInternals.handleRpcEvent(entry, {
      type: "extension_ui_request",
      id: "dialog-1",
      method: "select",
      title: "Choose",
      options: ["Alpha", "Beta"],
    });

    expect(runtime.getPendingExtensionUiRequest("thread-1")).toEqual({
      type: "extension_ui_request",
      id: "dialog-1",
      method: "select",
      title: "Choose",
      options: ["Alpha", "Beta"],
    });
    expect(
      events.filter((event) => event.type === "hookStatus").map((event) => event.hookStatus),
    ).toEqual(["needsInput"]);
    expect(runtime.getExtensionUiState("thread-1").statuses).toEqual({ "codex-usage": "Codex ok" });

    runtimeInternals.handleRpcEvent(entry, {
      type: "message_update",
      message: { role: "assistant", content: [] },
    });
    runtimeInternals.handleRpcEvent(entry, {
      type: "extension_ui_request",
      id: "status-2",
      method: "setStatus",
      statusKey: "codex-usage",
    });
    runtimeInternals.handleRpcEvent(entry, {
      type: "extension_ui_request",
      id: "widget-2",
      method: "setWidget",
      widgetKey: "subagent-async",
    });

    expect(runtime.getPendingExtensionUiRequest("thread-1")?.id).toBe("dialog-1");
    expect(runtime.getExtensionUiState("thread-1")).toEqual({ statuses: {}, widgets: [] });
    expect(
      events.filter((event) => event.type === "hookStatus").map((event) => event.hookStatus),
    ).toEqual(["needsInput"]);

    vi.spyOn(runtimeInternals, "sendRpcNotification").mockImplementation(() => undefined);
    entry!.mode = "rpc";
    entry!.rpcProcess = {};
    await runtime.respondExtensionUi("thread-1", { id: "dialog-1", value: "Alpha" });
    entry!.rpcProcess = null;
    entry!.mode = "terminal";

    expect(runtime.getPendingExtensionUiRequest("thread-1")).toBeNull();
    expect(
      events.filter((event) => event.type === "hookStatus").map((event) => event.hookStatus),
    ).toEqual(["needsInput", "working"]);
  });
});
