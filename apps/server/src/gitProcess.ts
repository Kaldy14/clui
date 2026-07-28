import { execFile } from "node:child_process";

const DEFAULT_GIT_PROCESS_TIMEOUT_MS = 30_000;
const GIT_PROCESS_FORCE_KILL_DELAY_MS = 1_000;

export interface GitProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface GitProcessOptions {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly maxBufferBytes: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export function normalizeGitPathArgument(filePath: string): string {
  return filePath === "-" ? "./-" : filePath;
}

export function runGitProcess(options: GitProcessOptions): Promise<GitProcessResult> {
  if (options.signal?.aborted) {
    return Promise.reject(new Error("git process aborted"));
  }

  return new Promise((resolve, reject) => {
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const child = execFile(
      "git",
      [...options.args],
      {
        cwd: options.cwd,
        encoding: "utf8",
        maxBuffer: options.maxBufferBytes,
      },
      (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        options.signal?.removeEventListener("abort", abort);

        if (timedOut) {
          reject(new Error(`git process timed out after ${timeoutMs}ms`));
          return;
        }
        if (aborted) {
          reject(new Error("git process aborted"));
          return;
        }

        const code = error && typeof error.code === "number" ? error.code : 0;
        if (error && code === 0) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr, code });
      },
    );

    const terminate = (): void => {
      if (forceKillTimer !== null || child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, GIT_PROCESS_FORCE_KILL_DELAY_MS);
      forceKillTimer.unref();
    };

    const abort = (): void => {
      aborted = true;
      terminate();
    };

    const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_PROCESS_TIMEOUT_MS;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeoutTimer.unref();

    child.stdin?.once("error", () => {
      // The process result carries the actionable error; stdin is intentionally unused.
    });
    child.stdin?.end();

    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
