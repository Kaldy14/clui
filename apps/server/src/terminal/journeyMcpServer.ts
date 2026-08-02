export const CLUI_JOURNEY_TOOL_ENDPOINT_ENV = "CLUI_JOURNEY_TOOL_ENDPOINT";
export const CLUI_JOURNEY_TOOL_THREAD_ID_ENV = "CLUI_JOURNEY_TOOL_THREAD_ID";
export const CLUI_JOURNEY_TOOL_TOKEN_ENV = "CLUI_JOURNEY_TOOL_TOKEN";

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

export function buildJourneyMcpServerSource(): string {
  return `
import readline from "node:readline";

const endpoint = process.env.${CLUI_JOURNEY_TOOL_ENDPOINT_ENV};
const threadId = process.env.${CLUI_JOURNEY_TOOL_THREAD_ID_ENV};
const token = process.env.${CLUI_JOURNEY_TOOL_TOKEN_ENV};
const updateSchema = ${JSON.stringify(JOURNEY_UPDATE_INPUT_SCHEMA)};
const getSchema = ${JSON.stringify(JOURNEY_GET_INPUT_SCHEMA)};

if (!endpoint || !threadId || !token) {
  process.stderr.write("Clui Journey MCP configuration is incomplete.\\n");
  process.exit(1);
}

const tools = [
  {
    name: "journey_get",
    description: "Read the latest durable Clui Journey graph before deciding the next mutation.",
    inputSchema: getSchema,
  },
  {
    name: "journey_update",
    description: "Immediately create, update, or remove Journey nodes and edges while real work is happening. Never create future placeholder nodes: start concrete work as running, then record its result or real blocker.",
    inputSchema: updateSchema,
  },
];

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

async function request(path, init = {}) {
  const response = await fetch(endpoint + path + "?thread=" + encodeURIComponent(threadId), {
    ...init,
    headers: {
      Authorization: "Bearer " + token,
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
