import { Schema } from "effect";
import { ClaudeHookStatus } from "./claude-terminal";
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

const PiSessionFileEvent = Schema.Struct({
  ...PiSessionEventBase.fields,
  type: Schema.Literal("sessionFile"),
  sessionFile: Schema.NullOr(Schema.String),
});

export const PiSessionEvent = Schema.Union([
  PiOutputEvent,
  PiStartedEvent,
  PiHibernatedEvent,
  PiExitedEvent,
  PiErrorEvent,
  PiHookStatusEvent,
  PiSessionFileEvent,
]);
export type PiSessionEvent = typeof PiSessionEvent.Type;
