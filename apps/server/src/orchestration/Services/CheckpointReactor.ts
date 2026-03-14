/**
 * CheckpointReactor - Checkpoint reaction service interface.
 *
 * Owns background workers that react to orchestration checkpoint lifecycle
 * events and apply checkpoint side effects.
 *
 * @module CheckpointReactor
 */
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";
import type { ThreadId } from "@clui/contracts";

/**
 * CheckpointReactorShape - Service API for checkpoint reactor lifecycle.
 */
export interface CheckpointReactorShape {
  /**
   * Start the checkpoint reactor.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   *
   * Consumes both orchestration-domain and provider-runtime events via an
   * internal queue.
   */
  readonly start: Effect.Effect<void, never, Scope.Scope>;

  /**
   * Ensure a baseline checkpoint exists for the thread's current turn count.
   * Called on UserPromptSubmit to capture the "before" state.
   */
  readonly ensureBaseline: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void>;

  /**
   * Capture a checkpoint after a terminal turn completes (Stop hook).
   * Computes the diff against the baseline and dispatches a
   * thread.turn.diff.complete command into the orchestration pipeline.
   */
  readonly captureTerminalTurnCheckpoint: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void>;
}

/**
 * CheckpointReactor - Service tag for checkpoint reactor workers.
 */
export class CheckpointReactor extends ServiceMap.Service<
  CheckpointReactor,
  CheckpointReactorShape
>()("t3/orchestration/Services/CheckpointReactor") {}
