/**
 * ClaudeSessionManager - Claude Code terminal session orchestration service interface.
 *
 * Owns lifecycle operations for Claude Code CLI sessions: spawn, hibernate,
 * resume, output fanout, and session state transitions.
 *
 * @module ClaudeSessionManager
 */
import { Effect, Schema, ServiceMap } from "effect";
import type {
  ClaudeCodeBackend,
  ClaudeCodeProxyStatus,
  CodingHarness,
  TerminalStatus,
} from "@clui/contracts";
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
    harness?: Exclude<CodingHarness, "pi">;
    resumeSessionId?: string;
    executionMode?: "interactive" | "exec";
    initialPrompt?: string;
    cols: number;
    rows: number;
    dangerouslySkipPermissions?: boolean;
    claudeCodeBackend?: ClaudeCodeBackend;
    model?: string;
    journeyTools?: { endpoint: string; token: string };
  }) => Effect.Effect<void, ClaudeSessionError>;
  readonly getClaudeCodeProxyStatus: () => Effect.Effect<ClaudeCodeProxyStatus>;
  readonly startClaudeCodeProxyLogin: () => Effect.Effect<
    ClaudeCodeProxyStatus,
    ClaudeSessionError
  >;
  readonly logoutClaudeCodeProxy: () => Effect.Effect<ClaudeCodeProxyStatus, ClaudeSessionError>;
  readonly hibernateSession: (threadId: string) => Effect.Effect<void, ClaudeSessionError>;
  readonly getScrollback: (
    threadId: string,
    sinceOffset?: number,
  ) => Effect.Effect<{ scrollback: string | null; offset: number; reset: boolean }>;
  readonly writeToSession: (
    threadId: string,
    data: string,
  ) => Effect.Effect<void, ClaudeSessionError>;
  readonly resizeSession: (
    threadId: string,
    cols: number,
    rows: number,
  ) => Effect.Effect<void, ClaudeSessionError>;
  readonly getSessionStatus: (threadId: string) => Effect.Effect<TerminalStatus>;
  readonly reconcileActiveSessions: (maxActive: number) => Effect.Effect<void>;
  readonly setMaxActiveSessions: (maxActive: number) => Effect.Effect<void>;
  readonly hibernateAll: () => Effect.Effect<void>;
  /** Hibernate active sessions except the excluded thread IDs. Returns hibernated thread IDs. */
  readonly hibernateActiveSessions: (
    excludeThreadIds: ReadonlySet<string>,
  ) => Effect.Effect<ReadonlyArray<string>>;
  readonly subscribe: (listener: (event: ClaudeSessionEvent) => void) => Effect.Effect<() => void>;
  readonly getClaudeSessionId: (threadId: string) => Effect.Effect<string | null>;
  readonly recordCodexSessionId: (
    threadId: string,
    sessionId: string,
  ) => Effect.Effect<void, ClaudeSessionError>;
  /** Kill PTY and remove session from map without emitting lifecycle events. Used for thread deletion. */
  readonly destroySession: (threadId: string) => Effect.Effect<void>;
  /** Kill all dormant sessions except the excluded thread IDs. Returns count of sessions killed. */
  readonly purgeInactiveSessions: (excludeThreadIds: ReadonlySet<string>) => Effect.Effect<number>;
  readonly dispose: Effect.Effect<void>;
}

export class ClaudeSessionManager extends ServiceMap.Service<
  ClaudeSessionManager,
  ClaudeSessionManagerShape
>()("clui/terminal/Services/ClaudeSession/ClaudeSessionManager") {}
