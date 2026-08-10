import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type {
  ClaudeCodeBackend,
  ClaudeCodeProxyStatus,
  ClaudeSessionEvent,
  CodingHarness,
  TerminalStatus,
} from "@clui/contracts";
import { Effect, Layer } from "effect";

import { createLogger } from "../../logger";
import { Open } from "../../open";
import { buildCodexHookConfigOverrides, buildHookSettingsJson } from "../../hooks/hookSettings";
import { loadServerSettings } from "../../serverSettings";
import {
  PtyAdapter,
  type PtyAdapterShape,
  type PtyExitEvent,
  type PtyProcess,
} from "../Services/PTY";
import {
  ClaudeSessionError,
  ClaudeSessionManager,
  type ClaudeSessionManagerShape,
  type ClaudeSessionState,
} from "../Services/ClaudeSession";
import {
  assertValidCwd,
  BoundedLineBuffer,
  createSpawnEnv,
  runWithThreadLock,
} from "../terminalUtils";
import {
  getSessionProcessRegistryDir,
  removeSessionProcessRegistryEntry,
  writeSessionProcessRegistryEntry,
} from "../sessionProcessRegistry";
import { ServerConfig } from "../../config";
import { ClaudeCodeProxyManager } from "../claudeCodeProxy";

const DEFAULT_HISTORY_LINE_LIMIT = 200_000;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_ACTIVE_SESSIONS = 10;

// ── Types ─────────────────────────────────────────────────────────────

type PtyCodingHarness = Exclude<CodingHarness, "pi">;

interface ClaudeSessionEntry extends ClaudeSessionState {
  harness: PtyCodingHarness;
  scrollbackBuffer: BoundedLineBuffer;
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
  stateDir?: string;
  claudeCodeProxyManager?: Pick<
    ClaudeCodeProxyManager,
    "dispose" | "getClaudeEnvironment" | "getStatus" | "logout" | "startLogin"
  >;
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
  private readonly stateDir: string | null;
  private readonly processRegistryDir: string | null;
  private readonly claudeCodeProxyManager: NonNullable<
    ClaudeSessionManagerOptions["claudeCodeProxyManager"]
  >;
  private readonly logger = createLogger("claude-session");

  constructor(options: ClaudeSessionManagerOptions) {
    super();
    this.ptyAdapter = options.ptyAdapter;
    this.processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
    this.historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
    this.maxActiveSessions = options.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS;
    this.hookConfig = options.hookConfig ?? null;
    this.dangerouslySkipPermissions = options.dangerouslySkipPermissions ?? false;
    this.stateDir = options.stateDir ?? null;
    this.processRegistryDir = options.stateDir
      ? getSessionProcessRegistryDir(options.stateDir)
      : null;
    this.claudeCodeProxyManager = options.claudeCodeProxyManager ?? new ClaudeCodeProxyManager();
  }

