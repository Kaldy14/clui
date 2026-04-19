/**
 * PiSessionManager - pi terminal session orchestration service interface.
 *
 * Owns lifecycle operations for pi CLI sessions: spawn, resume,
 * hibernate, output fanout, and session state transitions.
 */
import { Effect, Schema, ServiceMap } from "effect";
import type { TerminalStatus, PiSessionEvent } from "@clui/contracts";

export class PiSessionError extends Schema.TaggedErrorClass<PiSessionError>()(
  "PiSessionError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

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
  }) => Effect.Effect<void, PiSessionError>;
  readonly hibernateSession: (threadId: string) => Effect.Effect<string, PiSessionError>;
  readonly getScrollback: (
    threadId: string,
    sinceOffset?: number,
  ) => Effect.Effect<{ scrollback: string | null; offset: number; reset: boolean }>;
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
  readonly reconcileActiveSessions: (maxActive: number) => Effect.Effect<void>;
  readonly hibernateAll: () => Effect.Effect<void>;
  readonly subscribe: (listener: (event: PiSessionEvent) => void) => Effect.Effect<() => void>;
  readonly destroySession: (threadId: string) => Effect.Effect<void>;
  readonly purgeInactiveSessions: (excludeThreadIds: ReadonlySet<string>) => Effect.Effect<number>;
  readonly dispose: Effect.Effect<void>;
}

export class PiSessionManager extends ServiceMap.Service<
  PiSessionManager,
  PiSessionManagerShape
>()("clui/terminal/Services/PiSession/PiSessionManager") {}
