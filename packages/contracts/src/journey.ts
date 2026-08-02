import { Option, Schema, SchemaIssue } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";

export const JourneyNodeType = Schema.Literals([
  "goal",
  "question",
  "proposal",
  "task",
  "todoGroup",
  "research",
  "implementation",
  "review",
  "note",
]);
export type JourneyNodeType = typeof JourneyNodeType.Type;

export const JourneyNodeStatus = Schema.Literals([
  "draft",
  "ready",
  "running",
  "waitingForUser",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "superseded",
]);
export type JourneyNodeStatus = typeof JourneyNodeStatus.Type;

export const JourneyTodo = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  completed: Schema.Boolean,
  note: Schema.String.pipe(Schema.withDecodingDefault(() => "")),
});
export type JourneyTodo = typeof JourneyTodo.Type;

const JourneyQuestionnaireFieldBase = {
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: Schema.String,
  required: Schema.Boolean,
} as const;

export const JourneyQuestionnaireOption = Schema.Struct({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: Schema.String,
});
export type JourneyQuestionnaireOption = typeof JourneyQuestionnaireOption.Type;

export const JourneyQuestionnaireField = Schema.Union([
  Schema.Struct({
    ...JourneyQuestionnaireFieldBase,
    type: Schema.Literal("text"),
    placeholder: Schema.String,
    multiline: Schema.Boolean,
  }),
  Schema.Struct({
    ...JourneyQuestionnaireFieldBase,
    type: Schema.Literal("singleChoice"),
    options: Schema.Array(JourneyQuestionnaireOption),
  }),
  Schema.Struct({
    ...JourneyQuestionnaireFieldBase,
    type: Schema.Literal("multiChoice"),
    options: Schema.Array(JourneyQuestionnaireOption),
  }),
  Schema.Struct({
    ...JourneyQuestionnaireFieldBase,
    type: Schema.Literal("boolean"),
  }),
]);
export type JourneyQuestionnaireField = typeof JourneyQuestionnaireField.Type;

export const JourneyQuestionnaireStep = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  description: Schema.String,
  fields: Schema.Array(JourneyQuestionnaireField),
});
export type JourneyQuestionnaireStep = typeof JourneyQuestionnaireStep.Type;

export const JourneyQuestionnaireAnswer = Schema.Union([
  Schema.String,
  Schema.Boolean,
  Schema.Array(Schema.String),
]);
export type JourneyQuestionnaireAnswer = typeof JourneyQuestionnaireAnswer.Type;

export const JourneyInteraction = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  description: Schema.String,
  steps: Schema.Array(JourneyQuestionnaireStep),
  activeStepId: Schema.NullOr(TrimmedNonEmptyString),
  answers: Schema.Record(Schema.String, JourneyQuestionnaireAnswer),
  submittedAt: Schema.NullOr(IsoDateTime),
  submitLabel: TrimmedNonEmptyString.pipe(Schema.withDecodingDefault(() => "Continue")),
});
export type JourneyInteraction = typeof JourneyInteraction.Type;

export const JourneyActivityEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["agent", "human", "system"]).pipe(
    Schema.withDecodingDefault(() => "system" as const),
  ),
  summary: TrimmedNonEmptyString,
  detailMarkdown: Schema.String,
  createdAt: IsoDateTime,
});
export type JourneyActivityEntry = typeof JourneyActivityEntry.Type;

