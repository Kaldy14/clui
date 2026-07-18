import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createServer } from "node:net";
import type { Readable } from "node:stream";

import { type ClaudeCodeProxyStatus } from "@clui/contracts";
import { resolveClaudeCodeProxyModel } from "@clui/shared/claudeCodeProxy";

import { createLogger } from "../logger";

const PROXY_START_TIMEOUT_MS = 8_000;
const PROXY_COMMAND_TIMEOUT_MS = 10_000;
const PROXY_AUTH_URL_TIMEOUT_MS = 5_000;
const PROXY_OUTPUT_LIMIT = 8_192;
const PROXY_HOST = "127.0.0.1";

interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnError?: Error;
  readonly timedOut: boolean;
}

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = `${current}${chunk.toString()}`;
  return next.length <= PROXY_OUTPUT_LIMIT ? next : next.slice(-PROXY_OUTPUT_LIMIT);
}

export function findClaudeCodeProxyAuthorizationUrl(output: string): string | null {
  for (const match of output.matchAll(/https:\/\/[^\s]+/g)) {
    try {
      const url = new URL(match[0]);
      if (url.protocol === "https:") return url.toString();
    } catch {
      // Ignore incomplete output while the child process is still writing.
    }
  }
  return null;
}

function waitForAuthorizationUrl(
  child: ChildProcessByStdio<null, Readable, Readable>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stdout.resume();
      child.stderr.resume();
    };
    const finish = (result: { readonly url: string } | { readonly error: Error }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if ("url" in result) resolve(result.url);
      else reject(result.error);
    };
    const onStdout = (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
      const url = findClaudeCodeProxyAuthorizationUrl(stdout);
      if (url) finish({ url });
    };
    const onStderr = (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    };
    const onError = (error: Error) => finish({ error });
    const onExit = (exitCode: number | null) =>
      finish({
        error: new Error(
          stderr.trim() ||
            `Codex sign-in exited before providing an authorization URL (exit ${exitCode ?? "unknown"}).`,
        ),
      });
    const timeout = setTimeout(
      () =>
        finish({
          error: new Error("Codex sign-in did not provide an authorization URL."),
        }),
      PROXY_AUTH_URL_TIMEOUT_MS,
    );
    timeout.unref?.();

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function runCommand(
  binaryPath: string,
  args: readonly string[],
  timeoutMs = PROXY_COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn(binaryPath, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const finish = (result: Omit<CommandResult, "stdout" | "stderr" | "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ...result, stdout, stderr, timedOut });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", (error) => finish({ exitCode: null, spawnError: error }));
    child.once("exit", (exitCode) => finish({ exitCode }));

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
      finish({ exitCode: null });
    }, timeoutMs);
    timeout.unref?.();
  });
}

function findAvailableLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, PROXY_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port for Claude Code proxy."));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, delayMs);
    timeout.unref?.();
  });
}

export class ClaudeCodeProxyManager {
  private readonly binaryPath: string;
  private readonly openAuthorizationUrl: ((url: string) => Promise<void>) | null;
  private readonly logger = createLogger("claude-code-proxy");
  private proxyProcess: ReturnType<typeof spawn> | null = null;
  private proxyPort: number | null = null;
  private startPromise: Promise<string> | null = null;
  private authProcess: ReturnType<typeof spawn> | null = null;
  private lastAuthError: string | null = null;
  private disposed = false;

  constructor(binaryPath?: string, openAuthorizationUrl?: (url: string) => Promise<void>) {
    this.binaryPath = binaryPath?.trim() || "claude-code-proxy";
    this.openAuthorizationUrl = openAuthorizationUrl ?? null;
  }

  async getStatus(): Promise<ClaudeCodeProxyStatus> {
    const authResult = await runCommand(this.binaryPath, ["codex", "auth", "status"]);
    if (authResult.spawnError) {
      return {
        available: false,
        authenticated: false,
        running: false,
        authInProgress: this.authProcess !== null,
        message:
          this.binaryPath === "claude-code-proxy"
            ? "The bundled Claude Code proxy is unavailable in this build."
            : `Claude Code proxy could not be started from ${this.binaryPath}.`,
      };
    }

    const versionResult = await runCommand(this.binaryPath, ["--version"]);
    const versionText = versionResult.exitCode === 0 ? versionResult.stdout.trim() : "";
    const authenticated = authResult.exitCode === 0;
    return {
      available: true,
      authenticated,
      running: this.proxyProcess !== null,
      authInProgress: this.authProcess !== null,
      ...(versionText ? { version: versionText } : {}),
      ...(this.lastAuthError
        ? { message: this.lastAuthError }
        : authenticated
          ? { message: "Codex subscription is connected." }
          : { message: "Sign in with a ChatGPT Plus or Pro account to use Codex models." }),
    };
  }

