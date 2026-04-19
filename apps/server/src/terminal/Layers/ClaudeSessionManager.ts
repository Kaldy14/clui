import { EventEmitter } from "node:events";

import type { ClaudeSessionEvent, TerminalStatus } from "@clui/contracts";
import { Effect, Layer } from "effect";

import { createLogger } from "../../logger";
import { buildHookSettingsJson } from "../../hooks/hookSettings";
import { loadServerSettings } from "../../serverSettings";
import { PtyAdapter, type PtyAdapterShape, type PtyExitEvent, type PtyProcess } from "../Services/PTY";
import {
  ClaudeSessionError,
  ClaudeSessionManager,
  type ClaudeSessionManagerShape,
  type ClaudeSessionState,
} from "../Services/ClaudeSession";
import { assertValidCwd, createSpawnEnv, runWithThreadLock } from "../terminalUtils";
import { ServerConfig } from "../../config";

const DEFAULT_HISTORY_LINE_LIMIT = 200_000;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_ACTIVE_SESSIONS = 10;

// ── ScrollbackRingBuffer ──────────────────────────────────────────────

class ScrollbackRingBuffer {
  private lines: string[] = [];
  private partial = "";
  private readonly maxLines: number;
  /** Monotonic byte counter — total bytes ever appended (never resets on trim). */
  private _totalBytes = 0;
  /** Bytes that were dropped when the ring buffer trimmed old lines. */
  private _droppedBytes = 0;

  constructor(maxLines: number) {
    this.maxLines = maxLines;
  }

  append(data: string): void {
    this._totalBytes += data.length;
    const combined = this.partial + data;
    const parts = combined.split("\n");
    // Last element is the partial (incomplete line)
    this.partial = parts.pop()!;
    // Everything else is complete lines
    for (const line of parts) {
      this.lines.push(line);
    }
    // Trim if over limit
    if (this.lines.length > this.maxLines) {
      const dropped = this.lines.slice(0, this.lines.length - this.maxLines);
      // +1 per line for the '\n' delimiter that was split away
      for (const line of dropped) {
        this._droppedBytes += line.length + 1;
      }
      this.lines = this.lines.slice(this.lines.length - this.maxLines);
    }
  }

  /** Current byte offset — the total number of bytes appended so far. */
  get offset(): number {
    return this._totalBytes;
  }

  materialize(): string {
    if (this.lines.length === 0) return this.partial;
    const joined = this.lines.join("\n");
    return this.partial.length > 0 ? `${joined}\n${this.partial}` : `${joined}\n`;
  }

  /**
   * Return only the data appended since `sinceOffset` bytes. If the requested
   * offset is older than what the ring buffer still holds (lines were trimmed),
   * returns `null` to signal the caller must do a full reset.
   */
  materializeSince(sinceOffset: number): string | null {
    if (sinceOffset > this._totalBytes) return null; // stale offset from previous session — force full reset
    if (sinceOffset === this._totalBytes) return ""; // nothing new
    const currentData = this.materialize();
    const availableStart = this._totalBytes - currentData.length;
    if (sinceOffset < availableStart) return null; // requested data was already trimmed
    return currentData.slice(sinceOffset - availableStart);
  }

  clear(): void {
    this.lines = [];
    this.partial = "";
    this._totalBytes = 0;
    this._droppedBytes = 0;
  }

}

// ── Types ─────────────────────────────────────────────────────────────

interface ClaudeSessionEntry extends ClaudeSessionState {
  scrollbackBuffer: ScrollbackRingBuffer;
  process: PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
}

interface ClaudeSessionManagerEvents {
  event: [event: ClaudeSessionEvent];
}

export interface HookConfig {
  /** Port the Clui HTTP server listens on (for hook callback URLs). */
  serverPort: number;
}

interface ClaudeSessionManagerOptions {
  ptyAdapter: PtyAdapterShape;
  processKillGraceMs?: number;
  historyLineLimit?: number;
  maxActiveSessions?: number;
  hookConfig?: HookConfig | undefined;
  dangerouslySkipPermissions?: boolean;
}

