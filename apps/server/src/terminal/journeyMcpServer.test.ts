import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { afterEach, describe, expect, it } from "vitest";
import { ThreadId, type JourneyAttemptFence, type JourneyProjectionSnapshot } from "@clui/contracts";

import {
  buildJourneyMcpServerSource,
  CLUI_JOURNEY_TOOL_ENDPOINT_ENV,
  CLUI_JOURNEY_TOOL_ATTEMPT_ENV,
  CLUI_JOURNEY_TOOL_CAPABILITIES_ENV,
  CLUI_JOURNEY_TOOL_NODE_ID_ENV,
  CLUI_JOURNEY_TOOL_RUN_ID_ENV,
  CLUI_JOURNEY_TOOL_THREAD_ID_ENV,
  CLUI_JOURNEY_TOOL_TOKEN_ENV,
  JOURNEY_UPDATE_INPUT_SCHEMA,
  executeJourneyLifecycleToolRequest,
} from "./journeyMcpServer";
import { JourneyAttemptAuthorizer } from "./journeyAttemptAuthorization";

const attemptFence: JourneyAttemptFence = {
  threadId: ThreadId.makeUnsafe("thread-journey"),
  runId: "coordinator",
  nodeId: "goal",
  attempt: 1,
};
const projection = (): JourneyProjectionSnapshot => ({
  threadId: attemptFence.threadId,
  journeyRevision: 1,
  globalEventWatermark: 1,
  journey: {
    version: 1,
    destination: "Ship",
    layoutDirection: "TB",
    nodes: [
      {
        id: "goal",
        type: "goal",
        status: "running",
        title: "Ship",
        summary: "",
        detailMarkdown: "",
        todos: [],
        interaction: null,
        activity: [],
        createdAt: "2026-08-02T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
      },
    ],
    edges: [],
    activeNodeId: "goal",
    updatedAt: "2026-08-02T00:00:00.000Z",
  },
  runs: [
    {
      threadId: attemptFence.threadId,
      runId: "coordinator",
      nodeId: "goal",
      role: "coordinator",
      harness: "codexCli",
      status: "running",
      attempt: 1,
      capabilities: ["graph.read", "research.start", "research.read", "research.cancel"],
      parentRunId: null,
      coordinatorRunId: null,
      canonicalWorkspaceLeaseId: null,
      outputStreamId: "coordinator-output",
      failureReason: null,
      resumableHarnessIdentity: null,
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    },
  ],
  attempts: [
    {
      fence: attemptFence,
      status: "running",
      capabilities: ["graph.read", "research.start", "research.read", "research.cancel"],
      credentialId: null,
      startedAt: "2026-08-02T00:00:00.000Z",
      completedAt: null,
      failureReason: null,
    },
  ],
  approvals: [],
  steering: [],
});

