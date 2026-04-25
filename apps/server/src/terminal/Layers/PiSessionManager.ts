import { EventEmitter } from "node:events";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ClaudeHookStatus, PiSessionEvent, TerminalStatus } from "@clui/contracts";
import { Effect, Layer } from "effect";

import { createLogger } from "../../logger";
import { ServerConfig } from "../../config";
import { loadServerSettings } from "../../serverSettings";
import { PiSessionJsonlHookWatcher } from "../../PiSessionJsonlHook";
import { PtyAdapter, type PtyAdapterShape, type PtyExitEvent, type PtyProcess } from "../Services/PTY";
import {
  PiSessionError,
  PiSessionManager,
  type PiSessionManagerShape,
  type PiSessionState,
} from "../Services/PiSession";
import { assertValidCwd, createSpawnEnv, runWithThreadLock } from "../terminalUtils";

const DEFAULT_HISTORY_LINE_LIMIT = 200_000;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_ACTIVE_SESSIONS = 10;
const CLUI_PI_THREAD_ID_ENV = "CLUI_PI_THREAD_ID";
const CLUI_PI_SESSION_SYNC_DIR_ENV = "CLUI_PI_SESSION_SYNC_DIR";
const PI_RUNTIME_AGENT_DIR_NAME = "pi-agent";
const PI_LEGACY_THREAD_SESSION_DIR_NAME = "pi-sessions";
const PI_SESSION_SYNC_DIR_NAME = "pi-session-sync";
const PI_RUNTIME_EXTENSION_DIR_NAME = "pi-runtime";
const PI_SESSION_SYNC_EXTENSION_FILENAME = "clui-pi-session-sync.js";
const PI_HOOK_STATUSES = new Set<ClaudeHookStatus>([
  "working",
  "needsInput",
  "pendingApproval",
  "error",
  "completed",
]);

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

interface PiSessionSyncPayload {
  readonly threadId: string;
  readonly sessionFile: string | null;
  readonly timestamp: string;
  readonly reason?: string;
  readonly hookStatus?: ClaudeHookStatus | null;
}

interface PiSessionEntry extends PiSessionState {
  scrollbackBuffer: ScrollbackRingBuffer;
  process: PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hookStatus: ClaudeHookStatus | null;
  /** Absolute per-cwd pi session directory used for /resume current-folder. */
  sessionDir: string | null;
  /** Absolute path to the active pi session JSONL file for this Clui thread. */
  activeSessionFile: string | null;
  jsonlHookWatcher: PiSessionJsonlHookWatcher | null;
  syncFilePath: string | null;
  syncWatcher: FSWatcher | null;
  syncDebounceTimer: ReturnType<typeof setTimeout> | null;
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

function encodePiSessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function buildPiSessionSyncExtensionSource(): string {
  return `
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const syncDir = process.env.${CLUI_PI_SESSION_SYNC_DIR_ENV};
const threadId = process.env.${CLUI_PI_THREAD_ID_ENV};
const userInputToolNames = new Set([
  "ask",
  "askfollowupquestion",
  "askquestion",
  "askuser",
  "askuserquestion",
  "question",
  "questionnaire",
]);
const pendingUserInputToolCallIds = new Set();
let lastHookStatus;

function normalizeToolName(toolName) {
  return String(toolName ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isUserInputTool(toolName) {
  return userInputToolNames.has(normalizeToolName(toolName));
}

function writePayload(ctx, reason, hookStatus) {
  if (!syncDir || !threadId) return;
  mkdirSync(syncDir, { recursive: true });
  const payload = {
    threadId,
    sessionFile: ctx.sessionManager.getSessionFile() ?? null,
    timestamp: new Date().toISOString(),
    reason,
  };
  if (hookStatus !== undefined) {
    payload.hookStatus = hookStatus;
  }
  const target = path.join(syncDir, threadId + ".json");
  const tmp = target + ".tmp";
  writeFileSync(tmp, JSON.stringify(payload));
  renameSync(tmp, target);
}

function setHookStatus(ctx, hookStatus, reason) {
  if (lastHookStatus === hookStatus) return;
  lastHookStatus = hookStatus;
  writePayload(ctx, reason, hookStatus);
}

export default function (pi) {
  pi.on("session_start", async (event, ctx) => {
    pendingUserInputToolCallIds.clear();
    lastHookStatus = undefined;
    writePayload(ctx, event.reason);
  });

  pi.on("agent_start", async (_event, ctx) => {
    pendingUserInputToolCallIds.clear();
    setHookStatus(ctx, "working", "agent_start");
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (isUserInputTool(event.toolName)) {
      pendingUserInputToolCallIds.add(event.toolCallId);
      setHookStatus(ctx, "needsInput", "tool_input:" + event.toolName);
      return;
    }
    if (pendingUserInputToolCallIds.size === 0) {
      setHookStatus(ctx, "working", "tool_start:" + event.toolName);
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isUserInputTool(event.toolName)) return;
    pendingUserInputToolCallIds.add(event.toolCallId);
    setHookStatus(ctx, "needsInput", "tool_call:" + event.toolName);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    const wasUserInputTool = pendingUserInputToolCallIds.delete(event.toolCallId);
    if (wasUserInputTool && pendingUserInputToolCallIds.size === 0) {
      setHookStatus(ctx, "working", "tool_input_resolved:" + event.toolName);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    pendingUserInputToolCallIds.clear();
    setHookStatus(ctx, "completed", "agent_end");
  });
}
`.trimStart();
}

function parsePiHookStatus(value: unknown): ClaudeHookStatus | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  return PI_HOOK_STATUSES.has(value as ClaudeHookStatus) ? (value as ClaudeHookStatus) : undefined;
}

