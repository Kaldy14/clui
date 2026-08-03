import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  buildCodexResearchProcessLaunch,
  buildDarwinReadOnlySandboxProfile,
  buildPiResearchProcessLaunch,
  CODEX_JOURNEY_MCP_APPROVAL_CONFIG,
  PI_RESEARCH_TOOL_ALLOWLIST,
  preparePiResearchRuntime,
} from "./researchHarnessProfile";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })),
  );
});

describe("buildCodexResearchProcessLaunch", () => {
  it("enforces the Codex read-only sandbox for exec runs", () => {
    const launch = buildCodexResearchProcessLaunch({
      codexExecutable: "/opt/clui/bin/codex",
      codexArgs: ["--model", "gpt-test", "exec", "--json", "inspect the repository"],
    });

    expect(launch.args).toEqual([
      "--model",
      "gpt-test",
      "exec",
      "--sandbox",
      "read-only",
      "--json",
      "inspect the repository",
    ]);
  });

  it("rejects a Codex sandbox bypass", () => {
    expect(() =>
      buildCodexResearchProcessLaunch({
        codexExecutable: "/opt/clui/bin/codex",
        codexArgs: ["--dangerously-bypass-approvals-and-sandbox", "exec", "inspect"],
      }),
    ).toThrow("cannot bypass approvals or sandboxing");
  });

  it("allows only the fenced Journey MCP server to bypass interactive tool approvals", () => {
    const launch = buildCodexResearchProcessLaunch({
      codexExecutable: "/opt/clui/bin/codex",
      codexArgs: ["-c", CODEX_JOURNEY_MCP_APPROVAL_CONFIG, "exec", "inspect"],
    });

    expect(launch.args).toEqual(expect.arrayContaining(["-c", CODEX_JOURNEY_MCP_APPROVAL_CONFIG]));
  });

  it.each([
    ["short sandbox", ["exec", "-s", "workspace-write", "inspect"]],
    ["attached long sandbox", ["exec", "--sandbox=workspace-write", "inspect"]],
    ["attached short sandbox", ["exec", "-sworkspace-write", "inspect"]],
    ["duplicate sandbox", ["exec", "--sandbox", "read-only", "-s=read-only", "inspect"]],
    ["sandbox config", ["-c", 'sandbox_mode="workspace-write"', "exec", "inspect"]],
    ["approval config", ['--config=approval_policy="never"', "exec", "inspect"]],
  ])("rejects a Codex %s override", (_name, codexArgs) => {
    expect(() =>
      buildCodexResearchProcessLaunch({
        codexExecutable: "/opt/clui/bin/codex",
        codexArgs,
      }),
    ).toThrow(/read-only sandbox|duplicate sandbox|override sandbox or approval config/);
  });
});

describe("buildPiResearchProcessLaunch", () => {
  it("wraps Pi in the OS sandbox with the read-only tool allowlist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "clui-pi-profile-"));
    tempDirs.push(root);
    const runtimeRoot = path.join(root, "run-1");
    const prepared = await preparePiResearchRuntime(runtimeRoot);
    const launch = buildPiResearchProcessLaunch({
      piExecutable: "/opt/clui/bin/pi",
      piArgs: ["--print", "inspect the repository"],
      runtimeRoot,
      baseEnv: { PATH: "/usr/bin:/bin" },
      platform: "darwin",
    });

    expect(launch.command).toBe("/usr/bin/sandbox-exec");
    expect(launch.args).toEqual(
      expect.arrayContaining(["/opt/clui/bin/pi", "--tools", PI_RESEARCH_TOOL_ALLOWLIST]),
    );
    expect(launch.env).toMatchObject({
      PATH: "/usr/bin:/bin",
      PI_CODING_AGENT_DIR: prepared.agentDir,
      PI_CODING_AGENT_SESSION_DIR: prepared.sessionDir,
      TMPDIR: prepared.tempDir,
    });
  });

  it("rejects caller attempts to replace the Pi tool allowlist", () => {
    expect(() =>
      buildPiResearchProcessLaunch({
        piExecutable: "/opt/clui/bin/pi",
        piArgs: ["--tools", "bash,write", "--print", "inspect"],
        runtimeRoot: "/private/tmp/clui-pi-research/run-1",
        platform: "darwin",
      }),
    ).toThrow("cannot override the enforced tool allowlist");
  });

  it.each([
    ["attached long tools", ["--tools=bash,write"]],
    ["attached short tools", ["-tbash,write"]],
    ["repeated tools", ["--tools", "read", "--tools=write"]],
    ["extension", ["--extension", "/tmp/untrusted.mjs"]],
    ["attached extension", ["-e/tmp/untrusted.mjs"]],
    ["tool exclusion", ["--exclude-tools=bash"]],
  ])("rejects a Pi %s override", (_name, piArgs) => {
    expect(() =>
      buildPiResearchProcessLaunch({
        piExecutable: "/opt/clui/bin/pi",
        piArgs,
        runtimeRoot: "/private/tmp/clui-pi-research/run-1",
        platform: "darwin",
      }),
    ).toThrow("cannot override the enforced tool allowlist");
  });

  it("fails closed on platforms without an implemented Pi OS sandbox", () => {
    expect(() =>
      buildPiResearchProcessLaunch({
        piExecutable: "/opt/clui/bin/pi",
        piArgs: ["--print", "inspect"],
        runtimeRoot: "/tmp/clui-pi-research/run-1",
        platform: "linux",
      }),
    ).toThrow("filesystem isolation is unavailable on linux");
  });
});

describe.runIf(process.platform === "darwin")("Darwin research filesystem sandbox", () => {
  it("allows repository reads while denying writes outside the isolated runtime", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "clui-research-profile-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const runtimeRoot = path.join(root, "runtime");
    await preparePiResearchRuntime(runtimeRoot);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    await writeFile(path.join(workspace, "tracked.txt"), "original", "utf8");
    const probePath = path.join(runtimeRoot, "probe.mjs");
    const resultPath = path.join(runtimeRoot, "result.json");
    await writeFile(
      probePath,
      [
        'import { readFileSync, writeFileSync } from "node:fs";',
        "const [workspace, resultPath] = process.argv.slice(2);",
        'const result = { read: readFileSync(`${workspace}/tracked.txt`, "utf8") };',
        'try { writeFileSync(`${workspace}/created.txt`, "created"); result.write = "allowed"; }',
        "catch (error) { result.write = error.code; }",
        "writeFileSync(resultPath, JSON.stringify(result));",
      ].join("\n"),
      "utf8",
    );

    await execFileAsync(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        buildDarwinReadOnlySandboxProfile([runtimeRoot]),
        process.execPath,
        probePath,
        workspace,
        resultPath,
      ],
      { cwd: workspace },
    );

    expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({
      read: "original",
      write: "EPERM",
    });
    await expect(readFile(path.join(workspace, "created.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
