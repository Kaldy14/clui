import { mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";

export const PI_RESEARCH_TOOL_ALLOWLIST = "read,grep,find,ls";
export const CODEX_RESEARCH_SANDBOX = "read-only";
export const CODEX_JOURNEY_MCP_APPROVAL_CONFIG =
  'mcp_servers.clui_journey.default_tools_approval_mode="approve"';

export interface ResearchProcessLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Sole process-launch construction boundary for future Journey coordinator and
 * research-worker adapters. The existing thread-keyed session managers are
 * interactive terminal owners and must not be used to construct worker argv:
 * doing so would bypass the fail-closed capability checks in this module.
 */

function assertAbsolutePath(name: string, value: string): void {
  if (!path.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${name} must be an absolute path without NUL bytes.`);
  }
}

function seatbeltString(value: string): string {
  return JSON.stringify(value);
}

function darwinSeatbeltPath(value: string): string {
  if (value === "/var" || value.startsWith("/var/")) return `/private${value}`;
  if (value === "/tmp" || value.startsWith("/tmp/")) return `/private${value}`;
  return value;
}

export function buildDarwinReadOnlySandboxProfile(
  runtimeWritableRoots: ReadonlyArray<string>,
): string {
  if (runtimeWritableRoots.length === 0) {
    throw new Error("A research process requires at least one isolated writable runtime root.");
  }
  for (const root of runtimeWritableRoots) {
    assertAbsolutePath("runtime writable root", root);
  }

  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    '(allow file-write* (literal "/dev/null"))',
    ...runtimeWritableRoots.map(
      (root) =>
        `(allow file-write* (subpath ${seatbeltString(darwinSeatbeltPath(path.resolve(root)))}))`,
    ),
  ].join("\n");
}

function assertNoPiToolOverride(args: ReadonlyArray<string>): void {
  const forbiddenExact = new Set([
    "--tools",
    "-t",
    "--exclude-tools",
    "-xt",
    "--no-tools",
    "-nt",
    "--no-builtin-tools",
    "-nbt",
    "--extension",
    "-e",
  ]);
  const override = args.find(
    (arg) =>
      forbiddenExact.has(arg) ||
      arg.startsWith("--tools=") ||
      arg.startsWith("--exclude-tools=") ||
      arg.startsWith("--extension=") ||
      /^-t.+/.test(arg) ||
      /^-xt.+/.test(arg) ||
      /^-e.+/.test(arg),
  );
  if (override) {
    throw new Error(
      `Pi research launch arguments cannot override the enforced tool allowlist: ${override}`,
    );
  }
}

export async function preparePiResearchRuntime(runtimeRoot: string): Promise<{
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly tempDir: string;
}> {
  assertAbsolutePath("Pi research runtime root", runtimeRoot);
  const resolvedRoot = path.resolve(runtimeRoot);
  const requestedAgentDir = path.join(resolvedRoot, "agent");
  const requestedSessionDir = path.join(resolvedRoot, "sessions");
  const requestedTempDir = path.join(resolvedRoot, "tmp");
  await Promise.all([
    mkdir(requestedAgentDir, { recursive: true }),
    mkdir(requestedSessionDir, { recursive: true }),
    mkdir(requestedTempDir, { recursive: true }),
  ]);
  const canonicalRoot = realpathSync.native(resolvedRoot);
  const agentDir = path.join(canonicalRoot, "agent");
  const sessionDir = path.join(canonicalRoot, "sessions");
  const tempDir = path.join(canonicalRoot, "tmp");
  return { agentDir, sessionDir, tempDir };
}

export function buildPiResearchProcessLaunch(input: {
  readonly piExecutable: string;
  readonly piArgs: ReadonlyArray<string>;
  readonly trustedExtensionPaths?: ReadonlyArray<string>;
  readonly trustedToolNames?: ReadonlyArray<string>;
  readonly runtimeRoot: string;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly sandboxExecutable?: string;
}): ResearchProcessLaunch {
  const platform = input.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new Error(`Pi research filesystem isolation is unavailable on ${platform}.`);
  }
  assertAbsolutePath("Pi executable", input.piExecutable);
  assertAbsolutePath("Pi research runtime root", input.runtimeRoot);
  assertNoPiToolOverride(input.piArgs);
  for (const extensionPath of input.trustedExtensionPaths ?? []) {
    assertAbsolutePath("trusted Pi extension", extensionPath);
  }
  for (const toolName of input.trustedToolNames ?? []) {
    if (!/^[a-z][a-z0-9_]*$/u.test(toolName)) {
      throw new Error(`Invalid trusted Pi tool name: ${toolName}`);
    }
  }

  let runtimeRoot: string;
  try {
    runtimeRoot = realpathSync.native(input.runtimeRoot);
  } catch (cause) {
    throw new Error("Pi research runtime must be prepared before building its launch profile.", {
      cause,
    });
  }
  const agentDir = path.join(runtimeRoot, "agent");
  const sessionDir = path.join(runtimeRoot, "sessions");
  const tempDir = path.join(runtimeRoot, "tmp");
  const sandboxExecutable = input.sandboxExecutable ?? "/usr/bin/sandbox-exec";
  assertAbsolutePath("sandbox executable", sandboxExecutable);

  const env = Object.fromEntries(
    Object.entries(input.baseEnv ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  env.PI_CODING_AGENT_DIR = agentDir;
  env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  env.TMPDIR = tempDir;

  return {
    command: sandboxExecutable,
    args: [
      "-p",
      buildDarwinReadOnlySandboxProfile([runtimeRoot]),
      input.piExecutable,
      "--session-dir",
      sessionDir,
      "--tools",
      [PI_RESEARCH_TOOL_ALLOWLIST, ...(input.trustedToolNames ?? [])].join(","),
      ...(input.trustedExtensionPaths ?? []).flatMap((extensionPath) => [
        "--extension",
        extensionPath,
      ]),
      ...input.piArgs,
    ],
    env,
  };
}

export function buildCodexResearchProcessLaunch(input: {
  readonly codexExecutable: string;
  readonly codexArgs: ReadonlyArray<string>;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
}): ResearchProcessLaunch {
  assertAbsolutePath("Codex executable", input.codexExecutable);
  if (
    input.codexArgs.some(
      (arg) =>
        arg === "--dangerously-bypass-approvals-and-sandbox" ||
        arg.startsWith("--dangerously-bypass-approvals-and-sandbox="),
    )
  ) {
    throw new Error("Codex research processes cannot bypass approvals or sandboxing.");
  }

  const execIndex = input.codexArgs.indexOf("exec");
  if (execIndex === -1) {
    throw new Error("Codex research processes require non-interactive exec mode.");
  }
  const sandboxValues: string[] = [];
  const assertSafeConfig = (value: string): void => {
    const key = value.split("=", 1)[0]!;
    if (
      /(sandbox|approval|permission|dangerous)/i.test(key) &&
      value !== CODEX_JOURNEY_MCP_APPROVAL_CONFIG
    ) {
      throw new Error("Codex research processes cannot override sandbox or approval config.");
    }
  };
  for (let index = 0; index < input.codexArgs.length; index += 1) {
    const arg = input.codexArgs[index]!;
    if (arg === "--sandbox" || arg === "-s") {
      const value = input.codexArgs[index + 1];
      if (!value) throw new Error(`Codex research sandbox flag is missing its value: ${arg}`);
      sandboxValues.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--sandbox=")) {
      sandboxValues.push(arg.slice("--sandbox=".length));
      continue;
    }
    if (arg.startsWith("-s=") || /^-s[^-].+/.test(arg)) {
      sandboxValues.push(arg.replace(/^-s=?/, ""));
      continue;
    }
    if (arg === "--config" || arg === "-c") {
      const value = input.codexArgs[index + 1];
      if (!value) throw new Error(`Codex config flag is missing its value: ${arg}`);
      assertSafeConfig(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--config=") || /^-c[^-].+/.test(arg)) {
      const value = arg.replace(/^(?:--config=|-c=?)/, "");
      assertSafeConfig(value);
    }
  }

  if (sandboxValues.length > 1) {
    throw new Error("Codex research processes cannot specify duplicate sandbox flags.");
  }
  if (sandboxValues.some((value) => value !== CODEX_RESEARCH_SANDBOX)) {
    throw new Error("Codex research processes require the read-only sandbox.");
  }

  const codexArgs = [...input.codexArgs];
  if (sandboxValues.length === 0) {
    codexArgs.splice(execIndex + 1, 0, "--sandbox", CODEX_RESEARCH_SANDBOX);
  }

  return {
    command: input.codexExecutable,
    args: codexArgs,
    env: Object.fromEntries(
      Object.entries(input.baseEnv ?? {}).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  };
}
