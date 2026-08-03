export const CLUI_JOURNEY_TOOL_ENDPOINT_ENV = "CLUI_JOURNEY_TOOL_ENDPOINT";
export const CLUI_JOURNEY_TOOL_THREAD_ID_ENV = "CLUI_JOURNEY_TOOL_THREAD_ID";
export const CLUI_JOURNEY_TOOL_TOKEN_ENV = "CLUI_JOURNEY_TOOL_TOKEN";
export const CLUI_JOURNEY_TOOL_RUN_ID_ENV = "CLUI_JOURNEY_RUN_ID";
export const CLUI_JOURNEY_TOOL_NODE_ID_ENV = "CLUI_JOURNEY_NODE_ID";
export const CLUI_JOURNEY_TOOL_ATTEMPT_ENV = "CLUI_JOURNEY_ATTEMPT";
export const CLUI_JOURNEY_TOOL_CAPABILITIES_ENV = "CLUI_JOURNEY_CAPABILITIES";

const interactionSchema = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      required: [
        "id",
        "title",
        "description",
        "steps",
        "activeStepId",
        "answers",
        "submittedAt",
        "submitLabel",
      ],
      properties: {
        id: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        description: { type: "string" },
        steps: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "title", "description", "fields"],
            properties: {
              id: { type: "string", minLength: 1 },
              title: { type: "string", minLength: 1 },
              description: { type: "string" },
              fields: { type: "array", items: { type: "object" } },
            },
          },
        },
        activeStepId: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
        answers: { type: "object" },
        submittedAt: { anyOf: [{ type: "string" }, { type: "null" }] },
        submitLabel: { type: "string", minLength: 1 },
      },
    },
  ],
} as const;

const journeyNodeSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "type",
    "status",
    "title",
    "summary",
    "detailMarkdown",
    "todos",
    "interaction",
    "activity",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: { type: "string", minLength: 1 },
    type: {
      type: "string",
      enum: [
        "goal",
        "question",
        "proposal",
        "task",
        "todoGroup",
        "research",
        "implementation",
        "review",
        "note",
      ],
    },
    status: {
      type: "string",
      enum: [
        "running",
        "waitingForUser",
        "blocked",
        "completed",
        "failed",
        "cancelled",
        "superseded",
      ],
    },
    title: { type: "string", minLength: 1 },
    summary: { type: "string" },
    detailMarkdown: { type: "string" },
    todos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "completed", "note"],
        properties: {
          id: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          completed: { type: "boolean" },
          note: { type: "string" },
        },
      },
    },
    interaction: interactionSchema,
    activity: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "summary", "detailMarkdown", "createdAt"],
        properties: {
          id: { type: "string", minLength: 1 },
          kind: { type: "string", enum: ["agent", "human", "system"] },
          summary: { type: "string", minLength: 1 },
          detailMarkdown: { type: "string" },
          createdAt: { type: "string" },
        },
      },
    },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
} as const;

const journeyEdgeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "source", "target", "relation"],
  properties: {
    id: { type: "string", minLength: 1 },
    source: { type: "string", minLength: 1 },
    target: { type: "string", minLength: 1 },
    relation: { type: "string", enum: ["dependsOn", "spawns", "relatesTo"] },
    label: { type: "string", minLength: 1 },
  },
} as const;

export const JOURNEY_UPDATE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    nodes: {
      type: "array",
      description: "Complete new or updated nodes. Existing nodes with the same id are replaced.",
      items: journeyNodeSchema,
    },
    removeNodeIds: { type: "array", items: { type: "string", minLength: 1 } },
    edges: {
      type: "array",
      description: "Complete new or updated edges. Existing edges with the same id are replaced.",
      items: journeyEdgeSchema,
    },
    removeEdgeIds: { type: "array", items: { type: "string", minLength: 1 } },
    activeNodeId: {
      description: "The node currently deserving attention, or null when the journey is complete.",
      anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
    },
  },
} as const;

export const JOURNEY_GET_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

