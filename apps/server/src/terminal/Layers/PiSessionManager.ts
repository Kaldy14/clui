import { EventEmitter } from "node:events";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import type { ClaudeHookStatus, PiSessionEvent, TerminalStatus } from "@clui/contracts";
import { Effect, Layer } from "effect";

import { createLogger } from "../../logger";
import { ServerConfig } from "../../config";
import { PtyAdapter, type PtyAdapterShape, type PtyExitEvent, type PtyProcess } from "../Services/PTY";
import {
  PiSessionError,
  PiSessionManager,
  type PiSessionManagerShape,
  type PiSessionState,
} from "../Services/PiSession";
import { assertValidCwd, createSpawnEnv, runWithThreadLock } from "../terminalUtils";
import { PiSessionJsonlHookWatcher } from "../../PiSessionJsonlHook";

const DEFAULT_HISTORY_LINE_LIMIT = 200_000;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_ACTIVE_SESSIONS = 10;

class ScrollbackRingBuffer {
  private lines: string[] = [];
  private partial = "";
  private readonly maxLines: number;
  private _totalBytes = 0;
  private _droppedBytes = 0;

  constructor(maxLines: number) {
    this.maxLines = maxLines;
  }

  append(data: string): void {
    this._totalBytes += data.length;
    const combined = this.partial + data;
    const parts = combined.split("\n");
    this.partial = parts.pop()!;
    for (const line of parts) this.lines.push(line);
    if (this.lines.length > this.maxLines) {
      const dropped = this.lines.slice(0, this.lines.length - this.maxLines);
      for (const line of dropped) this._droppedBytes += line.length + 1;
      this.lines = this.lines.slice(this.lines.length - this.maxLines);
    }
  }

  get offset(): number {
    return this._totalBytes;
  }

  materialize(): string {
    if (this.lines.length === 0) return this.partial;
    const joined = this.lines.join("\n");
    return this.partial.length > 0 ? `${joined}\n${this.partial}` : `${joined}\n`;
  }

  materializeSince(sinceOffset: number): string | null {
    if (sinceOffset > this._totalBytes) return null;
    if (sinceOffset === this._totalBytes) return "";
    const currentData = this.materialize();
    const availableStart = this._totalBytes - currentData.length;
    if (sinceOffset < availableStart) return null;
    return currentData.slice(sinceOffset - availableStart);
  }

  clear(): void {
    this.lines = [];
    this.partial = "";
    this._totalBytes = 0;
    this._droppedBytes = 0;
  }
}

interface PiSessionEntry extends PiSessionState {
  scrollbackBuffer: ScrollbackRingBuffer;
  process: PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hookStatus: ClaudeHookStatus | null;
  /** Absolute path `<state>/pi-sessions/<threadId>` for JSONL hook watching. */
  sessionDir: string | null;
  jsonlHookWatcher: PiSessionJsonlHookWatcher | null;
}

interface PiSessionManagerEvents {
  event: [event: PiSessionEvent];
}

interface PiSessionManagerOptions {
  ptyAdapter: PtyAdapterShape;
  stateDir: string;
  processKillGraceMs?: number;
  historyLineLimit?: number;
  maxActiveSessions?: number;
}

export class PiSessionManagerRuntime extends EventEmitter<PiSessionManagerEvents> {
  private readonly sessions = new Map<string, PiSessionEntry>();
  private readonly threadLocks = new Map<string, Promise<void>>();
  private readonly killEscalationTimers = new Map<PtyProcess, ReturnType<typeof setTimeout>>();
  private readonly ptyAdapter: PtyAdapterShape;
  private readonly processKillGraceMs: number;
  private readonly historyLineLimit: number;
  private readonly maxActiveSessions: number;
  private readonly sessionsRootDir: string;
  private readonly logger = createLogger("pi-session");

  constructor(options: PiSessionManagerOptions) {
    super();
    this.ptyAdapter = options.ptyAdapter;
    this.processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
    this.historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
    this.maxActiveSessions = options.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS;
    this.sessionsRootDir = path.join(options.stateDir, "pi-sessions");
  }