export const JourneyNode = Schema.Struct({
  id: TrimmedNonEmptyString,
  type: JourneyNodeType,
  status: JourneyNodeStatus,
  title: TrimmedNonEmptyString,
  summary: Schema.String,
  detailMarkdown: Schema.String,
  todos: Schema.Array(JourneyTodo),
  interaction: Schema.NullOr(JourneyInteraction).pipe(Schema.withDecodingDefault(() => null)),
  activity: Schema.Array(JourneyActivityEntry),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type JourneyNode = typeof JourneyNode.Type;

export const JourneyEdgeRelation = Schema.Literals(["dependsOn", "spawns", "relatesTo"]);
export type JourneyEdgeRelation = typeof JourneyEdgeRelation.Type;

export const JourneyEdge = Schema.Struct({
  id: TrimmedNonEmptyString,
  source: TrimmedNonEmptyString,
  target: TrimmedNonEmptyString,
  relation: JourneyEdgeRelation,
  label: Schema.optional(TrimmedNonEmptyString),
});
export type JourneyEdge = typeof JourneyEdge.Type;

export const JourneyLayoutDirection = Schema.Literals(["TB", "LR"]);
export type JourneyLayoutDirection = typeof JourneyLayoutDirection.Type;

export const JourneySnapshot = Schema.Struct({
  version: Schema.Literal(1),
  destination: TrimmedNonEmptyString,
  layoutDirection: JourneyLayoutDirection,
  nodes: Schema.Array(JourneyNode),
  edges: Schema.Array(JourneyEdge),
  activeNodeId: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type JourneySnapshot = typeof JourneySnapshot.Type;

/**
 * Atomic graph changes emitted by a running Journey agent.
 *
 * Fields are optional so one tool call can update only the part of the graph
 * that changed. The server applies the mutation against its current snapshot
 * and emits the resulting durable Journey snapshot.
 */
export const JourneyMutation = Schema.Struct({
  nodes: Schema.optional(Schema.Array(JourneyNode)),
  removeNodeIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  edges: Schema.optional(Schema.Array(JourneyEdge)),
  removeEdgeIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  activeNodeId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type JourneyMutation = typeof JourneyMutation.Type;

// Journey v1 above remains the durable presentation graph. The contracts below
// add server-owned execution state without turning the graph into a workflow DSL.
export const JourneyRunId = TrimmedNonEmptyString;
export type JourneyRunId = typeof JourneyRunId.Type;
export const JourneyInteractionId = TrimmedNonEmptyString;
export type JourneyInteractionId = typeof JourneyInteractionId.Type;
export const JourneyProposalRevisionHash = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-f0-9]{64}$/),
);
export type JourneyProposalRevisionHash = typeof JourneyProposalRevisionHash.Type;

export const JourneyRunRole = Schema.Literals([
  "coordinator",
  "researchWorker",
  "implementationOwner",
]);
export type JourneyRunRole = typeof JourneyRunRole.Type;

export const JourneyRunStatus = Schema.Literals([
  "queued",
  "starting",
  "running",
  "quiescing",
  "waitingForDependencies",
  "waitingForUser",
  "interrupted",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
]);
export type JourneyRunStatus = typeof JourneyRunStatus.Type;

export const JourneyAttemptStatus = Schema.Literals([
  "starting",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type JourneyAttemptStatus = typeof JourneyAttemptStatus.Type;

export const JourneyAttemptFence = Schema.Struct({
  threadId: ThreadId,
  runId: JourneyRunId,
  nodeId: TrimmedNonEmptyString,
  attempt: PositiveInt,
});
export type JourneyAttemptFence = typeof JourneyAttemptFence.Type;

export const JourneyCapability = Schema.Literals([
  "graph.read",
  "graph.mutate",
  "research.start",
  "research.read",
  "research.cancel",
  "implementation.start",
  "decision.request",
  "repository.write",
]);
export type JourneyCapability = typeof JourneyCapability.Type;

const RESEARCH_FORBIDDEN_CAPABILITIES = new Set<JourneyCapability>([
  "graph.mutate",
  "research.start",
  "implementation.start",
  "repository.write",
]);

export const JourneyRoleCapabilityCheck = Schema.makeFilter(
  (grant: {
    readonly role: JourneyRunRole;
    readonly capabilities: ReadonlyArray<JourneyCapability>;
  }) => {
    if (
      grant.role === "researchWorker" &&
      grant.capabilities.some((capability) => RESEARCH_FORBIDDEN_CAPABILITIES.has(capability))
    ) {
      return new SchemaIssue.InvalidValue(Option.some(grant.capabilities), {
        message: "research workers cannot receive mutation, child-start, or write capabilities",
      });
    }
    if (grant.capabilities.includes("repository.write") && grant.role !== "implementationOwner") {
      return new SchemaIssue.InvalidValue(Option.some(grant.role), {
        message: "repository.write is restricted to implementation owners",
      });
    }
    return true;
  },
  { identifier: "JourneyRoleCapabilities" },
);

export const JourneyLogicalRun = Schema.Struct({
  threadId: ThreadId,
  runId: JourneyRunId,
  nodeId: TrimmedNonEmptyString,
  role: JourneyRunRole,
  harness: Schema.Literals(["pi", "codexCli"]),
  status: JourneyRunStatus,
  attempt: NonNegativeInt,
  capabilities: Schema.Array(JourneyCapability),
  parentRunId: Schema.NullOr(JourneyRunId),
  coordinatorRunId: Schema.NullOr(JourneyRunId),
  canonicalWorkspaceLeaseId: Schema.NullOr(TrimmedNonEmptyString),
  outputStreamId: TrimmedNonEmptyString,
  failureReason: Schema.NullOr(TrimmedNonEmptyString),
  resumableHarnessIdentity: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).check(JourneyRoleCapabilityCheck);
export type JourneyLogicalRun = typeof JourneyLogicalRun.Type;

export const JourneyPhysicalAttempt = Schema.Struct({
  fence: JourneyAttemptFence,
  status: JourneyAttemptStatus,
  capabilities: Schema.Array(JourneyCapability),
  credentialId: Schema.NullOr(TrimmedNonEmptyString),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  failureReason: Schema.NullOr(TrimmedNonEmptyString),
});
export type JourneyPhysicalAttempt = typeof JourneyPhysicalAttempt.Type;

export const JourneyCoordinatorOutcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("complete"),
    summary: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("waitForDependencies"),
    successDependencyNodeIds: Schema.Array(TrimmedNonEmptyString),
    observeTerminalRunIds: Schema.Array(JourneyRunId),
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("waitForUser"),
    interactionId: JourneyInteractionId,
    decisionNodeId: TrimmedNonEmptyString,
    proposalRevisionHash: Schema.optional(JourneyProposalRevisionHash),
    reason: TrimmedNonEmptyString,
  }),
]);
export type JourneyCoordinatorOutcome = typeof JourneyCoordinatorOutcome.Type;

export const JourneyResearchEvidence = Schema.Struct({
  source: TrimmedNonEmptyString,
  finding: TrimmedNonEmptyString,
});
export type JourneyResearchEvidence = typeof JourneyResearchEvidence.Type;

const JourneyResearchFindingResult = Schema.Struct({
  kind: Schema.Literal("research"),
  summary: TrimmedNonEmptyString,
  evidence: Schema.Array(JourneyResearchEvidence).check(
    Schema.makeFilter((items) => items.length > 0, {
      identifier: "JourneyResearchEvidenceRequired",
      description: "at least one research evidence item",
    }),
  ),
  unresolved: Schema.Array(TrimmedNonEmptyString),
  noFinding: Schema.optional(Schema.Literal(false)),
});
const JourneyResearchNoFindingResult = Schema.Struct({
  kind: Schema.Literal("research"),
  summary: TrimmedNonEmptyString,
  evidence: Schema.Array(JourneyResearchEvidence).check(
    Schema.makeFilter((items) => items.length === 0, {
      identifier: "JourneyResearchNoFindingEvidence",
      description: "noFinding results cannot contain evidence",
    }),
  ),
  unresolved: Schema.Array(TrimmedNonEmptyString),
  noFinding: Schema.Literal(true),
  noFindingRationale: TrimmedNonEmptyString,
});
export const JourneyResearchResult = Schema.Union([
  JourneyResearchFindingResult,
  JourneyResearchNoFindingResult,
]);
export type JourneyResearchResult = typeof JourneyResearchResult.Type;

export const JourneyImplementationVerification = Schema.Struct({
  command: TrimmedNonEmptyString,
  outcome: TrimmedNonEmptyString,
  passed: Schema.Boolean,
});
export type JourneyImplementationVerification = typeof JourneyImplementationVerification.Type;

export const JourneyImplementationResult = Schema.Struct({
  kind: Schema.Literal("implementation"),
  summary: TrimmedNonEmptyString,
  changedFiles: Schema.Array(TrimmedNonEmptyString).check(
    Schema.makeFilter((items) => items.length > 0, {
      identifier: "JourneyImplementationChangedFilesRequired",
      description: "at least one changed file",
    }),
  ),
  verification: Schema.Array(JourneyImplementationVerification).check(
    Schema.makeFilter((items) => items.length > 0, {
      identifier: "JourneyImplementationVerificationRequired",
      description: "at least one verification result",
    }),
  ),
  unresolved: Schema.Array(TrimmedNonEmptyString),
});
export type JourneyImplementationResult = typeof JourneyImplementationResult.Type;

export const JourneyStructuredResult = Schema.Union([
  JourneyResearchResult,
  JourneyImplementationResult,
]);
export type JourneyStructuredResult = typeof JourneyStructuredResult.Type;

export const JourneyMaterialTodo = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  note: Schema.String,
});
export type JourneyMaterialTodo = typeof JourneyMaterialTodo.Type;

