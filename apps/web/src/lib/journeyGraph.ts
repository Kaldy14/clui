import { type JourneyEdge, type JourneyNode, type JourneySnapshot } from "@clui/contracts";

export const JOURNEY_NODE_WIDTH = 280;
export const JOURNEY_NODE_EXPANDED_WIDTH = 520;
export const JOURNEY_NODE_FOCUSED_WIDTH = 720;
export const JOURNEY_NODE_HEIGHT = 64;
const JOURNEY_NODE_EXPANDED_HEIGHT = 360;
const JOURNEY_NODE_FOCUSED_HEIGHT = 560;
export const JOURNEY_LAYER_GAP = 48;
const JOURNEY_NODE_GAP = 24;

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