  async startSession(input: {
    threadId: string;
    cwd: string;
    cols: number;
    rows: number;
    fresh?: boolean;
  }): Promise<void> {
    await this.runWithThreadLock(input.threadId, async () => {
      const existing = this.sessions.get(input.threadId);
      if (existing?.process) {
        this.stopProcess(existing);
      }

      const entry: PiSessionEntry = existing ?? {
        threadId: input.threadId,
        lastInteractedAt: Date.now(),
        scrollbackBuffer: new ScrollbackRingBuffer(this.historyLineLimit),
        cols: input.cols,
        rows: input.rows,
        status: "active" as TerminalStatus,
        process: null,
        unsubscribeData: null,
        unsubscribeExit: null,
        hookStatus: null,
        sessionDir: null,
        jsonlHookWatcher: null,
      };

      entry.cols = input.cols;
      entry.rows = input.rows;
      entry.status = "active";
      entry.lastInteractedAt = Date.now();
      if (existing) {
        entry.scrollbackBuffer.clear();
        this.resetHookStatus(entry);
      }
      this.sessions.set(input.threadId, entry);

      const sessionDir = path.join(this.sessionsRootDir, input.threadId);
      entry.sessionDir = sessionDir;
      await mkdir(sessionDir, { recursive: true });
      const existingSessions = await this.listSessionFiles(sessionDir);

      const args: string[] = ["--session-dir", sessionDir];
      if (!input.fresh && existingSessions.length > 0) {
        args.push("-c");
      }

      try {
        await assertValidCwd(input.cwd);

        const spawnEnv = createSpawnEnv(process.env);
        const ptyProcess = await Effect.runPromise(
          this.ptyAdapter.spawn({
            shell: "pi",
            args,
            cwd: input.cwd,
            cols: input.cols,
            rows: input.rows,
            env: spawnEnv,
          }),
        );

        entry.process = ptyProcess;
        entry.unsubscribeData = ptyProcess.onData((data) => {
          this.onProcessData(entry, data);
        });
        const expectedProcess = ptyProcess;
        entry.unsubscribeExit = ptyProcess.onExit((event) => {
          if (entry.process !== expectedProcess) return;
          this.onProcessExit(entry, event);
        });

        this.logger.info("pi session started", {
          threadId: input.threadId,
          pid: ptyProcess.pid,
          resumed: !input.fresh && existingSessions.length > 0,
          sessionDir,
        });

        this.emitEvent({
          type: "started",
          threadId: input.threadId,
          createdAt: new Date().toISOString(),
        });

        this.startJsonlHookWatcher(entry, sessionDir);

        void this.reconcileActiveSessions(this.maxActiveSessions);
      } catch (error) {
        entry.status = "new";
        entry.process = null;
        const message = error instanceof Error ? error.message : "Failed to start pi session";
        this.logger.error("failed to start pi session", {
          threadId: input.threadId,
          error: message,
        });
        this.emitEvent({
          type: "error",
          threadId: input.threadId,
          createdAt: new Date().toISOString(),
          message,
        });
        throw new Error(message, { cause: error });
      }
    });
  }

  async hibernateSession(threadId: string): Promise<string> {
    return this.runWithThreadLock(threadId, async () => {
      const entry = this.sessions.get(threadId);
      if (!entry) {
        throw new Error(`No session found for thread: ${threadId}`);
      }

      const scrollback = entry.scrollbackBuffer.materialize();
      entry.scrollbackBuffer.clear();
      this.stopProcess(entry);
      entry.status = "dormant";

      this.logger.info("pi session hibernated", { threadId });
      this.emitEvent({ type: "hibernated", threadId, createdAt: new Date().toISOString() });
      return scrollback;
    });
  }

  getScrollback(threadId: string, sinceOffset?: number): { scrollback: string | null; offset: number; reset: boolean } {
    const entry = this.sessions.get(threadId);
    if (!entry) return { scrollback: null, offset: 0, reset: false };
    const offset = entry.scrollbackBuffer.offset;
    if (sinceOffset != null) {
      const delta = entry.scrollbackBuffer.materializeSince(sinceOffset);
      if (delta != null) return { scrollback: delta, offset, reset: false };
      return { scrollback: entry.scrollbackBuffer.materialize(), offset, reset: true };
    }
    return { scrollback: entry.scrollbackBuffer.materialize(), offset, reset: false };
  }

  writeToSession(threadId: string, data: string): void {
    const entry = this.sessions.get(threadId);
    if (!entry || !entry.process || entry.status !== "active") {
      throw new Error(`No active session for thread: ${threadId}`);
    }
    entry.process.write(data);
    entry.lastInteractedAt = Date.now();
  }

  /**
   * Called when the web client has sent a non-empty first line ending in newline
   * (see `advancePiWritePromptBuffer`). Covers pi's on-disk deferral of the first
   * user message until the first assistant response exists.
   */
  async notifyPromptSubmitted(threadId: string): Promise<void> {
    await this.runWithThreadLock(threadId, async () => {
      const entry = this.sessions.get(threadId);
      if (!entry?.process || entry.status !== "active") return;
      this.applyHookStatusIfChanged(entry, "working");
    });
  }

  resizeSession(threadId: string, cols: number, rows: number): void {
    const entry = this.sessions.get(threadId);
    if (!entry || !entry.process || entry.status !== "active") {
      throw new Error(`No active session for thread: ${threadId}`);
    }
    entry.cols = cols;
    entry.rows = rows;
    entry.process.resize(cols, rows);
  }

