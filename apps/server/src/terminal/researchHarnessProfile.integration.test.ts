import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import {
  buildCodexResearchProcessLaunch,
  buildDarwinReadOnlySandboxProfile,
  preparePiResearchRuntime,
} from "./researchHarnessProfile";

const execFileAsync = promisify(execFile);
const RUN_REAL_GATES = process.env.CLUI_RUN_REAL_RESEARCH_HARNESS_GATES === "1";
const tempDirs: string[] = [];

interface ProbeOutcome {
  readonly allowed: boolean;
  readonly code?: string;
  readonly value?: string;
}

interface ProbeResult {
  readonly attempts: Record<string, ProbeOutcome>;
}

const PROBE_SOURCE = String.raw`
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const workspace = process.env.CLUI_PROBE_WORKSPACE ?? process.cwd();
const resultPath = process.env.CLUI_PROBE_RESULT;
const attempts = {};
function capture(name, operation) {
  try {
    const value = operation();
    attempts[name] = { allowed: true, ...(value === undefined ? {} : { value: String(value) }) };
  } catch (error) {
    attempts[name] = {
      allowed: false,
      code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : "UNKNOWN",
    };
  }
}
capture("read", () => readFileSync(path.join(workspace, "tracked.txt"), "utf8"));
capture("list", () => readdirSync(workspace).includes("tracked.txt"));
capture("search", () => execFileSync("rg", ["-n", "original fixture", "tracked.txt"], {
  cwd: workspace,
  encoding: "utf8",
}));
capture("gitStatus", () => execFileSync("git", ["status", "--short"], {
  cwd: workspace,
  encoding: "utf8",
  env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
}));
capture("create", () => writeFileSync(path.join(workspace, "created.txt"), "created"));
capture("modify", () => writeFileSync(path.join(workspace, "tracked.txt"), "modified"));
capture("rename", () => renameSync(path.join(workspace, "rename-source.txt"), path.join(workspace, "renamed.txt")));
capture("delete", () => rmSync(path.join(workspace, "delete-source.txt")));
capture("createSymlink", () => symlinkSync("..", path.join(workspace, "created-parent-alias"), "dir"));
capture("symlinkAliasWrite", () => writeFileSync(path.join(workspace, "parent-alias", "symlink-write.txt"), "escaped"));
capture("parentEscapeWrite", () => writeFileSync(path.join(workspace, "..", "escaped-write.txt"), "escaped"));
const serialized = JSON.stringify({ attempts });
if (resultPath) writeFileSync(resultPath, serialized);
console.log("CLUI_PROBE_RESULT=" + serialized);
if (resultPath) process.exit(0);
export default function probe() {}
`;

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function resolveCommand(command: string): Promise<string> {
  const { stdout } = await execFileAsync("/bin/zsh", ["-ilc", `command -v ${command}`]);
  const resolved = stdout.trim();
  if (!path.isAbsolute(resolved)) throw new Error(`${command} was not found as an absolute path.`);
  return resolved;
}

async function resolvePiExecutable(): Promise<string> {
  if (process.env.CLUI_REAL_PI_EXECUTABLE) return realpath(process.env.CLUI_REAL_PI_EXECUTABLE);
  const { stdout } = await execFileAsync("npm", [
    "exec",
    "--yes",
    "--package=@earendil-works/pi-coding-agent",
    "--",
    "sh",
    "-c",
    "command -v pi",
  ]);
  return realpath(stdout.trim());
}

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function runWithClosedStdin(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(`Harness exited with code ${String(code)} (${String(signal)}): ${stderr}`),
        );
    });
  });
}

async function makeFixture(): Promise<{
  readonly root: string;
  readonly workspace: string;
  readonly runtimeRoot: string;
  readonly baselineHashes: Record<string, string>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "clui-real-research-gate-"));
  tempDirs.push(root);
  const workspace = path.join(root, "workspace");
  const runtimeRoot = path.join(root, "runtime");
  await mkdir(workspace);
  await preparePiResearchRuntime(runtimeRoot);
  await Promise.all([
    writeFile(path.join(workspace, "tracked.txt"), "original fixture content\n"),
    writeFile(path.join(workspace, "rename-source.txt"), "rename fixture\n"),
    writeFile(path.join(workspace, "delete-source.txt"), "delete fixture\n"),
    writeFile(path.join(root, "parent-fixture.txt"), "parent fixture\n"),
    writeFile(path.join(workspace, "probe.mjs"), PROBE_SOURCE),
    symlink("..", path.join(workspace, "parent-alias"), "dir"),
  ]);
  await execFileAsync("git", ["init", "-q"], { cwd: workspace });
  await execFileAsync("git", ["add", "."], { cwd: workspace });
  await execFileAsync(
    "git",
    ["-c", "user.name=Clui", "-c", "user.email=clui@example.invalid", "commit", "-qm", "fixture"],
    { cwd: workspace },
  );
  const baselineHashes = Object.fromEntries(
    await Promise.all(
      ["tracked.txt", "rename-source.txt", "delete-source.txt", "../parent-fixture.txt"].map(
        async (relativePath) => [relativePath, await sha256(path.resolve(workspace, relativePath))],
      ),
    ),
  );
  return { root, workspace, runtimeRoot, baselineHashes };
}