export class PiSessionManagerRuntime extends EventEmitter<PiSessionManagerEvents> {
  private readonly sessions = new Map<string, PiSessionEntry>();
  private readonly threadLocks = new Map<string, Promise<void>>();
  private readonly killEscalationTimers = new Map<PtyProcess, ReturnType<typeof setTimeout>>();
  private readonly ptyAdapter: PtyAdapterShape;
  private readonly processKillGraceMs: number;
  private readonly historyLineLimit: number;
  private maxActiveSessions: number;
  private readonly agentRootDir: string;
  private readonly sessionsRootDir: string;
  private readonly legacySessionsRootDir: string;
  private readonly sessionSyncDir: string;
  private readonly extensionFilePath: string;
  private runtimeFilesPromise: Promise<void> | null = null;
  private readonly logger = createLogger("pi-session");

  constructor(options: PiSessionManagerOptions) {
    super();
    this.ptyAdapter = options.ptyAdapter;
    this.processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
    this.historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
    this.maxActiveSessions = options.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS;
    this.agentRootDir = path.join(options.stateDir, PI_RUNTIME_AGENT_DIR_NAME);
    this.sessionsRootDir = path.join(this.agentRootDir, "sessions");
    this.legacySessionsRootDir = path.join(options.stateDir, PI_LEGACY_THREAD_SESSION_DIR_NAME);
    this.sessionSyncDir = path.join(options.stateDir, PI_SESSION_SYNC_DIR_NAME);
    this.extensionFilePath = path.join(
      options.stateDir,
      PI_RUNTIME_EXTENSION_DIR_NAME,
      PI_SESSION_SYNC_EXTENSION_FILENAME,
    );
  }

