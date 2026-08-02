import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  canonicalizeJourneyMaterialProposalRevisionInput,
  type JourneyLogicalRun,
  type JourneyProposalRevisionHash,
  type JourneySnapshot,
  type ThreadId,
} from "@clui/contracts";

export const DEFAULT_JOURNEY_RESEARCH_CONCURRENCY = 3;
export const DEFAULT_GLOBAL_RESEARCH_CONCURRENCY = 6;

const capacityHoldingStatuses = new Set([
  "starting",
  "running",
  "quiescing",
  "cancelling",
  "interrupted",
]);

export function validateJourneyResearchConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 4) {
    throw new Error("Journey research concurrency must be an integer between 1 and 4.");
  }
  return value;
}

export function assertAcyclicJourneyDependencies(snapshot: JourneySnapshot): void {
  const adjacency = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    if (edge.relation !== "dependsOn") continue;
    const targets = adjacency.get(edge.source) ?? [];
    targets.push(edge.target);
    adjacency.set(edge.source, targets);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string) => {
    if (visiting.has(nodeId)) {
      throw new Error(`Journey dependsOn edges contain a cycle through '${nodeId}'.`);
    }
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const target of adjacency.get(nodeId) ?? []) visit(target);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of snapshot.nodes) visit(node.id);
}

export function isJourneyNodeSuccessReady(snapshot: JourneySnapshot, nodeId: string): boolean {
  const node = snapshot.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return false;
  return snapshot.edges
    .filter((edge) => edge.relation === "dependsOn" && edge.target === nodeId)
    .every((edge) => {
      const dependency = snapshot.nodes.find((candidate) => candidate.id === edge.source);
      return dependency?.status === "completed" || dependency?.status === "superseded";
    });
}

export function canonicalJourneyWorkspaceIdentity(workspaceRoot: string): string {
  const resolved = resolve(workspaceRoot);
  const real = realpathSync.native(resolved);
  const stat = statSync(real);
  return `${real}#${stat.dev}:${stat.ino}`;
}

export function journeyProposalRevisionHash(
  snapshot: JourneySnapshot,
  proposalNodeId: string,
): JourneyProposalRevisionHash {
  const node = snapshot.nodes.find((candidate) => candidate.id === proposalNodeId);
  if (!node) throw new Error(`Journey proposal node '${proposalNodeId}' does not exist.`);
  const canonical = canonicalizeJourneyMaterialProposalRevisionInput({
    node: {
      id: node.id,
      type: node.type,
      title: node.title,
      summary: node.summary,
      detailMarkdown: node.detailMarkdown,
      todos: node.todos.map((todo) => ({ id: todo.id, title: todo.title, note: todo.note })),
      interaction:
        node.interaction === null
          ? null
          : {
              id: node.interaction.id,
              title: node.interaction.title,
              description: node.interaction.description,
              steps: node.interaction.steps,
              submitLabel: node.interaction.submitLabel,
            },
    },
    dependencies: snapshot.edges
      .filter((edge) => edge.relation === "dependsOn" && edge.target === proposalNodeId)
      .map((edge) => ({
        source: edge.source,
        target: edge.target,
        relation: "dependsOn" as const,
      })),
  });
  return createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex") as JourneyProposalRevisionHash;
}

interface JourneyResearchQueueProjection {
  readonly threadId: ThreadId;
  readonly runs: ReadonlyArray<JourneyLogicalRun>;
  readonly researchLimit?: number;
}

interface JourneyResearchScheduleResult {
  readonly selected: ReadonlyArray<JourneyLogicalRun>;
  readonly nextJourneyCursor: ThreadId | null;
}

