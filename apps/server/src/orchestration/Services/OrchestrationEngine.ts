/**
 * OrchestrationEngineService - Service interface for orchestration command handling.
 *
 * Owns command validation/dispatch and in-memory read-model updates backed by
 * `OrchestrationEventStore` persistence. It does not own provider process
 * management or transport concerns (e.g. websocket request parsing).
 *
 * Uses Effect `ServiceMap.Service` for dependency injection. Command dispatch,
 * replay, and unknown-input decoding all return typed domain errors.
 *
 * @module OrchestrationEngineService
 */
import type {
  JourneyAttemptFence,
  JourneyOutputReadResult,
  JourneyOutputChunk,
  JourneyProjectionDelta,
  JourneyProjectionSnapshot,
  OrchestrationGetJourneyDeltasResult,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@clui/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { OrchestrationDispatchError } from "../Errors.ts";
import type { OrchestrationEventStoreError } from "../../persistence/Errors.ts";

/**
 * OrchestrationEngineShape - Service API for orchestration command and event flow.
 */
export interface OrchestrationEngineShape {
  /**
   * Read the current in-memory orchestration read model.
   *
   * @returns Effect containing the latest read model.
   */
  readonly getReadModel: () => Effect.Effect<OrchestrationReadModel, never, never>;

  /** Read the rebuildable Journey run/attempt/approval projection for a thread. */
  readonly getJourneyProjection: (
    threadId: import("@clui/contracts").ThreadId,
  ) => Effect.Effect<JourneyProjectionSnapshot, Error, never>;

  /** Catch up a Journey projection without treating unrelated global events as gaps. */
  readonly getJourneyDeltas: (
    threadId: import("@clui/contracts").ThreadId,
    afterJourneyRevision: number,
  ) => Effect.Effect<OrchestrationGetJourneyDeltasResult, Error, never>;

  /** Initialize the bounded output stream for a newly active physical attempt. */
  readonly beginJourneyRunOutput: (fence: JourneyAttemptFence) => Effect.Effect<void, Error>;

  /** Append process output. Full-fence validation rejects late/stale attempts. */
  readonly appendJourneyRunOutput: (
    fence: JourneyAttemptFence,
    data: string,
  ) => Effect.Effect<{ firstCursor: number; nextCursor: number }, Error>;

  /** Read only one selected physical attempt's retained output. */
  readonly getJourneyRunOutput: (
    fence: JourneyAttemptFence,
    afterCursor: number,
  ) => Effect.Effect<JourneyOutputReadResult, Error>;

  readonly deactivateJourneyRunOutput: (fence: JourneyAttemptFence) => Effect.Effect<void, Error>;

  /**
   * Replay persisted orchestration events from an exclusive sequence cursor.
   *
   * @param fromSequenceExclusive - Sequence cursor (exclusive).
   * @returns Stream containing ordered events.
   */
  readonly readEvents: (
    fromSequenceExclusive: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  /**
   * Dispatch a validated orchestration command.
   *
   * @param command - Valid orchestration command.
   * @returns Effect containing the sequence of the persisted event.
   *
   * Dispatch is serialized through an internal queue and deduplicated via
   * command receipts.
   */
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;

  /**
   * Stream persisted domain events in dispatch order.
   *
   * This is a hot runtime stream (new events only), not a historical replay.
   */
  readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>;

  /** Hot, lightweight projection updates; never launches or resumes work. */
  readonly streamJourneyProjectionDeltas: Stream.Stream<JourneyProjectionDelta>;

  /** Hot output chunks for active physical attempts. Transport filters by full fence. */
  readonly streamJourneyRunOutput: Stream.Stream<JourneyOutputChunk>;
}

/**
 * OrchestrationEngineService - Service tag for orchestration engine access.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const engine = yield* OrchestrationEngineService
 *   return yield* engine.getReadModel()
 * })
 * ```
 */
export class OrchestrationEngineService extends ServiceMap.Service<
  OrchestrationEngineService,
  OrchestrationEngineShape
>()("t3/orchestration/Services/OrchestrationEngine/OrchestrationEngineService") {}