describe("Journey MCP server", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("does not offer draft or ready statuses for agent-authored mutations", () => {
    const schemaText = JSON.stringify(JOURNEY_UPDATE_INPUT_SCHEMA);
    expect(schemaText).toContain('"running"');
    expect(schemaText).toContain('"waitingForUser"');
    expect(schemaText).not.toContain('"draft"');
    expect(schemaText).not.toContain('"ready"');
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
        [CLUI_JOURNEY_TOOL_RUN_ID_ENV]: "coordinator",
        [CLUI_JOURNEY_TOOL_NODE_ID_ENV]: "goal",
        [CLUI_JOURNEY_TOOL_ATTEMPT_ENV]: "1",
        [CLUI_JOURNEY_TOOL_CAPABILITIES_ENV]: JSON.stringify([
          "graph.read",
          "graph.mutate",
          "research.start",
          "research.read",
          "research.cancel",
          "implementation.start",
        ]),
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
          { name: "journey_research_start", inputSchema: { type: "object" } },
          { name: "journey_research_get", inputSchema: { type: "object" } },
          { name: "journey_research_cancel", inputSchema: { type: "object" } },
          { name: "journey_implementation_start", inputSchema: { type: "object" } },
        ],
      },
    });
  });

  it("does not expose mutation or child-start tools to a research worker", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "clui-journey-mcp-research-tools-"));
    const serverPath = path.join(tempDir, "server.mjs");
    await writeFile(serverPath, buildJourneyMcpServerSource(), "utf8");

    const child = spawn(process.execPath, [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        [CLUI_JOURNEY_TOOL_ENDPOINT_ENV]: "http://127.0.0.1:1/journey-tools",
        [CLUI_JOURNEY_TOOL_THREAD_ID_ENV]: "thread-journey",
        [CLUI_JOURNEY_TOOL_TOKEN_ENV]: "token",
        [CLUI_JOURNEY_TOOL_RUN_ID_ENV]: "research-1",
        [CLUI_JOURNEY_TOOL_NODE_ID_ENV]: "research-node",
        [CLUI_JOURNEY_TOOL_ATTEMPT_ENV]: "1",
        [CLUI_JOURNEY_TOOL_CAPABILITIES_ENV]: JSON.stringify(["graph.read", "research.read"]),
      },
    });
    const responses: Array<Record<string, unknown>> = [];
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => responses.push(JSON.parse(line) as Record<string, unknown>));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);

    await expect.poll(() => responses.length, { timeout: 2_000, interval: 20 }).toBe(1);
    child.stdin.end();
    await new Promise<void>((resolve, reject) => {
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      child.once("error", reject);
    });

    expect(responses[0]).toMatchObject({
      result: { tools: [{ name: "journey_get" }, { name: "journey_research_get" }] },
    });
    expect(JSON.stringify(responses[0])).not.toContain("journey_update");
    expect(JSON.stringify(responses[0])).not.toContain("journey_implementation_start");
  });

  it.each([
    ["missing token", "missing"],
    ["missing capability", "capability"],
    ["stale attempt", "stale"],
    ["revoked token", "revoked"],
  ])("rejects %s before endpoint dispatch", async (_name, scenario) => {
    const authorizer = new JourneyAttemptAuthorizer();
    const grant = authorizer.issue({
      fence: attemptFence,
      role: "coordinator",
      capabilities: scenario === "capability" ? ["graph.read"] : ["research.start"],
    });
    if (scenario === "revoked") authorizer.revokeFence(attemptFence);
    let dispatches = 0;
    const baseProjection = projection();
    const staleProjection: JourneyProjectionSnapshot =
      scenario === "stale"
        ? {
            ...baseProjection,
            runs: baseProjection.runs.map((run, index) =>
              index === 0 ? { ...run, attempt: 2 } : run,
            ),
          }
        : baseProjection;
    await expect(
      executeJourneyLifecycleToolRequest({
        operation: "research.start",
        token: scenario === "missing" ? undefined : grant.token,
        fence: attemptFence,
        body: { nodeId: "research", title: "Research", question: "What is true?" },
        dependencies: {
          authorizer,
          readProjection: async () => staleProjection,
          dispatch: async () => {
            dispatches += 1;
          },
          resolveWorkspaceIdentity: async () => "/trusted#1:2",
        },
      }),
    ).rejects.toThrow("Unauthorized Journey tool request.");
    expect(dispatches).toBe(0);
  });

  it("starts research with exactly one composite dispatch and no caller lifecycle state", async () => {
    const authorizer = new JourneyAttemptAuthorizer();
    const grant = authorizer.issue({
      fence: attemptFence,
      role: "coordinator",
      capabilities: ["research.start"],
    });
    const dispatched: unknown[] = [];
    await executeJourneyLifecycleToolRequest({
      operation: "research.start",
      token: grant.token,
      fence: attemptFence,
      body: {
        nodeId: "research-node",
        title: "Inspect boundaries",
        question: "Where is authority enforced?",
        status: "completed",
        capabilities: ["repository.write"],
      },
      dependencies: {
        authorizer,
        readProjection: async () => projection(),
        dispatch: async (command) => {
          dispatched.push(command);
        },
        resolveWorkspaceIdentity: async () => "/trusted#1:2",
        now: () => "2026-08-02T00:00:00.000Z",
        randomId: () => "child-id",
      },
    });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "journey.child.start",
      childKind: "research",
      runId: "research:child-id",
      nodeId: "research-node",
      harness: "codexCli",
    });
    expect(JSON.stringify(dispatched[0])).not.toContain("repository.write");
    expect(JSON.stringify(dispatched[0])).not.toContain("completed");
  });

  it("derives implementation workspace identity from the trusted resolver", async () => {
    const authorizer = new JourneyAttemptAuthorizer();
    const grant = authorizer.issue({
      fence: attemptFence,
      role: "coordinator",
      capabilities: ["implementation.start"],
    });
    const dispatched: unknown[] = [];
    await executeJourneyLifecycleToolRequest({
      operation: "implementation.start",
      token: grant.token,
      fence: attemptFence,
      body: {
        nodeId: "implementation-node",
        title: "Implement",
        instructions: "Make the change.",
        canonicalWorkspaceId: "/attacker-controlled",
      },
      dependencies: {
        authorizer,
        readProjection: async () => projection(),
        dispatch: async (command) => {
          dispatched.push(command);
        },
        resolveWorkspaceIdentity: async () => "/trusted#7:11",
        randomId: () => "implementation-id",
      },
    });
    expect(dispatched[0]).toMatchObject({
      type: "journey.child.start",
      canonicalWorkspaceIdentity: "/trusted#7:11",
    });
    expect(JSON.stringify(dispatched[0])).not.toContain("attacker-controlled");
  });

  it("revokes a research credential before cancellation dispatch", async () => {
    const authorizer = new JourneyAttemptAuthorizer();
    const grant = authorizer.issue({
      fence: attemptFence,
      role: "coordinator",
      capabilities: ["research.cancel"],
    });
    const childFence = { ...attemptFence, runId: "research-1", nodeId: "research", attempt: 1 };
    authorizer.issue({
      fence: childFence,
      role: "researchWorker",
      capabilities: ["graph.read", "research.read"],
    });
    const baseProjection = projection();
    const current: JourneyProjectionSnapshot = {
      ...baseProjection,
      runs: [
        ...baseProjection.runs,
        {
          ...baseProjection.runs[0]!,
          runId: "research-1",
          nodeId: "research",
          role: "researchWorker",
          capabilities: ["graph.read", "research.read"],
          parentRunId: "coordinator",
        },
      ],
      attempts: [
        ...baseProjection.attempts,
        { ...baseProjection.attempts[0]!, fence: childFence },
      ],
    };
    const order: string[] = [];
    const revokeFence = authorizer.revokeFence.bind(authorizer);
    const instrumentedAuthorizer = {
      authorize: authorizer.authorize.bind(authorizer),
      revokeFence: (fence: JourneyAttemptFence) => {
        order.push("revoke");
        revokeFence(fence);
      },
    };
    await executeJourneyLifecycleToolRequest({
      operation: "research.cancel",
      token: grant.token,
      fence: attemptFence,
      body: { researchRunId: "research-1", reason: "No longer needed" },
      dependencies: {
        authorizer: instrumentedAuthorizer,
        readProjection: async () => current,
        dispatch: async () => {
          order.push("dispatch");
        },
        resolveWorkspaceIdentity: async () => "/trusted#1:2",
      },
    });
    expect(order).toEqual(["revoke", "dispatch"]);
    expect(authorizer.inspect()).toHaveLength(1);
  });

  it("does not attempt a second dispatch when the composite command fails", async () => {
    const authorizer = new JourneyAttemptAuthorizer();
    const grant = authorizer.issue({
      fence: attemptFence,
      role: "coordinator",
      capabilities: ["research.start"],
    });
    let dispatches = 0;
    await expect(
      executeJourneyLifecycleToolRequest({
        operation: "research.start",
        token: grant.token,
        fence: attemptFence,
        body: { nodeId: "research", title: "Research", question: "Question" },
        dependencies: {
          authorizer,
          readProjection: async () => projection(),
          dispatch: async () => {
            dispatches += 1;
            throw new Error("atomic dispatch rejected");
          },
          resolveWorkspaceIdentity: async () => "/trusted#1:2",
        },
      }),
    ).rejects.toThrow("atomic dispatch rejected");
    expect(dispatches).toBe(1);
  });
});
