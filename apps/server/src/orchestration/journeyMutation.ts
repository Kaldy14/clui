import type { JourneyMutation, JourneySnapshot } from "@clui/contracts";

import { assertAcyclicJourneyDependencies } from "./journeySchedulerPolicy.ts";

export function applyJourneyMutation(
  snapshot: JourneySnapshot,
  mutation: JourneyMutation,
  updatedAt: string,
): JourneySnapshot {
  const removeNodeIds = new Set(mutation.removeNodeIds ?? []);
  const nodesById = new Map(
    snapshot.nodes
      .filter((node) => !removeNodeIds.has(node.id))
      .map((node) => [node.id, node] as const),
  );

  for (const node of mutation.nodes ?? []) {
    if (node.status === "draft" || node.status === "ready") {
      throw new Error(
        `Agent-authored Journey node '${node.id}' cannot use status '${node.status}'. Start concrete work as running or record a real result/blocker.`,
      );
    }
    const existing = nodesById.get(node.id);
    nodesById.set(node.id, {
      ...node,
      createdAt: existing?.createdAt ?? node.createdAt,
      updatedAt,
    });
  }

  const removeEdgeIds = new Set(mutation.removeEdgeIds ?? []);
  const edgesById = new Map(
    snapshot.edges
      .filter(
        (edge) =>
          !removeEdgeIds.has(edge.id) &&
          !removeNodeIds.has(edge.source) &&
          !removeNodeIds.has(edge.target),
      )
      .map((edge) => [edge.id, edge] as const),
  );

  for (const edge of mutation.edges ?? []) {
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) {
      throw new Error(
        `Journey edge '${edge.id}' references missing node '${!nodesById.has(edge.source) ? edge.source : edge.target}'.`,
      );
    }
    edgesById.set(edge.id, edge);
  }

  let activeNodeId =
    mutation.activeNodeId !== undefined ? mutation.activeNodeId : snapshot.activeNodeId;
  if (activeNodeId !== null && !nodesById.has(activeNodeId)) {
    if (removeNodeIds.has(activeNodeId) && mutation.activeNodeId === undefined) {
      activeNodeId = null;
    } else {
      throw new Error(`Journey active node '${activeNodeId}' does not exist.`);
    }
  }

  const nextSnapshot: JourneySnapshot = {
    ...snapshot,
    nodes: [...nodesById.values()],
    edges: [...edgesById.values()],
    activeNodeId,
    updatedAt,
  };
  assertAcyclicJourneyDependencies(nextSnapshot);
  return nextSnapshot;
}