export const JOURNEY_RESEARCH_START_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["nodeId", "title", "question"],
  properties: {
    nodeId: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    question: { type: "string", minLength: 1 },
  },
} as const;

export const JOURNEY_RESEARCH_GET_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { researchRunId: { type: "string", minLength: 1 } },
} as const;

export const JOURNEY_RESEARCH_CANCEL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["researchRunId", "reason"],
  properties: {
    researchRunId: { type: "string", minLength: 1 },
    reason: { type: "string", minLength: 1 },
  },
} as const;

export const JOURNEY_IMPLEMENTATION_START_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["nodeId", "title", "instructions"],
  properties: {
    nodeId: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    instructions: { type: "string", minLength: 1 },
    proposalRevisionHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
  },
} as const;

export type JourneyLifecycleToolOperation =
  | "research.start"
  | "research.get"
  | "research.cancel"
  | "implementation.start";

export interface JourneyLifecycleToolDependencies {
  readonly authorizer: Pick<JourneyAttemptAuthorizer, "authorize" | "revokeFence">;
  readonly readProjection: () => Promise<JourneyProjectionSnapshot>;
  readonly dispatch: (command: OrchestrationCommand) => Promise<unknown>;
  readonly resolveWorkspaceIdentity: () => Promise<string>;
  readonly now?: () => string;
  readonly randomId?: () => string;
}

const lifecycleCapability: Record<JourneyLifecycleToolOperation, JourneyCapability> = {
  "research.start": "research.start",
  "research.get": "research.read",
  "research.cancel": "research.cancel",
  "implementation.start": "implementation.start",
};

function textField(body: Readonly<Record<string, unknown>>, key: string): string {
  return typeof body[key] === "string" ? body[key].trim() : "";
}

/** Executes one attempt-authorized lifecycle operation. Authorization and stale checks precede effects. */
export async function executeJourneyLifecycleToolRequest(input: {
  readonly operation: JourneyLifecycleToolOperation;
  readonly token: string | null | undefined;
  readonly fence: JourneyAttemptFence;
  readonly body: Readonly<Record<string, unknown>>;
  readonly dependencies: JourneyLifecycleToolDependencies;
}): Promise<unknown> {
  const { dependencies, fence, body } = input;
  dependencies.authorizer.authorize({
    token: input.token,
    fence,
    capability: lifecycleCapability[input.operation],
  });
  const projection = await dependencies.readProjection();
  const parentRun = projection.runs.find((candidate) => candidate.runId === fence.runId);
  const parentAttempt = projection.attempts.find(
    (candidate) =>
      candidate.fence.runId === fence.runId &&
      candidate.fence.nodeId === fence.nodeId &&
      candidate.fence.attempt === fence.attempt,
  );
  if (
    !parentRun ||
    parentRun.nodeId !== fence.nodeId ||
    parentRun.attempt !== fence.attempt ||
    parentRun.status !== "running" ||
    parentAttempt?.status !== "running"
  ) {
    throw new Error("Unauthorized Journey tool request.");
  }

  if (input.operation === "research.get") {
    const requestedRunId = textField(body, "researchRunId");
    const runs = projection.runs.filter(
      (run) => run.role === "researchWorker" && (!requestedRunId || run.runId === requestedRunId),
    );
    return {
      runs,
      attempts: projection.attempts.filter((candidate) =>
        runs.some((run) => run.runId === candidate.fence.runId),
      ),
    };
  }

  const now = dependencies.now?.() ?? new Date().toISOString();
  const randomId = dependencies.randomId?.() ?? crypto.randomUUID();
  if (input.operation === "research.cancel") {
    const runId = textField(body, "researchRunId");
    const reason = textField(body, "reason");
    if (!runId || !reason) throw new Error("Invalid research cancellation.");
    const run = projection.runs.find(
      (candidate) => candidate.runId === runId && candidate.role === "researchWorker",
    );
    if (!run || run.attempt <= 0) throw new Error("Research run was not found.");
    const targetFence = { ...fence, runId, nodeId: run.nodeId, attempt: run.attempt };
    dependencies.authorizer.revokeFence(targetFence);
    await dependencies.dispatch({
      type: "journey.run.cancel",
      commandId: CommandId.makeUnsafe(`journey-tool-cancel:${randomId}`),
      threadId: fence.threadId,
      runId,
      nodeId: run.nodeId,
      reason,
      createdAt: now,
    });
    return dependencies.readProjection();
  }

  const nodeId = textField(body, "nodeId");
  const title = textField(body, "title");
  const instructions =
    input.operation === "research.start"
      ? textField(body, "question")
      : textField(body, "instructions");
  if (!nodeId || !title || !instructions) {
    throw new Error(
      input.operation === "research.start"
        ? "Invalid research start request."
        : "Invalid implementation start request.",
    );
  }
  const childKind = input.operation === "research.start" ? "research" : "implementation";
  const runId = `${childKind}:${randomId}`;
  const canonicalWorkspaceIdentity =
    childKind === "implementation" ? await dependencies.resolveWorkspaceIdentity() : undefined;
  const proposalRevisionHash = textField(body, "proposalRevisionHash") || undefined;
  await dependencies.dispatch({
    type: "journey.child.start",
    commandId: CommandId.makeUnsafe(`journey-tool-start:${randomId}`),
    parentFence: fence,
    childKind,
    runId,
    nodeId,
    title,
    instructions,
    harness: parentRun.harness,
    ...(canonicalWorkspaceIdentity ? { canonicalWorkspaceIdentity } : {}),
    ...(proposalRevisionHash ? { proposalRevisionHash } : {}),
    createdAt: now,
  });
  return dependencies.readProjection();
}

