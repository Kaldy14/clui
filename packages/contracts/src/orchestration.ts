import { Option, Schema, SchemaIssue, Struct } from "effect";
import { ProviderModelOptions } from "./model";
import {
  JourneyApprovalSubmission,
  JourneyAttemptFence,
  JourneyCapability,
  JourneyCoordinatorOutcome,
  JourneyDecisionSubmission,
  JourneyLogicalRun,
  JourneyOutputChunk,
  JourneyOutputReadInput,
  JourneyOutputReadResult,
  JourneyProjectionDelta,
  JourneyProjectionSnapshot,
  JourneyProposalRevisionHash,
  JourneyRevisionBoundApproval,
  JourneyRoleCapabilityCheck,
  JourneyRunId,
  JourneyRunRole,
  JourneyStructuredResult,
  JourneySteeringItem,
  JourneyMutation,
  JourneySnapshot,
} from "./journey";
import { AgentActivityStatus, ClaudeHookStatus } from "./claude-terminal";
import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";

export const ORCHESTRATION_WS_METHODS = {
  getSnapshot: "orchestration.getSnapshot",
  dispatchCommand: "orchestration.dispatchCommand",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  getWorkingTreeDiff: "orchestration.getWorkingTreeDiff",
  generateDiffReview: "orchestration.generateDiffReview",
  askDiffReview: "orchestration.askDiffReview",
  replayEvents: "orchestration.replayEvents",
  getSessionMetrics: "orchestration.getSessionMetrics",
  getSlashCommands: "orchestration.getSlashCommands",
  getCachedSlashCommands: "orchestration.getCachedSlashCommands",
  getJourneyProjection: "orchestration.getJourneyProjection",
  getJourneyDeltas: "orchestration.getJourneyDeltas",
  getJourneyRunOutput: "orchestration.getJourneyRunOutput",
  subscribeJourneyRunOutput: "orchestration.subscribeJourneyRunOutput",
  unsubscribeJourneyRunOutput: "orchestration.unsubscribeJourneyRunOutput",
} as const;

export const ORCHESTRATION_WS_CHANNELS = {
  domainEvent: "orchestration.domainEvent",
  approvalFastPath: "orchestration.approvalFastPath",
  journeyProjection: "orchestration.journeyProjection",
  journeyRunOutput: "orchestration.journeyRunOutput",
} as const;

export const ProviderKind = Schema.Literals(["codex", "claudeCode", "cursor"]);
export type ProviderKind = typeof ProviderKind.Type;
export const CodingHarness = Schema.Literals(["claudeCode", "pi", "codexCli"]);
export type CodingHarness = typeof CodingHarness.Type;
export const ClaudeCodeBackend = Schema.Literals(["anthropic", "codex"]);
export type ClaudeCodeBackend = typeof ClaudeCodeBackend.Type;
export const DEFAULT_CLAUDE_CODE_BACKEND: ClaudeCodeBackend = "anthropic";
export const ClaudeCodeProxyModel = Schema.Literals([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);
export type ClaudeCodeProxyModel = typeof ClaudeCodeProxyModel.Type;
export const DEFAULT_CLAUDE_CODE_PROXY_MODEL: ClaudeCodeProxyModel = "gpt-5.6-sol";
export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;
export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;
export const DEFAULT_PROVIDER_KIND: ProviderKind = "codex";
export const DEFAULT_CODING_HARNESS: CodingHarness = "claudeCode";
export const ThreadSurface = Schema.Literals(["terminal", "journey"]);
export type ThreadSurface = typeof ThreadSurface.Type;
export const DEFAULT_THREAD_SURFACE: ThreadSurface = "terminal";
export const PiRenderMode = Schema.Literals(["terminal", "html"] as const);
export type PiRenderMode = typeof PiRenderMode.Type;
export const DEFAULT_PI_RENDER_MODE: PiRenderMode = "terminal";
const CodexProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
});
const ProviderStartOptions = Schema.Struct({
  codex: Schema.optional(CodexProviderStartOptions),
});
export const RuntimeMode = Schema.Literals(["approval-required", "full-access"]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
export const ProviderInteractionMode = Schema.Literals(["default", "plan"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";
export const ProviderRequestKind = Schema.Literals(["command", "file-read", "file-change"]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;
export const AssistantDeliveryMode = Schema.Literals(["buffered", "streaming"]);
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type;
export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;
export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
// Correlation id is command id by design in this model.
export const CorrelationId = CommandId;
export type CorrelationId = typeof CorrelationId.Type;

const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ChatAttachmentId = typeof ChatAttachmentId.Type;

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

const UploadChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  ),
});
export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type;

export const ChatAttachment = Schema.Union([ChatImageAttachment]);
export type ChatAttachment = typeof ChatAttachment.Type;
const UploadChatAttachment = Schema.Union([UploadChatImageAttachment]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;

export const ProjectScriptIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectScriptIcon = typeof ProjectScriptIcon.Type;

export const ProjectScriptTerminalTarget = Schema.Literals(["thread", "project"]);
export type ProjectScriptTerminalTarget = typeof ProjectScriptTerminalTarget.Type;

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
  openTerminalOnWorktreeCreate: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  terminalTarget: ProjectScriptTerminalTarget.pipe(
    Schema.withDecodingDefault(() => "thread" as const),
  ),
});
export type ProjectScript = typeof ProjectScript.Type;

export const ProjectPrompt = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
});
export type ProjectPrompt = typeof ProjectPrompt.Type;

export const OrchestrationProject = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModel: Schema.NullOr(TrimmedNonEmptyString),
  scripts: Schema.Array(ProjectScript),
  prompts: Schema.Array(ProjectPrompt).pipe(Schema.withDecodingDefault(() => [])),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  hiddenAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationProject = typeof OrchestrationProject.Type;

export const OrchestrationMessageRole = Schema.Literals(["user", "assistant", "system"]);
export type OrchestrationMessageRole = typeof OrchestrationMessageRole.Type;

export const OrchestrationMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationMessage = typeof OrchestrationMessage.Type;

export const OrchestrationProposedPlanId = TrimmedNonEmptyString;
export type OrchestrationProposedPlanId = typeof OrchestrationProposedPlanId.Type;