/** Deterministic round-robin across Journeys and FIFO within each Journey. */
export function selectJourneyResearchStarts(input: {
  readonly journeys: ReadonlyArray<JourneyResearchQueueProjection>;
  readonly perJourneyLimit?: number;
  readonly globalLimit?: number;
  readonly afterJourneyId?: ThreadId | null;
}): JourneyResearchScheduleResult {
  const perJourneyLimit = validateJourneyResearchConcurrency(
    input.perJourneyLimit ?? DEFAULT_JOURNEY_RESEARCH_CONCURRENCY,
  );
  const globalLimit = input.globalLimit ?? DEFAULT_GLOBAL_RESEARCH_CONCURRENCY;
  if (!Number.isInteger(globalLimit) || globalLimit < 1) {
    throw new Error("Global Journey research concurrency must be a positive integer.");
  }
  const journeys = input.journeys.toSorted((left, right) =>
    left.threadId.localeCompare(right.threadId),
  );
  if (journeys.length === 0) return { selected: [], nextJourneyCursor: null };
  const afterIndex =
    input.afterJourneyId === null || input.afterJourneyId === undefined
      ? -1
      : journeys.findIndex((journey) => journey.threadId === input.afterJourneyId);
  const ordered = [
    ...journeys.slice(afterIndex + 1),
    ...journeys.slice(0, Math.max(0, afterIndex + 1)),
  ];
  const activeGlobal = journeys
    .flatMap((journey) => journey.runs)
    .filter(
      (run) => run.role === "researchWorker" && capacityHoldingStatuses.has(run.status),
    ).length;
  let remainingGlobal = Math.max(0, globalLimit - activeGlobal);
  const activeByJourney = new Map(
    journeys.map((journey) => [
      journey.threadId,
      journey.runs.filter(
        (run) => run.role === "researchWorker" && capacityHoldingStatuses.has(run.status),
      ).length,
    ]),
  );
  const queues = new Map(
    journeys.map((journey) => [
      journey.threadId,
      journey.runs
        .filter((run) => run.role === "researchWorker" && run.status === "queued")
        .toSorted(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId),
        ),
    ]),
  );
  const selected: JourneyLogicalRun[] = [];
  let lastJourneyId: ThreadId | null = input.afterJourneyId ?? null;
  while (remainingGlobal > 0) {
    let selectedInRound = false;
    for (const journey of ordered) {
      if (remainingGlobal === 0) break;
      const active = activeByJourney.get(journey.threadId) ?? 0;
      const queue = queues.get(journey.threadId) ?? [];
      const journeyLimit = validateJourneyResearchConcurrency(
        journey.researchLimit ?? perJourneyLimit,
      );
      if (active >= journeyLimit || queue.length === 0) continue;
      const next = queue.shift();
      if (!next) continue;
      selected.push(next);
      activeByJourney.set(journey.threadId, active + 1);
      remainingGlobal -= 1;
      lastJourneyId = journey.threadId;
      selectedInRound = true;
    }
    if (!selectedInRound) break;
  }
  return { selected, nextJourneyCursor: lastJourneyId };
}

export interface JourneySteeringItem {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly runId: string;
  readonly prompt: string;
  readonly sequence: number;
  readonly status: "queued" | "delivered";
}

export function enqueueJourneySteering(
  queue: ReadonlyArray<JourneySteeringItem>,
  item: Omit<JourneySteeringItem, "sequence" | "status">,
): ReadonlyArray<JourneySteeringItem> {
  if (queue.some((candidate) => candidate.id === item.id)) return queue;
  return [
    ...queue,
    {
      ...item,
      sequence: (queue.at(-1)?.sequence ?? 0) + 1,
      status: "queued",
    },
  ];
}

export function nextJourneySteering(
  queue: ReadonlyArray<JourneySteeringItem>,
  runId: string,
): JourneySteeringItem | null {
  return (
    queue
      .filter((item) => item.runId === runId && item.status === "queued")
      .toSorted((left, right) => left.sequence - right.sequence)
      .at(0) ?? null
  );
}

export function acknowledgeJourneySteering(
  queue: ReadonlyArray<JourneySteeringItem>,
  itemId: string,
): ReadonlyArray<JourneySteeringItem> {
  const item = queue.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`Journey steering item '${itemId}' does not exist.`);
  const next = nextJourneySteering(queue, item.runId);
  if (next?.id !== itemId) throw new Error("Journey steering must be delivered in FIFO order.");
  return queue.map((candidate) =>
    candidate.id === itemId ? { ...candidate, status: "delivered" as const } : candidate,
  );
}
