import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

const TerminalColsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(20)).check(
  Schema.isLessThanOrEqualTo(400),
);
const TerminalRowsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(5)).check(
  Schema.isLessThanOrEqualTo(200),
);

export const ClaudeStartInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  resumeSessionId: Schema.optional(Schema.String),
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
});
export type ClaudeStartInput = Schema.Codec.Encoded<typeof ClaudeStartInput>;

export const ClaudeHibernateInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
});
export type ClaudeHibernateInput = Schema.Codec.Encoded<typeof ClaudeHibernateInput>;

export const ClaudeGetScrollbackInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
});
export type ClaudeGetScrollbackInput = Schema.Codec.Encoded<typeof ClaudeGetScrollbackInput>;

export const ClaudeWriteInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  data: Schema.String,
});
export type ClaudeWriteInput = Schema.Codec.Encoded<typeof ClaudeWriteInput>;

export const ClaudeResizeInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
});
export type ClaudeResizeInput = Schema.Codec.Encoded<typeof ClaudeResizeInput>;

const ClaudeSessionEventBase = Schema.Struct({
  threadId: Schema.String,
  createdAt: Schema.String,
});

const ClaudeOutputEvent = Schema.Struct({
  ...ClaudeSessionEventBase.fields,
  type: Schema.Literal("output"),
  data: Schema.String,
});

const ClaudeStartedEvent = Schema.Struct({
  ...ClaudeSessionEventBase.fields,
  type: Schema.Literal("started"),
});

const ClaudeHibernatedEvent = Schema.Struct({
  ...ClaudeSessionEventBase.fields,
  type: Schema.Literal("hibernated"),
});

const ClaudeExitedEvent = Schema.Struct({
  ...ClaudeSessionEventBase.fields,
  type: Schema.Literal("exited"),
  exitCode: Schema.NullOr(Schema.Int),
});

const ClaudeSessionIdEvent = Schema.Struct({
  ...ClaudeSessionEventBase.fields,
  type: Schema.Literal("sessionId"),
  claudeSessionId: Schema.String,
});

const ClaudeErrorEvent = Schema.Struct({
  ...ClaudeSessionEventBase.fields,
  type: Schema.Literal("error"),
  message: Schema.String,
});

export const ClaudeSessionEvent = Schema.Union([
  ClaudeOutputEvent,
  ClaudeStartedEvent,
  ClaudeHibernatedEvent,
  ClaudeExitedEvent,
  ClaudeSessionIdEvent,
  ClaudeErrorEvent,
]);
export type ClaudeSessionEvent = typeof ClaudeSessionEvent.Type;
