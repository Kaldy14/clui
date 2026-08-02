/**
 * PiSessionManager - pi terminal session orchestration service interface.
 *
 * Owns lifecycle operations for pi CLI sessions: spawn, resume,
 * hibernate, output fanout, and session state transitions.
 */
import { Effect, Schema, ServiceMap } from "effect";
import type {
  AgentActivityStatus,
  ClaudeHookStatus,
  PiExtensionUiState,
  PiSessionEvent,
  PiSessionUsageStats,
  TerminalStatus,
} from "@clui/contracts";

export class PiSessionError extends Schema.TaggedErrorClass<PiSessionError>()("PiSessionError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface PiSessionState {
  threadId: string;
  lastInteractedAt: number;
  cols: number;
  rows: number;
  status: TerminalStatus;
}

export interface PiSessionManagerShape {
  readonly startSession: (input: {
    threadId: string;
    cwd: string;
    cols: number;
    rows: number;
    fresh?: boolean;
    resumeSessionFile?: string;
    initialPrompt?: string;
    fastMode?: boolean;
    htmlMode?: boolean;
    journeyTools?: { endpoint: string; token: string };
  }) => Effect.Effect<void, PiSessionError>;
  readonly hibernateSession: (threadId: string) => Effect.Effect<void, PiSessionError>;
  readonly getScrollback: (
    threadId: string,
    sinceOffset?: number,
  ) => Effect.Effect<{ scrollback: string | null; offset: number; reset: boolean }>;
  readonly promptSession: (
    threadId: string,
    message: string,
    streamingBehavior?: "steer" | "followUp",
  ) => Effect.Effect<void, PiSessionError>;
  readonly abortSession: (threadId: string) => Effect.Effect<void, PiSessionError>;
  readonly respondExtensionUi: (
    threadId: string,
    response: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean },
  ) => Effect.Effect<void, PiSessionError>;
  readonly getCommands: (
    threadId: string,
  ) => Effect.Effect<
    ReadonlyArray<{ name: string; description?: string; source?: string }>,
    PiSessionError
  >;
  readonly sendRpcSessionCommand: (
    threadId: string,
    commandType: string,
    payload?: Record<string, unknown>,
  ) => Effect.Effect<unknown, PiSessionError>;
  readonly writeToSession: (threadId: string, data: string) => Effect.Effect<void, PiSessionError>;
  /** After a non-empty first line is submitted via `pi.write` (newline seen). */
  readonly notifyPromptSubmitted: (threadId: string) => Effect.Effect<void, PiSessionError>;
  readonly resizeSession: (
    threadId: string,
    cols: number,
    rows: number,
  ) => Effect.Effect<void, PiSessionError>;
  readonly getSessionStatus: (threadId: string) => Effect.Effect<TerminalStatus>;
  readonly getSessionFile: (threadId: string) => Effect.Effect<string | null>;
  readonly getSessionHookStatus: (threadId: string) => Effect.Effect<ClaudeHookStatus | null>;
  readonly getSessionActivityStatus: (
    threadId: string,
  ) => Effect.Effect<AgentActivityStatus | null>;
  readonly getPendingExtensionUiRequest: (
    threadId: string,
  ) => Effect.Effect<Record<string, unknown> | null>;
  readonly getExtensionUiState: (threadId: string) => Effect.Effect<PiExtensionUiState>;
  readonly getSessionUsageStats: (
    threadId: string,
  ) => Effect.Effect<PiSessionUsageStats | null, PiSessionError>;
  readonly reconcileActiveSessions: (maxActive: number) => Effect.Effect<void>;
  readonly setMaxActiveSessions: (maxActive: number) => Effect.Effect<void>;
  readonly hibernateAll: () => Effect.Effect<void>;
  /** Hibernate active sessions except the excluded thread IDs. Returns hibernated thread IDs. */
  readonly hibernateActiveSessions: (
    excludeThreadIds: ReadonlySet<string>,
  ) => Effect.Effect<ReadonlyArray<string>>;
  readonly subscribe: (listener: (event: PiSessionEvent) => void) => Effect.Effect<() => void>;
  readonly destroySession: (threadId: string) => Effect.Effect<void>;
  readonly purgeInactiveSessions: (excludeThreadIds: ReadonlySet<string>) => Effect.Effect<number>;
  readonly dispose: Effect.Effect<void>;
}

export class PiSessionManager extends ServiceMap.Service<PiSessionManager, PiSessionManagerShape>()(
  "clui/terminal/Services/PiSession/PiSessionManager",
) {}
