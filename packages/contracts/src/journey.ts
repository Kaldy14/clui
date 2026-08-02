import { Schema } from "effect";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";

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