  getSessionStatus(threadId: string): TerminalStatus {
    const entry = this.sessions.get(threadId);
    return entry?.status ?? "new";
  }

  async reconcileActiveSessions(maxActive: number): Promise<void> {
    const activeSessions = [...this.sessions.values()].filter(
      (entry) => entry.status === "active" && entry.process !== null,
    );
    if (activeSessions.length <= maxActive) return;
    const sorted = activeSessions.toSorted((a, b) => a.lastInteractedAt - b.lastInteractedAt);
    const toHibernate = sorted.slice(0, sorted.length - maxActive);
    for (const entry of toHibernate) {
      await this.hibernateSession(entry.threadId);
    }
  }

  async hibernateAll(): Promise<void> {
    const activeSessions = [...this.sessions.values()].filter(
      (entry) => entry.status === "active" && entry.process !== null,
    );
    const TIMEOUT_MS = 5_000;
    const results = await Promise.race([
      Promise.allSettled(activeSessions.map((entry) => this.hibernateSession(entry.threadId))),
      new Promise<PromiseSettledResult<string>[]>((resolve) =>
        setTimeout(() => {
          for (const entry of activeSessions) {
            if (entry.process) this.stopProcess(entry);
          }
          resolve(
            activeSessions.map(() => ({
              status: "rejected" as const,
              reason: new Error("timeout"),
            })),
          );
        }, TIMEOUT_MS),
      ),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        this.logger.warn("failed to hibernate pi session during hibernateAll", {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  }

  async destroySession(threadId: string): Promise<void> {
    await this.runWithThreadLock(threadId, async () => {
      const entry = this.sessions.get(threadId);
      if (!entry) return;
      this.stopProcess(entry);
      this.sessions.delete(threadId);
    });
  }

  async purgeInactiveSessions(excludeThreadIds: ReadonlySet<string>): Promise<number> {
    const candidates = [...this.sessions.entries()]
      .filter(([id, e]) => !excludeThreadIds.has(id) && e.status !== "active")
      .map(([id]) => id);
    let killed = 0;
    for (const threadId of candidates) {
      await this.runWithThreadLock(threadId, async () => {
        const current = this.sessions.get(threadId);
        if (!current || current.status === "active") return;
        this.stopProcess(current);
        this.sessions.delete(threadId);
        killed++;
      });
    }
    return killed;
  }

  dispose(): void {
    for (const entry of this.sessions.values()) {
      this.stopJsonlHookWatcher(entry);
      this.stopProcess(entry);
    }
    this.sessions.clear();
    for (const timer of this.killEscalationTimers.values()) clearTimeout(timer);
    this.killEscalationTimers.clear();
    this.threadLocks.clear();
  }

  private async listSessionFiles(sessionDir: string): Promise<string[]> {
    try {
      const entries = await readdir(sessionDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => entry.name)
        .toSorted();
    } catch {
      return [];
    }
  }

  private onProcessData(entry: PiSessionEntry, data: string): void {
    entry.scrollbackBuffer.append(data);
    entry.lastInteractedAt = Date.now();
    this.emitEvent({
      type: "output",
      threadId: entry.threadId,
      createdAt: new Date().toISOString(),
      data,
      offset: entry.scrollbackBuffer.offset,
    });
  }

  private applyHookStatusIfChanged(entry: PiSessionEntry, status: ClaudeHookStatus): void {
    if (entry.hookStatus === status) return;
    entry.hookStatus = status;
    this.emitEvent({
      type: "hookStatus",
      threadId: entry.threadId,
      createdAt: new Date().toISOString(),
      hookStatus: status,
    });
  }

  private startJsonlHookWatcher(entry: PiSessionEntry, sessionDir: string): void {
    this.stopJsonlHookWatcher(entry);
    const watcher = new PiSessionJsonlHookWatcher({
      threadId: entry.threadId,
      sessionDir,
      logger: this.logger,
      emitHookStatus: (event) => {
        if (event.type !== "hookStatus" || event.hookStatus == null) return;
        const current = this.sessions.get(event.threadId);
        if (!current) return;
        this.applyHookStatusIfChanged(current, event.hookStatus);
      },
    });
    entry.jsonlHookWatcher = watcher;
    watcher.start();
  }

  private stopJsonlHookWatcher(entry: PiSessionEntry): void {
    entry.jsonlHookWatcher?.stop();
    entry.jsonlHookWatcher = null;
  }

  private resetHookStatus(entry: PiSessionEntry): void {
    this.stopJsonlHookWatcher(entry);
    entry.hookStatus = null;
  }

  private onProcessExit(entry: PiSessionEntry, event: PtyExitEvent): void {
    this.cleanupProcessHandles(entry);
    this.clearKillEscalationTimer(entry.process);
    entry.process = null;
    entry.status = "dormant";
    this.resetHookStatus(entry);

    this.logger.info("pi session exited", {
      threadId: entry.threadId,
      exitCode: event.exitCode,
      signal: event.signal,
    });

    this.emitEvent({
      type: "exited",
      threadId: entry.threadId,
      createdAt: new Date().toISOString(),
      exitCode: Number.isInteger(event.exitCode) ? event.exitCode : null,
    });
  }

  private stopProcess(entry: PiSessionEntry): void {
    this.stopJsonlHookWatcher(entry);
    const ptyProcess = entry.process;
    if (!ptyProcess) {
      this.resetHookStatus(entry);
      return;
    }
    this.cleanupProcessHandles(entry);
    entry.process = null;
    this.resetHookStatus(entry);
    this.killProcessWithEscalation(ptyProcess, entry.threadId);
  }

  private cleanupProcessHandles(entry: PiSessionEntry): void {
    entry.unsubscribeData?.();
    entry.unsubscribeData = null;
    entry.unsubscribeExit?.();
    entry.unsubscribeExit = null;
  }

  private clearKillEscalationTimer(process: PtyProcess | null): void {
    if (!process) return;
    const timer = this.killEscalationTimers.get(process);
    if (!timer) return;
    clearTimeout(timer);
    this.killEscalationTimers.delete(process);
  }

  private killProcessWithEscalation(ptyProcess: PtyProcess, threadId: string): void {
    this.clearKillEscalationTimer(ptyProcess);
    try {
      ptyProcess.kill("SIGTERM");
    } catch (error) {
      this.logger.warn("failed to kill pi process", {
        threadId,
        signal: "SIGTERM",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const timer = setTimeout(() => {
      this.killEscalationTimers.delete(ptyProcess);
      try {
        ptyProcess.kill("SIGKILL");
      } catch (error) {
        this.logger.warn("failed to force-kill pi process", {
          threadId,
          signal: "SIGKILL",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, this.processKillGraceMs);
    timer.unref?.();
    this.killEscalationTimers.set(ptyProcess, timer);
  }

  private emitEvent(event: PiSessionEvent): void {
    this.emit("event", event);
  }

  private runWithThreadLock<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    return runWithThreadLock(this.threadLocks, threadId, task);
  }
}

export const PiSessionManagerLive = Layer.effect(
  PiSessionManager,
  Effect.gen(function* () {
    const ptyAdapter = yield* PtyAdapter;
    const serverConfig = yield* ServerConfig;

    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() =>
        new PiSessionManagerRuntime({
          ptyAdapter,
          stateDir: serverConfig.stateDir,
        }),
      ),
      (r) => Effect.sync(() => r.dispose()),
    );

    return {
      startSession: (input) =>
        Effect.tryPromise({
          try: () => runtime.startSession(input),
          catch: (cause) => new PiSessionError({ message: "Failed to start pi session", cause }),
        }),
      hibernateSession: (threadId) =>
        Effect.tryPromise({
          try: () => runtime.hibernateSession(threadId),
          catch: (cause) =>
            new PiSessionError({ message: "Failed to hibernate pi session", cause }),
        }),
      getScrollback: (threadId, sinceOffset) => Effect.sync(() => runtime.getScrollback(threadId, sinceOffset)),
      writeToSession: (threadId, data) =>
        Effect.try({
          try: () => runtime.writeToSession(threadId, data),
          catch: (cause) => new PiSessionError({ message: "Failed to write to pi session", cause }),
        }),
      notifyPromptSubmitted: (threadId) =>
        Effect.tryPromise({
          try: () => runtime.notifyPromptSubmitted(threadId),
          catch: (cause) =>
            new PiSessionError({ message: "Failed to record pi prompt submit", cause }),
        }),
      resizeSession: (threadId, cols, rows) =>
        Effect.try({
          try: () => runtime.resizeSession(threadId, cols, rows),
          catch: (cause) => new PiSessionError({ message: "Failed to resize pi session", cause }),
        }),
      getSessionStatus: (threadId) => Effect.sync(() => runtime.getSessionStatus(threadId)),
      reconcileActiveSessions: (maxActive) => Effect.promise(() => runtime.reconcileActiveSessions(maxActive)),
      hibernateAll: () => Effect.promise(() => runtime.hibernateAll()),
      subscribe: (listener) =>
        Effect.sync(() => {
          runtime.on("event", listener);
          return () => {
            runtime.off("event", listener);
          };
        }),
      destroySession: (threadId) => Effect.promise(() => runtime.destroySession(threadId)),
      purgeInactiveSessions: (excludeThreadIds) =>
        Effect.promise(() => runtime.purgeInactiveSessions(excludeThreadIds)),
      dispose: Effect.sync(() => runtime.dispose()),
    } satisfies PiSessionManagerShape;
  }),
);
