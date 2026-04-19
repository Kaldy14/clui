import { afterEach, describe, expect, it } from "vitest";
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
import { PiSessionManagerRuntime } from "./PiSessionManager";

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  readonly killSignals: Array<string | undefined> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();

  constructor(readonly pid: number) {}

  write(data: string): void {
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

function collectEvents(runtime: PiSessionManagerRuntime): PiSessionEvent[] {
  const events: PiSessionEvent[] = [];
  runtime.on("event", (event) => events.push(event));
  return events;
}

describe("PiSessionManagerRuntime", () => {
  let runtime: PiSessionManagerRuntime | null = null;
  let stateDir: string | null = null;

  afterEach(async () => {
    runtime?.dispose();
    runtime = null;
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true });
      stateDir = null;
    }
  });

  it("spawns pi with a shared per-cwd session dir and pi agent dir override", async () => {
    stateDir = await makeTempDir();
    const cwd = await makeProjectCwd(stateDir);
    const ptyAdapter = new FakePtyAdapter();
    runtime = new PiSessionManagerRuntime({ ptyAdapter, stateDir });

    await runtime.startSession({
      threadId: "thread-1",
      cwd,
      cols: 100,
      rows: 30,
    });

    const spawnInput = ptyAdapter.spawnInputs[0]!;
    expect(spawnInput.shell).toBe("pi");
    expect(spawnInput.args).toEqual([
      "--session-dir",
      encodedCwdDir(stateDir, cwd),
      "--extension",
      path.join(stateDir, "pi-runtime", "clui-pi-session-sync.js"),
    ]);
    expect(spawnInput.env.PI_CODING_AGENT_DIR).toBe(path.join(stateDir, "pi-agent"));
    expect(spawnInput.env.CLUI_PI_THREAD_ID).toBe("thread-1");
    expect(spawnInput.env.CLUI_PI_SESSION_SYNC_DIR).toBe(path.join(stateDir, "pi-session-sync"));

    const extensionSource = await readFile(
      path.join(stateDir, "pi-runtime", "clui-pi-session-sync.js"),
      "utf8",
    );
    expect(extensionSource).toContain("session_start");
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
    await writeFile(
      path.join(stateDir, "pi-session-sync", "thread-1.json"),
      JSON.stringify({
        threadId: "thread-1",
        sessionFile,
        timestamp: new Date().toISOString(),
        reason: "resume",
      }),
      "utf8",
    );

    await waitFor(() => {
      expect(runtime!.getSessionFile("thread-1")).toBe(sessionFile);
      expect(events.some((event) => event.type === "sessionFile" && event.sessionFile === sessionFile)).toBe(true);
    });
  });
});