export const OrchestrationProposedPlan = Schema.Struct({
  id: OrchestrationProposedPlanId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProposedPlan = typeof OrchestrationProposedPlan.Type;

export const OrchestrationSessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type OrchestrationSessionStatus = typeof OrchestrationSessionStatus.Type;

export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type OrchestrationSession = typeof OrchestrationSession.Type;

export const OrchestrationCheckpointFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type OrchestrationCheckpointFile = typeof OrchestrationCheckpointFile.Type;

export const OrchestrationCheckpointStatus = Schema.Literals(["ready", "missing", "error"]);
export type OrchestrationCheckpointStatus = typeof OrchestrationCheckpointStatus.Type;

export const OrchestrationCheckpointSummary = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type OrchestrationCheckpointSummary = typeof OrchestrationCheckpointSummary.Type;

export const OrchestrationThreadActivityTone = Schema.Literals([
  "info",
  "tool",
  "approval",
  "error",
]);
export type OrchestrationThreadActivityTone = typeof OrchestrationThreadActivityTone.Type;

export const OrchestrationThreadActivity = Schema.Struct({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  payload: Schema.Unknown,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  taskId: Schema.optional(TrimmedNonEmptyString),
  parentToolUseId: Schema.optional(TrimmedNonEmptyString),
});
export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;

const OrchestrationLatestTurnState = Schema.Literals([
  "running",
  "interrupted",
  "completed",
  "error",
]);
export type OrchestrationLatestTurnState = typeof OrchestrationLatestTurnState.Type;

export const OrchestrationLatestTurn = Schema.Struct({
  turnId: TurnId,
  state: OrchestrationLatestTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  inputTokens: Schema.optional(Schema.NullOr(Schema.Int)),
  outputTokens: Schema.optional(Schema.NullOr(Schema.Int)),
  cacheReadTokens: Schema.optional(Schema.NullOr(Schema.Int)),
  cacheWriteTokens: Schema.optional(Schema.NullOr(Schema.Int)),
  totalCostUsd: Schema.optional(Schema.NullOr(Schema.Number)),
  model: Schema.optional(Schema.NullOr(Schema.String)),
});
export type OrchestrationLatestTurn = typeof OrchestrationLatestTurn.Type;

export const RateLimitEntry = Schema.Struct({
  rateLimitType: Schema.String,
  status: Schema.String,
  utilization: Schema.Number,
  resetsAt: Schema.NullOr(Schema.Number),
  isUsingOverage: Schema.optional(Schema.Boolean),
});
export type RateLimitEntry = typeof RateLimitEntry.Type;

export const OrchestrationSessionMetrics = Schema.Struct({
  // Cumulative totals across all completed turns
  turnCount: NonNegativeInt,
  totalInputTokens: NonNegativeInt,
  totalOutputTokens: NonNegativeInt,
  totalCostUsd: Schema.Number,
  // Context window status from latest completed turn (point-in-time)
  contextUsedTokens: Schema.NullOr(NonNegativeInt),
  contextWindowSize: Schema.NullOr(NonNegativeInt),
  contextUsagePercent: Schema.NullOr(Schema.Number),
  // Rate limits (ephemeral, from latest rate_limit_event)
  rateLimits: Schema.Array(RateLimitEntry),
});
export type OrchestrationSessionMetrics = typeof OrchestrationSessionMetrics.Type;

export const TerminalStatus = Schema.Literals(["new", "active", "dormant"]);
export type TerminalStatus = typeof TerminalStatus.Type;

export const TitleSource = Schema.Literals(["auto", "manual"]);
export type TitleSource = typeof TitleSource.Type;

export const OrchestrationThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  surface: ThreadSurface.pipe(Schema.withDecodingDefault(() => DEFAULT_THREAD_SURFACE)),
  journey: Schema.NullOr(JourneySnapshot).pipe(Schema.withDecodingDefault(() => null)),
  harness: CodingHarness.pipe(Schema.withDecodingDefault(() => DEFAULT_CODING_HARNESS)),
  claudeCodeBackend: ClaudeCodeBackend.pipe(
    Schema.withDecodingDefault(() => DEFAULT_CLAUDE_CODE_BACKEND),
  ),
  piRenderMode: Schema.optional(PiRenderMode),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  claudeSessionId: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(() => null)),
  piSessionFile: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(() => null)),
  terminalStatus: TerminalStatus.pipe(Schema.withDecodingDefault(() => "new" as const)),
  /**
   * Ephemeral live terminal hook status for harnesses that can expose it in
   * snapshots (currently pi). `null` means no active hook status.
   */
  hookStatus: Schema.optional(Schema.NullOr(ClaudeHookStatus)),
  activityStatus: Schema.optional(Schema.NullOr(AgentActivityStatus)),
  scrollbackSnapshot: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(() => null)),
  titleSource: TitleSource.pipe(Schema.withDecodingDefault(() => "auto" as const)),
  bookmarked: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Only bumped when the user actively interacts (new turn starts). Used for sidebar sort. */
  lastInteractedAt: IsoDateTime.pipe(Schema.withDecodingDefault(() => "")),
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  snoozedUntil: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  snoozedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  deletedAt: Schema.NullOr(IsoDateTime),
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(Schema.withDecodingDefault(() => [])),
  activities: Schema.Array(OrchestrationThreadActivity),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  session: Schema.NullOr(OrchestrationSession),
});
export type OrchestrationThread = typeof OrchestrationThread.Type;

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  threads: Schema.Array(OrchestrationThread),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;

export const ProjectCreateCommand = Schema.Struct({
  type: Schema.Literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModel: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModel: Schema.optional(TrimmedNonEmptyString),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  prompts: Schema.optional(Schema.Array(ProjectPrompt)),
  hiddenAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});

const ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
});

const ThreadCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  surface: ThreadSurface.pipe(Schema.withDecodingDefault(() => DEFAULT_THREAD_SURFACE)),
  harness: CodingHarness.pipe(Schema.withDecodingDefault(() => DEFAULT_CODING_HARNESS)),
  claudeCodeBackend: Schema.optional(ClaudeCodeBackend),
  piRenderMode: Schema.optional(PiRenderMode),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const ThreadDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.delete"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadSettleCommand = Schema.Struct({
  type: Schema.Literal("thread.settle"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUnsettleCommand = Schema.Struct({
  type: Schema.Literal("thread.unsettle"),
  commandId: CommandId,
  threadId: ThreadId,
  reason: Schema.Literal("user"),
});

const ThreadSnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.snooze"),
  commandId: CommandId,
  threadId: ThreadId,
  snoozedUntil: IsoDateTime,
});

const ThreadUnsnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.unsnooze"),
  commandId: CommandId,
  threadId: ThreadId,
  reason: Schema.Literal("user"),
});

const ThreadMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.meta.update"),
  commandId: CommandId,
  threadId: ThreadId,
  surface: Schema.optional(ThreadSurface),
  title: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  harness: Schema.optional(CodingHarness),
  claudeCodeBackend: Schema.optional(ClaudeCodeBackend),
  piRenderMode: Schema.optional(PiRenderMode),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  titleSource: Schema.optional(TitleSource),
  bookmarked: Schema.optional(Schema.Boolean),
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});

const ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

const ThreadInteractionModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.interaction-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

const ThreadJourneyUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.journey.update"),
  commandId: CommandId,
  threadId: ThreadId,
  journey: JourneySnapshot,
  createdAt: IsoDateTime,
});

const ThreadJourneyMutateCommand = Schema.Struct({
  type: Schema.Literal("thread.journey.mutate"),
  commandId: CommandId,
  threadId: ThreadId,
  mutation: JourneyMutation,
  createdAt: IsoDateTime,
});

export const JourneyDecisionSubmitCommand = Schema.Struct({
  type: Schema.Literal("journey.decision.submit"),
  commandId: CommandId,
  submission: JourneyDecisionSubmission,
});
export type JourneyDecisionSubmitCommand = typeof JourneyDecisionSubmitCommand.Type;

export const JourneyApprovalSubmitCommand = Schema.Struct({
  type: Schema.Literal("journey.approval.submit"),
  commandId: CommandId,
  submission: JourneyApprovalSubmission,
});
export type JourneyApprovalSubmitCommand = typeof JourneyApprovalSubmitCommand.Type;

export const JourneyRootStartCommand = Schema.Struct({
  type: Schema.Literal("journey.root.start"),
  commandId: CommandId,
  threadId: ThreadId,
  destination: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  harness: Schema.Literals(["pi", "codexCli"]),
  createdAt: IsoDateTime,
});
export type JourneyRootStartCommand = typeof JourneyRootStartCommand.Type;