function assertFullMatrix(result: ProbeResult): void {
  for (const name of ["read", "list", "search", "gitStatus"]) {
    expect(result.attempts[name], `${name} should be allowed`).toMatchObject({ allowed: true });
  }
  expect(result.attempts.gitStatus?.value).toBe("");
  for (const name of [
    "create",
    "modify",
    "rename",
    "delete",
    "createSymlink",
    "symlinkAliasWrite",
    "parentEscapeWrite",
  ]) {
    expect(result.attempts[name], `${name} should be denied`).toEqual({
      allowed: false,
      code: "EPERM",
    });
  }
}

async function assertFixtureUnchanged(fixture: Awaited<ReturnType<typeof makeFixture>>) {
  const { stdout } = await execFileAsync("git", ["status", "--short"], {
    cwd: fixture.workspace,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  expect(stdout).toBe("");
  for (const [relativePath, expectedHash] of Object.entries(fixture.baselineHashes)) {
    expect(await sha256(path.resolve(fixture.workspace, relativePath))).toBe(expectedHash);
  }
  for (const relativePath of [
    "created.txt",
    "renamed.txt",
    "created-parent-alias",
    "../symlink-write.txt",
    "../escaped-write.txt",
  ]) {
    await expect(readFile(path.resolve(fixture.workspace, relativePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
}

function readCodexProbeResult(stdout: string): ProbeResult {
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as { item?: { aggregated_output?: string } };
    const output = event.item?.aggregated_output;
    const marker = output?.split("CLUI_PROBE_RESULT=")[1]?.trim();
    if (marker) return JSON.parse(marker) as ProbeResult;
  }
  throw new Error("Codex did not execute the checked-in filesystem probe.");
}

describe.runIf(RUN_REAL_GATES)("real research harness filesystem gates", () => {
  it("runs the full mutation matrix inside a real Pi process before authentication", async () => {
    const fixture = await makeFixture();
    const piExecutable = await resolvePiExecutable();
    const resultPath = path.join(fixture.runtimeRoot, "pi-result.json");
    const runtime = await preparePiResearchRuntime(fixture.runtimeRoot);
    await execFileAsync(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        buildDarwinReadOnlySandboxProfile([fixture.runtimeRoot]),
        piExecutable,
        "--offline",
        "--no-session",
        "--no-extensions",
        "--extension",
        path.join(fixture.workspace, "probe.mjs"),
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--tools",
        "bash,edit,write,read,grep,find,ls",
        "--print",
        "run the startup probe",
      ],
      {
        cwd: fixture.workspace,
        env: {
          ...process.env,
          CLUI_PROBE_WORKSPACE: fixture.workspace,
          CLUI_PROBE_RESULT: resultPath,
          PI_CODING_AGENT_DIR: runtime.agentDir,
          PI_CODING_AGENT_SESSION_DIR: runtime.sessionDir,
          TMPDIR: runtime.tempDir,
        },
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    assertFullMatrix(JSON.parse(await readFile(resultPath, "utf8")) as ProbeResult);
    await assertFixtureUnchanged(fixture);
  }, 120_000);

  it("runs the full mutation matrix through real Codex exec read-only sandboxing", async () => {
    const fixture = await makeFixture();
    const codexExecutable = process.env.CLUI_REAL_CODEX_EXECUTABLE
      ? await realpath(process.env.CLUI_REAL_CODEX_EXECUTABLE)
      : await resolveCommand("codex");
    const launch = buildCodexResearchProcessLaunch({
      codexExecutable,
      codexArgs: [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--json",
        "--color",
        "never",
        "Run exactly `node ./probe.mjs` once, then return its raw output. Do not modify the probe.",
      ],
      baseEnv: { ...process.env, CLUI_PROBE_WORKSPACE: fixture.workspace },
    });
    const stdout = await runWithClosedStdin({
      command: launch.command,
      args: launch.args,
      cwd: fixture.workspace,
      env: launch.env,
    });
    assertFullMatrix(readCodexProbeResult(stdout));
    await assertFixtureUnchanged(fixture);
  }, 180_000);
});