export function buildJourneyMcpServerSource(): string {
  return `
import readline from "node:readline";

const endpoint = process.env.${CLUI_JOURNEY_TOOL_ENDPOINT_ENV};
const threadId = process.env.${CLUI_JOURNEY_TOOL_THREAD_ID_ENV};
const token = process.env.${CLUI_JOURNEY_TOOL_TOKEN_ENV};
const runId = process.env.${CLUI_JOURNEY_TOOL_RUN_ID_ENV};
const nodeId = process.env.${CLUI_JOURNEY_TOOL_NODE_ID_ENV};
const attempt = process.env.${CLUI_JOURNEY_TOOL_ATTEMPT_ENV};
const grantedCapabilities = new Set(JSON.parse(process.env.${CLUI_JOURNEY_TOOL_CAPABILITIES_ENV} ?? "[]"));
const attemptScoped = Boolean(runId && nodeId && attempt);
const updateSchema = ${JSON.stringify(JOURNEY_UPDATE_INPUT_SCHEMA)};
const getSchema = ${JSON.stringify(JOURNEY_GET_INPUT_SCHEMA)};
const researchStartSchema = ${JSON.stringify(JOURNEY_RESEARCH_START_INPUT_SCHEMA)};
const researchGetSchema = ${JSON.stringify(JOURNEY_RESEARCH_GET_INPUT_SCHEMA)};
const researchCancelSchema = ${JSON.stringify(JOURNEY_RESEARCH_CANCEL_INPUT_SCHEMA)};
const implementationStartSchema = ${JSON.stringify(JOURNEY_IMPLEMENTATION_START_INPUT_SCHEMA)};

if (!endpoint || !threadId || !token) {
  process.stderr.write("Clui Journey MCP configuration is incomplete.\\n");
  process.exit(1);
}

const tools = [
  {
    name: "journey_get",
    requiredCapability: "graph.read",
    description: "Read the latest durable Clui Journey graph before deciding the next mutation.",
    inputSchema: getSchema,
  },
  {
    name: "journey_update",
    requiredCapability: "graph.mutate",
    description: "Immediately create, update, or remove Journey nodes and edges while real work is happening. Never create future placeholder nodes: start concrete work as running, then record its result or real blocker.",
    inputSchema: updateSchema,
  },
  {
    name: "journey_research_start",
    requiredCapability: "research.start",
    description: "Start a concrete read-only research node. The node and durable starting attempt are recorded before the worker is launched.",
    inputSchema: researchStartSchema,
  },
  {
    name: "journey_research_get",
    requiredCapability: "research.read",
    description: "Inspect the durable state of research runs started by this Journey.",
    inputSchema: researchGetSchema,
  },
  {
    name: "journey_research_cancel",
    requiredCapability: "research.cancel",
    description: "Cancel a research run. Its attempt credential is revoked before cancellation is requested.",
    inputSchema: researchCancelSchema,
  },
  {
    name: "journey_implementation_start",
    requiredCapability: "implementation.start",
    description: "Start a concrete repository-writing implementation node after any required plan approval.",
    inputSchema: implementationStartSchema,
  },
]
  .filter((tool) =>
    attemptScoped
      ? grantedCapabilities.has(tool.requiredCapability)
      : tool.name === "journey_get" || tool.name === "journey_update",
  )
  .map(({ requiredCapability: _requiredCapability, ...tool }) => tool);

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

async function request(path, init = {}) {
  const response = await fetch(endpoint + path + "?thread=" + encodeURIComponent(threadId), {
    ...init,
    headers: {
      Authorization: "Bearer " + token,
      ...(runId && nodeId && attempt ? {
        "X-Clui-Journey-Run-Id": runId,
        "X-Clui-Journey-Node-Id": nodeId,
        "X-Clui-Journey-Attempt": attempt,
      } : {}),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || "Clui Journey request failed with status " + response.status);
  return text ? JSON.parse(text) : {};
}

async function callTool(name, args) {
  if (name === "journey_get") return request("/snapshot");
  if (name === "journey_update") {
    return request("/update", { method: "POST", body: JSON.stringify(args ?? {}) });
  }
  if (name === "journey_research_start") {
    return request("/research/start", { method: "POST", body: JSON.stringify(args ?? {}) });
  }
  if (name === "journey_research_get") {
    return request("/research/get", { method: "POST", body: JSON.stringify(args ?? {}) });
  }
  if (name === "journey_research_cancel") {
    return request("/research/cancel", { method: "POST", body: JSON.stringify(args ?? {}) });
  }
  if (name === "journey_implementation_start") {
    return request("/implementation/start", { method: "POST", body: JSON.stringify(args ?? {}) });
  }
  throw new Error("Unknown Journey tool: " + name);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    continue;
  }
  if (message.id === undefined) continue;
  try {
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "clui-journey", version: "1.0.0" },
        },
      });
    } else if (message.method === "ping") {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools } });
    } else if (message.method === "tools/call") {
      const result = await callTool(message.params?.name, message.params?.arguments);
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        },
      });
    } else {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      });
    }
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      },
    });
  }
}
`.trimStart();
}

