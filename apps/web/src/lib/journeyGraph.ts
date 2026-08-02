import {
  JourneySnapshot as JourneySnapshotSchema,
  type JourneyEdge,
  type JourneyNode,
  type JourneySnapshot,
} from "@clui/contracts";
import { Schema } from "effect";

export const JOURNEY_NODE_WIDTH = 320;
export const JOURNEY_NODE_EXPANDED_WIDTH = 440;
export const JOURNEY_NODE_FOCUSED_WIDTH = 640;
const JOURNEY_NODE_HEIGHT = 146;
const JOURNEY_NODE_EXPANDED_HEIGHT = 430;
const JOURNEY_NODE_FOCUSED_HEIGHT = 600;
const LAYER_GAP = 150;
const NODE_GAP = 56;

export interface JourneyNodeLayout {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function graphLevels(
  nodes: readonly JourneyNode[],
  edges: readonly JourneyEdge[],
): Map<string, number> {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const node of nodes) {
    incoming.set(node.id, 0);
    outgoing.set(node.id, []);
  }

  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edge.source === edge.target)
      continue;
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }

  const queue = nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0).map((node) => node.id);
  const level = new Map<string, number>();
  for (const id of queue) level.set(id, 0);

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    if (!id) continue;
    const currentLevel = level.get(id) ?? 0;
    for (const target of outgoing.get(id) ?? []) {
      level.set(target, Math.max(level.get(target) ?? 0, currentLevel + 1));
      const remaining = (incoming.get(target) ?? 1) - 1;
      incoming.set(target, remaining);
      if (remaining === 0) queue.push(target);
    }
  }

  // A journey may deliberately contain cycles. Keep them renderable by placing
  // the unresolved component after the acyclic frontier in stable node order.
  let fallbackLevel = Math.max(0, ...level.values());
  for (const node of nodes) {
    if (level.has(node.id)) continue;
    fallbackLevel += 1;
    level.set(node.id, fallbackLevel);
  }
  return level;
}

export function layoutJourneyNodes(
  snapshot: JourneySnapshot,
  expandedNodeId: string | null,
  focusedNodeId: string | null = null,
): JourneyNodeLayout[] {
  const levels = graphLevels(snapshot.nodes, snapshot.edges);
  const nodesByLevel = new Map<number, JourneyNode[]>();
  for (const node of snapshot.nodes) {
    const level = levels.get(node.id) ?? 0;
    const layer = nodesByLevel.get(level) ?? [];
    layer.push(node);
    nodesByLevel.set(level, layer);
  }

  const layouts: JourneyNodeLayout[] = [];
  const orderedLevels = [...nodesByLevel.keys()].toSorted((left, right) => left - right);
  for (const layerIndex of orderedLevels) {
    const layer = nodesByLevel.get(layerIndex) ?? [];
    const layerSizes = layer.map((node) => {
      const expanded = node.id === expandedNodeId;
      const focused = node.id === focusedNodeId;
      return {
        node,
        width: focused
          ? JOURNEY_NODE_FOCUSED_WIDTH
          : expanded
            ? JOURNEY_NODE_EXPANDED_WIDTH
            : JOURNEY_NODE_WIDTH,
        height: focused
          ? JOURNEY_NODE_FOCUSED_HEIGHT
          : expanded
            ? JOURNEY_NODE_EXPANDED_HEIGHT
            : JOURNEY_NODE_HEIGHT,
      };
    });

    if (snapshot.layoutDirection === "TB") {
      const totalWidth = layerSizes.reduce((sum, size) => sum + size.width, 0);
      const gaps = Math.max(0, layerSizes.length - 1) * NODE_GAP;
      let x = -(totalWidth + gaps) / 2;
      for (const size of layerSizes) {
        layouts.push({
          id: size.node.id,
          x,
          y:
            layerIndex *
            ((focusedNodeId ? JOURNEY_NODE_FOCUSED_HEIGHT : JOURNEY_NODE_EXPANDED_HEIGHT) +
              LAYER_GAP),
          width: size.width,
          height: size.height,
        });
        x += size.width + NODE_GAP;
      }
      continue;
    }

    const totalHeight = layerSizes.reduce((sum, size) => sum + size.height, 0);
    const gaps = Math.max(0, layerSizes.length - 1) * NODE_GAP;
    let y = -(totalHeight + gaps) / 2;
    for (const size of layerSizes) {
      layouts.push({
        id: size.node.id,
        x:
          layerIndex *
          ((focusedNodeId ? JOURNEY_NODE_FOCUSED_WIDTH : JOURNEY_NODE_EXPANDED_WIDTH) + LAYER_GAP),
        y,
        width: size.width,
        height: size.height,
      });
      y += size.height + NODE_GAP;
    }
  }
  return layouts;
}

