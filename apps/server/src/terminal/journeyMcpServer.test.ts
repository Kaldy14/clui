import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildJourneyMcpServerSource,
  CLUI_JOURNEY_TOOL_ENDPOINT_ENV,
  CLUI_JOURNEY_TOOL_THREAD_ID_ENV,
  CLUI_JOURNEY_TOOL_TOKEN_ENV,
} from "./journeyMcpServer";

describe("Journey MCP server", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("negotiates MCP and lists the live Journey tools", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "clui-journey-mcp-protocol-"));
    const serverPath = path.join(tempDir, "server.mjs");
    await writeFile(serverPath, buildJourneyMcpServerSource(), "utf8");

    const child = spawn(process.execPath, [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        [CLUI_JOURNEY_TOOL_ENDPOINT_ENV]: "http://127.0.0.1:1/journey-tools",
        [CLUI_JOURNEY_TOOL_THREAD_ID_ENV]: "thread-journey",
        [CLUI_JOURNEY_TOOL_TOKEN_ENV]: "token",
      },
    });
    const responses: Array<Record<string, unknown>> = [];
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => responses.push(JSON.parse(line) as Record<string, unknown>));

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
    );

    await expect
      .poll(() => responses.length, { timeout: 2_000, interval: 20 })
      .toBeGreaterThanOrEqual(2);
    child.stdin.end();
    await new Promise<void>((resolve, reject) => {
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      child.once("error", reject);
    });

    expect(responses[0]).toMatchObject({
      id: 1,
      result: { protocolVersion: "2025-06-18", serverInfo: { name: "clui-journey" } },
    });
    expect(responses[1]).toMatchObject({
      id: 2,
      result: {
        tools: [
          { name: "journey_get" },
          { name: "journey_update", inputSchema: { type: "object" } },
        ],
      },
    });
  });
});