export const JourneyMaterialInteraction = Schema.Struct({
  id: JourneyInteractionId,
  title: TrimmedNonEmptyString,
  description: Schema.String,
  steps: Schema.Array(JourneyQuestionnaireStep),
  submitLabel: TrimmedNonEmptyString,
});
export type JourneyMaterialInteraction = typeof JourneyMaterialInteraction.Type;

export const JourneyMaterialDependency = Schema.Struct({
  source: TrimmedNonEmptyString,
  target: TrimmedNonEmptyString,
  relation: Schema.Literal("dependsOn"),
});
export type JourneyMaterialDependency = typeof JourneyMaterialDependency.Type;

/** Input to canonical key-sorted UTF-8 JSON serialization before SHA-256 hashing. */
export const JourneyMaterialProposalRevisionInput = Schema.Struct({
  node: Schema.Struct({
    id: TrimmedNonEmptyString,
    type: JourneyNodeType,
    title: TrimmedNonEmptyString,
    summary: Schema.String,
    detailMarkdown: Schema.String,
    todos: Schema.Array(JourneyMaterialTodo),
    interaction: Schema.NullOr(JourneyMaterialInteraction),
  }),
  dependencies: Schema.Array(JourneyMaterialDependency),
});
export type JourneyMaterialProposalRevisionInput = typeof JourneyMaterialProposalRevisionInput.Type;

const canonicalizeJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJson).join(",")}]`;
  }
  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(object[key])}`)
    .join(",")}}`;
};

const compareCanonicalString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Canonical UTF-8 JSON source for the server-owned SHA-256 proposal revision hash. */
export const canonicalizeJourneyMaterialProposalRevisionInput = (
  input: JourneyMaterialProposalRevisionInput,
): string =>
  canonicalizeJson({
    node: input.node,
    dependencies: input.dependencies.toSorted(
      (left, right) =>
        compareCanonicalString(left.source, right.source) ||
        compareCanonicalString(left.target, right.target) ||
        compareCanonicalString(left.relation, right.relation),
    ),
  });

export const JourneyApprovalAnswer = Schema.Literals(["approved", "rejected"]);
export type JourneyApprovalAnswer = typeof JourneyApprovalAnswer.Type;
export const JourneyApprovalActor = Schema.Struct({
  kind: Schema.Literals(["user", "system"]),
  id: TrimmedNonEmptyString,
});
export type JourneyApprovalActor = typeof JourneyApprovalActor.Type;

export const JourneyRevisionBoundApproval = Schema.Struct({
  interactionId: JourneyInteractionId,
  proposalNodeId: TrimmedNonEmptyString,
  proposalRevisionHash: JourneyProposalRevisionHash,
  actor: JourneyApprovalActor,
  answer: JourneyApprovalAnswer,
  timestamp: IsoDateTime,
});
export type JourneyRevisionBoundApproval = typeof JourneyRevisionBoundApproval.Type;

export const JourneyDecisionSubmission = Schema.Struct({
  threadId: ThreadId,
  interactionId: JourneyInteractionId,
  decisionNodeId: TrimmedNonEmptyString,
  answers: Schema.Record(Schema.String, JourneyQuestionnaireAnswer),
  actor: JourneyApprovalActor,
  submittedAt: IsoDateTime,
});
export type JourneyDecisionSubmission = typeof JourneyDecisionSubmission.Type;

export const JourneyApprovalSubmission = Schema.Struct({
  threadId: ThreadId,
  interactionId: JourneyInteractionId,
  proposalNodeId: TrimmedNonEmptyString,
  proposalRevisionHash: JourneyProposalRevisionHash,
  actor: JourneyApprovalActor,
  answer: JourneyApprovalAnswer,
  timestamp: IsoDateTime,
});
export type JourneyApprovalSubmission = typeof JourneyApprovalSubmission.Type;

export const JourneyOutputCursor = NonNegativeInt;
export type JourneyOutputCursor = typeof JourneyOutputCursor.Type;

export const JourneyOutputChunk = Schema.Struct({
  fence: JourneyAttemptFence,
  startCursor: JourneyOutputCursor,
  endCursor: JourneyOutputCursor,
  data: Schema.String,
});
export type JourneyOutputChunk = typeof JourneyOutputChunk.Type;

export const JourneyOutputReadInput = Schema.Struct({
  fence: JourneyAttemptFence,
  afterCursor: JourneyOutputCursor,
});
export type JourneyOutputReadInput = typeof JourneyOutputReadInput.Type;

export const JourneyOutputReadResult = Schema.Struct({
  fence: JourneyAttemptFence,
  reset: Schema.Boolean,
  firstCursor: JourneyOutputCursor,
  nextCursor: JourneyOutputCursor,
  data: Schema.String,
}).check(
  Schema.makeFilter(
    (result) =>
      result.firstCursor <= result.nextCursor ||
      new SchemaIssue.InvalidValue(Option.some(result.firstCursor), {
        message: "firstCursor must be less than or equal to nextCursor",
      }),
    { identifier: "JourneyOutputCursorRange" },
  ),
);
export type JourneyOutputReadResult = typeof JourneyOutputReadResult.Type;

export const JourneySteeringItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
  runId: JourneyRunId,
  nodeId: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  sequence: PositiveInt,
  status: Schema.Literals(["queued", "delivered"]),
  createdAt: IsoDateTime,
  deliveredAt: Schema.NullOr(IsoDateTime),
});
export type JourneySteeringItem = typeof JourneySteeringItem.Type;

export const JourneyProjectionChangedEntities = Schema.Struct({
  journey: Schema.optional(JourneySnapshot),
  runs: Schema.optional(Schema.Array(JourneyLogicalRun)),
  attempts: Schema.optional(Schema.Array(JourneyPhysicalAttempt)),
  approvals: Schema.optional(Schema.Array(JourneyRevisionBoundApproval)),
  steering: Schema.optional(Schema.Array(JourneySteeringItem)),
  removedRunIds: Schema.optional(Schema.Array(JourneyRunId)),
});
export type JourneyProjectionChangedEntities = typeof JourneyProjectionChangedEntities.Type;

export const JourneyProjectionDelta = Schema.Struct({
  threadId: ThreadId,
  fromRevision: NonNegativeInt,
  toRevision: PositiveInt,
  globalEventWatermark: NonNegativeInt,
  changedEntities: JourneyProjectionChangedEntities,
}).check(
  Schema.makeFilter(
    (delta) =>
      delta.toRevision === delta.fromRevision + 1 ||
      new SchemaIssue.InvalidValue(Option.some(delta.toRevision), {
        message: "Journey projection deltas must advance exactly one revision",
      }),
    { identifier: "ContiguousJourneyProjectionDelta" },
  ),
);
export type JourneyProjectionDelta = typeof JourneyProjectionDelta.Type;

export const JourneyProjectionSnapshot = Schema.Struct({
  threadId: ThreadId,
  journeyRevision: NonNegativeInt,
  globalEventWatermark: NonNegativeInt,
  journey: JourneySnapshot,
  runs: Schema.Array(JourneyLogicalRun),
  attempts: Schema.Array(JourneyPhysicalAttempt),
  approvals: Schema.Array(JourneyRevisionBoundApproval),
  steering: Schema.Array(JourneySteeringItem).pipe(Schema.withDecodingDefault(() => [])),
});
export type JourneyProjectionSnapshot = typeof JourneyProjectionSnapshot.Type;

export const JourneyResearchStartInput = Schema.Struct({
  fence: JourneyAttemptFence,
  nodeId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  question: TrimmedNonEmptyString,
});
export type JourneyResearchStartInput = typeof JourneyResearchStartInput.Type;
export const JourneyResearchGetInput = Schema.Struct({
  fence: JourneyAttemptFence,
  researchRunId: JourneyRunId,
});
export type JourneyResearchGetInput = typeof JourneyResearchGetInput.Type;
export const JourneyResearchCancelInput = JourneyResearchGetInput;
export type JourneyResearchCancelInput = typeof JourneyResearchCancelInput.Type;
export const JourneyImplementationStartInput = Schema.Struct({
  fence: JourneyAttemptFence,
  nodeId: TrimmedNonEmptyString,
  canonicalWorkspaceId: TrimmedNonEmptyString,
  proposalRevisionHash: Schema.optional(JourneyProposalRevisionHash),
});
export type JourneyImplementationStartInput = typeof JourneyImplementationStartInput.Type;
