import { Schema } from "effect";
import { AgentActivityStatus, ClaudeHookStatus } from "./claude-terminal";
import { TrimmedNonEmptyString } from "./baseSchemas";

const TerminalColsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(20)).check(
  Schema.isLessThanOrEqualTo(400),
);
const TerminalRowsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(5)).check(
  Schema.isLessThanOrEqualTo(200),
);

export const PiStartInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
  fresh: Schema.optional(Schema.Boolean),
  resumeSessionFile: Schema.optional(TrimmedNonEmptyString),
  initialPrompt: Schema.optional(Schema.String),
  fastMode: Schema.optional(Schema.Boolean),
  htmlMode: Schema.optional(Schema.Boolean),
});
export type PiStartInput = Schema.Codec.Encoded<typeof PiStartInput>;

export const PiHibernateInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
});
export type PiHibernateInput = Schema.Codec.Encoded<typeof PiHibernateInput>;

export const PiGetScrollbackInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  sinceOffset: Schema.optional(Schema.Number),
});
export type PiGetScrollbackInput = Schema.Codec.Encoded<typeof PiGetScrollbackInput>;

export const PiGetTranscriptInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  sinceOffset: Schema.optional(Schema.Number),
});
export type PiGetTranscriptInput = Schema.Codec.Encoded<typeof PiGetTranscriptInput>;

export const PiTranscriptPart = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("thinking"),
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("toolCall"),
    name: Schema.String,
    input: Schema.Unknown,
    id: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("image"),
    mimeType: Schema.NullOr(Schema.String),
  }),
]);
export type PiTranscriptPart = typeof PiTranscriptPart.Type;

export const PiTranscriptItem = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals([
    "user",
    "assistant",
    "toolResult",
    "bashExecution",
    "custom",
    "summary",
    "system",
  ] as const),
  text: Schema.String,
  parts: Schema.Array(PiTranscriptPart),
  createdAt: Schema.NullOr(Schema.String),
  toolName: Schema.optional(Schema.String),
  toolCallId: Schema.optional(Schema.String),
  isError: Schema.optional(Schema.Boolean),
});
export type PiTranscriptItem = typeof PiTranscriptItem.Type;

export const PiExtensionUiWidget = Schema.Struct({
  key: Schema.String,
  lines: Schema.Array(Schema.String),
  placement: Schema.Literals(["aboveEditor", "belowEditor"] as const),
});
export type PiExtensionUiWidget = typeof PiExtensionUiWidget.Type;

export const PiExtensionUiState = Schema.Struct({
  statuses: Schema.Record(Schema.String, Schema.String),
  widgets: Schema.Array(PiExtensionUiWidget),
});
export type PiExtensionUiState = typeof PiExtensionUiState.Type;

export const PiSessionTokenUsage = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  total: Schema.Number,
});
export type PiSessionTokenUsage = typeof PiSessionTokenUsage.Type;

export const PiSessionContextUsage = Schema.Struct({
  tokens: Schema.NullOr(Schema.Number),
  contextWindow: Schema.Number,
  percent: Schema.NullOr(Schema.Number),
});
export type PiSessionContextUsage = typeof PiSessionContextUsage.Type;

export const PiSessionUsageStats = Schema.Struct({
  tokens: PiSessionTokenUsage,
  cost: Schema.Number,
  contextUsage: Schema.NullOr(PiSessionContextUsage),
  latestCacheHitRate: Schema.optional(Schema.Number),
});
export type PiSessionUsageStats = typeof PiSessionUsageStats.Type;

export const PiGetTranscriptResult = Schema.Struct({
  threadId: Schema.String,
  sessionFile: Schema.NullOr(Schema.String),
  items: Schema.Array(PiTranscriptItem),
  offset: Schema.Number,
  reset: Schema.Boolean,
  pendingExtensionUiRequest: Schema.NullOr(Schema.Unknown),
  extensionUiState: PiExtensionUiState,
  usageStats: Schema.NullOr(PiSessionUsageStats),
});
export type PiGetTranscriptResult = typeof PiGetTranscriptResult.Type;

