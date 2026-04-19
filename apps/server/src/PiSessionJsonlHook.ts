/**
 * Watches the active pi session JSONL file and maps persisted session lines to
 * hookStatus events.
 *
 * Pi's SessionManager buffers the first user turn on disk until the first
 * assistant message exists (`_persist` / `hasAssistant` in @mariozechner/pi-coding-agent).
 * Clui pairs this watcher with `notifyPromptSubmitted` on `pi.write` newlines.
 */
import { closeSync, existsSync, openSync, readSync, statSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";

import type { ClaudeHookStatus, PiSessionEvent } from "@clui/contracts";

export interface PiJsonlHookLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface PiSessionJsonlHookWatcherOptions {
  readonly threadId: string;
  readonly logger: PiJsonlHookLogger;
  readonly emitHookStatus: (event: PiSessionEvent) => void;
}

/**
 * Returns the hookStatus to apply after processing a complete JSONL line, or
 * `null` if the line does not imply a change.
 */
export function hookStatusFromSessionJsonlLine(line: string): ClaudeHookStatus | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  if (rec.type !== "message") return null;
  const message = rec.message;
  if (!message || typeof message !== "object") return null;
  const role = (message as Record<string, unknown>).role;
  if (role === "user") {
    return "working";
  }
  if (role === "assistant") {
    const stopReason = (message as Record<string, unknown>).stopReason;
    if (stopReason === "toolUse") {
      return "working";
    }
    if (stopReason === "stop" || stopReason === "length") {
      return "completed";
    }
    if (stopReason === "error" || stopReason === "aborted") {
      return "error";
    }
    return "working";
  }
  return null;
}

export class PiSessionJsonlHookWatcher {
  private readonly threadId: string;
  private readonly logger: PiJsonlHookLogger;
  private readonly emitHookStatus: (event: PiSessionEvent) => void;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private activeFile: string | null = null;
  private watchedDir: string | null = null;
  /** Byte offset in `activeFile` already processed. */
  private readOffset = 0;
  private lastEmitted: ClaudeHookStatus | null = null;
  private lineCarry = "";

  constructor(options: PiSessionJsonlHookWatcherOptions) {
    this.threadId = options.threadId;
    this.logger = options.logger;
    this.emitHookStatus = options.emitHookStatus;
  }

  start(sessionFile: string | null): void {
    this.stop();
    this.setSessionFile(sessionFile);
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.activeFile = null;
    this.watchedDir = null;
    this.readOffset = 0;
    this.lastEmitted = null;
    this.lineCarry = "";
  }

  setSessionFile(sessionFile: string | null): void {
    const normalized = sessionFile ? path.resolve(sessionFile) : null;
    if (this.activeFile === normalized && this.watcher) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    this.activeFile = normalized;
    this.watchedDir = normalized ? path.dirname(normalized) : null;
    this.readOffset = 0;
    this.lastEmitted = null;
    this.lineCarry = "";

    if (!normalized || !this.watchedDir) {
      return;
    }

    this.rescan();

    try {
      this.watcher = watch(this.watchedDir, { persistent: false }, (_eventType, fileName) => {
        if (!this.activeFile) return;
        if (fileName) {
          const changed = path.join(this.watchedDir!, fileName.toString());
          if (changed !== this.activeFile) return;
        }
        this.scheduleRescan();
      });
    } catch (error) {
      this.logger.warn("pi jsonl hook: failed to watch session file", {
        threadId: this.threadId,
        sessionFile: normalized,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private scheduleRescan(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      try {
        this.rescan();
      } catch (error) {
        this.logger.warn("pi jsonl hook: rescan failed", {
          threadId: this.threadId,
          sessionFile: this.activeFile,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, 80);
    this.debounceTimer.unref?.();
  }

  private rescan(): void {
    if (!this.activeFile || !existsSync(this.activeFile)) return;

    let size = 0;
    try {
      size = statSync(this.activeFile).size;
    } catch {
      return;
    }

    if (size < this.readOffset) {
      this.readOffset = 0;
      this.lineCarry = "";
      this.lastEmitted = null;
    }
    if (size === this.readOffset) return;

    const fd = openSync(this.activeFile, "r");
    try {
      const toRead = size - this.readOffset;
      const buf = Buffer.alloc(toRead);
      const bytes = readSync(fd, buf, 0, toRead, this.readOffset);
      this.readOffset += bytes;
      const chunk = buf.slice(0, bytes).toString("utf8");
      this.processChunk(chunk);
    } finally {
      closeSync(fd);
    }
  }

  private processChunk(chunk: string): void {
    const combined = this.lineCarry + chunk;
    const lines = combined.split("\n");
    this.lineCarry = lines.pop() ?? "";
    for (const line of lines) {
      const next = hookStatusFromSessionJsonlLine(line);
      if (next == null) continue;
      if (next === this.lastEmitted) continue;
      this.lastEmitted = next;
      this.emitHookStatus({
        type: "hookStatus",
        threadId: this.threadId,
        createdAt: new Date().toISOString(),
        hookStatus: next,
      });
    }
  }
}