export function makeInitialJourney(
  destination: string,
  now = new Date().toISOString(),
): JourneySnapshot {
  return {
    version: 1,
    destination: destination.trim(),
    layoutDirection: "TB",
    activeNodeId: "destination",
    nodes: [
      {
        id: "destination",
        type: "goal",
        status: "running",
        title: destination.trim(),
        summary: "The agent is mapping the first useful frontier.",
        detailMarkdown: "",
        todos: [],
        interaction: null,
        activity: [
          {
            id: `activity-${now}`,
            kind: "system",
            summary: "Journey started",
            detailMarkdown: "Clui asked the agent to define the initial graph.",
            createdAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
    ],
    edges: [],
    updatedAt: now,
  };
}

function extractJsonText(text: string): string | null {
  const tagged = text.match(/<journey-update>\s*([\s\S]*?)\s*<\/journey-update>/iu);
  if (tagged?.[1]) return tagged[1];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu);
  if (fenced?.[1]) return fenced[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

export function parseJourneyAgentResponse(text: string): JourneySnapshot {
  const jsonText = extractJsonText(text);
  if (!jsonText) throw new Error("The agent did not return a journey update.");
  let candidate: unknown;
  try {
    candidate = JSON.parse(jsonText) as unknown;
  } catch (error) {
    throw new Error("The agent returned invalid journey JSON.", { cause: error });
  }
  return Schema.decodeUnknownSync(JourneySnapshotSchema)(candidate);
}

export function settleJourneyAgentSnapshot(snapshot: JourneySnapshot): JourneySnapshot {
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) =>
      node.status === "running" ? { ...node, status: "ready" as const } : node,
    ),
  };
}

export function buildJourneyAgentPrompt(input: {
  snapshot: JourneySnapshot;
  focusNodeId: string;
  userMessage: string;
}): string {
  const focusNode = input.snapshot.nodes.find((node) => node.id === input.focusNodeId) ?? null;
  return `You are driving a Clui Journey: a free-form graph that you evolve as understanding and work progress.

Destination: ${input.snapshot.destination}
Focused node: ${focusNode ? `${focusNode.title} (${focusNode.id})` : input.focusNodeId}
User input: ${input.userMessage || "Continue this node and advance the journey."}

Rules:
- The graph has no prescribed shape. Add, update, supersede, or complete nodes only when useful.
- Preserve durable completed decisions and work unless the new information explicitly invalidates them.
- Use dependencies to show what blocks what. Edge direction is prerequisite source -> dependent target.
- A node may represent a goal, question, proposal, task, todo group, research, implementation, review, or note.
- A task or todoGroup can contain multiple todos.
- Do the concrete work represented by the focused node when possible: inspect, research, edit, test, or review the project as appropriate. Record only work you actually completed.
- When the user must answer, set status to waitingForUser and include a multi-step interaction.
- When more agent work is useful, leave the relevant node ready. Do not pretend work happened.
- Keep summaries concise; put detail in detailMarkdown.
- Reuse existing IDs for updated nodes and use stable kebab-case IDs for new nodes.
- Return the complete updated snapshot, not a patch. Preserve layoutDirection.
- Set activeNodeId to the next node that deserves attention, or null when none does.
- Set every updated timestamp and the snapshot updatedAt to an ISO-8601 string.

Exact JSON shape:
{
  "version": 1,
  "destination": "string",
  "layoutDirection": "TB | LR",
  "activeNodeId": "node-id | null",
  "nodes": [{
    "id": "string",
    "type": "goal | question | proposal | task | todoGroup | research | implementation | review | note",
    "status": "draft | ready | running | waitingForUser | blocked | completed | failed | cancelled | superseded",
    "title": "string",
    "summary": "string",
    "detailMarkdown": "string",
    "todos": [{ "id": "string", "title": "string", "completed": false, "note": "string" }],
    "interaction": null,
    "activity": [{ "id": "string", "kind": "agent | human | system", "summary": "string", "detailMarkdown": "string", "createdAt": "ISO string" }],
    "createdAt": "ISO string",
    "updatedAt": "ISO string"
  }],
  "edges": [{ "id": "string", "source": "node-id", "target": "node-id", "relation": "dependsOn | spawns | relatesTo", "label": "string | omitted" }],
  "updatedAt": "ISO string"
}

For a form, replace interaction:null with:
{
  "id": "interaction-id",
  "title": "string",
  "description": "string",
  "activeStepId": "first-step-id | null",
  "steps": [{
    "id": "string",
    "title": "string",
    "description": "string",
    "fields": [
      { "id": "string", "type": "text", "label": "string", "description": "string", "required": true, "multiline": true, "placeholder": "string" },
      { "id": "string", "type": "singleChoice", "label": "string", "description": "string", "required": true, "options": [{ "value": "string", "label": "string", "description": "string" }] },
      { "id": "string", "type": "multiChoice", "label": "string", "description": "string", "required": false, "options": [{ "value": "string", "label": "string", "description": "string" }] },
      { "id": "string", "type": "boolean", "label": "string", "description": "string", "required": false }
    ]
  }],
  "answers": {},
  "submitLabel": "Continue",
  "submittedAt": null
}

Current snapshot:
${JSON.stringify(input.snapshot, null, 2)}

Respond with exactly:
<journey-update>
{ complete JSON snapshot }
</journey-update>`;
}

export function withJourneyNode(
  snapshot: JourneySnapshot,
  nodeId: string,
  update: (node: JourneyNode) => JourneyNode,
): JourneySnapshot {
  const now = new Date().toISOString();
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => (node.id === nodeId ? update(node) : node)),
    updatedAt: now,
  };
}