export const JourneySchedulerConfigureCommand = Schema.Struct({
  type: Schema.Literal("journey.scheduler.configure"),
  commandId: CommandId,
  threadId: ThreadId,
  perJourneyResearchLimit: Schema.optional(PositiveInt),
  globalResearchLimit: Schema.optional(PositiveInt),
  createdAt: IsoDateTime,
});
export type JourneySchedulerConfigureCommand = typeof JourneySchedulerConfigureCommand.Type;

export const JourneySteeringEnqueueCommand = Schema.Struct({
  type: Schema.Literal("journey.steering.enqueue"),
  commandId: CommandId,
  threadId: ThreadId,
  runId: JourneyRunId,
  nodeId: TrimmedNonEmptyString,
  itemId: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type JourneySteeringEnqueueCommand = typeof JourneySteeringEnqueueCommand.Type;

export const JourneySteeringRemoveCommand = Schema.Struct({
  type: Schema.Literal("journey.steering.remove"),
  commandId: CommandId,
  threadId: ThreadId,
  runId: JourneyRunId,
  itemId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type JourneySteeringRemoveCommand = typeof JourneySteeringRemoveCommand.Type;

export const JourneyNodeDeleteCommand = Schema.Struct({
  type: Schema.Literal("journey.node.delete"),
  commandId: CommandId,
  threadId: ThreadId,
  nodeId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type JourneyNodeDeleteCommand = typeof JourneyNodeDeleteCommand.Type;

export const ThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
  }),
  provider: Schema.optional(ProviderKind),
  model: Schema.optional(TrimmedNonEmptyString),
  modelOptions: Schema.optional(ProviderModelOptions),
  providerOptions: Schema.optional(ProviderStartOptions),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  createdAt: IsoDateTime,
});

const ClientThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(UploadChatAttachment),
  }),
  provider: Schema.optional(ProviderKind),
  model: Schema.optional(TrimmedNonEmptyString),
  modelOptions: Schema.optional(ProviderModelOptions),
  providerOptions: Schema.optional(ProviderStartOptions),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

const ThreadTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadApprovalRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

const ThreadCheckpointRevertCommand = Schema.Struct({
  type: Schema.Literal("thread.checkpoint.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const DispatchableClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadJourneyUpdateCommand,
  JourneyRootStartCommand,
  JourneyDecisionSubmitCommand,
  JourneyApprovalSubmitCommand,
  JourneySchedulerConfigureCommand,
  JourneySteeringEnqueueCommand,
  JourneySteeringRemoveCommand,
  JourneyNodeDeleteCommand,
  ThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
]);
type WithOptionalThreadCreateSurface<T> = T extends { readonly type: "thread.create" }
  ? Omit<T, "surface"> & { readonly surface?: ThreadSurface }
  : T;
export type DispatchableClientOrchestrationCommand = WithOptionalThreadCreateSurface<
  typeof DispatchableClientOrchestrationCommand.Type
>;

export const ClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadJourneyUpdateCommand,
  JourneyRootStartCommand,
  JourneyDecisionSubmitCommand,
  JourneyApprovalSubmitCommand,
  JourneySchedulerConfigureCommand,
  JourneySteeringEnqueueCommand,
  JourneySteeringRemoveCommand,
  JourneyNodeDeleteCommand,
  ClientThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
]);
export type ClientOrchestrationCommand = WithOptionalThreadCreateSurface<
  typeof ClientOrchestrationCommand.Type
>;

const ThreadSessionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.session.set"),
  commandId: CommandId,
  threadId: ThreadId,
  session: OrchestrationSession,
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantDeltaCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.delta"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadProposedPlanUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.proposed-plan.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
  createdAt: IsoDateTime,
});

const ThreadTurnDiffCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.diff.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: IsoDateTime,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.optional(MessageId),
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadActivityAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.activity.append"),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
});

const ThreadRevertCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.revert.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadTerminalStatusChangedCommand = Schema.Struct({
  type: Schema.Literal("thread.terminal.statusChanged"),
  commandId: CommandId,
  threadId: ThreadId,
  terminalStatus: TerminalStatus,
  claudeSessionId: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(() => null)),
  piSessionFile: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(() => null)),
  updatedAt: IsoDateTime,
});

const ThreadTurnUsageUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.usage.update"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  inputTokens: Schema.NullOr(Schema.Int),
  outputTokens: Schema.NullOr(Schema.Int),
  cacheReadTokens: Schema.NullOr(Schema.Int),
  cacheWriteTokens: Schema.NullOr(Schema.Int),
  totalCostUsd: Schema.NullOr(Schema.Number),
  model: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});

const JourneyRunIdentity = {
  threadId: ThreadId,
  runId: JourneyRunId,
  nodeId: TrimmedNonEmptyString,
} as const;

export const JourneyRunRequestCommand = Schema.Struct({
  type: Schema.Literal("journey.run.request"),
  commandId: CommandId,
  ...JourneyRunIdentity,
  role: JourneyRunRole,
  harness: Schema.Literals(["pi", "codexCli"]),
  capabilities: Schema.Array(JourneyCapability),
  parentRunId: Schema.NullOr(JourneyRunId),
  coordinatorRunId: Schema.NullOr(JourneyRunId),
  prompt: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
}).check(JourneyRoleCapabilityCheck);
export type JourneyRunRequestCommand = typeof JourneyRunRequestCommand.Type;

export const JourneyChildStartCommand = Schema.Struct({
  type: Schema.Literal("journey.child.start"),
  commandId: CommandId,
  parentFence: JourneyAttemptFence,
  childKind: Schema.Literals(["research", "implementation"]),
  runId: JourneyRunId,
  nodeId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  instructions: TrimmedNonEmptyString,
  harness: Schema.Literals(["pi", "codexCli"]),
  canonicalWorkspaceIdentity: Schema.optional(TrimmedNonEmptyString),
  proposalRevisionHash: Schema.optional(JourneyProposalRevisionHash),
  createdAt: IsoDateTime,
});
export type JourneyChildStartCommand = typeof JourneyChildStartCommand.Type;

export const JourneyAttemptStartRequestCommand = Schema.Struct({
  type: Schema.Literal("journey.attempt.start.request"),
  commandId: CommandId,
  fence: JourneyAttemptFence,
  capabilities: Schema.Array(JourneyCapability),
  canonicalWorkspaceId: Schema.optional(TrimmedNonEmptyString),
  proposalRevisionHash: Schema.optional(JourneyProposalRevisionHash),
  createdAt: IsoDateTime,
});
export type JourneyAttemptStartRequestCommand = typeof JourneyAttemptStartRequestCommand.Type;

const JourneyFencedCallbackFields = {
  commandId: CommandId,
  fence: JourneyAttemptFence,
  adapterEventId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
} as const;

export const JourneyAttemptStartedCommand = Schema.Struct({
  type: Schema.Literal("journey.attempt.started"),
  ...JourneyFencedCallbackFields,
  resumableHarnessIdentity: Schema.NullOr(TrimmedNonEmptyString),
});
export type JourneyAttemptStartedCommand = typeof JourneyAttemptStartedCommand.Type;

export const JourneyAttemptQuiesceRequestCommand = Schema.Struct({
  type: Schema.Literal("journey.attempt.quiesce.request"),
  ...JourneyFencedCallbackFields,
  outcome: JourneyCoordinatorOutcome,
});
export type JourneyAttemptQuiesceRequestCommand = typeof JourneyAttemptQuiesceRequestCommand.Type;

