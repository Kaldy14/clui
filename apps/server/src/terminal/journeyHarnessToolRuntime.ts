import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { JourneyCapability } from "@clui/contracts";

import { CODEX_JOURNEY_MCP_APPROVAL_CONFIG } from "./researchHarnessProfile";
import {
  buildJourneyMcpServerSource,
  buildJourneyPiExtensionSource,
  CLUI_JOURNEY_TOOL_ATTEMPT_ENV,
  CLUI_JOURNEY_TOOL_CAPABILITIES_ENV,
  CLUI_JOURNEY_TOOL_ENDPOINT_ENV,
  CLUI_JOURNEY_TOOL_NODE_ID_ENV,
  CLUI_JOURNEY_TOOL_RUN_ID_ENV,
  CLUI_JOURNEY_TOOL_THREAD_ID_ENV,
  CLUI_JOURNEY_TOOL_TOKEN_ENV,
} from "./journeyMcpServer";

const JOURNEY_RUNTIME_DIR_NAME = "journey-runtime";
const JOURNEY_MCP_SERVER_FILENAME = "clui-journey-mcp.mjs";
const JOURNEY_PI_EXTENSION_FILENAME = "clui-journey-pi-extension.js";

export interface JourneyHarnessToolRuntimePaths {
  readonly mcpServerPath: string;
  readonly piExtensionPath: string;
}

export function journeyHarnessToolRuntimePaths(stateDir: string): JourneyHarnessToolRuntimePaths {
  const runtimeDir = path.join(stateDir, JOURNEY_RUNTIME_DIR_NAME);
  return {
    mcpServerPath: path.join(runtimeDir, JOURNEY_MCP_SERVER_FILENAME),
    piExtensionPath: path.join(runtimeDir, JOURNEY_PI_EXTENSION_FILENAME),
  };
}

/** Writes the generated, capability-fenced tool adapters shared by all Journey harness owners. */
export async function ensureJourneyHarnessToolRuntime(
  stateDir: string,
): Promise<JourneyHarnessToolRuntimePaths> {
  const paths = journeyHarnessToolRuntimePaths(stateDir);
  await mkdir(path.dirname(paths.mcpServerPath), { recursive: true });
  await Promise.all([
    writeFile(paths.mcpServerPath, buildJourneyMcpServerSource(), {
      encoding: "utf8",
      mode: 0o600,
    }),
    writeFile(paths.piExtensionPath, buildJourneyPiExtensionSource(), {
      encoding: "utf8",
      mode: 0o600,
    }),
  ]);
  return paths;
}

export function buildCodexJourneyMcpConfigArgs(
  mcpServerPath: string,
  options?: { readonly attemptScoped?: boolean },
): string[] {
  const forwardedEnvVars = [
    CLUI_JOURNEY_TOOL_ENDPOINT_ENV,
    CLUI_JOURNEY_TOOL_THREAD_ID_ENV,
    CLUI_JOURNEY_TOOL_TOKEN_ENV,
    ...(options?.attemptScoped
      ? [
          CLUI_JOURNEY_TOOL_RUN_ID_ENV,
          CLUI_JOURNEY_TOOL_NODE_ID_ENV,
          CLUI_JOURNEY_TOOL_ATTEMPT_ENV,
          CLUI_JOURNEY_TOOL_CAPABILITIES_ENV,
        ]
      : []),
  ];
  return [
    "-c",
    `mcp_servers.clui_journey.command=${JSON.stringify(process.execPath)}`,
    "-c",
    `mcp_servers.clui_journey.args=${JSON.stringify([mcpServerPath])}`,
    "-c",
    `mcp_servers.clui_journey.env_vars=${JSON.stringify(forwardedEnvVars)}`,
    "-c",
    "mcp_servers.clui_journey.required=true",
    ...(options?.attemptScoped ? ["-c", CODEX_JOURNEY_MCP_APPROVAL_CONFIG] : []),
  ];
}

const JOURNEY_TOOL_NAME_BY_CAPABILITY: Readonly<Partial<Record<JourneyCapability, string>>> = {
  "graph.read": "journey_get",
  "graph.mutate": "journey_update",
  "research.start": "journey_research_start",
  "research.read": "journey_research_get",
  "research.cancel": "journey_research_cancel",
  "implementation.start": "journey_implementation_start",
};

export function journeyToolNamesForCapabilities(
  capabilities: ReadonlyArray<JourneyCapability>,
): string[] {
  return capabilities.flatMap((capability) => {
    const toolName = JOURNEY_TOOL_NAME_BY_CAPABILITY[capability];
    return toolName ? [toolName] : [];
  });
}