  async startLogin(): Promise<ClaudeCodeProxyStatus> {
    const status = await this.getStatus();
    if (!status.available) {
      throw new Error(status.message ?? "Claude Code proxy is unavailable.");
    }
    if (this.authProcess) return status;
    if (!this.openAuthorizationUrl) {
      throw new Error("Browser opening is unavailable for Codex sign-in.");
    }

    this.lastAuthError = null;
    const child = spawn(this.binaryPath, ["codex", "auth", "login"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.authProcess = child;
    child.once("error", (error) => {
      if (this.authProcess === child) this.authProcess = null;
      this.lastAuthError = `Codex sign-in could not start: ${error.message}`;
      this.logger.warn("codex auth login failed to start", { error: error.message });
    });
    child.once("exit", (code, signal) => {
      const wasCurrent = this.authProcess === child;
      if (wasCurrent) this.authProcess = null;
      if (code !== 0 && wasCurrent) {
        this.lastAuthError = `Codex sign-in stopped before completion (${signal ?? `exit ${code}`}).`;
        this.logger.warn("codex auth login exited", { code, signal });
      }
    });

    try {
      const authorizationUrl = await waitForAuthorizationUrl(child);
      await this.openAuthorizationUrl(authorizationUrl);
    } catch (error) {
      child.kill();
      if (this.authProcess === child) this.authProcess = null;
      const message = error instanceof Error ? error.message : "Codex sign-in could not start.";
      this.lastAuthError = message;
      throw new Error(message, { cause: error });
    }

    return {
      ...status,
      authInProgress: true,
      message: "Complete the Codex sign-in in your browser.",
    };
  }

  async logout(): Promise<ClaudeCodeProxyStatus> {
    this.stopProxy();
    this.authProcess?.kill();
    this.authProcess = null;
    this.lastAuthError = null;

    const result = await runCommand(this.binaryPath, ["codex", "auth", "logout"]);
    if (result.spawnError) {
      throw new Error("Claude Code proxy is unavailable.");
    }
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Could not disconnect the Codex subscription.");
    }
    return this.getStatus();
  }

  async getClaudeEnvironment(model: string): Promise<Record<string, string>> {
    const status = await this.getStatus();
    if (!status.available) {
      throw new Error(status.message ?? "Claude Code proxy is unavailable.");
    }
    if (!status.authenticated) {
      throw new Error("Codex subscription is not connected. Open Clui Settings and sign in first.");
    }

    const baseUrl = await this.ensureReady();
    const resolvedModel = resolveClaudeCodeProxyModel(model);
    return {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: "unused",
      ANTHROPIC_MODEL: `${resolvedModel}[1m]`,
      ANTHROPIC_SMALL_FAST_MODEL: "gpt-5.6-luna[1m]",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "272000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
    };
  }

  dispose(): void {
    this.disposed = true;
    this.authProcess?.kill();
    this.authProcess = null;
    this.stopProxy();
  }

  private ensureReady(): Promise<string> {
    if (this.disposed) {
      return Promise.reject(new Error("Claude Code proxy manager is disposed."));
    }
    if (this.proxyProcess && this.proxyPort) {
      return Promise.resolve(`http://${PROXY_HOST}:${this.proxyPort}`);
    }
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startProxy().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startProxy(): Promise<string> {
    const port = await findAvailableLoopbackPort();
    let startupOutput = "";
    const child = spawn(this.binaryPath, ["serve"], {
      env: {
        ...process.env,
        PORT: String(port),
        CCP_BIND_ADDRESS: PROXY_HOST,
        CCP_LOG_STDERR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proxyProcess = child;
    this.proxyPort = port;
    child.stdout.on("data", (chunk: Buffer) => {
      startupOutput = appendBounded(startupOutput, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      startupOutput = appendBounded(startupOutput, chunk);
    });
    child.once("error", (error) => {
      if (this.proxyProcess === child) {
        this.proxyProcess = null;
        this.proxyPort = null;
      }
      this.logger.warn("proxy process error", { error: error.message });
    });
    child.once("exit", (code, signal) => {
      if (this.proxyProcess === child) {
        this.proxyProcess = null;
        this.proxyPort = null;
      }
      if (!this.disposed) {
        this.logger.warn("proxy process exited", { code, signal });
      }
    });

    const deadline = Date.now() + PROXY_START_TIMEOUT_MS;
    const healthUrl = `http://${PROXY_HOST}:${port}/healthz`;
    while (Date.now() < deadline) {
      if (this.proxyProcess !== child || child.exitCode !== null) break;
      try {
        const response = await fetch(healthUrl, { signal: AbortSignal.timeout(500) });
        if (response.ok) {
          this.logger.info("proxy ready", { port });
          return `http://${PROXY_HOST}:${port}`;
        }
      } catch {
        // The proxy is still starting.
      }
      await wait(100);
    }

    this.stopProxy();
    const detail = startupOutput.trim();
    throw new Error(
      detail
        ? `Claude Code proxy did not become ready: ${detail}`
        : "Claude Code proxy did not become ready before the startup timeout.",
    );
  }

  private stopProxy(): void {
    const child = this.proxyProcess;
    this.proxyProcess = null;
    this.proxyPort = null;
    if (!child || child.exitCode !== null) return;
    child.kill();
  }
}