export const JourneyAttemptQuiescedCommand = Schema.Struct({
  type: Schema.Literal("journey.attempt.quiesced"),
  ...JourneyFencedCallbackFields,
  outcome: JourneyCoordinatorOutcome,
});
export type JourneyAttemptQuiescedCommand = typeof JourneyAttemptQuiescedCommand.Type;

export const JourneyWaitEvaluateCommand = Schema.Struct({
  type: Schema.Literal("journey.wait.evaluate"),
  commandId: CommandId,
  ...JourneyRunIdentity,
  waitGeneration: PositiveInt,
  triggerEventSequence: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type JourneyWaitEvaluateCommand = typeof JourneyWaitEvaluateCommand.Type;

export const JourneyWaitWakeCommand = Schema.Struct({
  type: Schema.Literal("journey.wait.wake"),
  commandId: CommandId,
  ...JourneyRunIdentity,
  waitGeneration: PositiveInt,
  triggerEventSequence: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type JourneyWaitWakeCommand = typeof JourneyWaitWakeCommand.Type;

export const JourneyAttemptResultSubmitCommand = Schema.Struct({
  type: Schema.Literal("journey.attempt.result.submit"),
  ...JourneyFencedCallbackFields,
  resultSequence: PositiveInt,
  result: JourneyStructuredResult,
});
export type JourneyAttemptResultSubmitCommand = typeof JourneyAttemptResultSubmitCommand.Type;

export const JourneyAttemptFailCommand = Schema.Struct({
  type: Schema.Literal("journey.attempt.fail"),
  ...JourneyFencedCallbackFields,
  failureKind: Schema.Literals([
    "launchRejected",
    "spawnFailed",
    "startAckTimeout",
    "processExited",
    "invalidOutcome",
    "invalidResult",
    "outputOverflow",
    "quiesceTimeout",
    "adapterError",
  ]),
  reason: TrimmedNonEmptyString,
});
export type JourneyAttemptFailCommand = typeof JourneyAttemptFailCommand.Type;

export const JourneyRunCancelCommand = Schema.Struct({
  type: Schema.Literal("journey.run.cancel"),
  commandId: CommandId,
  ...JourneyRunIdentity,
  reason: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type JourneyRunCancelCommand = typeof JourneyRunCancelCommand.Type;

export const JourneyRunCancelledCommand = Schema.Struct({
  type: Schema.Literal("journey.run.cancelled"),
  ...JourneyFencedCallbackFields,
});
export type JourneyRunCancelledCommand = typeof JourneyRunCancelledCommand.Type;

export const JourneyRunInterruptCommand = Schema.Struct({
  type: Schema.Literal("journey.run.interrupt"),
  ...JourneyFencedCallbackFields,
  reason: TrimmedNonEmptyString,
  orphanProcessPossible: Schema.Boolean,
});
export type JourneyRunInterruptCommand = typeof JourneyRunInterruptCommand.Type;

export const JourneyPermitCommand = Schema.Struct({
  type: Schema.Literals(["journey.permit.claim", "journey.permit.release"]),
  commandId: CommandId,
  fence: JourneyAttemptFence,
  permitId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type JourneyPermitCommand = typeof JourneyPermitCommand.Type;

export const JourneyWriterLeaseCommand = Schema.Struct({
  type: Schema.Literals(["journey.writer-lease.claim", "journey.writer-lease.release"]),
  commandId: CommandId,
  fence: JourneyAttemptFence,
  leaseId: TrimmedNonEmptyString,
  canonicalWorkspaceId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type JourneyWriterLeaseCommand = typeof JourneyWriterLeaseCommand.Type;

export const JourneyApprovalInvalidateCommand = Schema.Struct({
  type: Schema.Literal("journey.approval.invalidate"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionId: TrimmedNonEmptyString,
  proposalNodeId: TrimmedNonEmptyString,
  previousRevisionHash: JourneyProposalRevisionHash,
  nextRevisionHash: JourneyProposalRevisionHash,
  reason: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type JourneyApprovalInvalidateCommand = typeof JourneyApprovalInvalidateCommand.Type;

export const JourneyReconciliationObservation = Schema.Literals([
  "reattached",
  "processAbsent",
  "processExited",
  "orphanTerminated",
  "workspaceClean",
  "workspaceDirty",
]);
export type JourneyReconciliationObservation = typeof JourneyReconciliationObservation.Type;

export const JourneyReconcileObserveCommand = Schema.Struct({
  type: Schema.Literal("journey.reconcile.observe"),
  ...JourneyFencedCallbackFields,
  observation: JourneyReconciliationObservation,
  detail: Schema.String,
});
export type JourneyReconcileObserveCommand = typeof JourneyReconcileObserveCommand.Type;

export const JourneySteeringAcknowledgeCommand = Schema.Struct({
  type: Schema.Literal("journey.steering.acknowledge"),
  commandId: CommandId,
  threadId: ThreadId,
  runId: JourneyRunId,
  itemId: TrimmedNonEmptyString,
  sequence: PositiveInt,
  createdAt: IsoDateTime,
});
export type JourneySteeringAcknowledgeCommand = typeof JourneySteeringAcknowledgeCommand.Type;

const InternalOrchestrationCommand = Schema.Union([
  ThreadSessionSetCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadActivityAppendCommand,
  ThreadRevertCompleteCommand,
  ThreadTurnUsageUpdateCommand,
  ThreadTerminalStatusChangedCommand,
  ThreadJourneyMutateCommand,
  JourneyChildStartCommand,
  JourneyRunRequestCommand,
  JourneyAttemptStartRequestCommand,
  JourneyAttemptStartedCommand,
  JourneyAttemptQuiesceRequestCommand,
  JourneyAttemptQuiescedCommand,
  JourneyWaitEvaluateCommand,
  JourneyWaitWakeCommand,
  JourneyAttemptResultSubmitCommand,
  JourneyAttemptFailCommand,
  JourneyRunCancelCommand,
  JourneyRunCancelledCommand,
  JourneyRunInterruptCommand,
  JourneyPermitCommand,
  JourneyWriterLeaseCommand,
  JourneyApprovalInvalidateCommand,
  JourneyReconcileObserveCommand,
  JourneySteeringAcknowledgeCommand,
]);
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type;

export const OrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommand,
  InternalOrchestrationCommand,
]);
export type OrchestrationCommand = WithOptionalThreadCreateSurface<
  typeof OrchestrationCommand.Type
>;

export const OrchestrationEventType = Schema.Literals([
  "project.created",
  "project.meta-updated",
  "project.deleted",
  "thread.created",
  "thread.deleted",
  "thread.settled",
  "thread.unsettled",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.meta-updated",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.journey-updated",
  "thread.message-sent",
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.checkpoint-revert-requested",
  "thread.reverted",
  "thread.session-stop-requested",
  "thread.session-set",
  "thread.proposed-plan-upserted",
  "thread.turn-diff-completed",
  "thread.activity-appended",
  "thread.turn-usage-updated",
  "thread.terminal-status-changed",
  "journey.run-requested",
  "journey.attempt-start-requested",
  "journey.attempt-started",
  "journey.attempt-quiesce-requested",
  "journey.attempt-quiesced",
  "journey.run-waiting-for-dependencies",
  "journey.run-waiting-for-user",
  "journey.wait-wake-accepted",
  "journey.attempt-result-accepted",
  "journey.run-completed",
  "journey.attempt-failed",
  "journey.run-failed",
  "journey.run-cancellation-requested",
  "journey.run-cancelled",
  "journey.run-interrupted",
  "journey.decision-recorded",
  "journey.approval-recorded",
  "journey.approval-invalidated",
  "journey.permit-claimed",
  "journey.permit-released",
  "journey.writer-lease-claimed",
  "journey.writer-lease-released",
  "journey.reconciled",
  "journey.scheduler-configured",
  "journey.scheduler-admission-recorded",
  "journey.steering-enqueued",
  "journey.steering-delivered",
  "journey.steering-removed",
  "journey.node-deletion-requested",
  "journey.thread-deletion-requested",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

export const OrchestrationAggregateKind = Schema.Literals(["project", "thread"]);
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type;
export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);

export const ProjectCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModel: Schema.NullOr(TrimmedNonEmptyString),
  scripts: Schema.Array(ProjectScript),
  prompts: Schema.Array(ProjectPrompt).pipe(Schema.withDecodingDefault(() => [])),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ProjectMetaUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModel: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  prompts: Schema.optional(Schema.Array(ProjectPrompt)),
  hiddenAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  updatedAt: IsoDateTime,
});

export const ProjectDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  deletedAt: IsoDateTime,
});

export const ThreadCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  surface: ThreadSurface.pipe(Schema.withDecodingDefault(() => DEFAULT_THREAD_SURFACE)),
  harness: CodingHarness.pipe(Schema.withDecodingDefault(() => DEFAULT_CODING_HARNESS)),
  claudeCodeBackend: Schema.optional(ClaudeCodeBackend),
  piRenderMode: Schema.optional(PiRenderMode),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  deletedAt: IsoDateTime,
});

export const ThreadSettledPayload = Schema.Struct({
  threadId: ThreadId,
  settledAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnsettledPayload = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.Literals(["user", "activity"]),
  updatedAt: IsoDateTime,
});

export const ThreadSnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  snoozedUntil: IsoDateTime,
  snoozedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnsnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.Literals(["user", "activity"]),
  updatedAt: IsoDateTime,
});

export const ThreadMetaUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  surface: Schema.optional(ThreadSurface),
  title: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  harness: Schema.optional(CodingHarness),
  claudeCodeBackend: Schema.optional(ClaudeCodeBackend),
  piRenderMode: Schema.optional(PiRenderMode),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  titleSource: Schema.optional(TitleSource),
  bookmarked: Schema.optional(Schema.Boolean),
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  updatedAt: IsoDateTime,
});

export const ThreadRuntimeModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  updatedAt: IsoDateTime,
});

