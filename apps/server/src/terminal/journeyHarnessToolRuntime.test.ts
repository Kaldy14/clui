import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildCodexJourneyMcpConfigArgs,
  ensureJourneyHarnessToolRuntime,
  journeyToolNamesForCapabilities,
} from "./journeyHarnessToolRuntime";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("Journey harness tool runtime", () => {
  it("writes both harness adapters with attempt-scoped lifecycle tools", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "clui-journey-tools-"));
    temporaryRoots.push(stateDir);

    const paths = await ensureJourneyHarnessToolRuntime(stateDir);
    const [mcpSource, piSource] = await Promise.all([
      readFile(paths.mcpServerPath, "utf8"),
      readFile(paths.piExtensionPath, "utf8"),
    ]);

    for (const source of [mcpSource, piSource]) {
      expect(source).toContain('name: "journey_get"');
      expect(source).toContain('name: "journey_research_start"');
      expect(source).toContain('name: "journey_implementation_start"');
      expect(source).toContain("X-Clui-Journey-Attempt");
    }
  });

  it("forwards the complete attempt fence to the Codex MCP process", () => {
    const args = buildCodexJourneyMcpConfigArgs("/runtime/clui-journey-mcp.mjs", {
      attemptScoped: true,
    });
    const joined = args.join(" ");

    expect(joined).toContain("CLUI_JOURNEY_TOOL_ENDPOINT");
    expect(joined).toContain("CLUI_JOURNEY_RUN_ID");
    expect(joined).toContain("CLUI_JOURNEY_NODE_ID");
    expect(joined).toContain("CLUI_JOURNEY_ATTEMPT");
    expect(joined).toContain("CLUI_JOURNEY_CAPABILITIES");
    expect(joined).toContain("mcp_servers.clui_journey.required=true");
    expect(joined).toContain('mcp_servers.clui_journey.default_tools_approval_mode="approve"');
  });

  it("derives the Pi custom-tool allowlist from the durable capability grant", () => {
    expect(
      journeyToolNamesForCapabilities([
        "graph.read",
        "graph.mutate",
        "research.start",
        "decision.request",
      ]),
    ).toEqual(["journey_get", "journey_update", "journey_research_start"]);
  });
});
