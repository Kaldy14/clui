import type {
  JourneyProjectionDelta,
  JourneyProjectionSnapshot,
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@clui/contracts";
import { OrchestrationCommand } from "@clui/contracts";
import { Deferred, Effect, Layer, Option, PubSub, Queue, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import {
  createEmptyJourneyDomainState,
  getJourneyProjectionSnapshot,
  projectJourneyEvent,
} from "../journeyDomain.ts";
import { JourneyOutputStoreLive, JourneyOutputStoreService } from "../journeyOutputStore.ts";
import { JourneyProjectionDeltaStore } from "../journeyProjectionDeltas.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";

interface CommandEnvelope {
  command: OrchestrationCommand;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
}

function journeyRevision(
  state: ReturnType<typeof createEmptyJourneyDomainState>,
  threadId: ThreadId,
) {
  return state.threads.find((thread) => thread.threadId === threadId)?.journeyRevision ?? 0;
}

export function getJourneyProjectionDeltaCandidate(input: {
  previousState: ReturnType<typeof createEmptyJourneyDomainState>;
  nextState: ReturnType<typeof createEmptyJourneyDomainState>;
  nextReadModel: OrchestrationReadModel;
  event: OrchestrationEvent;
}): { previousRevision: number; snapshot: JourneyProjectionSnapshot } | null {
  if (input.event.aggregateKind !== "thread") return null;
  if (!input.event.type.startsWith("journey.") && input.event.type !== "thread.journey-updated") {
    return null;
  }
  const threadId = input.event.aggregateId as ThreadId;
  const previousRevision = journeyRevision(input.previousState, threadId);
  const nextRevision = journeyRevision(input.nextState, threadId);
  if (nextRevision !== previousRevision + 1) return null;
  return {
    previousRevision,
    snapshot: getJourneyProjectionSnapshot({
      state: input.nextState,
      readModel: input.nextReadModel,
      threadId,
    }),
  };
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    default:
      if (
        command.type === "journey.decision.submit" ||
        command.type === "journey.approval.submit"
      ) {
        return {
          aggregateKind: "thread",
          aggregateId: command.submission.threadId,
        };
      }
      return {
        aggregateKind: "thread",
        aggregateId:
          "threadId" in command
            ? command.threadId
            : "parentFence" in command
              ? command.parentFence.threadId
              : command.fence.threadId,
      };
  }
}

function formatDispatchError(error: OrchestrationDispatchError): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const journeyOutputStore = yield* JourneyOutputStoreService;

  let readModel = createEmptyReadModel(new Date().toISOString());
  let journeyDomainState = createEmptyJourneyDomainState();

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();
  const journeyDeltaPubSub = yield* PubSub.unbounded<JourneyProjectionDelta>();
  const journeyOutputPubSub =
    yield* PubSub.unbounded<import("@clui/contracts").JourneyOutputChunk>();
  const journeyDeltaStore = new JourneyProjectionDeltaStore();

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = readModel.snapshotSequence;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      let nextReadModel = readModel;
      let nextJourneyDomainState = journeyDomainState;
      const recoveredJourneySnapshots: Array<{
        previousRevision: number;
        snapshot: JourneyProjectionSnapshot;
      }> = [];
      for (const persistedEvent of persistedEvents) {
        const previousState = nextJourneyDomainState;
        nextReadModel = yield* projectEvent(nextReadModel, persistedEvent);
        nextJourneyDomainState = projectJourneyEvent(nextJourneyDomainState, persistedEvent);
        const changed = getJourneyProjectionDeltaCandidate({
          previousState,
          nextState: nextJourneyDomainState,
          nextReadModel,
          event: persistedEvent,
        });
        if (changed) recoveredJourneySnapshots.push(changed);
      }
      readModel = nextReadModel;
      journeyDomainState = nextJourneyDomainState;

      for (const persistedEvent of persistedEvents) {
        yield* PubSub.publish(eventPubSub, persistedEvent);
      }
      for (const changed of recoveredJourneySnapshots) {
        const delta = journeyDeltaStore.record(changed.previousRevision, changed.snapshot);
        yield* PubSub.publish(journeyDeltaPubSub, delta);
      }
    });

    return Effect.gen(function* () {
      const existingReceipt = yield* commandReceiptRepository.getByCommandId({
        commandId: envelope.command.commandId,
      });
      if (Option.isSome(existingReceipt)) {
        if (existingReceipt.value.status === "accepted") {
          yield* Deferred.succeed(envelope.result, {
            sequence: existingReceipt.value.resultSequence,
          });
          return;
        }
        yield* Deferred.fail(
          envelope.result,
          new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          }),
        );
        return;
      }

      const eventBase = yield* decideOrchestrationCommand({
        command: envelope.command,
        readModel,
        journeyDomainState,
      });
      const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
      const committedCommand = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const committedEvents: OrchestrationEvent[] = [];
            const journeySnapshots: Array<{
              previousRevision: number;
              snapshot: JourneyProjectionSnapshot;
            }> = [];
            let nextReadModel = readModel;
            let nextJourneyDomainState = journeyDomainState;

            for (const nextEvent of eventBases) {
              const savedEvent = yield* eventStore.append(nextEvent);
              const previousState = nextJourneyDomainState;
              nextReadModel = yield* projectEvent(nextReadModel, savedEvent);
              nextJourneyDomainState = projectJourneyEvent(nextJourneyDomainState, savedEvent);
              const changed = getJourneyProjectionDeltaCandidate({
                previousState,
                nextState: nextJourneyDomainState,
                nextReadModel,
                event: savedEvent,
              });
              if (changed) journeySnapshots.push(changed);
              yield* projectionPipeline.projectEvent(savedEvent);
              committedEvents.push(savedEvent);
            }

            const lastSavedEvent = committedEvents.at(-1) ?? null;
            if (lastSavedEvent === null) {
              return yield* new OrchestrationCommandInvariantError({
                commandType: envelope.command.type,
                detail: "Command produced no events.",
              });
            }

            yield* commandReceiptRepository.upsert({
              commandId: envelope.command.commandId,
              aggregateKind: lastSavedEvent.aggregateKind,
              aggregateId: lastSavedEvent.aggregateId,
              acceptedAt: lastSavedEvent.occurredAt,
              resultSequence: lastSavedEvent.sequence,
              status: "accepted",
              error: null,
            });

            return {
              committedEvents,
              lastSequence: lastSavedEvent.sequence,
              nextReadModel,
              nextJourneyDomainState,
              journeySnapshots,
            } as const;
          }),
        )
        .pipe(
          Effect.catchTag("SqlError", (sqlError) =>
            Effect.fail(
              toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
            ),
          ),
        );

      readModel = committedCommand.nextReadModel;
      journeyDomainState = committedCommand.nextJourneyDomainState;
      for (const event of committedCommand.committedEvents) {
        yield* PubSub.publish(eventPubSub, event);
      }
      for (const changed of committedCommand.journeySnapshots) {
        const delta = journeyDeltaStore.record(changed.previousRevision, changed.snapshot);
        yield* PubSub.publish(journeyDeltaPubSub, delta);
      }
      yield* Deferred.succeed(envelope.result, { sequence: committedCommand.lastSequence });
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* reconcileReadModelAfterDispatchFailure.pipe(
            Effect.catch(() =>
              Effect.logWarning(
                "failed to reconcile orchestration read model after dispatch failure",
              ).pipe(
                Effect.annotateLogs({
                  commandId: envelope.command.commandId,
                  snapshotSequence: readModel.snapshotSequence,
                }),
              ),
            ),
          );

          if (Schema.is(OrchestrationCommandInvariantError)(error)) {
            const aggregateRef = commandToAggregateRef(envelope.command);
            yield* commandReceiptRepository
              .upsert({
                commandId: envelope.command.commandId,
                aggregateKind: aggregateRef.aggregateKind,
                aggregateId: aggregateRef.aggregateId,
                acceptedAt: new Date().toISOString(),
                resultSequence: readModel.snapshotSequence,
                status: "rejected",
                error: formatDispatchError(error),
              })
              .pipe(Effect.catch(() => Effect.void));
          }
          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
  };

  yield* projectionPipeline.bootstrap;

  // bootstrap in-memory read model from event store
  yield* Stream.runForEach(eventStore.readAll(), (event) =>
    Effect.gen(function* () {
      readModel = yield* projectEvent(readModel, event);
      journeyDomainState = projectJourneyEvent(journeyDomainState, event);
    }),
  );

  const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
  yield* Effect.forkScoped(worker);
  yield* Effect.log("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: readModel.snapshotSequence }),
  );

  const getReadModel: OrchestrationEngineShape["getReadModel"] = () =>
    Effect.sync((): OrchestrationReadModel => readModel);

  const getJourneyProjection: OrchestrationEngineShape["getJourneyProjection"] = (threadId) =>
    Effect.try({
      try: () => getJourneyProjectionSnapshot({ state: journeyDomainState, readModel, threadId }),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

  const getJourneyDeltas: OrchestrationEngineShape["getJourneyDeltas"] = (
    threadId,
    afterJourneyRevision,
  ) =>
    getJourneyProjection(threadId).pipe(
      Effect.map((snapshot) => journeyDeltaStore.catchUp(threadId, afterJourneyRevision, snapshot)),
    );

  const beginJourneyRunOutput: OrchestrationEngineShape["beginJourneyRunOutput"] = (fence) =>
    Effect.gen(function* () {
      const projection = journeyDomainState.threads.find(
        (candidate) => candidate.threadId === fence.threadId,
      );
      const run = projection?.runs.find((candidate) => candidate.runId === fence.runId);
      const attempt = projection?.attempts.find(
        (candidate) =>
          candidate.fence.runId === fence.runId && candidate.fence.attempt === fence.attempt,
      );
      if (
        !run ||
        !attempt ||
        run.nodeId !== fence.nodeId ||
        run.attempt !== fence.attempt ||
        attempt.fence.nodeId !== fence.nodeId ||
        !["starting", "running"].includes(run.status) ||
        !["starting", "running"].includes(attempt.status)
      ) {
        return yield* Effect.fail(
          new Error(`Journey output fence '${fence.runId}:${fence.attempt}' is not authoritative.`),
        );
      }
      yield* journeyOutputStore.beginAttempt(fence);
    });

  const appendJourneyRunOutput: OrchestrationEngineShape["appendJourneyRunOutput"] = (
    fence,
    data,
  ) =>
    journeyOutputStore.append(fence, data).pipe(
      Effect.tap(({ firstCursor, nextCursor }) =>
        PubSub.publish(journeyOutputPubSub, {
          fence,
          startCursor: firstCursor,
          endCursor: nextCursor,
          data,
        }),
      ),
    );

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive) =>
    eventStore.readFromSequence(fromSequenceExclusive);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, { command, result });
      return yield* Deferred.await(result);
    });

  const streamDomainEvents: OrchestrationEngineShape["streamDomainEvents"] =
    Stream.fromPubSub(eventPubSub);
  const streamJourneyProjectionDeltas: OrchestrationEngineShape["streamJourneyProjectionDeltas"] =
    Stream.fromPubSub(journeyDeltaPubSub);
  const streamJourneyRunOutput: OrchestrationEngineShape["streamJourneyRunOutput"] =
    Stream.fromPubSub(journeyOutputPubSub);

  return {
    getReadModel,
    getJourneyProjection,
    getJourneyDeltas,
    beginJourneyRunOutput,
    appendJourneyRunOutput,
    getJourneyRunOutput: journeyOutputStore.read,
    deactivateJourneyRunOutput: journeyOutputStore.deactivate,
    readEvents,
    dispatch,
    streamDomainEvents,
    streamJourneyProjectionDeltas,
    streamJourneyRunOutput,
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
).pipe(Layer.provide(JourneyOutputStoreLive));