export const ThreadInteractionModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  updatedAt: IsoDateTime,
});

export const ThreadJourneyUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  journey: JourneySnapshot,
  updatedAt: IsoDateTime,
});
export type ThreadJourneyUpdatedPayload = typeof ThreadJourneyUpdatedPayload.Type;

export const ThreadMessageSentPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadTurnStartRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  provider: Schema.optional(ProviderKind),
  model: Schema.optional(TrimmedNonEmptyString),
  modelOptions: Schema.optional(ProviderModelOptions),
  providerOptions: Schema.optional(ProviderStartOptions),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  createdAt: IsoDateTime,
});

export const ThreadTurnInterruptRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

export const ThreadApprovalResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

export const ThreadCheckpointRevertRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadRevertedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
});

export const ThreadSessionStopRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const ThreadSessionSetPayload = Schema.Struct({
  threadId: ThreadId,
  session: OrchestrationSession,
});

export const ThreadProposedPlanUpsertedPayload = Schema.Struct({
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
});

export const ThreadTurnDiffCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});

export const ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
});

export const ThreadTerminalStatusChangedPayload = Schema.Struct({
  threadId: ThreadId,
  terminalStatus: TerminalStatus,
  claudeSessionId: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(() => null)),
  piSessionFile: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(() => null)),
  updatedAt: IsoDateTime,
});
export type ThreadTerminalStatusChangedPayload = typeof ThreadTerminalStatusChangedPayload.Type;

export const ThreadTurnUsageUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  inputTokens: Schema.NullOr(Schema.Int),
  outputTokens: Schema.NullOr(Schema.Int),
  cacheReadTokens: Schema.NullOr(Schema.Int),
  cacheWriteTokens: Schema.NullOr(Schema.Int),
  totalCostUsd: Schema.NullOr(Schema.Number),
  model: Schema.NullOr(Schema.String),
});
export type ThreadTurnUsageUpdatedPayload = typeof ThreadTurnUsageUpdatedPayload.Type;

export const JourneyRunRequestedPayload = Schema.Struct({
  run: JourneyLogicalRun,
  prompt: TrimmedNonEmptyString,
});
export type JourneyRunRequestedPayload = typeof JourneyRunRequestedPayload.Type;

export const JourneyAttemptStartRequestedPayload = Schema.Struct({
  fence: JourneyAttemptFence,
  capabilities: Schema.Array(JourneyCapability),
  canonicalWorkspaceId: Schema.optional(TrimmedNonEmptyString),
});
export type JourneyAttemptStartRequestedPayload = typeof JourneyAttemptStartRequestedPayload.Type;

export const JourneyAttemptStartedPayload = Schema.Struct({
  fence: JourneyAttemptFence,
  resumableHarnessIdentity: Schema.NullOr(TrimmedNonEmptyString),
});
export type JourneyAttemptStartedPayload = typeof JourneyAttemptStartedPayload.Type;

export const JourneyAttemptQuiesceRequestedPayload = Schema.Struct({
  fence: JourneyAttemptFence,
  outcome: JourneyCoordinatorOutcome,
  waitGeneration: Schema.optional(PositiveInt),
});
export type JourneyAttemptQuiesceRequestedPayload =
  typeof JourneyAttemptQuiesceRequestedPayload.Type;

export const JourneyAttemptQuiescedPayload = Schema.Struct({
  fence: JourneyAttemptFence,
  outcome: JourneyCoordinatorOutcome,
});
export type JourneyAttemptQuiescedPayload = typeof JourneyAttemptQuiescedPayload.Type;

export const JourneyRunWaitingPayload = Schema.Struct({
  fence: JourneyAttemptFence,
  status: Schema.Literals(["waitingForDependencies", "waitingForUser"]),
  waitGeneration: PositiveInt,
  acceptedWakeGeneration: Schema.NullOr(PositiveInt),
});
export type JourneyRunWaitingPayload = typeof JourneyRunWaitingPayload.Type;

export const JourneyWaitWakeAcceptedPayload = Schema.Struct({
  fence: JourneyAttemptFence,
  waitGeneration: PositiveInt,
  acceptedWakeGeneration: PositiveInt,
  triggerEventSequence: NonNegativeInt,
});
export type JourneyWaitWakeAcceptedPayload = typeof JourneyWaitWakeAcceptedPayload.Type;

export const JourneyAttemptResultAcceptedPayload = Schema.Struct({
  fence: JourneyAttemptFence,
  resultSequence: PositiveInt,
  result: JourneyStructuredResult,
});
export type JourneyAttemptResultAcceptedPayload = typeof JourneyAttemptResultAcceptedPayload.Type;

export const JourneyRunCompletedPayload = Schema.Struct({
  fence: JourneyAttemptFence,
  status: Schema.Literal("completed"),
  reason: Schema.NullOr(TrimmedNonEmptyString),
});
export type JourneyRunCompletedPayload = typeof JourneyRunCompletedPayload.Type;
export const JourneyRunFailedPayload = Schema.Struct({
  fence: JourneyAttemptFence,
  status: Schema.Literal("failed"),
  reason: TrimmedNonEmptyString,
});
export type JourneyRunFailedPayload = typeof JourneyRunFailedPayload.Type;
export const JourneyRunCancelledPayload = Schema.Struct({
  fence: JourneyAttemptFence,
  status: Schema.Literal("cancelled"),
  reason: Schema.NullOr(TrimmedNonEmptyString),
});
export type JourneyRunCancelledPayload = typeof JourneyRunCancelledPayload.Type;

