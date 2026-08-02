import {
  JourneySnapshot as JourneySnapshotSchema,
  type JourneyEdge,
  type JourneyNode,
  type JourneySnapshot,
} from "@clui/contracts";
import { Schema } from "effect";

export const JOURNEY_NODE_WIDTH = 280;
export const JOURNEY_NODE_EXPANDED_WIDTH = 520;
export const JOURNEY_NODE_FOCUSED_WIDTH = 720;
export const JOURNEY_NODE_HEIGHT = 64;
const JOURNEY_NODE_EXPANDED_HEIGHT = 360;
const JOURNEY_NODE_FOCUSED_HEIGHT = 560;
export const JOURNEY_LAYER_GAP = 48;
export const JOURNEY_NODE_GAP = 24;

export function journeyNodeZIndex(expanded: boolean, focused: boolean): number {
  if (focused) return 200;
  if (expanded) return 100;
  return 0;
}

export function toggleJourneyNodeFocusState(
  nodeId: string,
  focusedNodeId: string | null,
): { expandedNodeId: string | null; focusedNodeId: string | null } {
  if (focusedNodeId === nodeId) {
    return { expandedNodeId: null, focusedNodeId: null };
  }
  return { expandedNodeId: nodeId, focusedNodeId: nodeId };
}

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
  measuredHeights: Readonly<Record<string, number>> = {},
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
  let primaryOffset = 0;
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
        height:
          measuredHeights[node.id] ??
          (focused
            ? JOURNEY_NODE_FOCUSED_HEIGHT
            : expanded
              ? JOURNEY_NODE_EXPANDED_HEIGHT
              : JOURNEY_NODE_HEIGHT),
      };
    });

    if (snapshot.layoutDirection === "TB") {
      const totalWidth = layerSizes.reduce((sum, size) => sum + size.width, 0);
      const gaps = Math.max(0, layerSizes.length - 1) * JOURNEY_NODE_GAP;
      let x = -(totalWidth + gaps) / 2;
      for (const size of layerSizes) {
        layouts.push({
          id: size.node.id,
          x,
          y: primaryOffset,
          width: size.width,
          height: size.height,
        });
        x += size.width + JOURNEY_NODE_GAP;
      }
      primaryOffset +=
        Math.max(JOURNEY_NODE_HEIGHT, ...layerSizes.map((size) => size.height)) + JOURNEY_LAYER_GAP;
      continue;
    }

    const totalHeight = layerSizes.reduce((sum, size) => sum + size.height, 0);
    const gaps = Math.max(0, layerSizes.length - 1) * JOURNEY_NODE_GAP;
    let y = -(totalHeight + gaps) / 2;
    for (const size of layerSizes) {
      layouts.push({
        id: size.node.id,
        x: primaryOffset,
        y,
        width: size.width,
        height: size.height,
      });
      y += size.height + JOURNEY_NODE_GAP;
    }
    primaryOffset +=
      Math.max(JOURNEY_NODE_WIDTH, ...layerSizes.map((size) => size.width)) + JOURNEY_LAYER_GAP;
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
        summary: "The agent is starting concrete work.",
        detailMarkdown: "",
        todos: [],
        interaction: null,
        activity: [
          {
            id: `activity-${now}`,
            kind: "system",
            summary: "Journey started",
            detailMarkdown: "Clui started the agent on the Journey destination.",
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
  const snapshot = Schema.decodeUnknownSync(JourneySnapshotSchema)(candidate);
  const placeholderNodes = snapshot.nodes.filter(
    (node) => node.status === "draft" || node.status === "ready",
  );
  if (placeholderNodes.length > 0) {
    throw new Error(
      `The agent returned speculative Journey nodes instead of starting real work: ${placeholderNodes.map((node) => node.id).join(", ")}.`,
    );
  }
  return snapshot;
}

export function settleJourneyAgentSnapshot(
  snapshot: JourneySnapshot,
  now = new Date().toISOString(),
): JourneySnapshot {
  if (!snapshot.nodes.some((node) => node.status === "running")) return snapshot;
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) =>
      node.status === "running" ? { ...node, status: "ready" as const, updatedAt: now } : node,
    ),
    updatedAt: now,
  };
}

function journeyPrerequisiteIsSatisfied(status: JourneyNode["status"]): boolean {
  return status === "completed" || status === "superseded";
}

export function nextAutomaticJourneyNodeId(snapshot: JourneySnapshot): string | null {
  if (snapshot.nodes.some((node) => node.status === "waitingForUser")) return null;

  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node] as const));
  const isRunnable = (node: JourneyNode): boolean => {
    if (node.status !== "ready") return false;
    return snapshot.edges
      .filter((edge) => edge.target === node.id && edge.relation !== "relatesTo")
      .every((edge) => {
        const prerequisite = nodesById.get(edge.source);
        return prerequisite !== undefined && journeyPrerequisiteIsSatisfied(prerequisite.status);
      });
  };

  const activeNode = snapshot.activeNodeId ? nodesById.get(snapshot.activeNodeId) : undefined;
  if (activeNode && isRunnable(activeNode)) return activeNode.id;
  return snapshot.nodes.find(isRunnable)?.id ?? null;
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
- journey_get and journey_update are the live graph protocol and the source of truth when available.
- Call journey_update immediately before concrete work so its node appears as running before you do that work.
- Call journey_update again at every meaningful transition: new branch, result, blocker, question, proposal, implementation milestone, or completed task. Each call is shown in the UI immediately.
- Never create a completed research, implementation, or review node retroactively. Create it as running first, do the concrete work, then update it with the real result.
- Never create roadmap or placeholder nodes for work you may do later. A node exists only for work you are starting now, a result that already exists, or a concrete human/external blocker. Keep future ideas in the current node detail until you actually start them.
- Agent-authored nodes must never use draft or ready. Start real agent work as running, record finished work as completed, and use waitingForUser only for a genuine human decision with an interaction.
- Continue all non-HITL work autonomously in this harness turn. Do not stop to ask the user to press a generic Continue button. Pause only for waitingForUser, a real external blocker, failure/cancellation, or Journey completion.
- Before moving to another concrete work node, complete, supersede, block, or fail the current node. Do not leave several ancestor nodes running.
- The graph has no prescribed shape. Add, update, supersede, or complete nodes only when useful.
- Preserve durable completed decisions and work unless the new information explicitly invalidates them.
- Use dependencies to show what blocks what. Edge direction is prerequisite source -> dependent target.
- A node may represent a goal, question, proposal, task, todo group, research, implementation, review, or note.
- A task or todoGroup can contain multiple todos.
- Do the concrete work represented by the focused node when possible: inspect, research, edit, test, or review the project as appropriate. Record only work you actually completed.
- When the user must answer, set status to waitingForUser and include a multi-step interaction.
- When more agent work is useful, start it now as running and continue. Do not leave it ready for a user click and do not pretend work happened.
- Keep summaries concise; put detail in detailMarkdown.
- Reuse existing IDs for updated nodes and use stable kebab-case IDs for new nodes.
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

When the Journey tools are available, use them throughout the run and finish with a short plain-language summary. Do not return a <journey-update> snapshot after using the tools.

Fallback only when journey_get and journey_update are unavailable: return exactly:
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
