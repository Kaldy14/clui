import {
  CommandId,
  EventId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@clui/contracts";
import { Cause, Effect, Layer, Queue, Stream } from "effect";

import {
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import { OrchestrationDispatchError } from "../Errors.ts";

type ReactorInput = {
  readonly source: "domain";
  readonly event: OrchestrationEvent;
};

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const checkpointStore = yield* CheckpointStore;

  const appendRevertFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-revert-failure"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: "checkpoint.revert.failed",
        summary: "Checkpoint revert failed",
        payload: {
          turnCount: input.turnCount,
          detail: input.detail,
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const isGitWorkspace = (cwd: string) => checkpointStore.isGitRepository(cwd);

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fnUntraced(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (event.type === "thread.message-sent") {
      if (
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    const threadId = event.payload.threadId;
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return;
    }

    const checkpointCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });
    if (!checkpointCwd) {
      yield* Effect.logWarning("checkpoint pre-turn capture skipped: no workspace cwd", {
        threadId,
      });
      return;
    }
    if (!(yield* isGitWorkspace(checkpointCwd))) {
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const baselineCheckpointRef = checkpointRefForThreadTurn(threadId, currentTurnCount);
    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    if (baselineExists) {
      return;
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
  });

  const handleRevertRequested = Effect.fnUntraced(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ) {
    const now = new Date().toISOString();

    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === event.payload.threadId);
    if (!thread) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Thread was not found in read model.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    // Resolve cwd from thread/project configuration.
    const checkpointCwd = resolveThreadWorkspaceCwd({ thread, projects: readModel.projects });
    if (!checkpointCwd) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "No workspace cwd could be resolved for this thread.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }
    if (!(yield* isGitWorkspace(checkpointCwd))) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Checkpoints are unavailable because this project is not a git repository.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );

    if (event.payload.turnCount > currentTurnCount) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint turn count ${event.payload.turnCount} exceeds current turn count ${currentTurnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const targetCheckpointRef =
      event.payload.turnCount === 0
        ? checkpointRefForThreadTurn(event.payload.threadId, 0)
        : thread.checkpoints.find(
            (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
          )?.checkpointRef;

    if (!targetCheckpointRef) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint ref for turn ${event.payload.turnCount} is unavailable in read model.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const restored = yield* checkpointStore.restoreCheckpoint({
      cwd: checkpointCwd,
      checkpointRef: targetCheckpointRef,
      fallbackToHead: event.payload.turnCount === 0,
    });
    if (!restored) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Filesystem checkpoint is unavailable for turn ${event.payload.turnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const staleCheckpointRefs = thread.checkpoints
      .filter((checkpoint) => checkpoint.checkpointTurnCount > event.payload.turnCount)
      .map((checkpoint) => checkpoint.checkpointRef);

    if (staleCheckpointRefs.length > 0) {
      yield* checkpointStore.deleteCheckpointRefs({
        cwd: checkpointCwd,
        checkpointRefs: staleCheckpointRefs,
      });
    }

    yield* orchestrationEngine
      .dispatch({
        type: "thread.revert.complete",
        commandId: serverCommandId("checkpoint-revert-complete"),
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        createdAt: now,
      })
      .pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: now,
          }),
        ),
        Effect.asVoid,
      );
  });

  const processDomainEvent = Effect.fnUntraced(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* handleRevertRequested(event).pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: new Date().toISOString(),
          }),
        ),
      );
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<void, CheckpointStoreError | OrchestrationDispatchError, never> =>
    processDomainEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("checkpoint reactor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const ensureBaseline: CheckpointReactorShape["ensureBaseline"] = (input) =>
    Effect.gen(function* () {
      yield* Effect.logInfo("[checkpoint] ensureBaseline called", { threadId: input.threadId });
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === input.threadId);
      if (!thread) {
        yield* Effect.logWarning("[checkpoint] ensureBaseline: thread not found", { threadId: input.threadId });
        return;
      }

      const checkpointCwd = resolveThreadWorkspaceCwd({ thread, projects: readModel.projects });
      if (!checkpointCwd) {
        yield* Effect.logWarning("[checkpoint] ensureBaseline: no workspace cwd", { threadId: input.threadId });
        return;
      }
      if (!(yield* isGitWorkspace(checkpointCwd))) {
        yield* Effect.logWarning("[checkpoint] ensureBaseline: not a git repo", { cwd: checkpointCwd });
        return;
      }

      const currentTurnCount = thread.checkpoints.reduce(
        (max, cp) => Math.max(max, cp.checkpointTurnCount),
        0,
      );
      const baselineRef = checkpointRefForThreadTurn(input.threadId, currentTurnCount);
      const exists = yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: baselineRef,
      });
      if (exists) return;

      yield* checkpointStore.captureCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: baselineRef,
      });
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("ensureBaseline failed", { threadId: input.threadId, cause }),
      ),
    );

  const captureTerminalTurnCheckpoint: CheckpointReactorShape["captureTerminalTurnCheckpoint"] = (input) =>
    Effect.gen(function* () {
      yield* Effect.logInfo("[checkpoint] captureTerminalTurnCheckpoint called", { threadId: input.threadId });
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === input.threadId);
      if (!thread) {
        yield* Effect.logWarning("[checkpoint] capture: thread not found", { threadId: input.threadId });
        return;
      }

      const checkpointCwd = resolveThreadWorkspaceCwd({ thread, projects: readModel.projects });
      if (!checkpointCwd) {
        yield* Effect.logWarning("[checkpoint] capture: no workspace cwd", { threadId: input.threadId });
        return;
      }
      if (!(yield* isGitWorkspace(checkpointCwd))) {
        yield* Effect.logWarning("[checkpoint] capture: not a git repo", { cwd: checkpointCwd });
        return;
      }

      const currentTurnCount = thread.checkpoints.reduce(
        (max, cp) => Math.max(max, cp.checkpointTurnCount),
        0,
      );
      const nextTurnCount = currentTurnCount + 1;

      // Ensure baseline exists for the "from" side of the diff
      const baselineRef = checkpointRefForThreadTurn(input.threadId, currentTurnCount);
      const baselineExists = yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: baselineRef,
      });
      if (!baselineExists) {
        yield* checkpointStore.captureCheckpoint({
          cwd: checkpointCwd,
          checkpointRef: baselineRef,
        });
      }

      // Capture the post-turn checkpoint
      const targetRef = checkpointRefForThreadTurn(input.threadId, nextTurnCount);
      yield* checkpointStore.captureCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: targetRef,
      });

      // Compute diff
      const diff = yield* checkpointStore.diffCheckpoints({
        cwd: checkpointCwd,
        fromCheckpointRef: baselineRef,
        toCheckpointRef: targetRef,
        fallbackFromToHead: false,
      });

      yield* Effect.logInfo("[checkpoint] diff computed", { cwd: checkpointCwd, diffLength: diff.length });
      const files = parseTurnDiffFilesFromUnifiedDiff(diff);
      yield* Effect.logInfo("[checkpoint] parsed files", { fileCount: files.length });
      if (files.length === 0) {
        // No changes — delete the checkpoint ref and skip
        yield* checkpointStore.deleteCheckpointRefs({
          cwd: checkpointCwd,
          checkpointRefs: [targetRef],
        });
        return;
      }

      const now = new Date().toISOString();
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: serverCommandId("checkpoint-turn-diff-complete"),
        threadId: input.threadId,
        turnId: TurnId.makeUnsafe(crypto.randomUUID()),
        completedAt: now,
        checkpointRef: targetRef,
        status: "ready",
        files: files.map((f) => ({
          path: f.path,
          kind: "modified",
          additions: f.additions,
          deletions: f.deletions,
        })),
        checkpointTurnCount: nextTurnCount,
        createdAt: now,
      });
      yield* Effect.logInfo("[checkpoint] dispatched thread.turn.diff.complete", {
        threadId: input.threadId,
        turnCount: nextTurnCount,
        fileCount: files.length,
      });
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("captureTerminalTurnCheckpoint failed", {
          threadId: input.threadId,
          cause,
        }),
      ),
    );

  const start: CheckpointReactorShape["start"] = Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ReactorInput>();
    yield* Effect.addFinalizer(() => Queue.shutdown(queue).pipe(Effect.asVoid));

    yield* Effect.forkScoped(
      Effect.forever(Queue.take(queue).pipe(Effect.flatMap(processInputSafely))),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.checkpoint-revert-requested"
        ) {
          return Effect.void;
        }
        return Queue.offer(queue, { source: "domain", event }).pipe(Effect.asVoid);
      }),
    );
  });

  return {
    start,
    ensureBaseline,
    captureTerminalTurnCheckpoint,
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make);
