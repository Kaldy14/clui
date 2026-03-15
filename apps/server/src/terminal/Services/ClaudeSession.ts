/**
 * ClaudeSessionManager - Claude Code terminal session orchestration service interface.
 *
 * Owns lifecycle operations for Claude Code CLI sessions: spawn, hibernate,
 * resume, output fanout, and session state transitions.
 *
 * @module ClaudeSessionManager
 */
import { Effect, Schema, ServiceMap } from "effect";
import type { TerminalStatus } from "@clui/contracts";
import type { ClaudeSessionEvent } from "@clui/contracts";

export class ClaudeSessionError extends Schema.TaggedErrorClass<ClaudeSessionError>()(
  "ClaudeSessionError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface ClaudeSessionState {
  threadId: string;
  claudeSessionId: string | null;
  lastInteractedAt: number;
  cols: number;
  rows: number;
  status: TerminalStatus;
}

export interface ClaudeSessionManagerShape {
  readonly startSession: (input: {
    threadId: string;
    cwd: string;
    resumeSessionId?: string;
    cols: number;
    rows: number;
    dangerouslySkipPermissions?: boolean;
  }) => Effect.Effect<void, ClaudeSessionError>;
  readonly hibernateSession: (
    threadId: string,
  ) => Effect.Effect<string, ClaudeSessionError>;
  readonly getScrollback: (
    threadId: string,
  ) => Effect.Effect<string | null>;
  readonly writeToSession: (
    threadId: string,
    data: string,
  ) => Effect.Effect<void, ClaudeSessionError>;
  readonly resizeSession: (
    threadId: string,
    cols: number,
    rows: number,
  ) => Effect.Effect<void, ClaudeSessionError>;
  readonly getSessionStatus: (
    threadId: string,
  ) => Effect.Effect<TerminalStatus>;
  readonly reconcileActiveSessions: (
    maxActive: number,
  ) => Effect.Effect<void>;
  readonly hibernateAll: () => Effect.Effect<void>;
  readonly subscribe: (
    listener: (event: ClaudeSessionEvent) => void,
  ) => Effect.Effect<() => void>;
  readonly getClaudeSessionId: (
    threadId: string,
  ) => Effect.Effect<string | null>;
  /** Kill PTY and remove session from map without emitting lifecycle events. Used for thread deletion. */
  readonly destroySession: (
    threadId: string,
  ) => Effect.Effect<void>;
  readonly dispose: Effect.Effect<void>;
}

export class ClaudeSessionManager extends ServiceMap.Service<
  ClaudeSessionManager,
  ClaudeSessionManagerShape
>()("clui/terminal/Services/ClaudeSession/ClaudeSessionManager") {}