export const JourneyAttemptFailedPayload = Schema.Struct({
  fence: JourneyAttemptFence,
  status: Schema.Literal("failed"),
  failureKind: TrimmedNonEmptyString,
  reason: TrimmedNonEmptyString,
});
export type JourneyAttemptFailedPayload = typeof JourneyAttemptFailedPayload.Type;

export const JourneyRunCancellationRequestedPayload = Schema.Struct({
  ...JourneyRunIdentity,
  reason: TrimmedNonEmptyString,
});
export type JourneyRunCancellationRequestedPayload =
  typeof JourneyRunCancellationRequestedPayload.Type;

export const JourneyRunInterruptedPayload = Schema.Struct({
  fence: JourneyAttemptFence,
  reason: TrimmedNonEmptyString,
  orphanProcessPossible: Schema.Boolean,
});
export type JourneyRunInterruptedPayload = typeof JourneyRunInterruptedPayload.Type;

export const JourneyDecisionRecordedPayload = JourneyDecisionSubmission;
export type JourneyDecisionRecordedPayload = typeof JourneyDecisionRecordedPayload.Type;

export const JourneyApprovalRecordedPayload = JourneyRevisionBoundApproval.mapFields(
  Struct.assign({ threadId: ThreadId }),
);
export type JourneyApprovalRecordedPayload = typeof JourneyApprovalRecordedPayload.Type;

export const JourneyApprovalInvalidatedPayload = Schema.Struct({
  threadId: ThreadId,
  interactionId: TrimmedNonEmptyString,
  proposalNodeId: TrimmedNonEmptyString,
  previousRevisionHash: JourneyProposalRevisionHash,
  nextRevisionHash: JourneyProposalRevisionHash,
  reason: TrimmedNonEmptyString,
});
export type JourneyApprovalInvalidatedPayload = typeof JourneyApprovalInvalidatedPayload.Type;

export const JourneyPermitPayload = Schema.Struct({
  fence: JourneyAttemptFence,
  permitId: TrimmedNonEmptyString,
});
export type JourneyPermitPayload = typeof JourneyPermitPayload.Type;

export const JourneyWriterLeasePayload = Schema.Struct({
  fence: JourneyAttemptFence,
  leaseId: TrimmedNonEmptyString,
  canonicalWorkspaceId: TrimmedNonEmptyString,
});
export type JourneyWriterLeasePayload = typeof JourneyWriterLeasePayload.Type;

export const JourneyReconciledPayload = Schema.Struct({
  fence: JourneyAttemptFence,
  observation: JourneyReconciliationObservation,
  detail: Schema.String,
});
export type JourneyReconciledPayload = typeof JourneyReconciledPayload.Type;

export const JourneySchedulerConfiguredPayload = Schema.Struct({
  threadId: ThreadId,
  perJourneyResearchLimit: PositiveInt,
  globalResearchLimit: PositiveInt,
});
export type JourneySchedulerConfiguredPayload = typeof JourneySchedulerConfiguredPayload.Type;

export const JourneySchedulerAdmissionRecordedPayload = Schema.Struct({
  fence: JourneyAttemptFence,
  nextJourneyCursor: ThreadId,
});
export type JourneySchedulerAdmissionRecordedPayload =
  typeof JourneySchedulerAdmissionRecordedPayload.Type;

export const JourneySteeringEnqueuedPayload = JourneySteeringItem;
export type JourneySteeringEnqueuedPayload = typeof JourneySteeringEnqueuedPayload.Type;
export const JourneySteeringRemovedPayload = Schema.Struct({
  threadId: ThreadId,
  runId: JourneyRunId,
  itemId: TrimmedNonEmptyString,
  sequence: PositiveInt,
  removedAt: IsoDateTime,
});
export type JourneySteeringRemovedPayload = typeof JourneySteeringRemovedPayload.Type;
export const JourneyNodeDeletionRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  nodeId: TrimmedNonEmptyString,
  requestedAt: IsoDateTime,
});
export const JourneyThreadDeletionRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestedAt: IsoDateTime,
});

export const JourneySteeringDeliveredPayload = Schema.Struct({
  threadId: ThreadId,
  runId: JourneyRunId,
  itemId: TrimmedNonEmptyString,
  sequence: PositiveInt,
  deliveredAt: IsoDateTime,
});
export type JourneySteeringDeliveredPayload = typeof JourneySteeringDeliveredPayload.Type;

export const OrchestrationEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
});
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

const EventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const;

export const OrchestrationEvent = Schema.Union([
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.created"),
    payload: ProjectCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.meta-updated"),
    payload: ProjectMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.deleted"),
    payload: ProjectDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: ThreadCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.deleted"),
    payload: ThreadDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.settled"),
    payload: ThreadSettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsettled"),
    payload: ThreadUnsettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.snoozed"),
    payload: ThreadSnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsnoozed"),
    payload: ThreadUnsnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.meta-updated"),
    payload: ThreadMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-mode-set"),
    payload: ThreadRuntimeModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.interaction-mode-set"),
    payload: ThreadInteractionModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.journey-updated"),
    payload: ThreadJourneyUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-sent"),
    payload: ThreadMessageSentPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-start-requested"),
    payload: ThreadTurnStartRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-interrupt-requested"),
    payload: ThreadTurnInterruptRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.approval-response-requested"),
    payload: ThreadApprovalResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.user-input-response-requested"),
    payload: ThreadUserInputResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.checkpoint-revert-requested"),
    payload: ThreadCheckpointRevertRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.reverted"),
    payload: ThreadRevertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-stop-requested"),
    payload: ThreadSessionStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-set"),
    payload: ThreadSessionSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.proposed-plan-upserted"),
    payload: ThreadProposedPlanUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-diff-completed"),
    payload: ThreadTurnDiffCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.activity-appended"),
    payload: ThreadActivityAppendedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-usage-updated"),
    payload: ThreadTurnUsageUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.terminal-status-changed"),
    payload: ThreadTerminalStatusChangedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.run-requested"),
    payload: JourneyRunRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.attempt-start-requested"),
    payload: JourneyAttemptStartRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.attempt-started"),
    payload: JourneyAttemptStartedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.attempt-quiesce-requested"),
    payload: JourneyAttemptQuiesceRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.attempt-quiesced"),
    payload: JourneyAttemptQuiescedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.run-waiting-for-dependencies"),
    payload: JourneyRunWaitingPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.run-waiting-for-user"),
    payload: JourneyRunWaitingPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.wait-wake-accepted"),
    payload: JourneyWaitWakeAcceptedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.attempt-result-accepted"),
    payload: JourneyAttemptResultAcceptedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.run-completed"),
    payload: JourneyRunCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.attempt-failed"),
    payload: JourneyAttemptFailedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.run-failed"),
    payload: JourneyRunFailedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.run-cancellation-requested"),
    payload: JourneyRunCancellationRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.run-cancelled"),
    payload: JourneyRunCancelledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.run-interrupted"),
    payload: JourneyRunInterruptedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.decision-recorded"),
    payload: JourneyDecisionRecordedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.approval-recorded"),
    payload: JourneyApprovalRecordedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.approval-invalidated"),
    payload: JourneyApprovalInvalidatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.permit-claimed"),
    payload: JourneyPermitPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.permit-released"),
    payload: JourneyPermitPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.writer-lease-claimed"),
    payload: JourneyWriterLeasePayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.writer-lease-released"),
    payload: JourneyWriterLeasePayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.reconciled"),
    payload: JourneyReconciledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.scheduler-configured"),
    payload: JourneySchedulerConfiguredPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.scheduler-admission-recorded"),
    payload: JourneySchedulerAdmissionRecordedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.steering-enqueued"),
    payload: JourneySteeringEnqueuedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.steering-delivered"),
    payload: JourneySteeringDeliveredPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.steering-removed"),
    payload: JourneySteeringRemovedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.node-deletion-requested"),
    payload: JourneyNodeDeletionRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("journey.thread-deletion-requested"),
    payload: JourneyThreadDeletionRequestedPayload,
  }),
]);
type WithOptionalThreadCreatedSurface<T> = T extends {
  readonly type: "thread.created";
  readonly payload: infer Payload extends { readonly surface: ThreadSurface };
}
  ? Omit<T, "payload"> & {
      readonly payload: Omit<Payload, "surface"> & { readonly surface?: ThreadSurface };
    }
  : T;
