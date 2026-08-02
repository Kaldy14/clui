import type {
  CodingHarness,
  CommandId,
  JourneyApprovalAnswer,
  JourneyApprovalSubmitCommand,
  JourneyAttemptFence,
  JourneyDecisionSubmitCommand,
  JourneyLogicalRun,
  JourneyPhysicalAttempt,
  JourneyProjectionSnapshot,
  JourneyProposalRevisionHash,
  JourneyQuestionnaireAnswer,
  JourneyRootStartCommand,
  JourneySteeringItem,
  JourneySteeringRemoveCommand,
  ThreadId,
} from "@clui/contracts";
import { canonicalizeJourneyMaterialProposalRevisionInput } from "@clui/contracts";

const ACTIVE_RUN_STATUSES = new Set<JourneyLogicalRun["status"]>([
  "queued",
  "starting",
  "running",
  "quiescing",
  "waitingForDependencies",
  "waitingForUser",
  "cancelling",
]);

export function isJourneyRunActive(run: JourneyLogicalRun): boolean {
  return ACTIVE_RUN_STATUSES.has(run.status);
}

export function activeJourneyRuns(snapshot: JourneyProjectionSnapshot): JourneyLogicalRun[] {
  return snapshot.runs.filter(isJourneyRunActive);
}

export function latestAttemptFenceForRun(
  attempts: readonly JourneyPhysicalAttempt[],
  runId: string,
): JourneyAttemptFence | null {
  const attempt = attempts
    .filter((candidate) => candidate.fence.runId === runId)
    .toSorted((left, right) => right.fence.attempt - left.fence.attempt)[0];
  return attempt?.fence ?? null;
}

export function latestRunForNode(
  snapshot: JourneyProjectionSnapshot,
  nodeId: string,
): JourneyLogicalRun | null {
  return (
    snapshot.runs
      .filter((run) => run.nodeId === nodeId)
      .toSorted((left, right) => {
        const attemptDifference = right.attempt - left.attempt;
        return attemptDifference === 0
          ? right.updatedAt.localeCompare(left.updatedAt)
          : attemptDifference;
      })[0] ?? null
  );
}

export function selectJourneySteeringRun(
  snapshot: JourneyProjectionSnapshot,
  nodeId: string,
): JourneyLogicalRun | null {
  const nodeRun = latestRunForNode(snapshot, nodeId);
  if (nodeRun && isJourneyRunActive(nodeRun)) return nodeRun;
  return (
    snapshot.runs
      .filter((run) => run.role === "coordinator" && isJourneyRunActive(run))
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
  );
}

export function coordinatorPrompt(destination: string): string {
  return `Coordinate this Journey: ${destination}\n\nAdapt the workflow to the actual work. For a simple, concrete request, create one cohesive task or implementation node and proceed without approval. For ambiguous or complex work, first research facts that can be discovered without the user, split independent research into concurrent branches, and ask only questions that require a real user decision. Converge real research results into a concrete material proposal and wait for approval before repository writes. Add nodes only for work that is starting, a real result, or a genuine decision/blocker; never create placeholder or future-roadmap nodes.`;
}

export function journeyRootStartCommand(input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly destination: string;
  readonly harness: Extract<CodingHarness, "pi" | "codexCli">;
  readonly createdAt: string;
}): JourneyRootStartCommand {
  return {
    type: "journey.root.start",
    commandId: input.commandId,
    threadId: input.threadId,
    destination: input.destination,
    prompt: coordinatorPrompt(input.destination),
    harness: input.harness,
    createdAt: input.createdAt,
  };
}

export function journeySteeringRemoveCommand(input: {
  readonly commandId: CommandId;
  readonly item: JourneySteeringItem;
  readonly createdAt: string;
}): JourneySteeringRemoveCommand {
  return {
    type: "journey.steering.remove",
    commandId: input.commandId,
    threadId: input.item.threadId,
    runId: input.item.runId,
    itemId: input.item.id,
    createdAt: input.createdAt,
  };
}

export function journeyApprovalAnswer(
  answers: Readonly<Record<string, JourneyQuestionnaireAnswer>>,
): JourneyApprovalAnswer | null {
  const values = Object.values(answers).flatMap((value) =>
    Array.isArray(value) ? value : [value],
  );
  for (const value of values) {
    if (value === true) return "approved";
    if (value === false) return "rejected";
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase();
    if (["approve", "approved", "accept", "accepted", "yes"].includes(normalized)) {
      return "approved";
    }
    if (["reject", "rejected", "decline", "declined", "no"].includes(normalized)) {
      return "rejected";
    }
  }
  return null;
}

export async function journeyProposalRevisionHash(
  snapshot: JourneyProjectionSnapshot["journey"],
  proposalNodeId: string,
): Promise<JourneyProposalRevisionHash> {
  const node = snapshot.nodes.find((candidate) => candidate.id === proposalNodeId);
  if (!node || node.type !== "proposal" || !node.interaction) {
    throw new Error("The current authoritative proposal interaction is unavailable.");
  }
  if (!globalThis.crypto?.subtle) {
    throw new Error("Proposal approval requires secure revision hashing in this browser.");
  }
  const canonical = canonicalizeJourneyMaterialProposalRevisionInput({
    node: {
      id: node.id,
      type: node.type,
      title: node.title,
      summary: node.summary,
      detailMarkdown: node.detailMarkdown,
      todos: node.todos.map((todo) => ({ id: todo.id, title: todo.title, note: todo.note })),
      interaction: {
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
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("") as JourneyProposalRevisionHash;
}

export async function journeyInteractionSubmitCommand(input: {
  readonly commandId: CommandId;
  readonly projection: JourneyProjectionSnapshot;
  readonly nodeId: string;
  readonly answers: Record<string, JourneyQuestionnaireAnswer>;
  readonly actorId: string;
  readonly timestamp: string;
}): Promise<JourneyApprovalSubmitCommand | JourneyDecisionSubmitCommand> {
  const node = input.projection.journey.nodes.find((candidate) => candidate.id === input.nodeId);
  if (!node?.interaction) throw new Error("The current Journey interaction is unavailable.");
  const actor = { kind: "user" as const, id: input.actorId };
  if (node.type !== "proposal") {
    return {
      type: "journey.decision.submit",
      commandId: input.commandId,
      submission: {
        threadId: input.projection.threadId,
        interactionId: node.interaction.id,
        decisionNodeId: node.id,
        answers: input.answers,
        actor,
        submittedAt: input.timestamp,
      },
    };
  }
  const answer = journeyApprovalAnswer(input.answers);
  if (!answer) throw new Error("Choose Approve or Reject before submitting this proposal.");
  return {
    type: "journey.approval.submit",
    commandId: input.commandId,
    submission: {
      threadId: input.projection.threadId,
      interactionId: node.interaction.id,
      proposalNodeId: node.id,
      proposalRevisionHash: await journeyProposalRevisionHash(input.projection.journey, node.id),
      actor,
      answer,
      timestamp: input.timestamp,
    },
  };
}