export class ClaudeSessionManagerRuntime extends EventEmitter<ClaudeSessionManagerEvents> {
  private readonly sessions = new Map<string, ClaudeSessionEntry>();
  private readonly threadLocks = new Map<string, Promise<void>>();
  private readonly killEscalationTimers = new Map<PtyProcess, ReturnType<typeof setTimeout>>();
  private readonly ptyAdapter: PtyAdapterShape;
  private readonly processKillGraceMs: number;
  private readonly historyLineLimit: number;
  private maxActiveSessions: number;
  private readonly hookConfig: HookConfig | null;
  private readonly dangerouslySkipPermissions: boolean;
  private readonly logger = createLogger("claude-session");

  constructor(options: ClaudeSessionManagerOptions) {
    super();
    this.ptyAdapter = options.ptyAdapter;
    this.processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
    this.historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
    this.maxActiveSessions = options.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS;
    this.hookConfig = options.hookConfig ?? null;
    this.dangerouslySkipPermissions = options.dangerouslySkipPermissions ?? false;
  }

  async startSession(input: {
    threadId: string;
    cwd: string;
    resumeSessionId?: string;
    cols: number;
    rows: number;
    dangerouslySkipPermissions?: boolean;
  }): Promise<void> {
    await this.runWithThreadLock(input.threadId, async () => {
      const existing = this.sessions.get(input.threadId);
      if (existing?.process) {
        this.stopProcess(existing);
      }

      // Determine the claude session ID:
      // - Resuming: reuse the provided session ID with --resume
      // - New session: generate a UUID and pass --session-id so we know it upfront
      const claudeSessionId = input.resumeSessionId ?? crypto.randomUUID();

      const entry: ClaudeSessionEntry = existing ?? {
        threadId: input.threadId,
        claudeSessionId,
        lastInteractedAt: Date.now(),
        scrollbackBuffer: new ScrollbackRingBuffer(this.historyLineLimit),
        cols: input.cols,
        rows: input.rows,
        status: "active" as TerminalStatus,
        process: null,
        unsubscribeData: null,
        unsubscribeExit: null,
      };

      entry.claudeSessionId = claudeSessionId;
      entry.cols = input.cols;
      entry.rows = input.rows;
      entry.status = "active";
      entry.lastInteractedAt = Date.now();
      // Clear old scrollback when starting a new session so the buffer only
      // contains output from the current CLI process. Without this, old output
      // (including the previous session's startup banner) persists and gets
      // re-sent to the client, causing duplicate banners.
      if (existing) {
        entry.scrollbackBuffer.clear();
      }
      this.sessions.set(input.threadId, entry);

      const args: string[] = [];
      if (input.dangerouslySkipPermissions ?? this.dangerouslySkipPermissions) {
        args.push("--dangerously-skip-permissions");
      }
      if (input.resumeSessionId) {
        args.push("--resume", input.resumeSessionId);
      } else {
        args.push("--session-id", claudeSessionId);
      }

      // Inject hook settings as inline JSON (matching cmux's approach).
      // Claude Code merges --settings additively with the user's own settings.json.
      if (this.hookConfig) {
        const settingsJson = buildHookSettingsJson(
          this.hookConfig.serverPort,
          input.threadId,
          claudeSessionId,
        );
        args.push("--settings", settingsJson);
        this.logger.info("hook settings injected", {
          threadId: input.threadId,
          port: this.hookConfig.serverPort,
        });
      }

      try {
        await assertValidCwd(input.cwd);

        const spawnEnv = createSpawnEnv(process.env);

        const ptyProcess = await Effect.runPromise(
          this.ptyAdapter.spawn({
            shell: "claude",
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

        // Capture process ref to detect stale exit callbacks
        const expectedProcess = ptyProcess;
        entry.unsubscribeExit = ptyProcess.onExit((event) => {
          if (entry.process !== expectedProcess) return; // stale exit — ignore
          this.onProcessExit(entry, event);
        });

        this.logger.info("claude session started", {
          threadId: input.threadId,
          pid: ptyProcess.pid,
          claudeSessionId,
          resume: !!input.resumeSessionId,
        });

        this.emitEvent({
          type: "started",
          threadId: input.threadId,
          createdAt: new Date().toISOString(),
        });

        // Emit session ID immediately — we know it upfront via --session-id or --resume
        this.emitEvent({
          type: "sessionId",
          threadId: input.threadId,
          createdAt: new Date().toISOString(),
          claudeSessionId,
        });

        // Fire-and-forget reconciliation
        void this.reconcileActiveSessions(this.maxActiveSessions);
      } catch (error) {
        entry.status = "new";
        entry.process = null;
        const message = error instanceof Error ? error.message : "Failed to start claude session";
        this.logger.error("failed to start claude session", {
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

      this.logger.info("claude session hibernated", { threadId });

      this.emitEvent({
        type: "hibernated",
        threadId,
        createdAt: new Date().toISOString(),
      });

      return scrollback;
    });
  }

  getScrollback(threadId: string, sinceOffset?: number): { scrollback: string | null; offset: number; reset: boolean } {
    const entry = this.sessions.get(threadId);
    if (!entry) return { scrollback: null, offset: 0, reset: false };

    const offset = entry.scrollbackBuffer.offset;

    if (sinceOffset != null) {
      const delta = entry.scrollbackBuffer.materializeSince(sinceOffset);
      if (delta != null) {
        return { scrollback: delta, offset, reset: false };
      }
      // Delta unavailable (data was trimmed or buffer was cleared after session
      // restart) — fall through to full materialization with reset flag so the
      // client knows to clear the terminal before writing.
      return { scrollback: entry.scrollbackBuffer.materialize(), offset, reset: true };
    }

    return { scrollback: entry.scrollbackBuffer.materialize(), offset, reset: false };
  }

  getClaudeSessionId(threadId: string): string | null {
    const entry = this.sessions.get(threadId);
    return entry?.claudeSessionId ?? null;
  }

  writeToSession(threadId: string, data: string): void {
    const entry = this.sessions.get(threadId);
    if (!entry || !entry.process || entry.status !== "active") {
      throw new Error(`No active session for thread: ${threadId}`);
    }
    entry.process.write(data);
    entry.lastInteractedAt = Date.now();
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

    const sorted = activeSessions.toSorted(
      (a, b) => a.lastInteractedAt - b.lastInteractedAt,
    );

    const toHibernate = sorted.slice(0, sorted.length - maxActive);
    for (const entry of toHibernate) {
      await this.hibernateSession(entry.threadId);
    }
  }

  async setMaxActiveSessions(maxActive: number): Promise<void> {
    this.maxActiveSessions = maxActive;
    await this.reconcileActiveSessions(maxActive);
  }

  async hibernateAll(): Promise<void> {
    const activeSessions = [...this.sessions.values()].filter(
      (entry) => entry.status === "active" && entry.process !== null,
    );
    const TIMEOUT_MS = 5_000;
    const results = await Promise.race([
      Promise.allSettled(activeSessions.map((entry) => this.hibernateSession(entry.threadId))),
      new Promise<PromiseSettledResult<string>[]>((resolve) =>
        setTimeout(
          () => {
            // Force-kill any PTYs that haven't hibernated yet to avoid
            // orphaned promises holding locks after shutdown proceeds.
            for (const entry of activeSessions) {
              if (entry.process) this.stopProcess(entry);
            }
            resolve(
              activeSessions.map(() => ({
                status: "rejected" as const,
                reason: new Error("timeout"),
              })),
            );
          },
          TIMEOUT_MS,
        ),
      ),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        this.logger.warn("failed to hibernate session during hibernateAll", {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  }

  /** Kill PTY and remove session from map without emitting lifecycle events. Used for thread deletion. */
  async destroySession(threadId: string): Promise<void> {
    await this.runWithThreadLock(threadId, async () => {
      const entry = this.sessions.get(threadId);
      if (!entry) return;
      this.stopProcess(entry);
      this.sessions.delete(threadId);
    });
  }

  /** Kill all dormant sessions except the excluded thread IDs. Returns count of sessions killed. */
  async purgeInactiveSessions(excludeThreadIds: ReadonlySet<string>): Promise<number> {
    // Collect candidates first to avoid mutating the Map during iteration
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
      this.stopProcess(entry);
    }
    this.sessions.clear();
    for (const timer of this.killEscalationTimers.values()) {
      clearTimeout(timer);
    }
    this.killEscalationTimers.clear();
    this.threadLocks.clear();
  }

  // ── Private ────────────────────────────────────────────────────────

  private onProcessData(entry: ClaudeSessionEntry, data: string): void {
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

  private onProcessExit(entry: ClaudeSessionEntry, event: PtyExitEvent): void {
    this.cleanupProcessHandles(entry);
    this.clearKillEscalationTimer(entry.process);
    entry.process = null;
    entry.status = "dormant";

    this.logger.info("claude session exited", {
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

  private stopProcess(entry: ClaudeSessionEntry): void {
    const ptyProcess = entry.process;
    if (!ptyProcess) return;
    this.cleanupProcessHandles(entry);
    entry.process = null;
    this.killProcessWithEscalation(ptyProcess, entry.threadId);
  }

  private cleanupProcessHandles(entry: ClaudeSessionEntry): void {
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
      this.logger.warn("failed to kill claude process", {
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
        this.logger.warn("failed to force-kill claude process", {
          threadId,
          signal: "SIGKILL",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, this.processKillGraceMs);
    timer.unref?.();
    this.killEscalationTimers.set(ptyProcess, timer);
  }

  private emitEvent(event: ClaudeSessionEvent): void {
    this.emit("event", event);
  }

  private runWithThreadLock<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    return runWithThreadLock(this.threadLocks, threadId, task);
  }
}

export const ClaudeSessionManagerLive = Layer.effect(
  ClaudeSessionManager,
  Effect.gen(function* () {
    const ptyAdapter = yield* PtyAdapter;

    // Resolve hook config from ServerConfig
    const serverConfig = yield* ServerConfig;
    const settings = yield* Effect.promise(() => loadServerSettings(serverConfig.stateDir));
    const hookConfig: HookConfig = {
      serverPort: serverConfig.port,
    };

    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => new ClaudeSessionManagerRuntime({
        ptyAdapter,
        hookConfig,
        maxActiveSessions: settings.maxActiveHarnessSessions,
        dangerouslySkipPermissions: serverConfig.dangerouslySkipPermissions,
      })),
      (r) => Effect.sync(() => r.dispose()),
    );

    return {
      startSession: (input) =>
        Effect.tryPromise({
          try: () => runtime.startSession(input),
          catch: (cause) =>
            new ClaudeSessionError({ message: "Failed to start claude session", cause }),
        }),
      hibernateSession: (threadId) =>
        Effect.tryPromise({
          try: () => runtime.hibernateSession(threadId),
          catch: (cause) =>
            new ClaudeSessionError({ message: "Failed to hibernate claude session", cause }),
        }),
      getScrollback: (threadId, sinceOffset) =>
        Effect.sync(() => runtime.getScrollback(threadId, sinceOffset)),
      writeToSession: (threadId, data) =>
        Effect.try({
          try: () => runtime.writeToSession(threadId, data),
          catch: (cause) =>
            new ClaudeSessionError({ message: "Failed to write to claude session", cause }),
        }),
      resizeSession: (threadId, cols, rows) =>
        Effect.try({
          try: () => runtime.resizeSession(threadId, cols, rows),
          catch: (cause) =>
            new ClaudeSessionError({ message: "Failed to resize claude session", cause }),
        }),
      getSessionStatus: (threadId) =>
        Effect.sync(() => runtime.getSessionStatus(threadId)),
      reconcileActiveSessions: (maxActive) =>
        Effect.promise(() => runtime.reconcileActiveSessions(maxActive)),
      setMaxActiveSessions: (maxActive) =>
        Effect.promise(() => runtime.setMaxActiveSessions(maxActive)),
      hibernateAll: () =>
        Effect.promise(() => runtime.hibernateAll()),
      subscribe: (listener) =>
        Effect.sync(() => {
          runtime.on("event", listener);
          return () => {
            runtime.off("event", listener);
          };
        }),
      getClaudeSessionId: (threadId) =>
        Effect.sync(() => runtime.getClaudeSessionId(threadId)),
      destroySession: (threadId) =>
        Effect.promise(() => runtime.destroySession(threadId)),
      purgeInactiveSessions: (excludeThreadIds) =>
        Effect.promise(() => runtime.purgeInactiveSessions(excludeThreadIds)),
      dispose: Effect.sync(() => runtime.dispose()),
    } satisfies ClaudeSessionManagerShape;
  }),
);