export type OrchestrationEvent = WithOptionalThreadCreatedSurface<typeof OrchestrationEvent.Type>;

export const OrchestrationCommandReceiptStatus = Schema.Literals(["accepted", "rejected"]);
export type OrchestrationCommandReceiptStatus = typeof OrchestrationCommandReceiptStatus.Type;

export const TurnCountRange = Schema.Struct({
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (input) =>
      input.fromTurnCount <= input.toTurnCount ||
      new SchemaIssue.InvalidValue(Option.some(input.fromTurnCount), {
        message: "fromTurnCount must be less than or equal to toTurnCount",
      }),
    { identifier: "OrchestrationTurnDiffRange" },
  ),
);

export const ThreadTurnDiff = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    diff: Schema.String,
  }),
  { unsafePreserveChecks: true },
);

const UserInputQuestionOption = Schema.Struct({
  label: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
});
export type UserInputQuestionOption = typeof UserInputQuestionOption.Type;

export const UserInputQuestion = Schema.Struct({
  id: TrimmedNonEmptyString,
  header: TrimmedNonEmptyString,
  question: TrimmedNonEmptyString,
  options: Schema.Array(UserInputQuestionOption),
});
export type UserInputQuestion = typeof UserInputQuestion.Type;

const ProjectionThreadTurnStatus = Schema.Literals([
  "running",
  "completed",
  "interrupted",
  "error",
]);
export type ProjectionThreadTurnStatus = typeof ProjectionThreadTurnStatus.Type;

const ProjectionCheckpointRow = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionCheckpointRow = typeof ProjectionCheckpointRow.Type;

export const ProjectionPendingApprovalStatus = Schema.Literals(["pending", "resolved"]);
export type ProjectionPendingApprovalStatus = typeof ProjectionPendingApprovalStatus.Type;

export const ProjectionPendingApprovalDecision = Schema.NullOr(ProviderApprovalDecision);
export type ProjectionPendingApprovalDecision = typeof ProjectionPendingApprovalDecision.Type;

export const DispatchResult = Schema.Struct({
  sequence: NonNegativeInt,
});
export type DispatchResult = typeof DispatchResult.Type;

export const OrchestrationGetSnapshotInput = Schema.Struct({});
export type OrchestrationGetSnapshotInput = typeof OrchestrationGetSnapshotInput.Type;
const OrchestrationGetSnapshotResult = OrchestrationReadModel;
export type OrchestrationGetSnapshotResult = typeof OrchestrationGetSnapshotResult.Type;

export const OrchestrationGetTurnDiffInput = TurnCountRange.mapFields(
  Struct.assign({ threadId: ThreadId }),
  { unsafePreserveChecks: true },
);
export type OrchestrationGetTurnDiffInput = typeof OrchestrationGetTurnDiffInput.Type;

export const OrchestrationGetTurnDiffResult = ThreadTurnDiff;
export type OrchestrationGetTurnDiffResult = typeof OrchestrationGetTurnDiffResult.Type;

export const OrchestrationGetFullThreadDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
});
export type OrchestrationGetFullThreadDiffInput = typeof OrchestrationGetFullThreadDiffInput.Type;

export const OrchestrationGetFullThreadDiffResult = ThreadTurnDiff;
export type OrchestrationGetFullThreadDiffResult = typeof OrchestrationGetFullThreadDiffResult.Type;

export const OrchestrationGetWorkingTreeDiffInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationGetWorkingTreeDiffInput = typeof OrchestrationGetWorkingTreeDiffInput.Type;

export const OrchestrationGetWorkingTreeDiffResult = Schema.Struct({
  threadId: ThreadId,
  diff: Schema.String,
});
export type OrchestrationGetWorkingTreeDiffResult =
  typeof OrchestrationGetWorkingTreeDiffResult.Type;

export const OrchestrationDiffReviewScope = Schema.Union([
  Schema.Struct({ type: Schema.Literal("branch") }),
  Schema.Struct({ type: Schema.Literal("workingTree") }),
  Schema.Struct({
    type: Schema.Literal("turn"),
    fromTurnCount: NonNegativeInt,
    toTurnCount: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("fullThread"),
    toTurnCount: NonNegativeInt,
  }),
]);
export type OrchestrationDiffReviewScope = typeof OrchestrationDiffReviewScope.Type;

export const OrchestrationDiffReviewAnchor = Schema.Struct({
  filePath: TrimmedNonEmptyString,
  oldStartLine: NonNegativeInt.pipe(Schema.NullOr),
  oldEndLine: NonNegativeInt.pipe(Schema.NullOr),
  newStartLine: NonNegativeInt.pipe(Schema.NullOr),
  newEndLine: NonNegativeInt.pipe(Schema.NullOr),
  hunkHeader: Schema.String.pipe(Schema.NullOr),
});
export type OrchestrationDiffReviewAnchor = typeof OrchestrationDiffReviewAnchor.Type;

export const OrchestrationDiffReviewSignificance = Schema.Literals(["high", "medium", "low"]);
export type OrchestrationDiffReviewSignificance = typeof OrchestrationDiffReviewSignificance.Type;

export const OrchestrationDiffReviewChange = Schema.Struct({
  id: TrimmedNonEmptyString,
  rank: PositiveInt,
  significance: OrchestrationDiffReviewSignificance,
  filePath: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  summary: Schema.String,
  whyItMatters: Schema.String,
  reviewFocus: Schema.Array(Schema.String),
  risks: Schema.Array(Schema.String),
  anchors: Schema.Array(OrchestrationDiffReviewAnchor),
});
export type OrchestrationDiffReviewChange = typeof OrchestrationDiffReviewChange.Type;

export const OrchestrationGenerateDiffReviewInput = Schema.Struct({
  threadId: ThreadId,
  scope: OrchestrationDiffReviewScope,
});
export type OrchestrationGenerateDiffReviewInput = typeof OrchestrationGenerateDiffReviewInput.Type;

