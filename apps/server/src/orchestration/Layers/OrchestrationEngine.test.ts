import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type JourneySnapshot,
} from "@clui/contracts";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import {
  getJourneyProjectionDeltaCandidate,
  OrchestrationEngineLive,
} from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import { ServerConfig } from "../../config.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createEmptyJourneyDomainState, projectJourneyEvent } from "../journeyDomain.ts";
import { createEmptyReadModel } from "../projector.ts";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.makeUnsafe(value);

async function createOrchestrationSystem() {
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  return {
    engine,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

async function createPersistentOrchestrationSystem(databasePath: string) {
  const stateDir = path.dirname(databasePath);
  const persistence = makeSqlitePersistenceLive(databasePath).pipe(
    Layer.provide(NodeServices.layer),
  );
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(persistence),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), stateDir)),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  return {
    engine,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

function now() {
  return new Date().toISOString();
}

function journeySnapshot(
  nodeId: string,
  dependencies: JourneySnapshot["edges"] = [],
): JourneySnapshot {
  const createdAt = now();
  const node = (id: string): JourneySnapshot["nodes"][number] => ({
    id,
    type: "research",
    status: "ready",
    title: id,
    summary: "",
    detailMarkdown: "",
    todos: [],
    interaction: null,
    activity: [],
    createdAt,
    updatedAt: createdAt,
  });
  const nodeIds = new Set([nodeId, ...dependencies.flatMap((edge) => [edge.source, edge.target])]);
  return {
    version: 1,
    destination: "Journey",
    layoutDirection: "TB",
    activeNodeId: nodeId,
    nodes: [...nodeIds].map(node),
    edges: [...dependencies],
    updatedAt: createdAt,
  };
}

describe("OrchestrationEngine", () => {
  it("surfaces projection generation failures instead of dropping Journey deltas", () => {
    const createdAt = now();
    const threadId = ThreadId.makeUnsafe("missing-journey-projection");
    const event = {
      sequence: 1,
      eventId: "missing-projection-event",
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.journey-updated",
      payload: { threadId, journey: journeySnapshot("goal"), updatedAt: createdAt },
    } as unknown as OrchestrationEvent;
    const previousState = createEmptyJourneyDomainState();
    const nextState = projectJourneyEvent(previousState, event);
    expect(() =>
      getJourneyProjectionDeltaCandidate({
        previousState,
        nextState,
        nextReadModel: createEmptyReadModel(createdAt),
        event,
      }),
    ).toThrow(/not initialized/u);
  });

  it("commits a composite Journey child start as one all-or-nothing dispatch", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();
    const projectId = asProjectId("project-composite-child");
    const journeyThreadId = ThreadId.makeUnsafe("thread-composite-child");
    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("create-project-composite-child"),
        projectId,
        title: "Project",
        workspaceRoot: "/tmp/project-composite-child",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("create-thread-composite-child"),
        threadId: journeyThreadId,
        projectId,
        title: "Journey",
        model: "gpt-5-codex",
        harness: "codexCli",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        surface: "journey",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    const graph = journeySnapshot("goal");
    await system.run(
      engine.dispatch({
        type: "thread.journey.update",
        commandId: CommandId.makeUnsafe("graph-composite-child"),
        threadId: journeyThreadId,
        journey: {
          ...graph,
          nodes: [
            {
              ...graph.nodes[0]!,
              type: "goal" as const,
              status: "running" as const,
            },
          ],
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "journey.run.request",
        commandId: CommandId.makeUnsafe("parent-run-composite-child"),
        threadId: journeyThreadId,
        runId: "coordinator",
        nodeId: "goal",
        role: "coordinator",
        harness: "codexCli",
        capabilities: ["graph.read", "research.start"],
        parentRunId: null,
        coordinatorRunId: null,
        prompt: "Coordinate",
        createdAt,
      }),
    );
    const parentFence = {
      threadId: journeyThreadId,
      runId: "coordinator",
      nodeId: "goal",
      attempt: 1,
    } as const;
    await system.run(
      engine.dispatch({
        type: "journey.attempt.start.request",
        commandId: CommandId.makeUnsafe("parent-attempt-composite-child"),
        fence: parentFence,
        capabilities: ["graph.read", "research.start"],
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "journey.attempt.started",
        commandId: CommandId.makeUnsafe("parent-started-composite-child"),
        fence: parentFence,
        adapterEventId: "parent-started-composite-child",
        resumableHarnessIdentity: null,
        createdAt,
      }),
    );
    const before = (await system.run(engine.getReadModel())).snapshotSequence;
    const result = await system.run(
      engine.dispatch({
        type: "journey.child.start",
        commandId: CommandId.makeUnsafe("composite-child-start"),
        parentFence,
        childKind: "research",
        runId: "research-child",
        nodeId: "research-node",
        title: "Research",
        instructions: "Inspect the boundary.",
        harness: "codexCli",
        createdAt,
      }),
    );
    expect(result.sequence - before).toBe(5);
    const projectionAfter = await system.run(engine.getJourneyProjection(journeyThreadId));
    expect(projectionAfter.runs.find((run) => run.runId === "research-child")).toMatchObject({
      status: "starting",
      attempt: 1,
    });
    expect(
      projectionAfter.attempts.filter((attempt) => attempt.fence.runId === "research-child"),
    ).toHaveLength(1);
    expect(
      (await system.run(engine.getReadModel())).threads
        .find((thread) => thread.id === journeyThreadId)
        ?.journey?.nodes.find((node) => node.id === "research-node")?.status,
    ).toBe("draft");

    const sequenceBeforeRejected = (await system.run(engine.getReadModel())).snapshotSequence;
    await expect(
      system.run(
        engine.dispatch({
          type: "journey.child.start",
          commandId: CommandId.makeUnsafe("composite-child-start-rejected"),
          parentFence,
          childKind: "research",
          runId: "research-child-duplicate",
          nodeId: "research-node",
          title: "Duplicate",
          instructions: "Must reject atomically.",
          harness: "codexCli",
          createdAt,
        }),
      ),
    ).rejects.toThrow("already exists");
    expect((await system.run(engine.getReadModel())).snapshotSequence).toBe(sequenceBeforeRejected);
    expect((await system.run(engine.getJourneyProjection(journeyThreadId))).runs).toHaveLength(2);
    await system.dispose();
  });

  it("returns deterministic read models for repeated reads", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-1-create"),
        projectId: asProjectId("project-1"),
        title: "Project 1",
        workspaceRoot: "/tmp/project-1",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-1-create"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        model: "gpt-5-codex",
        harness: "claudeCode",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-1"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    const readModelA = await system.run(engine.getReadModel());
    const readModelB = await system.run(engine.getReadModel());
    expect(readModelB).toEqual(readModelA);
    await system.dispose();
  });

  it("replays append-only events from sequence", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-replay-create"),
        projectId: asProjectId("project-replay"),
        title: "Replay Project",
        workspaceRoot: "/tmp/project-replay",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-replay-create"),
        threadId: ThreadId.makeUnsafe("thread-replay"),
        projectId: asProjectId("project-replay"),
        title: "replay",
        model: "gpt-5-codex",
        harness: "claudeCode",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("cmd-thread-replay-delete"),
        threadId: ThreadId.makeUnsafe("thread-replay"),
      }),
    );

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.deleted",
    ]);
    await system.dispose();
  });

  it("streams persisted domain events in order", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-stream-create"),
        projectId: asProjectId("project-stream"),
        title: "Stream Project",
        workspaceRoot: "/tmp/project-stream",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );

    const eventTypes: string[] = [];
    await system.run(
      Effect.gen(function* () {
        const eventQueue = yield* Queue.unbounded<OrchestrationEvent>();
        yield* Effect.forkScoped(
          Stream.take(engine.streamDomainEvents, 2).pipe(
            Stream.runForEach((event) => Queue.offer(eventQueue, event).pipe(Effect.asVoid)),
          ),
        );
        yield* Effect.sleep("10 millis");
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-stream-thread-create"),
          threadId: ThreadId.makeUnsafe("thread-stream"),
          projectId: asProjectId("project-stream"),
          title: "domain-stream",
          model: "gpt-5-codex",
          harness: "claudeCode",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-stream-thread-update"),
          threadId: ThreadId.makeUnsafe("thread-stream"),
          title: "domain-stream-updated",
        });
        eventTypes.push((yield* Queue.take(eventQueue)).type);
        eventTypes.push((yield* Queue.take(eventQueue)).type);
      }).pipe(Effect.scoped),
    );

    expect(eventTypes).toEqual(["thread.created", "thread.meta-updated"]);
    await system.dispose();
  });

  it("stores completed checkpoint summaries even when no files changed", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-turn-diff-create"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn Diff Project",
        workspaceRoot: "/tmp/project-turn-diff",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-turn-diff-create"),
        threadId: ThreadId.makeUnsafe("thread-turn-diff"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn diff thread",
        model: "gpt-5-codex",
        harness: "claudeCode",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-turn-diff-complete"),
        threadId: ThreadId.makeUnsafe("thread-turn-diff"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: asCheckpointRef("refs/t3/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    const thread = (await system.run(engine.getReadModel())).threads.find(
      (entry) => entry.id === "thread-turn-diff",
    );
    expect(thread?.checkpoints).toEqual([
      {
        turnId: asTurnId("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: asCheckpointRef("refs/t3/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: createdAt,
      },
    ]);
    await system.dispose();
  });

  it("keeps processing queued commands after a storage failure", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;
    let shouldFailFirstAppend = true;

    const flakyStore: OrchestrationEventStoreShape = {
      append(event) {
        if (shouldFailFirstAppend && event.commandId === CommandId.makeUnsafe("cmd-flaky-1")) {
          shouldFailFirstAppend = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.append",
              detail: "append failed",
            }),
          );
        }
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, flakyStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-flaky-create"),
        projectId: asProjectId("project-flaky"),
        title: "Flaky Project",
        workspaceRoot: "/tmp/project-flaky",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-flaky-1"),
          threadId: ThreadId.makeUnsafe("thread-flaky-fail"),
          projectId: asProjectId("project-flaky"),
          title: "flaky-fail",
          model: "gpt-5-codex",
          harness: "claudeCode",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("append failed");

    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-flaky-2"),
        threadId: ThreadId.makeUnsafe("thread-flaky-ok"),
        projectId: asProjectId("project-flaky"),
        title: "flaky-ok",
        model: "gpt-5-codex",
        harness: "claudeCode",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    expect(result.sequence).toBe(2);
    expect((await runtime.runPromise(engine.getReadModel())).snapshotSequence).toBe(2);
    await runtime.dispose();
  });

  it("rolls back all events for a multi-event command when projection fails mid-dispatch", async () => {
    let shouldFailRequestedProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: (event) => {
        if (
          shouldFailRequestedProjection &&
          event.commandId === CommandId.makeUnsafe("cmd-turn-start-atomic") &&
          event.type === "thread.turn-start-requested"
        ) {
          shouldFailRequestedProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.void;
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-atomic-create"),
        projectId: asProjectId("project-atomic"),
        title: "Atomic Project",
        workspaceRoot: "/tmp/project-atomic",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-atomic-create"),
        threadId: ThreadId.makeUnsafe("thread-atomic"),
        projectId: asProjectId("project-atomic"),
        title: "atomic",
        model: "gpt-5-codex",
        harness: "claudeCode",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const turnStartCommand = {
      type: "thread.turn.start" as const,
      commandId: CommandId.makeUnsafe("cmd-turn-start-atomic"),
      threadId: ThreadId.makeUnsafe("thread-atomic"),
      message: {
        messageId: asMessageId("msg-atomic-1"),
        role: "user" as const,
        text: "hello",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt,
    };

    await expect(runtime.runPromise(engine.dispatch(turnStartCommand))).rejects.toThrow(
      "projection failed",
    );

    const eventsAfterFailure = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterFailure.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
    ]);
    expect((await runtime.runPromise(engine.getReadModel())).snapshotSequence).toBe(2);

    const retryResult = await runtime.runPromise(engine.dispatch(turnStartCommand));
    expect(retryResult.sequence).toBe(4);

    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(
      eventsAfterRetry.filter((event) => event.commandId === turnStartCommand.commandId),
    ).toHaveLength(2);

    await runtime.dispose();
  });

  it("reconciles in-memory state when append persists but projection fails", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;

    const nonTransactionalStore: OrchestrationEventStoreShape = {
      append(event) {
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    let shouldFailProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: (event) => {
        if (
          shouldFailProjection &&
          event.commandId === CommandId.makeUnsafe("cmd-thread-meta-sync-fail")
        ) {
          shouldFailProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.void;
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-sync-create"),
        projectId: asProjectId("project-sync"),
        title: "Sync Project",
        workspaceRoot: "/tmp/project-sync",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-sync-create"),
        threadId: ThreadId.makeUnsafe("thread-sync"),
        projectId: asProjectId("project-sync"),
        title: "sync-before",
        model: "gpt-5-codex",
        harness: "claudeCode",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-thread-meta-sync-fail"),
          threadId: ThreadId.makeUnsafe("thread-sync"),
          title: "sync-after-failed-projection",
        }),
      ),
    ).rejects.toThrow("projection failed");

    const readModelAfterFailure = await runtime.runPromise(engine.getReadModel());
    const updatedThread = readModelAfterFailure.threads.find(
      (thread) => thread.id === "thread-sync",
    );
    expect(readModelAfterFailure.snapshotSequence).toBe(3);
    expect(updatedThread?.title).toBe("sync-after-failed-projection");

    await runtime.dispose();
  });

  it("fails command dispatch when command invariants are violated", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-invariant-missing-thread"),
          threadId: ThreadId.makeUnsafe("thread-missing"),
          message: {
            messageId: asMessageId("msg-missing"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now(),
        }),
      ),
    ).rejects.toThrow("Thread 'thread-missing' does not exist");

    await system.dispose();
  });

  it("authoritatively admits research fairly and persists steering FIFO", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();
    const projectId = asProjectId("project-journey-authority");
    const threadA = ThreadId.makeUnsafe("journey-a");
    const threadB = ThreadId.makeUnsafe("journey-b");

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("journey-project-create"),
        projectId,
        title: "Journey Authority",
        workspaceRoot: "/tmp/journey-authority",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    for (const threadId of [threadA, threadB]) {
      await system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(`create-${threadId}`),
          threadId,
          projectId,
          title: threadId,
          model: "gpt-5-codex",
          harness: "codexCli",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          surface: "journey",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      await system.run(
        engine.dispatch({
          type: "thread.journey.update",
          commandId: CommandId.makeUnsafe(`snapshot-${threadId}`),
          threadId,
          journey: journeySnapshot("research"),
          createdAt,
        }),
      );
      await system.run(
        engine.dispatch({
          type: "journey.run.request",
          commandId: CommandId.makeUnsafe(`request-${threadId}`),
          threadId,
          runId: "research-run",
          nodeId: "research",
          role: "researchWorker",
          harness: "codexCli",
          capabilities: ["graph.read"],
          parentRunId: null,
          coordinatorRunId: null,
          prompt: "research",
          createdAt,
        }),
      );
    }
    await system.run(
      engine.dispatch({
        type: "journey.scheduler.configure",
        commandId: CommandId.makeUnsafe("configure-research-caps"),
        threadId: threadA,
        perJourneyResearchLimit: 1,
        globalResearchLimit: 2,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "journey.run.request",
        commandId: CommandId.makeUnsafe("request-a-second"),
        threadId: threadA,
        runId: "research-run-2",
        nodeId: "research",
        role: "researchWorker",
        harness: "codexCli",
        capabilities: ["graph.read"],
        parentRunId: null,
        coordinatorRunId: null,
        prompt: "more research",
        createdAt,
      }),
    );

    const start = (threadId: ThreadId, suffix: string) =>
      engine.dispatch({
        type: "journey.attempt.start.request",
        commandId: CommandId.makeUnsafe(`start-${suffix}`),
        fence: { threadId, runId: "research-run", nodeId: "research", attempt: 1 },
        capabilities: ["graph.read"],
        createdAt,
      });
    await expect(system.run(start(threadB, "b-too-early"))).rejects.toThrow(
      "next fair scheduler admission",
    );
    await system.run(start(threadA, "a"));
    await system.run(start(threadB, "b"));
    await expect(
      system.run(
        engine.dispatch({
          type: "journey.attempt.start.request",
          commandId: CommandId.makeUnsafe("start-a-second-over-cap"),
          fence: { threadId: threadA, runId: "research-run-2", nodeId: "research", attempt: 1 },
          capabilities: ["graph.read"],
          createdAt,
        }),
      ),
    ).rejects.toThrow("scheduler admission");

    const beforeSteering = await system.run(engine.getJourneyProjection(threadA));
    await system.run(
      engine.dispatch({
        type: "journey.steering.enqueue",
        commandId: CommandId.makeUnsafe("steer-one"),
        threadId: threadA,
        runId: "research-run",
        nodeId: "research",
        itemId: "steer-1",
        prompt: "First",
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "journey.steering.enqueue",
        commandId: CommandId.makeUnsafe("steer-two"),
        threadId: threadA,
        runId: "research-run",
        nodeId: "research",
        itemId: "steer-2",
        prompt: "Second",
        createdAt,
      }),
    );
    await expect(
      system.run(
        engine.dispatch({
          type: "journey.steering.acknowledge",
          commandId: CommandId.makeUnsafe("ack-two-early"),
          threadId: threadA,
          runId: "research-run",
          itemId: "steer-2",
          sequence: 2,
          createdAt,
        }),
      ),
    ).rejects.toThrow("FIFO head");
    await system.run(
      engine.dispatch({
        type: "journey.steering.acknowledge",
        commandId: CommandId.makeUnsafe("ack-one"),
        threadId: threadA,
        runId: "research-run",
        itemId: "steer-1",
        sequence: 1,
        createdAt,
      }),
    );
    const snapshot = await system.run(engine.getJourneyProjection(threadA));
    expect(snapshot.steering.map((item) => [item.id, item.status])).toEqual([
      ["steer-1", "delivered"],
      ["steer-2", "queued"],
    ]);
    const steeringCatchUp = await system.run(
      engine.getJourneyDeltas(threadA, beforeSteering.journeyRevision),
    );
    expect(steeringCatchUp.kind).toBe("deltas");
    if (steeringCatchUp.kind === "deltas") {
      expect(steeringCatchUp.deltas.map((delta) => [delta.fromRevision, delta.toRevision])).toEqual(
        [
          [beforeSteering.journeyRevision, beforeSteering.journeyRevision + 1],
          [beforeSteering.journeyRevision + 1, beforeSteering.journeyRevision + 2],
          [beforeSteering.journeyRevision + 2, beforeSteering.journeyRevision + 3],
        ],
      );
      expect(steeringCatchUp.deltas.at(-1)?.changedEntities.steering).toEqual(snapshot.steering);
    }
    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(events.map((event) => event.type)).toContain("journey.scheduler-admission-recorded");
    expect(events.map((event) => event.type)).toContain("journey.steering-delivered");
    await system.dispose();
  });

  it("rejects cyclic legacy Journey snapshots", async () => {
    const system = await createOrchestrationSystem();
    const createdAt = now();
    const projectId = asProjectId("project-journey-cycle");
    const threadId = ThreadId.makeUnsafe("journey-cycle");
    await system.run(
      system.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cycle-project"),
        projectId,
        title: "Cycle",
        workspaceRoot: "/tmp/journey-cycle",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cycle-thread"),
        threadId,
        projectId,
        title: "Cycle",
        model: "gpt-5-codex",
        harness: "codexCli",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        surface: "journey",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await expect(
      system.run(
        system.engine.dispatch({
          type: "thread.journey.update",
          commandId: CommandId.makeUnsafe("cycle-snapshot"),
          threadId,
          journey: journeySnapshot("a", [
            { id: "a-b", source: "a", target: "b", relation: "dependsOn", label: "" },
            { id: "b-a", source: "b", target: "a", relation: "dependsOn", label: "" },
          ]),
          createdAt,
        }),
      ),
    ).rejects.toThrow("contain a cycle");
    await system.dispose();
  });

  it("serves fenced output and contiguous Journey-only projection catch-up", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();
    const projectId = asProjectId("project-journey-delivery");
    const threadId = ThreadId.makeUnsafe("journey-delivery");
    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("delivery-project"),
        projectId,
        title: "Delivery",
        workspaceRoot: "/tmp/journey-delivery",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("delivery-thread"),
        threadId,
        projectId,
        title: "Delivery",
        model: "gpt-5-codex",
        harness: "codexCli",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        surface: "journey",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.journey.update",
        commandId: CommandId.makeUnsafe("delivery-snapshot"),
        threadId,
        journey: journeySnapshot("research"),
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "journey.run.request",
        commandId: CommandId.makeUnsafe("delivery-run"),
        threadId,
        runId: "delivery-run",
        nodeId: "research",
        role: "researchWorker",
        harness: "codexCli",
        capabilities: ["graph.read"],
        parentRunId: null,
        coordinatorRunId: null,
        prompt: "inspect",
        createdAt,
      }),
    );
    const fence = { threadId, runId: "delivery-run", nodeId: "research", attempt: 1 } as const;
    await system.run(
      engine.dispatch({
        type: "journey.attempt.start.request",
        commandId: CommandId.makeUnsafe("delivery-attempt"),
        fence,
        capabilities: ["graph.read"],
        createdAt,
      }),
    );

    const projection = await system.run(engine.getJourneyProjection(threadId));
    const catchUp = await system.run(engine.getJourneyDeltas(threadId, 0));
    expect(catchUp.kind).toBe("deltas");
    if (catchUp.kind === "deltas") {
      expect(catchUp.deltas.map((delta) => [delta.fromRevision, delta.toRevision])).toEqual([
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 4],
        [4, 5],
      ]);
      expect(catchUp.deltas.at(-1)?.globalEventWatermark).toBe(projection.globalEventWatermark);
    }

    await system.run(engine.beginJourneyRunOutput(fence));
    await system.run(engine.beginJourneyRunOutput(fence));
    await expect(
      system.run(engine.beginJourneyRunOutput({ ...fence, nodeId: "wrong-node" })),
    ).rejects.toThrow(/not authoritative/u);
    await expect(
      system.run(engine.beginJourneyRunOutput({ ...fence, attempt: 2 })),
    ).rejects.toThrow(/not authoritative/u);
    await system.run(engine.appendJourneyRunOutput(fence, "live output"));
    expect(await system.run(engine.getJourneyRunOutput(fence, 0))).toMatchObject({
      fence,
      reset: false,
      nextCursor: 11,
      data: "live output",
    });
    await system.dispose();
  });

  it("restores Journey attempt output after engine recreation", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clui-journey-engine-output-"));
    const databasePath = path.join(tempDir, "state.sqlite");
    const createdAt = now();
    const projectId = asProjectId("project-journey-output-restart");
    const threadId = ThreadId.makeUnsafe("journey-output-restart");
    const fence = { threadId, runId: "restart-run", nodeId: "research", attempt: 1 } as const;
    const first = await createPersistentOrchestrationSystem(databasePath);
    await first.run(
      first.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("restart-output-project"),
        projectId,
        title: "Restart output",
        workspaceRoot: tempDir,
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await first.run(
      first.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("restart-output-thread"),
        threadId,
        projectId,
        title: "Restart output",
        model: "gpt-5-codex",
        harness: "codexCli",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        surface: "journey",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await first.run(
      first.engine.dispatch({
        type: "thread.journey.update",
        commandId: CommandId.makeUnsafe("restart-output-snapshot"),
        threadId,
        journey: journeySnapshot("research"),
        createdAt,
      }),
    );
    await first.run(
      first.engine.dispatch({
        type: "journey.run.request",
        commandId: CommandId.makeUnsafe("restart-output-run"),
        threadId,
        runId: fence.runId,
        nodeId: fence.nodeId,
        role: "researchWorker",
        harness: "codexCli",
        capabilities: ["graph.read"],
        parentRunId: null,
        coordinatorRunId: null,
        prompt: "inspect",
        createdAt,
      }),
    );
    await first.run(
      first.engine.dispatch({
        type: "journey.attempt.start.request",
        commandId: CommandId.makeUnsafe("restart-output-attempt"),
        fence,
        capabilities: ["graph.read"],
        createdAt,
      }),
    );
    await first.run(first.engine.beginJourneyRunOutput(fence));
    await first.run(first.engine.appendJourneyRunOutput(fence, "persistent output"));
    await first.dispose();

    const second = await createPersistentOrchestrationSystem(databasePath);
    expect(await second.run(second.engine.getJourneyRunOutput(fence, 0))).toMatchObject({
      fence,
      nextCursor: 17,
      data: "persistent output",
    });
    expect((await second.run(second.engine.getJourneyProjection(threadId))).journeyRevision).toBe(
      5,
    );
    expect(await second.run(second.engine.getJourneyDeltas(threadId, 0))).toMatchObject({
      kind: "reset",
      snapshot: { threadId, journeyRevision: 5 },
    });
    await second.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects duplicate thread creation", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-duplicate-create"),
        projectId: asProjectId("project-duplicate"),
        title: "Duplicate Project",
        workspaceRoot: "/tmp/project-duplicate",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-duplicate-1"),
        threadId: ThreadId.makeUnsafe("thread-duplicate"),
        projectId: asProjectId("project-duplicate"),
        title: "duplicate",
        model: "gpt-5-codex",
        harness: "claudeCode",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-duplicate-2"),
          threadId: ThreadId.makeUnsafe("thread-duplicate"),
          projectId: asProjectId("project-duplicate"),
          title: "duplicate",
          model: "gpt-5-codex",
          harness: "claudeCode",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already exists");

    await system.dispose();
  });
});
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