export const PiPromptInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  message: Schema.String,
  streamingBehavior: Schema.optional(Schema.Literals(["steer", "followUp"] as const)),
});
export type PiPromptInput = Schema.Codec.Encoded<typeof PiPromptInput>;

export const PiAbortInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
});
export type PiAbortInput = Schema.Codec.Encoded<typeof PiAbortInput>;

export const PiExtensionUiResponseInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  id: TrimmedNonEmptyString,
  value: Schema.optional(Schema.String),
  confirmed: Schema.optional(Schema.Boolean),
  cancelled: Schema.optional(Schema.Boolean),
});
export type PiExtensionUiResponseInput = Schema.Codec.Encoded<typeof PiExtensionUiResponseInput>;

export const PiGetCommandsInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
});
export type PiGetCommandsInput = Schema.Codec.Encoded<typeof PiGetCommandsInput>;

export const PiCommandSuggestion = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
});
export type PiCommandSuggestion = typeof PiCommandSuggestion.Type;

export const PiGetCommandsResult = Schema.Struct({
  commands: Schema.Array(PiCommandSuggestion),
});
export type PiGetCommandsResult = typeof PiGetCommandsResult.Type;

export const PiRpcCommandInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  commandType: TrimmedNonEmptyString,
  payload: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type PiRpcCommandInput = Schema.Codec.Encoded<typeof PiRpcCommandInput>;

export const PiRpcCommandResult = Schema.Struct({
  data: Schema.Unknown,
});
export type PiRpcCommandResult = typeof PiRpcCommandResult.Type;

export const PiWriteInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  data: Schema.String,
});
export type PiWriteInput = Schema.Codec.Encoded<typeof PiWriteInput>;

export const PiResizeInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
});
export type PiResizeInput = Schema.Codec.Encoded<typeof PiResizeInput>;

const PiSessionEventBase = Schema.Struct({
  threadId: Schema.String,
  createdAt: Schema.String,
});

const PiOutputEvent = Schema.Struct({
  ...PiSessionEventBase.fields,
  type: Schema.Literal("output"),
  data: Schema.String,
  offset: Schema.Number,
});

const PiStartedEvent = Schema.Struct({
  ...PiSessionEventBase.fields,
  type: Schema.Literal("started"),
});

const PiHibernatedEvent = Schema.Struct({
  ...PiSessionEventBase.fields,
  type: Schema.Literal("hibernated"),
});

const PiExitedEvent = Schema.Struct({
  ...PiSessionEventBase.fields,
  type: Schema.Literal("exited"),
  exitCode: Schema.NullOr(Schema.Int),
});

const PiErrorEvent = Schema.Struct({
  ...PiSessionEventBase.fields,
  type: Schema.Literal("error"),
  message: Schema.String,
});

const PiHookStatusEvent = Schema.Struct({
  ...PiSessionEventBase.fields,
  type: Schema.Literal("hookStatus"),
  hookStatus: Schema.NullOr(ClaudeHookStatus),
});

const PiActivityStatusEvent = Schema.Struct({
  ...PiSessionEventBase.fields,
  type: Schema.Literal("activityStatus"),
  activityStatus: Schema.NullOr(AgentActivityStatus),
});

const PiSessionFileEvent = Schema.Struct({
  ...PiSessionEventBase.fields,
  type: Schema.Literal("sessionFile"),
  sessionFile: Schema.NullOr(Schema.String),
});

const PiRpcEvent = Schema.Struct({
  ...PiSessionEventBase.fields,
  type: Schema.Literal("rpcEvent"),
  event: Schema.Unknown,
});

export const PiSessionEvent = Schema.Union([
  PiOutputEvent,
  PiStartedEvent,
  PiHibernatedEvent,
  PiExitedEvent,
  PiErrorEvent,
  PiHookStatusEvent,
  PiActivityStatusEvent,
  PiSessionFileEvent,
  PiRpcEvent,
]);
export type PiSessionEvent = typeof PiSessionEvent.Type;
