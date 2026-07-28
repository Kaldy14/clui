import fs from "node:fs";

const TERMINAL_ENV_BLOCKLIST = new Set([
  "PORT",
  "ELECTRON_RENDERER_PORT",
  "ELECTRON_RUN_AS_NODE",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DATABASE_URL",
]);

const SENSITIVE_SUFFIX_PATTERNS = ["_SECRET", "_TOKEN", "_KEY"];

/**
 * A line-bounded append buffer with monotonic byte offsets.
 *
 * Trimming advances a head index instead of copying the retained history on
 * every append. The backing array is compacted occasionally, making removal
 * amortized O(1) per line while keeping memory bounded.
 */
export class BoundedLineBuffer {
  private lines: string[] = [];
  private head = 0;
  private partial = "";
  private totalBytes = 0;

  constructor(
    private readonly maxLines: number,
    options: {
      initialValue?: string;
      partialLineCountsTowardLimit?: boolean;
    } = {},
  ) {
    if (!Number.isInteger(maxLines) || maxLines < 0) {
      throw new Error(`maxLines must be a non-negative integer (received ${maxLines})`);
    }
    this.partialLineCountsTowardLimit = options.partialLineCountsTowardLimit ?? false;
    this.append(options.initialValue ?? "");
  }

  private readonly partialLineCountsTowardLimit: boolean;

  append(data: string): void {
    if (data.length === 0) return;
    this.totalBytes += data.length;
    const parts = `${this.partial}${data}`.split("\n");
    this.partial = parts.pop() ?? "";
    for (const line of parts) {
      this.lines.push(line);
    }

    const completeLineCount = this.lines.length - this.head;
    const completeLineLimit = Math.max(
      0,
      this.maxLines - (this.partialLineCountsTowardLimit && this.partial.length > 0 ? 1 : 0),
    );
    if (completeLineCount > completeLineLimit) {
      this.head += completeLineCount - completeLineLimit;
      this.compactIfNeeded();
    }
  }

  get offset(): number {
    return this.totalBytes;
  }

  materialize(): string {
    if (this.head === this.lines.length) return this.partial;
    const retainedLines = this.lines.slice(this.head).join("\n");
    return this.partial.length > 0 ? `${retainedLines}\n${this.partial}` : `${retainedLines}\n`;
  }

  materializeSince(sinceOffset: number): string | null {
    if (sinceOffset > this.totalBytes) return null;
    if (sinceOffset === this.totalBytes) return "";
    const currentData = this.materialize();
    const availableStart = this.totalBytes - currentData.length;
    if (sinceOffset < availableStart) return null;
    return currentData.slice(sinceOffset - availableStart);
  }

  clear(): void {
    this.lines = [];
    this.head = 0;
    this.partial = "";
    this.totalBytes = 0;
  }

  private compactIfNeeded(): void {
    if (this.head < 1_024 || this.head * 2 < this.lines.length) return;
    this.lines = this.lines.slice(this.head);
    this.head = 0;
  }
}

export function capHistory(history: string, maxLines: number): string {
  if (history.length === 0) return history;
  const hasTrailingNewline = history.endsWith("\n");
  const lines = history.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  if (lines.length <= maxLines) return history;
  const capped = lines.slice(lines.length - maxLines).join("\n");
  return hasTrailingNewline ? `${capped}\n` : capped;
}

export function shouldExcludeEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  if (normalized.startsWith("VITE_")) return true;
  if (normalized.startsWith("CLUI_")) return true;
  // Strip Claude Code env vars to prevent nested-session detection (forces --print mode).
  // Strip CMUX vars so the cmux claude wrapper does a clean pass-through.
  if (normalized === "CLAUDECODE" || normalized.startsWith("CLAUDE_CODE_")) return true;
  if (normalized.startsWith("CMUX_")) return true;
  if (TERMINAL_ENV_BLOCKLIST.has(normalized)) return true;
  for (const suffix of SENSITIVE_SUFFIX_PATTERNS) {
    if (normalized.endsWith(suffix)) return true;
  }
  return false;
}

export function createSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv?: Record<string, string> | null,
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeEnvKey(key)) continue;
    spawnEnv[key] = value;
  }
  // xterm.js supports 24-bit true-color — ensure child processes know this
  // regardless of whether the parent (e.g. Electron) has COLORTERM set.
  if (!spawnEnv.COLORTERM) {
    spawnEnv.COLORTERM = "truecolor";
  }
  if (runtimeEnv) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      spawnEnv[key] = value;
    }
  }
  return spawnEnv;
}

export async function runWithThreadLock<T>(
  locks: Map<string, Promise<void>>,
  threadId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(threadId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(threadId, current);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (locks.get(threadId) === current) {
      locks.delete(threadId);
    }
  }
}

export async function assertValidCwd(cwd: string): Promise<void> {
  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(cwd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Terminal cwd does not exist: ${cwd}`, { cause: error });
    }
    throw error;
  }
  if (!stats.isDirectory()) {
    throw new Error(`Terminal cwd is not a directory: ${cwd}`);
  }
}