  async startSession(input: {
    threadId: string;
    cwd: string;
    cols: number;
    rows: number;
    fresh?: boolean;
    resumeSessionFile?: string;
  }): Promise<void> {
    await this.runWithThreadLock(input.threadId, async () => {
      await this.ensureRuntimeFiles();

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
        activeSessionFile: null,
        jsonlHookWatcher: null,
        syncFilePath: null,
        syncWatcher: null,
        syncDebounceTimer: null,
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

      const sessionDir = this.getSessionDirForCwd(input.cwd);
      entry.sessionDir = sessionDir;
      await mkdir(sessionDir, { recursive: true });

      const preferredSessionFile = input.resumeSessionFile ?? entry.activeSessionFile ?? undefined;
      const resolvedSessionFile = input.fresh
        ? null
        : await this.resolveStartSessionFile(input.threadId, input.cwd, preferredSessionFile);
      entry.activeSessionFile = resolvedSessionFile;

      const args: string[] = [
        "--session-dir",
        sessionDir,
        "--extension",
        this.extensionFilePath,
      ];
      if (resolvedSessionFile) {
        args.push("--session", resolvedSessionFile);
      }

      try {
        await assertValidCwd(input.cwd);
        await this.startSessionSyncWatcher(entry);
        this.startJsonlHookWatcher(entry, entry.activeSessionFile);

        const spawnEnv = createSpawnEnv(process.env);
        spawnEnv[CLUI_PI_THREAD_ID_ENV] = input.threadId;
        spawnEnv[CLUI_PI_SESSION_SYNC_DIR_ENV] = this.sessionSyncDir;

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
          resumed: resolvedSessionFile != null,
          sessionDir,
          activeSessionFile: resolvedSessionFile,
        });

        this.emitEvent({
          type: "started",
          threadId: input.threadId,
          createdAt: new Date().toISOString(),
        });

        const refreshTimer = setTimeout(() => {
          void this.runWithThreadLock(input.threadId, async () => {
            const current = this.sessions.get(input.threadId);
            if (!current) return;
            await this.refreshSessionSyncFile(current);
          });
        }, 150);
        refreshTimer.unref?.();

        void this.reconcileActiveSessions(this.maxActiveSessions);
      } catch (error) {
        entry.status = "new";
        entry.process = null;
        this.stopSessionSyncWatcher(entry);
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

      this.logger.info("pi session hibernated", {
        threadId,
        activeSessionFile: entry.activeSessionFile,
      });
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

  getSessionFile(threadId: string): string | null {
    const entry = this.sessions.get(threadId);
    return entry?.activeSessionFile ?? null;
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
      this.stopSessionSyncWatcher(entry);
      this.stopJsonlHookWatcher(entry);
      this.stopProcess(entry);
    }
    this.sessions.clear();
    for (const timer of this.killEscalationTimers.values()) clearTimeout(timer);
    this.killEscalationTimers.clear();
    this.threadLocks.clear();
  }

  private async ensureRuntimeFiles(): Promise<void> {
    if (!this.runtimeFilesPromise) {
      this.runtimeFilesPromise = (async () => {
        await mkdir(this.sessionsRootDir, { recursive: true });
        await mkdir(this.sessionSyncDir, { recursive: true });
        await mkdir(path.dirname(this.extensionFilePath), { recursive: true });
        await writeFile(this.extensionFilePath, buildPiSessionSyncExtensionSource(), "utf8");
      })();
    }
    await this.runtimeFilesPromise;
  }

  private getSessionDirForCwd(cwd: string): string {
    return path.join(this.sessionsRootDir, encodePiSessionDirName(cwd));
  }

  private async resolveStartSessionFile(
    threadId: string,
    cwd: string,
    explicitSessionFile?: string,
  ): Promise<string | null> {
    if (explicitSessionFile) {
      const resolved = path.resolve(explicitSessionFile);
      if (existsSync(resolved)) {
        return resolved;
      }
      this.logger.warn("pi session resume file missing; falling back", {
        threadId,
        sessionFile: resolved,
      });
    }

    const migrated = await this.migrateLegacyThreadSessions(threadId, cwd);
    if (migrated) {
      return migrated;
    }

    return null;
  }

  private async migrateLegacyThreadSessions(threadId: string, cwd: string): Promise<string | null> {
    const legacyDir = path.join(this.legacySessionsRootDir, threadId);
    if (!existsSync(legacyDir)) return null;

    const targetDir = this.getSessionDirForCwd(cwd);
    await mkdir(targetDir, { recursive: true });

    const legacyFiles = await this.listJsonlFilesRecursive(legacyDir);
    let migratedCount = 0;
    let mostRecent: { file: string; mtimeMs: number } | null = null;

    for (const legacyFile of legacyFiles) {
      const header = await this.readSessionHeader(legacyFile);
      if (!header || header.cwd !== cwd) continue;

      const targetFile = path.join(targetDir, path.basename(legacyFile));
      if (!existsSync(targetFile)) {
        try {
          await copyFile(legacyFile, targetFile);
          migratedCount++;
        } catch {
          // ignore individual copy failures; fallback continues best-effort
        }
      }

      const candidateFile = existsSync(targetFile) ? targetFile : legacyFile;
      try {
        const candidateStat = await stat(candidateFile);
        if (!mostRecent || candidateStat.mtimeMs >= mostRecent.mtimeMs) {
          mostRecent = { file: candidateFile, mtimeMs: candidateStat.mtimeMs };
        }
      } catch {
        // ignore stat failures
      }
    }

    if (migratedCount > 0) {
      this.logger.info("migrated legacy pi sessions into shared per-cwd store", {
        threadId,
        cwd,
        migratedCount,
        targetDir,
      });
    }

    return mostRecent?.file ?? null;
  }

  private async listJsonlFilesRecursive(rootDir: string): Promise<string[]> {
    const results: string[] = [];
    const stack = [rootDir];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true, encoding: "utf8" });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          results.push(fullPath);
        }
      }
    }
    return results;
  }

  private async readSessionHeader(
    filePath: string,
  ): Promise<{ cwd: string } | null> {
    try {
      const content = await readFile(filePath, "utf8");
      const firstLine = content.split("\n", 1)[0]?.trim();
      if (!firstLine) return null;
      const parsed = JSON.parse(firstLine) as Record<string, unknown>;
      if (parsed.type !== "session" || typeof parsed.cwd !== "string") {
        return null;
      }
      return { cwd: parsed.cwd };
    } catch {
      return null;
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

  private applyHookStatusIfChanged(entry: PiSessionEntry, status: ClaudeHookStatus | null): void {
    if (entry.hookStatus === status) return;
    entry.hookStatus = status;
    this.emitEvent({
      type: "hookStatus",
      threadId: entry.threadId,
      createdAt: new Date().toISOString(),
      hookStatus: status,
    });
  }

  private startJsonlHookWatcher(entry: PiSessionEntry, sessionFile: string | null): void {
    if (!entry.jsonlHookWatcher) {
      entry.jsonlHookWatcher = new PiSessionJsonlHookWatcher({
        threadId: entry.threadId,
        logger: this.logger,
        emitHookStatus: (event) => {
          if (event.type !== "hookStatus" || event.hookStatus == null) return;
          const current = this.sessions.get(event.threadId);
          if (!current) return;
          this.applyHookStatusIfChanged(current, event.hookStatus);
        },
      });
    }
    entry.jsonlHookWatcher.start(sessionFile);
  }

  private stopJsonlHookWatcher(entry: PiSessionEntry): void {
    entry.jsonlHookWatcher?.stop();
  }

  private async startSessionSyncWatcher(entry: PiSessionEntry): Promise<void> {
    this.stopSessionSyncWatcher(entry);
    entry.syncFilePath = path.join(this.sessionSyncDir, `${entry.threadId}.json`);
    try {
      await rm(entry.syncFilePath, { force: true });
    } catch {
      // ignore stale file cleanup failures
    }
    try {
      entry.syncWatcher = watch(this.sessionSyncDir, { persistent: false }, (_eventType, fileName) => {
        if (fileName && fileName.toString() !== path.basename(entry.syncFilePath!)) return;
        this.scheduleSessionSyncRefresh(entry);
      });
    } catch (error) {
      this.logger.warn("failed to watch pi session sync dir", {
        threadId: entry.threadId,
        syncDir: this.sessionSyncDir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private stopSessionSyncWatcher(entry: PiSessionEntry): void {
    if (entry.syncDebounceTimer) {
      clearTimeout(entry.syncDebounceTimer);
      entry.syncDebounceTimer = null;
    }
    entry.syncWatcher?.close();
    entry.syncWatcher = null;
    entry.syncFilePath = null;
  }

  private scheduleSessionSyncRefresh(entry: PiSessionEntry): void {
    if (entry.syncDebounceTimer) clearTimeout(entry.syncDebounceTimer);
    entry.syncDebounceTimer = setTimeout(() => {
      entry.syncDebounceTimer = null;
      void this.runWithThreadLock(entry.threadId, async () => {
        const current = this.sessions.get(entry.threadId);
        if (!current) return;
        await this.refreshSessionSyncFile(current);
      });
    }, 80);
    entry.syncDebounceTimer.unref?.();
  }

  private async refreshSessionSyncFile(entry: PiSessionEntry): Promise<void> {
    if (!entry.syncFilePath || !existsSync(entry.syncFilePath)) return;

    let payload: PiSessionSyncPayload;
    try {
      const raw = await readFile(entry.syncFilePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.threadId !== entry.threadId) return;
      const hookStatus = parsePiHookStatus(parsed.hookStatus);
      payload = {
        threadId: entry.threadId,
        sessionFile: typeof parsed.sessionFile === "string" ? parsed.sessionFile : null,
        timestamp:
          typeof parsed.timestamp === "string" ? parsed.timestamp : new Date().toISOString(),
        ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
        ...(hookStatus !== undefined ? { hookStatus } : {}),
      };
    } catch (error) {
      this.logger.warn("failed to parse pi session sync file", {
        threadId: entry.threadId,
        syncFilePath: entry.syncFilePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const nextSessionFile = payload.sessionFile ? path.resolve(payload.sessionFile) : null;
    if (nextSessionFile !== entry.activeSessionFile) {
      entry.activeSessionFile = nextSessionFile;
      if (entry.jsonlHookWatcher) {
        entry.jsonlHookWatcher.setSessionFile(nextSessionFile);
      } else {
        this.startJsonlHookWatcher(entry, nextSessionFile);
      }

      this.logger.info("pi session file updated", {
        threadId: entry.threadId,
        sessionFile: nextSessionFile,
        reason: payload.reason,
      });

      this.emitEvent({
        type: "sessionFile",
        threadId: entry.threadId,
        createdAt: payload.timestamp,
        sessionFile: nextSessionFile,
      });
    }

    if ("hookStatus" in payload) {
      this.applyHookStatusIfChanged(entry, payload.hookStatus ?? null);
    }
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
    this.stopSessionSyncWatcher(entry);
    this.resetHookStatus(entry);

    this.logger.info("pi session exited", {
      threadId: entry.threadId,
      exitCode: event.exitCode,
      signal: event.signal,
      activeSessionFile: entry.activeSessionFile,
    });

    this.emitEvent({
      type: "exited",
      threadId: entry.threadId,
      createdAt: new Date().toISOString(),
      exitCode: Number.isInteger(event.exitCode) ? event.exitCode : null,
    });
  }

  private stopProcess(entry: PiSessionEntry): void {
    this.stopSessionSyncWatcher(entry);
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
    const settings = yield* Effect.promise(() => loadServerSettings(serverConfig.stateDir));

    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() =>
        new PiSessionManagerRuntime({
          ptyAdapter,
          stateDir: serverConfig.stateDir,
          maxActiveSessions: settings.maxActiveHarnessSessions,
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
      getScrollback: (threadId, sinceOffset) =>
        Effect.sync(() => runtime.getScrollback(threadId, sinceOffset)),
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
      getSessionFile: (threadId) => Effect.sync(() => runtime.getSessionFile(threadId)),
      reconcileActiveSessions: (maxActive) => Effect.promise(() => runtime.reconcileActiveSessions(maxActive)),
      setMaxActiveSessions: (maxActive) => Effect.promise(() => runtime.setMaxActiveSessions(maxActive)),
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