/** Pi extension equivalent of the stdio MCP server used by Codex Journey attempts. */
export function buildJourneyPiExtensionSource(): string {
  return `
const endpoint = process.env.${CLUI_JOURNEY_TOOL_ENDPOINT_ENV};
const threadId = process.env.${CLUI_JOURNEY_TOOL_THREAD_ID_ENV};
const token = process.env.${CLUI_JOURNEY_TOOL_TOKEN_ENV};
const runId = process.env.${CLUI_JOURNEY_TOOL_RUN_ID_ENV};
const nodeId = process.env.${CLUI_JOURNEY_TOOL_NODE_ID_ENV};
const attempt = process.env.${CLUI_JOURNEY_TOOL_ATTEMPT_ENV};
const grantedCapabilities = new Set(JSON.parse(process.env.${CLUI_JOURNEY_TOOL_CAPABILITIES_ENV} ?? "[]"));

const toolDefinitions = [
  {
    name: "journey_get",
    label: "Read Journey",
    capability: "graph.read",
    description: "Read the latest durable Clui Journey graph before deciding the next mutation.",
    promptSnippet: "Read the current Clui Journey graph",
    promptGuidelines: ["Use journey_get when the current Journey graph may have changed."],
    parameters: ${JSON.stringify(JOURNEY_GET_INPUT_SCHEMA)},
    path: "/snapshot",
    method: "GET",
  },
  {
    name: "journey_update",
    label: "Update Journey",
    capability: "graph.mutate",
    description: "Immediately create, update, or remove Journey nodes and edges while real work is happening.",
    promptSnippet: "Update the visible Clui Journey graph while work progresses",
    promptGuidelines: ["Use journey_update only for concrete work that is starting, a real result, or a genuine blocker."],
    parameters: ${JSON.stringify(JOURNEY_UPDATE_INPUT_SCHEMA)},
    path: "/update",
    method: "POST",
  },
  {
    name: "journey_research_start",
    label: "Start Journey research",
    capability: "research.start",
    description: "Start a concrete read-only research node and its durable worker attempt.",
    promptSnippet: "Start a read-only Journey research worker",
    promptGuidelines: ["Use journey_research_start for concrete independent questions that can run concurrently."],
    parameters: ${JSON.stringify(JOURNEY_RESEARCH_START_INPUT_SCHEMA)},
    path: "/research/start",
    method: "POST",
  },
  {
    name: "journey_research_get",
    label: "Read Journey research",
    capability: "research.read",
    description: "Inspect the durable state of Journey research runs.",
    promptSnippet: "Inspect Journey research results",
    promptGuidelines: ["Use journey_research_get to read completed research before deciding the next Journey mutation."],
    parameters: ${JSON.stringify(JOURNEY_RESEARCH_GET_INPUT_SCHEMA)},
    path: "/research/get",
    method: "POST",
  },
  {
    name: "journey_research_cancel",
    label: "Cancel Journey research",
    capability: "research.cancel",
    description: "Cancel a Journey research run that is no longer needed.",
    promptSnippet: "Cancel obsolete Journey research",
    promptGuidelines: ["Use journey_research_cancel only for research that is no longer relevant to the active Journey."],
    parameters: ${JSON.stringify(JOURNEY_RESEARCH_CANCEL_INPUT_SCHEMA)},
    path: "/research/cancel",
    method: "POST",
  },
  {
    name: "journey_implementation_start",
    label: "Start Journey implementation",
    capability: "implementation.start",
    description: "Start a repository-writing implementation node after any required approval.",
    promptSnippet: "Start approved Journey implementation",
    promptGuidelines: ["Use journey_implementation_start only after any required material proposal is approved."],
    parameters: ${JSON.stringify(JOURNEY_IMPLEMENTATION_START_INPUT_SCHEMA)},
    path: "/implementation/start",
    method: "POST",
  },
];

async function requestJourney(path, method, params) {
  const response = await fetch(endpoint + path + "?thread=" + encodeURIComponent(threadId), {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "X-Clui-Journey-Run-Id": runId,
      "X-Clui-Journey-Node-Id": nodeId,
      "X-Clui-Journey-Attempt": attempt,
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(params ?? {}) } : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || "Clui Journey request failed with status " + response.status);
  }
  return text ? JSON.parse(text) : {};
}

export default function (pi) {
  if (!endpoint || !threadId || !token || !runId || !nodeId || !attempt) {
    throw new Error("Clui Journey Pi extension configuration is incomplete.");
  }
  for (const definition of toolDefinitions) {
    if (!grantedCapabilities.has(definition.capability)) continue;
    pi.registerTool({
      name: definition.name,
      label: definition.label,
      description: definition.description,
      promptSnippet: definition.promptSnippet,
      promptGuidelines: definition.promptGuidelines,
      parameters: definition.parameters,
      async execute(_toolCallId, params) {
        const result = await requestJourney(definition.path, definition.method, params);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    });
  }
}
`.trimStart();
}
import crypto from "node:crypto";

import {
  CommandId,
  type JourneyAttemptFence,
  type JourneyCapability,
  type JourneyProjectionSnapshot,
  type OrchestrationCommand,
} from "@clui/contracts";

import type { JourneyAttemptAuthorizer } from "./journeyAttemptAuthorization";
