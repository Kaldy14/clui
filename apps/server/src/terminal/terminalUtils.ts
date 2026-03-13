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
  if (normalized.startsWith("T3CODE_")) return true;
  if (normalized.startsWith("CLUI_")) return true;
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