  async startSession(input: {
    threadId: string;
    cwd: string;
    harness?: PtyCodingHarness;
    resumeSessionId?: string;
    cols: number;
    rows: number;
    dangerouslySkipPermissions?: boolean;
    claudeCodeBackend?: ClaudeCodeBackend;
    model?: string;
  }): Promise<void> {
    await this.runWithThreadLock(input.threadId, async () => {
      const harness = input.harness ?? "claudeCode";
      const existing = this.sessions.get(input.threadId);
      if (existing?.process) {
        this.stopProcess(existing);
      }

      // Claude accepts a caller-provided session ID. OMP uses a thread-scoped
      // session directory, so its synthetic ID is only a persisted resume marker.
      // Codex creates its own ID, which is recorded from SessionStart after launch.
      const claudeSessionId =
        harness === "claudeCode" || harness === "omp"
          ? (input.resumeSessionId ?? crypto.randomUUID())
          : null;

      const entry: ClaudeSessionEntry = existing ?? {
        threadId: input.threadId,
        harness,
        claudeSessionId,
        lastInteractedAt: Date.now(),
        scrollbackBuffer: new BoundedLineBuffer(this.historyLineLimit),
        cols: input.cols,
        rows: input.rows,
        status: "new" as TerminalStatus,
        process: null,
        unsubscribeData: null,
        unsubscribeExit: null,
      };

      entry.harness = harness;
      entry.claudeSessionId = claudeSessionId;
      entry.cols = input.cols;
      entry.rows = input.rows;
      entry.status = "new";
      entry.lastInteractedAt = Date.now();
      // Clear old scrollback when starting a new session so the buffer only
      // contains output from the current CLI process. Without this, old output
      // (including the previous session's startup banner) persists and gets
      // re-sent to the client, causing duplicate banners.
      if (existing) {
        entry.scrollbackBuffer.clear();
      }
      this.sessions.set(input.threadId, entry);

      const skipPermissions = input.dangerouslySkipPermissions ?? this.dangerouslySkipPermissions;

      try {
        await assertValidCwd(input.cwd);
        const args =
          harness === "codexCli"
            ? this.buildCodexArgs(input, skipPermissions)
            : harness === "omp"
              ? await this.buildOmpArgs(input, skipPermissions)
              : this.buildClaudeArgs(input, claudeSessionId!, skipPermissions);

        const runtimeEnv =
          harness === "claudeCode" && input.claudeCodeBackend === "codex"
            ? await this.claudeCodeProxyManager.getClaudeEnvironment(input.model ?? "")
            : undefined;
        const spawnEnv = createSpawnEnv(process.env, runtimeEnv);

        const ptyProcess = await Effect.runPromise(
          this.ptyAdapter.spawn({
            shell: harness === "codexCli" ? "codex" : harness === "omp" ? "omp" : "claude",
            args,
            cwd: input.cwd,
            cols: input.cols,
            rows: input.rows,
            env: spawnEnv,
          }),
        );

        entry.process = ptyProcess;
        entry.status = "active";
        this.registerProcess(entry, ptyProcess);
        const registerProcessTimer = setTimeout(() => {
          this.registerProcess(entry, ptyProcess);
        }, 100);
        registerProcessTimer.unref?.();

        entry.unsubscribeData = ptyProcess.onData((data) => {
          this.onProcessData(entry, data);
        });

        // Capture process ref to detect stale exit callbacks
        const expectedProcess = ptyProcess;
        entry.unsubscribeExit = ptyProcess.onExit((event) => {
          if (entry.process !== expectedProcess) return; // stale exit — ignore
          this.onProcessExit(entry, event);
        });

        this.logger.info("terminal coding session started", {
          threadId: input.threadId,
          harness,
          pid: ptyProcess.pid,
          claudeSessionId,
          resume: !!input.resumeSessionId,
        });

        this.emitEvent({
          type: "started",
          threadId: input.threadId,
          createdAt: new Date().toISOString(),
        });

        // Claude IDs, OMP resume markers, and resumed Codex IDs are known
        // immediately. A new Codex session reports its generated ID later.
        const knownSessionId =
          harness === "claudeCode" || harness === "omp"
            ? claudeSessionId
            : (entry.claudeSessionId ?? input.resumeSessionId);
        if (knownSessionId) {
          entry.claudeSessionId = knownSessionId;
          this.emitSessionId(input.threadId, knownSessionId);
        }

        // Fire-and-forget reconciliation
        void this.reconcileActiveSessions(this.maxActiveSessions);
      } catch (error) {
        this.unregisterProcess(entry);
        entry.status = "new";
        entry.process = null;
        const message = error instanceof Error ? error.message : `Failed to start ${harness}`;
        this.logger.error("failed to start terminal coding session", {
          threadId: input.threadId,
          harness,
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

  getClaudeCodeProxyStatus(): Promise<ClaudeCodeProxyStatus> {
    return this.claudeCodeProxyManager.getStatus();
  }

  startClaudeCodeProxyLogin(): Promise<ClaudeCodeProxyStatus> {
    return this.claudeCodeProxyManager.startLogin();
  }

  logoutClaudeCodeProxy(): Promise<ClaudeCodeProxyStatus> {
    return this.claudeCodeProxyManager.logout();
  }

  async hibernateSession(threadId: string): Promise<void> {
    return this.runWithThreadLock(threadId, async () => {
      const entry = this.sessions.get(threadId);
      if (!entry) {
        throw new Error(`No session found for thread: ${threadId}`);
      }

      this.stopProcess(entry);
      entry.status = "dormant";

      this.logger.info("claude session hibernated", { threadId });

      this.emitEvent({
        type: "hibernated",
        threadId,
        createdAt: new Date().toISOString(),
      });
    });
  }

  getScrollback(
    threadId: string,
    sinceOffset?: number,
  ): { scrollback: string | null; offset: number; reset: boolean } {
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

  recordCodexSessionId(threadId: string, sessionId: string): void {
    const entry = this.sessions.get(threadId);
    if (!entry || entry.harness !== "codexCli" || entry.status === "dormant") {
      throw new Error(`No starting or active Codex CLI session for thread: ${threadId}`);
    }
    if (entry.claudeSessionId === sessionId) return;
    entry.claudeSessionId = sessionId;
    if (entry.status === "active" && entry.process) {
      this.emitSessionId(threadId, sessionId);
    }
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
    const sizeChanged = entry.cols !== cols || entry.rows !== rows;
    entry.cols = cols;
    entry.rows = rows;
    entry.lastInteractedAt = Date.now();
    if (sizeChanged) {
      entry.process.resize(cols, rows);
    }
  }

  getSessionStatus(threadId: string): TerminalStatus {
    const entry = this.sessions.get(threadId);
    return entry?.status ?? "new";
  }

  async reconcileActiveSessions(maxActive: number): Promise<void> {
    for (const harness of ["claudeCode", "codexCli", "omp"] as const) {
      const activeSessions = [...this.sessions.values()].filter(
        (entry) => entry.harness === harness && entry.status === "active" && entry.process !== null,
      );

      if (activeSessions.length <= maxActive) continue;

      const sorted = activeSessions.toSorted((a, b) => a.lastInteractedAt - b.lastInteractedAt);
      const toHibernate = sorted.slice(0, sorted.length - maxActive);
      for (const entry of toHibernate) {
        await this.hibernateSession(entry.threadId);
      }
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
        setTimeout(() => {
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
        }, TIMEOUT_MS),
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

  async hibernateActiveSessions(excludeThreadIds: ReadonlySet<string>): Promise<string[]> {
    const candidates = [...this.sessions.values()]
      .filter(
        (entry) =>
          !excludeThreadIds.has(entry.threadId) &&
          entry.status === "active" &&
          entry.process !== null,
      )
      .toSorted((left, right) => left.lastInteractedAt - right.lastInteractedAt)
      .map((entry) => entry.threadId);

    const hibernated: string[] = [];
    for (const threadId of candidates) {
      try {
        await this.hibernateSession(threadId);
        hibernated.push(threadId);
      } catch (error) {
        this.logger.warn("failed to hibernate claude session during bulk hibernate", {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return hibernated;
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
    this.claudeCodeProxyManager.dispose();
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

  private buildClaudeArgs(
    input: { threadId: string; resumeSessionId?: string },
    sessionId: string,
    skipPermissions: boolean,
  ): string[] {
    const args: string[] = [];
    if (skipPermissions) {
      args.push("--dangerously-skip-permissions");
    }
    if (input.resumeSessionId) {
      args.push("--resume", input.resumeSessionId);
    } else {
      args.push("--session-id", sessionId);
    }

    // Claude Code merges inline --settings additively with user settings.
    if (this.hookConfig) {
      const settingsJson = buildHookSettingsJson(
        this.hookConfig.serverPort,
        input.threadId,
        sessionId,
      );
      args.push("--settings", settingsJson);
      this.logger.info("Claude Code hook settings injected", {
        threadId: input.threadId,
        port: this.hookConfig.serverPort,
      });
    }
    return args;
  }

  private buildCodexArgs(
    input: { threadId: string; resumeSessionId?: string; model?: string },
    skipPermissions: boolean,
  ): string[] {
    const args: string[] = input.resumeSessionId ? ["resume"] : [];
    if (skipPermissions) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    if (input.model) {
      args.push("--model", input.model);
    }
    if (this.hookConfig) {
      // The injected commands are generated entirely by Clui. Bypassing the
      // interactive trust prompt is required for SessionStart to capture the
      // generated ID before the session can be hibernated.
      args.push("--dangerously-bypass-hook-trust");
      for (const override of buildCodexHookConfigOverrides(
        this.hookConfig.serverPort,
        input.threadId,
      )) {
        args.push("-c", override);
      }
      this.logger.info("Codex CLI hook settings injected", {
        threadId: input.threadId,
        port: this.hookConfig.serverPort,
      });
    }
    if (input.resumeSessionId) {
      args.push(input.resumeSessionId);
    }
    return args;
  }

  private async buildOmpArgs(
    input: { threadId: string; resumeSessionId?: string },
    skipPermissions: boolean,
  ): Promise<string[]> {
    if (!this.stateDir) {
      throw new Error("OMP sessions require a configured Clui state directory");
    }
    const sessionDir = path.join(
      this.stateDir,
      "omp-sessions",
      Buffer.from(input.threadId).toString("base64url"),
    );
    await mkdir(sessionDir, { recursive: true });

    const args = ["--session-dir", sessionDir];
    if (input.resumeSessionId) {
      args.push("--continue");
    }
    if (skipPermissions) {
      args.push("--yolo");
    }
    return args;
  }

  private onProcessData(entry: ClaudeSessionEntry, data: string): void {
    entry.scrollbackBuffer.append(data);

    this.emitEvent({
      type: "output",
      threadId: entry.threadId,
      createdAt: new Date().toISOString(),
      data,
      offset: entry.scrollbackBuffer.offset,
    });
  }

  private onProcessExit(entry: ClaudeSessionEntry, event: PtyExitEvent): void {
    this.unregisterProcess(entry);
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
    this.unregisterProcess(entry);
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

  private registerProcess(entry: ClaudeSessionEntry, expectedProcess: PtyProcess): void {
    if (!this.processRegistryDir || entry.process !== expectedProcess || entry.status !== "active")
      return;
    try {
      writeSessionProcessRegistryEntry(this.processRegistryDir, {
        harness: entry.harness,
        threadId: entry.threadId,
        pid: expectedProcess.pid,
      });
    } catch (error) {
      this.logger.warn("failed to register claude session process", {
        threadId: entry.threadId,
        pid: expectedProcess.pid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private unregisterProcess(entry: ClaudeSessionEntry): void {
    if (!this.processRegistryDir) return;
    try {
      removeSessionProcessRegistryEntry(this.processRegistryDir, entry.harness, entry.threadId);
    } catch (error) {
      this.logger.warn("failed to unregister claude session process", {
        threadId: entry.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

  private emitSessionId(threadId: string, sessionId: string): void {
    this.emitEvent({
      type: "sessionId",
      threadId,
      createdAt: new Date().toISOString(),
      claudeSessionId: sessionId,
    });
  }

  private runWithThreadLock<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    return runWithThreadLock(this.threadLocks, threadId, task);
  }
}

export const ClaudeSessionManagerLive = Layer.effect(
  ClaudeSessionManager,
  Effect.gen(function* () {
    const ptyAdapter = yield* PtyAdapter;
    const open = yield* Open;

    // Resolve hook config from ServerConfig
    const serverConfig = yield* ServerConfig;
    const settings = yield* Effect.promise(() => loadServerSettings(serverConfig.stateDir));
    const hookConfig: HookConfig = {
      serverPort: serverConfig.port,
    };

    const runtime = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new ClaudeSessionManagerRuntime({
            ptyAdapter,
            hookConfig,
            maxActiveSessions: settings.maxActiveHarnessSessions,
            dangerouslySkipPermissions: serverConfig.dangerouslySkipPermissions,
            stateDir: serverConfig.stateDir,
            claudeCodeProxyManager: new ClaudeCodeProxyManager(
              serverConfig.claudeCodeProxyBinaryPath,
              (url) => Effect.runPromise(open.openBrowser(url)),
            ),
          }),
      ),
      (r) => Effect.sync(() => r.dispose()),
    );

    return {
      startSession: (input) =>
        Effect.tryPromise({
          try: () => runtime.startSession(input),
          catch: (cause) =>
            new ClaudeSessionError({
              message: cause instanceof Error ? cause.message : "Failed to start claude session",
              cause,
            }),
        }),
      getClaudeCodeProxyStatus: () => Effect.promise(() => runtime.getClaudeCodeProxyStatus()),
      startClaudeCodeProxyLogin: () =>
        Effect.tryPromise({
          try: () => runtime.startClaudeCodeProxyLogin(),
          catch: (cause) =>
            new ClaudeSessionError({
              message: cause instanceof Error ? cause.message : "Could not start Codex sign-in",
              cause,
            }),
        }),
      logoutClaudeCodeProxy: () =>
        Effect.tryPromise({
          try: () => runtime.logoutClaudeCodeProxy(),
          catch: (cause) =>
            new ClaudeSessionError({
              message: cause instanceof Error ? cause.message : "Could not disconnect Codex",
              cause,
            }),
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
      getSessionStatus: (threadId) => Effect.sync(() => runtime.getSessionStatus(threadId)),
      reconcileActiveSessions: (maxActive) =>
        Effect.promise(() => runtime.reconcileActiveSessions(maxActive)),
      setMaxActiveSessions: (maxActive) =>
        Effect.promise(() => runtime.setMaxActiveSessions(maxActive)),
      hibernateAll: () => Effect.promise(() => runtime.hibernateAll()),
      hibernateActiveSessions: (excludeThreadIds) =>
        Effect.promise(() => runtime.hibernateActiveSessions(excludeThreadIds)),
      subscribe: (listener) =>
        Effect.sync(() => {
          runtime.on("event", listener);
          return () => {
            runtime.off("event", listener);
          };
        }),
      getClaudeSessionId: (threadId) => Effect.sync(() => runtime.getClaudeSessionId(threadId)),
      recordCodexSessionId: (threadId, sessionId) =>
        Effect.try({
          try: () => runtime.recordCodexSessionId(threadId, sessionId),
          catch: (cause) =>
            new ClaudeSessionError({
              message: "Failed to record Codex CLI session ID",
              cause,
            }),
        }),
      destroySession: (threadId) => Effect.promise(() => runtime.destroySession(threadId)),
      purgeInactiveSessions: (excludeThreadIds) =>
        Effect.promise(() => runtime.purgeInactiveSessions(excludeThreadIds)),
      dispose: Effect.sync(() => runtime.dispose()),
    } satisfies ClaudeSessionManagerShape;
  }),
);