export const OrchestrationGenerateDiffReviewResult = Schema.Struct({
  threadId: ThreadId,
  scope: OrchestrationDiffReviewScope,
  sourceLabel: TrimmedNonEmptyString,
  baseBranch: Schema.String.pipe(Schema.NullOr),
  headBranch: Schema.String.pipe(Schema.NullOr),
  defaultBranchSafety: Schema.Boolean,
  diffStat: Schema.String,
  totalFileCount: NonNegativeInt,
  coveredFileCount: NonNegativeInt,
  summarizedFileCount: NonNegativeInt,
  overview: Schema.String,
  keyChanges: Schema.Array(OrchestrationDiffReviewChange),
  testFocus: Schema.Array(Schema.String),
  followUps: Schema.Array(Schema.String),
  generatedAt: IsoDateTime,
});
export type OrchestrationGenerateDiffReviewResult =
  typeof OrchestrationGenerateDiffReviewResult.Type;

export const OrchestrationAskDiffReviewInput = Schema.Struct({
  threadId: ThreadId,
  filePath: TrimmedNonEmptyString,
  lineNumber: NonNegativeInt.pipe(Schema.NullOr),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  contextPatch: Schema.String.check(Schema.isMaxLength(80_000)),
});
export type OrchestrationAskDiffReviewInput = typeof OrchestrationAskDiffReviewInput.Type;

export const OrchestrationAskDiffReviewResult = Schema.Struct({
  answer: Schema.String,
});
export type OrchestrationAskDiffReviewResult = typeof OrchestrationAskDiffReviewResult.Type;

export const OrchestrationReplayEventsInput = Schema.Struct({
  fromSequenceExclusive: NonNegativeInt,
});
export type OrchestrationReplayEventsInput = typeof OrchestrationReplayEventsInput.Type;

const OrchestrationReplayEventsResult = Schema.Array(OrchestrationEvent);
export type OrchestrationReplayEventsResult = typeof OrchestrationReplayEventsResult.Type;

export const OrchestrationGetSessionMetricsInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationGetSessionMetricsInput = typeof OrchestrationGetSessionMetricsInput.Type;

export const OrchestrationGetSessionMetricsResult = OrchestrationSessionMetrics;
export type OrchestrationGetSessionMetricsResult = typeof OrchestrationGetSessionMetricsResult.Type;

export const OrchestrationGetJourneyProjectionInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationGetJourneyProjectionInput =
  typeof OrchestrationGetJourneyProjectionInput.Type;
export const OrchestrationGetJourneyProjectionResult = JourneyProjectionSnapshot;
export type OrchestrationGetJourneyProjectionResult =
  typeof OrchestrationGetJourneyProjectionResult.Type;

export const OrchestrationGetJourneyDeltasInput = Schema.Struct({
  threadId: ThreadId,
  afterJourneyRevision: NonNegativeInt,
});
export type OrchestrationGetJourneyDeltasInput = typeof OrchestrationGetJourneyDeltasInput.Type;
export const OrchestrationGetJourneyDeltasResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("deltas"),
    deltas: Schema.Array(JourneyProjectionDelta),
  }),
  Schema.Struct({
    kind: Schema.Literal("reset"),
    snapshot: JourneyProjectionSnapshot,
  }),
]);
export type OrchestrationGetJourneyDeltasResult = typeof OrchestrationGetJourneyDeltasResult.Type;

export const OrchestrationGetJourneyRunOutputInput = JourneyOutputReadInput;
export type OrchestrationGetJourneyRunOutputInput =
  typeof OrchestrationGetJourneyRunOutputInput.Type;
export const OrchestrationGetJourneyRunOutputResult = JourneyOutputReadResult;
export type OrchestrationGetJourneyRunOutputResult =
  typeof OrchestrationGetJourneyRunOutputResult.Type;

export const OrchestrationSubscribeJourneyRunOutputInput = JourneyOutputReadInput;
export type OrchestrationSubscribeJourneyRunOutputInput =
  typeof OrchestrationSubscribeJourneyRunOutputInput.Type;
export const OrchestrationSubscribeJourneyRunOutputResult = JourneyOutputReadResult;
export type OrchestrationSubscribeJourneyRunOutputResult =
  typeof OrchestrationSubscribeJourneyRunOutputResult.Type;

export const OrchestrationUnsubscribeJourneyRunOutputInput = Schema.Struct({
  fence: JourneyAttemptFence,
});
export type OrchestrationUnsubscribeJourneyRunOutputInput =
  typeof OrchestrationUnsubscribeJourneyRunOutputInput.Type;
export const OrchestrationUnsubscribeJourneyRunOutputResult = Schema.Void;
export type OrchestrationUnsubscribeJourneyRunOutputResult =
  typeof OrchestrationUnsubscribeJourneyRunOutputResult.Type;

export const OrchestrationJourneyRunOutputPush = Schema.Union([
  JourneyOutputChunk,
  JourneyOutputReadResult,
]);
export type OrchestrationJourneyRunOutputPush = typeof OrchestrationJourneyRunOutputPush.Type;

export const OrchestrationJourneyProjectionPush = JourneyProjectionDelta;
export type OrchestrationJourneyProjectionPush = typeof OrchestrationJourneyProjectionPush.Type;

export const OrchestrationGetSlashCommandsInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationGetSlashCommandsInput = typeof OrchestrationGetSlashCommandsInput.Type;

export const OrchestrationGetCachedSlashCommandsInput = Schema.Struct({
  providerKind: ProviderKind,
});
export type OrchestrationGetCachedSlashCommandsInput =
  typeof OrchestrationGetCachedSlashCommandsInput.Type;

export const OrchestrationRpcSchemas = {
  getSnapshot: {
    input: OrchestrationGetSnapshotInput,
    output: OrchestrationGetSnapshotResult,
  },
  dispatchCommand: {
    input: ClientOrchestrationCommand,
    output: DispatchResult,
  },
  getTurnDiff: {
    input: OrchestrationGetTurnDiffInput,
    output: OrchestrationGetTurnDiffResult,
  },
  getFullThreadDiff: {
    input: OrchestrationGetFullThreadDiffInput,
    output: OrchestrationGetFullThreadDiffResult,
  },
  getWorkingTreeDiff: {
    input: OrchestrationGetWorkingTreeDiffInput,
    output: OrchestrationGetWorkingTreeDiffResult,
  },
  generateDiffReview: {
    input: OrchestrationGenerateDiffReviewInput,
    output: OrchestrationGenerateDiffReviewResult,
  },
  askDiffReview: {
    input: OrchestrationAskDiffReviewInput,
    output: OrchestrationAskDiffReviewResult,
  },
  replayEvents: {
    input: OrchestrationReplayEventsInput,
    output: OrchestrationReplayEventsResult,
  },
  getSessionMetrics: {
    input: OrchestrationGetSessionMetricsInput,
    output: OrchestrationGetSessionMetricsResult,
  },
  getJourneyProjection: {
    input: OrchestrationGetJourneyProjectionInput,
    output: OrchestrationGetJourneyProjectionResult,
  },
  getJourneyDeltas: {
    input: OrchestrationGetJourneyDeltasInput,
    output: OrchestrationGetJourneyDeltasResult,
  },
  getJourneyRunOutput: {
    input: OrchestrationGetJourneyRunOutputInput,
    output: OrchestrationGetJourneyRunOutputResult,
  },
  subscribeJourneyRunOutput: {
    input: OrchestrationSubscribeJourneyRunOutputInput,
    output: OrchestrationSubscribeJourneyRunOutputResult,
  },
  unsubscribeJourneyRunOutput: {
    input: OrchestrationUnsubscribeJourneyRunOutputInput,
    output: OrchestrationUnsubscribeJourneyRunOutputResult,
  },
} as const;
