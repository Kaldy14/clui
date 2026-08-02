import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@clui/contracts";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
  createEmptyJourneyDomainState,
  decideJourneyCommand,
  projectJourneyEvent,
  type JourneyDomainState,
  type JourneyEventSpec,
} from "./journeyDomain.ts";
import { decideOrchestrationCommand } from "./decider.ts";
import {
  canonicalJourneyWorkspaceIdentity,
  journeyProposalRevisionHash,
} from "./journeySchedulerPolicy.ts";

const now = "2026-08-02T12:00:00.000Z";
const threadId = ThreadId.makeUnsafe("journey-thread");

const node = (id: string, status: "running" | "completed" = "running") => ({
  id,
  type: id === "research" ? ("research" as const) : ("goal" as const),
  status,
  title: id,
  summary: "",
  detailMarkdown: "",
  todos: [],
  interaction: null,
  activity: [],
  createdAt: now,
  updatedAt: now,
});

function readModel(researchStatus: "running" | "completed" = "completed"): OrchestrationReadModel {
  return {
    snapshotSequence: 10,
    updatedAt: now,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.makeUnsafe("project"),
        title: "Journey",
        model: "gpt",
        harness: "codexCli",
        claudeCodeBackend: "anthropic",
        piRenderMode: "terminal",
        runtimeMode: "full-access",
        interactionMode: "default",
        surface: "journey",
        journey: {
          version: 1,
          destination: "Ship",
          layoutDirection: "TB",
          activeNodeId: "goal",
          nodes: [node("goal"), node("research", researchStatus)],
          edges: [],
          updatedAt: now,
        },
        branch: null,
        worktreePath: null,
        claudeSessionId: null,
        piSessionFile: null,
        terminalStatus: "dormant",
        scrollbackSnapshot: null,
        titleSource: "auto",
        bookmarked: false,
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        lastInteractedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
  };
}

function event(spec: JourneyEventSpec, sequence: number): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: now,
    commandId: CommandId.makeUnsafe(`event-command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: spec.type,
    payload: spec.payload,
  } as OrchestrationEvent;
}

function apply(state: JourneyDomainState, specs: ReadonlyArray<JourneyEventSpec>, from = 1) {
  return specs.reduce(
    (next, spec, index) => projectJourneyEvent(next, event(spec, from + index)),
    state,
  );
}

function decide(command: OrchestrationCommand, state: JourneyDomainState, model = readModel()) {
  const specs = decideJourneyCommand({ command, state, readModel: model });
  if (specs === null) throw new Error("Expected Journey command");
  return specs;
}

function withTemporaryWorkspace<T>(run: (workspaceRoot: string) => T): T {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "clui-journey-domain-"));
  try {
    return run(workspaceRoot);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function requestRun(
  state: JourneyDomainState,
  role: "coordinator" | "researchWorker" = "coordinator",
) {
  const specs = decide(
    {
      type: "journey.run.request",
      commandId: CommandId.makeUnsafe(`request-${role}`),
      threadId,
      runId: "run-1",
      nodeId: "goal",
      role,
      harness: "codexCli",
      capabilities: role === "coordinator" ? ["graph.read", "graph.mutate"] : ["graph.read"],
      parentRunId: null,
      coordinatorRunId: null,
      prompt: "work",
      createdAt: now,
    },
    state,
  );
  return apply(state, specs);
}

describe("Journey authoritative domain", () => {
  it("atomically starts a Journey root graph and coordinator attempt", () => {
    const model = readModel();
    const emptyJourneyModel: OrchestrationReadModel = {
      ...model,
      threads: [{ ...model.threads[0]!, journey: null }],
    };
    const specs = decide(
      {
        type: "journey.root.start",
        commandId: CommandId.makeUnsafe("root-start"),
        threadId,
        destination: "Improve adaptive planning",
        prompt: "Research ambiguity before implementation.",
        harness: "codexCli",
        createdAt: now,
      },
      createEmptyJourneyDomainState(),
      emptyJourneyModel,
    );

    expect(specs.map((candidate) => candidate.type)).toEqual([
      "thread.journey-updated",
      "journey.run-requested",
      "journey.attempt-start-requested",
    ]);
    const projected = apply(createEmptyJourneyDomainState(), specs);
    expect(projected.threads[0]?.runs[0]).toMatchObject({
      role: "coordinator",
      status: "starting",
      attempt: 1,
    });
    expect(projected.threads[0]?.attempts).toHaveLength(1);
  });

  it("removes only durable queued steering items", () => {
    const base = requestRun(createEmptyJourneyDomainState());
    const queued = apply(
      base,
      [
        {
          type: "journey.steering-enqueued",
          payload: {
            id: "steer-1",
            threadId,
            runId: "run-1",
            nodeId: "goal",
            sequence: 1,
            prompt: "Change direction",
            status: "queued",
            createdAt: now,
            deliveredAt: null,
          },
        },
      ],
      2,
    );
    expect(queued.threads[0]?.steering).toEqual([
      expect.objectContaining({ id: "steer-1", status: "queued" }),
    ]);
    const specs = decide(
      {
        type: "journey.steering.remove",
        commandId: CommandId.makeUnsafe("remove-steering"),
        threadId,
        runId: "run-1",
        itemId: "steer-1",
        createdAt: now,
      },
      queued,
    );
    expect(specs.map((candidate) => candidate.type)).toEqual(["journey.steering-removed"]);
    expect(apply(queued, specs).threads[0]?.steering).toEqual([]);
  });

  it("atomically decides a real draft research node, logical run, permit, and one starting attempt", () => {
    let state = requestRun(createEmptyJourneyDomainState());
    const parentFence = { threadId, runId: "run-1", nodeId: "goal", attempt: 1 } as const;
    state = apply(
      state,
      decide(
        {
          type: "journey.attempt.start.request",
          commandId: CommandId.makeUnsafe("parent-start"),
          fence: parentFence,
          capabilities: ["graph.read", "graph.mutate"],
          createdAt: now,
        },
        state,
      ),
      2,
    );
    state = apply(
      state,
      decide(
        {
          type: "journey.attempt.started",
          commandId: CommandId.makeUnsafe("parent-started"),
          fence: parentFence,
          adapterEventId: "parent-started",
          resumableHarnessIdentity: null,
          createdAt: now,
        },
        state,
      ),
      3,
    );

    const specs = decide(
      {
        type: "journey.child.start",
        commandId: CommandId.makeUnsafe("child-start"),
        parentFence,
        childKind: "research",
        runId: "child-run",
        nodeId: "child-node",
        title: "Investigate boundary",
        instructions: "Find the authoritative boundary.",
        harness: "codexCli",
        createdAt: now,
      },
      state,
    );
    expect(specs.map((candidate) => candidate.type)).toEqual([
      "thread.journey-updated",
      "journey.run-requested",
      "journey.scheduler-admission-recorded",
      "journey.permit-claimed",
      "journey.attempt-start-requested",
    ]);
    const graphEvent = specs[0]!.payload as {
      journey: ReturnType<typeof readModel>["threads"][number]["journey"];
    };
    expect(
      graphEvent.journey?.nodes.find((candidate) => candidate.id === "child-node"),
    ).toMatchObject({
      type: "research",
      status: "draft",
      title: "Investigate boundary",
    });
    expect(graphEvent.journey?.edges).toContainEqual(
      expect.objectContaining({ source: "goal", target: "child-node", relation: "spawns" }),
    );
    state = apply(state, specs, 4);
    expect(
      state.threads[0]?.runs.find((candidate) => candidate.runId === "child-run"),
    ).toMatchObject({
      status: "starting",
      attempt: 1,
      role: "researchWorker",
    });
    expect(
      state.threads[0]?.attempts.filter((candidate) => candidate.fence.runId === "child-run"),
    ).toHaveLength(1);
    expect(state.threads[0]?.permits).toHaveLength(1);

    const baseModel = readModel();
    const modelWithDraft: OrchestrationReadModel = {
      ...baseModel,
      threads: [{ ...baseModel.threads[0]!, journey: graphEvent.journey }],
    };
    const ack = decide(
      {
        type: "journey.attempt.started",
        commandId: CommandId.makeUnsafe("child-ack"),
        fence: { threadId, runId: "child-run", nodeId: "child-node", attempt: 1 },
        adapterEventId: "child-ack",
        resumableHarnessIdentity: null,
        createdAt: now,
      },
      state,
      modelWithDraft,
    );
    expect(ack.map((candidate) => candidate.type)).toEqual([
      "thread.journey-updated",
      "journey.attempt-started",
    ]);
    expect(
      (
        ack[0]!.payload as {
          journey: NonNullable<ReturnType<typeof readModel>["threads"][number]["journey"]>;
        }
      ).journey.nodes.find((candidate) => candidate.id === "child-node")?.status,
    ).toBe("running");
  });

  it("durably queues an atomic research child when scheduler capacity is full", () => {
    let state = requestRun(createEmptyJourneyDomainState());
    const parentFence = { threadId, runId: "run-1", nodeId: "goal", attempt: 1 } as const;
    state = apply(
      state,
      decide(
        {
          type: "journey.attempt.start.request",
          commandId: CommandId.makeUnsafe("capacity-parent-start"),
          fence: parentFence,
          capabilities: ["graph.read", "graph.mutate"],
          createdAt: now,
        },
        state,
      ),
      2,
    );
    state = apply(
      state,
      decide(
        {
          type: "journey.attempt.started",
          commandId: CommandId.makeUnsafe("capacity-parent-started"),
          fence: parentFence,
          adapterEventId: "capacity-parent-started",
          resumableHarnessIdentity: null,
          createdAt: now,
        },
        state,
      ),
      3,
    );
    state = {
      ...state,
      scheduler: {
        globalResearchLimit: 1,
        journeyResearchLimits: [{ threadId, limit: 1 }],
        lastAdmittedJourneyId: null,
      },
      threads: state.threads.map((projection) => ({
        ...projection,
        runs: [
          ...projection.runs,
          {
            ...projection.runs[0]!,
            runId: "active-research",
            nodeId: "research",
            role: "researchWorker" as const,
            capabilities: ["graph.read"] as const,
            status: "running" as const,
            parentRunId: "run-1",
            coordinatorRunId: "run-1",
          },
        ],
      })),
    };

    const specs = decide(
      {
        type: "journey.child.start",
        commandId: CommandId.makeUnsafe("capacity-child-start"),
        parentFence,
        childKind: "research",
        runId: "queued-child",
        nodeId: "queued-child-node",
        title: "Queued research",
        instructions: "Wait for a permit.",
        harness: "codexCli",
        createdAt: now,
      },
      state,
    );

    expect(specs.map((candidate) => candidate.type)).toEqual([
      "thread.journey-updated",
      "journey.run-requested",
    ]);
    const projected = apply(state, specs, 4).threads[0]!;
    expect(projected.runs.find((run) => run.runId === "queued-child")).toMatchObject({
      status: "queued",
      attempt: 0,
    });
    expect(projected.attempts.some((attempt) => attempt.fence.runId === "queued-child")).toBe(
      false,
    );
  });

  it("cascades node deletion through the full nonterminal run descendant closure", () => {
    const base = requestRun(createEmptyJourneyDomainState());
    const root = { ...base.threads[0]!.runs[0]!, status: "running" as const, attempt: 1 };
    const child = {
      ...root,
      runId: "child-run",
      nodeId: "research",
      role: "researchWorker" as const,
      capabilities: ["graph.read"] as const,
      parentRunId: root.runId,
      coordinatorRunId: root.runId,
    };
    const grandchild = {
      ...child,
      runId: "grandchild-run",
      nodeId: "grandchild",
      parentRunId: child.runId,
    };
    const state: JourneyDomainState = {
      ...base,
      threads: [{ ...base.threads[0]!, runs: [root, child, grandchild] }],
    };
    const model = readModel();
    const journey = model.threads[0]!.journey!;
    const deletionModel: OrchestrationReadModel = {
      ...model,
      threads: [
        {
          ...model.threads[0]!,
          journey: {
            ...journey,
            nodes: [...journey.nodes, node("grandchild")],
          },
        },
      ],
    };

    const specs = decide(
      {
        type: "journey.node.delete",
        commandId: CommandId.makeUnsafe("delete-root-closure"),
        threadId,
        nodeId: "goal",
        createdAt: now,
      },
      state,
      deletionModel,
    );

    expect(specs[0]?.type).toBe("journey.node-deletion-requested");
    expect(
      specs
        .filter((event) => event.type === "journey.run-cancellation-requested")
        .map((event) => (event.payload as { runId: string }).runId),
    ).toEqual(["grandchild-run", "child-run", "run-1"]);
  });

  it("rejects composite child starts before returning any partial event specification", () => {
    const state = requestRun(createEmptyJourneyDomainState());
    expect(() =>
      decide(
        {
          type: "journey.child.start",
          commandId: CommandId.makeUnsafe("invalid-child"),
          parentFence: { threadId, runId: "run-1", nodeId: "goal", attempt: 1 },
          childKind: "implementation",
          runId: "implementation",
          nodeId: "implementation",
          title: "Implement",
          instructions: "Implement safely.",
          harness: "codexCli",
          canonicalWorkspaceIdentity: "/trusted#1:2",
          createdAt: now,
        },
        state,
      ),
    ).toThrow("current running parent attempt");
    expect(state.threads[0]?.runs).toHaveLength(1);
    expect(state.threads[0]?.attempts).toHaveLength(0);
  });

  it("rejects stale attempt fences without changing the projection", () => {
    let state = requestRun(createEmptyJourneyDomainState());
    const start = decide(
      {
        type: "journey.attempt.start.request",
        commandId: CommandId.makeUnsafe("start"),
        fence: { threadId, runId: "run-1", nodeId: "goal", attempt: 1 },
        capabilities: ["graph.read", "graph.mutate"],
        createdAt: now,
      },
      state,
    );
    state = apply(state, start, 2);

    expect(() =>
      decide(
        {
          type: "journey.attempt.started",
          commandId: CommandId.makeUnsafe("stale"),
          fence: { threadId, runId: "run-1", nodeId: "goal", attempt: 2 },
          adapterEventId: "adapter-stale",
          resumableHarnessIdentity: null,
          createdAt: now,
        },
        state,
      ),
    ).toThrow("Stale Journey attempt fence");
    expect(state.threads[0]?.runs[0]?.status).toBe("starting");
  });

  it("registers an already-ready wait and starts exactly one next attempt", () => {
    let state = requestRun(createEmptyJourneyDomainState());
    state = apply(
      state,
      decide(
        {
          type: "journey.attempt.start.request",
          commandId: CommandId.makeUnsafe("start"),
          fence: { threadId, runId: "run-1", nodeId: "goal", attempt: 1 },
          capabilities: ["graph.read", "graph.mutate"],
          createdAt: now,
        },
        state,
      ),
      2,
    );
    state = apply(
      state,
      decide(
        {
          type: "journey.attempt.started",
          commandId: CommandId.makeUnsafe("started"),
          fence: { threadId, runId: "run-1", nodeId: "goal", attempt: 1 },
          adapterEventId: "adapter-started",
          resumableHarnessIdentity: "process-1",
          createdAt: now,
        },
        state,
      ),
      3,
    );
    const outcome = {
      kind: "waitForDependencies" as const,
      successDependencyNodeIds: ["research"],
      observeTerminalRunIds: [],
      reason: "converge",
    };
    const quiesceRequestEvents = decide(
      {
        type: "journey.attempt.quiesce.request",
        commandId: CommandId.makeUnsafe("wait"),
        fence: { threadId, runId: "run-1", nodeId: "goal", attempt: 1 },
        adapterEventId: "adapter-wait",
        outcome,
        createdAt: now,
      },
      state,
    );
    expect(quiesceRequestEvents.map((candidate) => candidate.type)).toEqual([
      "journey.attempt-quiesce-requested",
    ]);
    state = apply(state, quiesceRequestEvents, 4);
    const quiescedEvents = decide(
      {
        type: "journey.attempt.quiesced",
        commandId: CommandId.makeUnsafe("wait-quiesced"),
        fence: { threadId, runId: "run-1", nodeId: "goal", attempt: 1 },
        adapterEventId: "adapter-wait-quiesced",
        outcome,
        createdAt: now,
      },
      state,
    );
    expect(quiescedEvents.map((candidate) => candidate.type)).toEqual([
      "journey.attempt-quiesced",
      "journey.run-waiting-for-dependencies",
      "journey.wait-wake-accepted",
      "journey.attempt-start-requested",
    ]);
    state = apply(state, quiescedEvents, 5);
    expect(state.threads[0]?.runs[0]).toMatchObject({ status: "starting", attempt: 2 });
    expect(state.threads[0]?.attempts).toHaveLength(2);
    expect(state.threads[0]?.waits[0]?.acceptedWakeGeneration).toBe(1);
    expect(state.threads[0]?.waits[0]?.consumedWakeGeneration).toBe(1);
  });

  it("records an answer during quiescence and wakes that wait exactly once", () => {
    const baseModel = readModel();
    const model: OrchestrationReadModel = {
      ...baseModel,
      threads: [
        {
          ...baseModel.threads[0]!,
          journey: {
            ...baseModel.threads[0]!.journey!,
            nodes: baseModel.threads[0]!.journey!.nodes.map((candidate) =>
              candidate.id === "goal"
                ? Object.assign({}, candidate, {
                    interaction: {
                      id: "decision-1",
                      title: "Choose scope",
                      description: "Select the implementation scope.",
                      steps: [],
                      activeStepId: null,
                      answers: {},
                      submittedAt: null,
                      submitLabel: "Continue",
                    },
                  })
                : candidate,
            ),
          },
        },
      ],
    };
    let state = requestRun(createEmptyJourneyDomainState());
    let sequence = 2;
    const applyNext = (specs: ReadonlyArray<JourneyEventSpec>) => {
      state = apply(state, specs, sequence);
      sequence += specs.length;
    };
    const fence = { threadId, runId: "run-1", nodeId: "goal", attempt: 1 } as const;
    applyNext(
      decide(
        {
          type: "journey.attempt.start.request",
          commandId: CommandId.makeUnsafe("answer-race-start"),
          fence,
          capabilities: ["graph.read", "graph.mutate"],
          createdAt: now,
        },
        state,
        model,
      ),
    );
    applyNext(
      decide(
        {
          type: "journey.attempt.started",
          commandId: CommandId.makeUnsafe("answer-race-started"),
          fence,
          adapterEventId: "answer-race-started",
          resumableHarnessIdentity: null,
          createdAt: now,
        },
        state,
        model,
      ),
    );
    const outcome = {
      kind: "waitForUser" as const,
      interactionId: "decision-1",
      decisionNodeId: "goal",
      reason: "Need user scope",
    };
    applyNext(
      decide(
        {
          type: "journey.attempt.quiesce.request",
          commandId: CommandId.makeUnsafe("answer-race-quiesce"),
          fence,
          adapterEventId: "answer-race-quiesce",
          outcome,
          createdAt: now,
        },
        state,
        model,
      ),
    );
    const answer = {
      type: "journey.decision.submit" as const,
      commandId: CommandId.makeUnsafe("answer-during-quiesce"),
      submission: {
        threadId,
        interactionId: "decision-1",
        decisionNodeId: "goal",
        answers: { scope: "minimal" },
        actor: { kind: "user" as const, id: "user" },
        submittedAt: now,
      },
    };
    const answerSpecs = decide(answer, state, model);
    expect(answerSpecs.map((candidate) => candidate.type)).toEqual(["journey.decision-recorded"]);
    applyNext(answerSpecs);
    const quiesced = decide(
      {
        type: "journey.attempt.quiesced",
        commandId: CommandId.makeUnsafe("answer-race-quiesced"),
        fence,
        adapterEventId: "answer-race-quiesced",
        outcome,
        createdAt: now,
      },
      state,
      model,
    );
    expect(quiesced.map((candidate) => candidate.type)).toEqual([
      "journey.attempt-quiesced",
      "journey.run-waiting-for-user",
      "journey.wait-wake-accepted",
      "journey.attempt-start-requested",
    ]);
    applyNext(quiesced);
    expect(state.threads[0]?.runs[0]).toMatchObject({ status: "starting", attempt: 2 });
    expect(() =>
      decide({ ...answer, commandId: CommandId.makeUnsafe("answer-again") }, state, model),
    ).toThrow("already been answered");
  });

  it("rejects direct starts before wake acceptance and cannot double-start after consumption", () => {
    let state = requestRun(createEmptyJourneyDomainState());
    const fence = { threadId, runId: "run-1", nodeId: "goal", attempt: 1 } as const;
    state = apply(
      state,
      decide(
        {
          type: "journey.attempt.start.request",
          commandId: CommandId.makeUnsafe("start-race"),
          fence,
          capabilities: ["graph.read", "graph.mutate"],
          createdAt: now,
        },
        state,
      ),
      2,
    );
    state = apply(
      state,
      decide(
        {
          type: "journey.attempt.started",
          commandId: CommandId.makeUnsafe("started-race"),
          fence,
          adapterEventId: "started-race",
          resumableHarnessIdentity: null,
          createdAt: now,
        },
        state,
      ),
      3,
    );
    const outcome = {
      kind: "waitForDependencies" as const,
      successDependencyNodeIds: ["research"],
      observeTerminalRunIds: [],
      reason: "wait",
    };
    const quiesceRequestEvents = decide(
      {
        type: "journey.attempt.quiesce.request",
        commandId: CommandId.makeUnsafe("wait-race"),
        fence,
        adapterEventId: "wait-race",
        outcome,
        createdAt: now,
      },
      state,
      readModel("running"),
    );
    state = apply(state, quiesceRequestEvents, 4);
    state = apply(
      state,
      decide(
        {
          type: "journey.attempt.quiesced",
          commandId: CommandId.makeUnsafe("wait-race-quiesced"),
          fence,
          adapterEventId: "wait-race-quiesced",
          outcome,
          createdAt: now,
        },
        state,
        readModel("running"),
      ),
      5,
    );
    const nextFence = { ...fence, attempt: 2 };
    expect(() =>
      decide(
        {
          type: "journey.attempt.start.request",
          commandId: CommandId.makeUnsafe("illegal-direct-start"),
          fence: nextFence,
          capabilities: ["graph.read", "graph.mutate"],
          createdAt: now,
        },
        state,
      ),
    ).toThrow("accepted, unconsumed wake generation");

    const evaluation = decide(
      {
        type: "journey.wait.evaluate",
        commandId: CommandId.makeUnsafe("evaluate-ready"),
        threadId,
        runId: "run-1",
        nodeId: "goal",
        waitGeneration: 1,
        triggerEventSequence: 11,
        createdAt: now,
      },
      state,
    );
    expect(evaluation.map((candidate) => candidate.type)).toEqual([
      "journey.wait-wake-accepted",
      "journey.attempt-start-requested",
    ]);
    state = apply(state, evaluation, 6);
    expect(state.threads[0]?.runs[0]).toMatchObject({ status: "starting", attempt: 2 });
    expect(() =>
      decide(
        {
          type: "journey.wait.evaluate",
          commandId: CommandId.makeUnsafe("evaluate-duplicate"),
          threadId,
          runId: "run-1",
          nodeId: "goal",
          waitGeneration: 1,
          triggerEventSequence: 12,
          createdAt: now,
        },
        state,
      ),
    ).toThrow("no longer in the matching wait generation");
  });

  it("rebuilds the same run projection by replaying the committed event stream", () => {
    const initial = createEmptyJourneyDomainState();
    const requested = decide(
      {
        type: "journey.run.request",
        commandId: CommandId.makeUnsafe("request-replay"),
        threadId,
        runId: "run-1",
        nodeId: "goal",
        role: "researchWorker",
        harness: "pi",
        capabilities: ["graph.read", "research.read"],
        parentRunId: null,
        coordinatorRunId: null,
        prompt: "research",
        createdAt: now,
      },
      initial,
    );
    const projected = apply(initial, requested);
    const committedEvents = requested.map((spec, index) => event(spec, index + 1));
    const replayed = committedEvents.reduce(projectJourneyEvent, createEmptyJourneyDomainState());
    expect(replayed).toEqual(projected);
  });

  it("replays complete lifecycle, interaction, ownership, and reconciliation metadata", () => {
    const coordinatorFence = { threadId, runId: "coordinator", nodeId: "goal", attempt: 1 };
    const implementationFence = {
      threadId,
      runId: "implementation",
      nodeId: "goal",
      attempt: 1,
    };
    const run = (
      runId: string,
      role: "coordinator" | "implementationOwner",
      capabilities: ReadonlyArray<"graph.read" | "repository.write">,
    ) => ({
      threadId,
      runId,
      nodeId: "goal",
      role,
      harness: "codexCli" as const,
      status: "queued" as const,
      attempt: 0,
      capabilities,
      parentRunId: null,
      coordinatorRunId: role === "coordinator" ? null : "coordinator",
      canonicalWorkspaceLeaseId: null,
      outputStreamId: `${threadId}:${runId}`,
      failureReason: null,
      resumableHarnessIdentity: null,
      createdAt: now,
      updatedAt: now,
    });
    const waitOutcome = {
      kind: "waitForDependencies" as const,
      successDependencyNodeIds: ["research"],
      observeTerminalRunIds: [],
      reason: "converge",
    };
    const specs: JourneyEventSpec[] = [
      {
        type: "journey.run-requested",
        payload: { run: run("coordinator", "coordinator", ["graph.read"]), prompt: "plan" },
      },
      {
        type: "journey.attempt-start-requested",
        payload: { fence: coordinatorFence, capabilities: ["graph.read"] },
      },
      {
        type: "journey.attempt-started",
        payload: { fence: coordinatorFence, resumableHarnessIdentity: "coordinator-process" },
      },
      {
        type: "journey.permit-claimed",
        payload: { fence: coordinatorFence, permitId: "permit-coordinator" },
      },
      {
        type: "journey.attempt-quiesce-requested",
        payload: { fence: coordinatorFence, outcome: waitOutcome, waitGeneration: 1 },
      },
      {
        type: "journey.run-waiting-for-dependencies",
        payload: {
          fence: coordinatorFence,
          status: "waitingForDependencies",
          waitGeneration: 1,
          acceptedWakeGeneration: null,
        },
      },
      {
        type: "journey.wait-wake-accepted",
        payload: {
          fence: coordinatorFence,
          waitGeneration: 1,
          acceptedWakeGeneration: 1,
          triggerEventSequence: 7,
        },
      },
      {
        type: "journey.attempt-start-requested",
        payload: {
          fence: { ...coordinatorFence, attempt: 2 },
          capabilities: ["graph.read"],
        },
      },
      {
        type: "journey.decision-recorded",
        payload: {
          threadId,
          interactionId: "decision-1",
          decisionNodeId: "goal",
          answers: { scope: "minimal" },
          actor: { kind: "user", id: "user-1" },
          submittedAt: now,
        },
      },
      {
        type: "journey.approval-recorded",
        payload: {
          threadId,
          interactionId: "approval-1",
          proposalNodeId: "goal",
          proposalRevisionHash: "a".repeat(64),
          actor: { kind: "user", id: "user-1" },
          answer: "approved",
          timestamp: now,
        },
      },
      {
        type: "journey.run-requested",
        payload: {
          run: run("implementation", "implementationOwner", ["graph.read", "repository.write"]),
          prompt: "implement",
        },
      },
      {
        type: "journey.writer-lease-claimed",
        payload: {
          fence: implementationFence,
          leaseId: "writer-1",
          canonicalWorkspaceId: "/workspace",
        },
      },
      {
        type: "journey.attempt-start-requested",
        payload: {
          fence: implementationFence,
          capabilities: ["graph.read", "repository.write"],
          canonicalWorkspaceId: "/workspace",
        },
      },
      {
        type: "journey.run-interrupted",
        payload: {
          fence: implementationFence,
          reason: "server restart",
          orphanProcessPossible: true,
        },
      },
      {
        type: "journey.reconciled",
        payload: {
          fence: implementationFence,
          observation: "workspaceDirty",
          detail: "uncommitted repository changes remain",
        },
      },
    ];
    const projected = apply(createEmptyJourneyDomainState(), specs);
    const committed = specs.map((spec, index) => event(spec, index + 1));
    const replayed = committed.reduce(projectJourneyEvent, createEmptyJourneyDomainState());
    expect(replayed).toEqual(projected);
    const projection = replayed.threads[0]!;
    expect(projection.waits[0]).toMatchObject({
      acceptedWakeGeneration: 1,
      consumedWakeGeneration: 1,
    });
    expect(projection.decisions[0]).toMatchObject({
      interactionId: "decision-1",
      answers: { scope: "minimal" },
    });
    expect(projection.approvals[0]).toMatchObject({ answer: "approved" });
    expect(projection.permits[0]).toMatchObject({ permitId: "permit-coordinator" });
    expect(projection.writerLeases[0]).toMatchObject({
      leaseId: "writer-1",
      canonicalWorkspaceId: "/workspace",
    });
    expect(projection.runs.find((candidate) => candidate.runId === "implementation")).toMatchObject(
      { status: "interrupted", canonicalWorkspaceLeaseId: "writer-1" },
    );
    expect(projection.reconciliations[0]).toMatchObject({
      observation: "workspaceDirty",
      detail: "uncommitted repository changes remain",
    });
  });

  it("allows reconciliation of only the current interrupted attempt", () => {
    let state = requestRun(createEmptyJourneyDomainState(), "researchWorker");
    state = apply(
      state,
      decide(
        {
          type: "journey.attempt.start.request",
          commandId: CommandId.makeUnsafe("start-research"),
          fence: { threadId, runId: "run-1", nodeId: "goal", attempt: 1 },
          capabilities: ["graph.read"],
          createdAt: now,
        },
        state,
      ),
      2,
    );
    state = apply(
      state,
      decide(
        {
          type: "journey.permit.claim",
          commandId: CommandId.makeUnsafe("claim-before-interrupt"),
          fence: { threadId, runId: "run-1", nodeId: "goal", attempt: 1 },
          permitId: "research-permit",
          createdAt: now,
        },
        state,
      ),
      3,
    );
    state = apply(
      state,
      decide(
        {
          type: "journey.run.interrupt",
          commandId: CommandId.makeUnsafe("interrupt"),
          fence: { threadId, runId: "run-1", nodeId: "goal", attempt: 1 },
          adapterEventId: "adapter-interrupt",
          reason: "lost process",
          orphanProcessPossible: true,
          createdAt: now,
        },
        state,
      ),
      4,
    );
    state = apply(
      state,
      decide(
        {
          type: "journey.reconcile.observe",
          commandId: CommandId.makeUnsafe("reconcile"),
          fence: { threadId, runId: "run-1", nodeId: "goal", attempt: 1 },
          adapterEventId: "adapter-reconcile",
          observation: "processAbsent",
          detail: "not found",
          createdAt: now,
        },
        state,
      ),
      5,
    );
    expect(state.threads[0]?.recoveryAuthorizedRunIds).toEqual(["run-1"]);
    expect(state.threads[0]?.permits).toEqual([]);
  });

  it("enforces the cancellation transition matrix without reopening terminal attempts", () => {
    const withStatus = (status: string) => {
      let state = requestRun(createEmptyJourneyDomainState());
      if (status === "queued") return state;
      state = apply(
        state,
        decide(
          {
            type: "journey.attempt.start.request",
            commandId: CommandId.makeUnsafe(`start-${status}`),
            fence: { threadId, runId: "run-1", nodeId: "goal", attempt: 1 },
            capabilities: ["graph.read", "graph.mutate"],
            createdAt: now,
          },
          state,
        ),
        2,
      );
      const attemptStatus =
        status === "starting"
          ? "starting"
          : status === "cancelling"
            ? "cancelling"
            : ["completed", "failed", "cancelled", "interrupted"].includes(status)
              ? status
              : status.startsWith("waiting")
                ? "completed"
                : "running";
      return {
        threads: [
          {
            ...state.threads[0]!,
            runs: state.threads[0]!.runs.map((run) =>
              Object.assign({}, run, { status: status as never }),
            ),
            attempts: state.threads[0]!.attempts.map((attempt) =>
              Object.assign({}, attempt, { status: attemptStatus as never }),
            ),
          },
        ],
      } satisfies JourneyDomainState;
    };

    for (const [status, expected] of [
      ["queued", "cancelled"],
      ["starting", "cancelling"],
      ["running", "cancelling"],
      ["quiescing", "cancelling"],
      ["waitingForDependencies", "cancelled"],
      ["waitingForUser", "cancelled"],
    ] as const) {
      const state = withStatus(status);
      const cancelled = apply(
        state,
        decide(
          {
            type: "journey.run.cancel",
            commandId: CommandId.makeUnsafe(`cancel-${status}`),
            threadId,
            runId: "run-1",
            nodeId: "goal",
            reason: "stop",
            createdAt: now,
          },
          state,
        ),
        20,
      );
      expect(cancelled.threads[0]?.runs[0]?.status).toBe(expected);
      if (status.startsWith("waiting")) {
        expect(cancelled.threads[0]?.attempts[0]?.status).toBe("completed");
      }
    }

    for (const status of ["cancelling", "completed", "failed", "cancelled", "interrupted"]) {
      const state = withStatus(status);
      expect(() =>
        decide(
          {
            type: "journey.run.cancel",
            commandId: CommandId.makeUnsafe(`reject-cancel-${status}`),
            threadId,
            runId: "run-1",
            nodeId: "goal",
            reason: "stop",
            createdAt: now,
          },
          state,
        ),
      ).toThrow("cannot be cancelled");
    }

    const cancelling = withStatus("cancelling");
    expect(
      decide(
        {
          type: "journey.attempt.fail",
          commandId: CommandId.makeUnsafe("cancel-failure"),
          fence: { threadId, runId: "run-1", nodeId: "goal", attempt: 1 },
          adapterEventId: "cancel-failure",
          failureKind: "adapterError",
          reason: "cancellation acknowledgement was lost",
          createdAt: now,
        },
        cancelling,
      ).map((candidate) => candidate.type),
    ).toEqual(["journey.run-interrupted"]);
  });

  it("reserves terminal interrupted fences exclusively for reconciliation", () => {
    let state = requestRun(createEmptyJourneyDomainState(), "researchWorker");
    state = apply(
      state,
      decide(
        {
          type: "journey.attempt.start.request",
          commandId: CommandId.makeUnsafe("start-terminal-fence"),
          fence: { threadId, runId: "run-1", nodeId: "goal", attempt: 1 },
          capabilities: ["graph.read"],
          createdAt: now,
        },
        state,
      ),
      2,
    );
    state = {
      threads: state.threads.map((thread) => ({
        ...thread,
        runs: thread.runs.map((run) => ({ ...run, status: "interrupted" as const })),
        attempts: thread.attempts.map((attempt) => ({
          ...attempt,
          status: "interrupted" as const,
        })),
      })),
    };
    expect(() =>
      decide(
        {
          type: "journey.permit.claim",
          commandId: CommandId.makeUnsafe("permit-terminal-fence"),
          fence: { threadId, runId: "run-1", nodeId: "goal", attempt: 1 },
          permitId: "permit-1",
          createdAt: now,
        },
        state,
      ),
    ).toThrow("Normal Journey callbacks cannot target a terminal attempt");
    const reattached = apply(
      state,
      decide(
        {
          type: "journey.reconcile.observe",
          commandId: CommandId.makeUnsafe("reconcile-terminal-fence"),
          fence: { threadId, runId: "run-1", nodeId: "goal", attempt: 1 },
          adapterEventId: "reconcile-terminal-fence",
          observation: "reattached",
          detail: "matched process marker",
          createdAt: now,
        },
        state,
      ),
      4,
    );
    expect(reattached.threads[0]?.runs[0]).toMatchObject({
      status: "running",
      failureReason: null,
    });
    expect(reattached.threads[0]?.attempts[0]).toMatchObject({
      status: "running",
      completedAt: null,
      failureReason: null,
    });
    expect(reattached.threads[0]?.reconciliations[0]).toMatchObject({
      observation: "reattached",
      detail: "matched process marker",
    });
  });

  it("guards revision-bound implementation starts while allowing simple starts", () => {
    withTemporaryWorkspace((workspaceRoot) => {
      const requested = decide(
        {
          type: "journey.run.request",
          commandId: CommandId.makeUnsafe("request-implementation"),
          threadId,
          runId: "implementation",
          nodeId: "goal",
          role: "implementationOwner",
          harness: "codexCli",
          capabilities: ["graph.read", "repository.write"],
          parentRunId: null,
          coordinatorRunId: null,
          prompt: "implement",
          createdAt: now,
        },
        createEmptyJourneyDomainState(),
      );
      const state = apply(createEmptyJourneyDomainState(), requested);
      const simpleModel = readModel();
      const proposalNode = {
        ...simpleModel.threads[0]!.journey!.nodes[0]!,
        id: "proposal",
        type: "proposal" as const,
        interaction: {
          id: "approval",
          title: "Approve",
          description: "Approve plan",
          steps: [],
          activeStepId: null,
          answers: {},
          submittedAt: null,
          submitLabel: "Approve",
        },
      };
      const complexModel: OrchestrationReadModel = {
        ...simpleModel,
        threads: [
          {
            ...simpleModel.threads[0]!,
            journey: {
              ...simpleModel.threads[0]!.journey!,
              nodes: [...simpleModel.threads[0]!.journey!.nodes, proposalNode],
            },
          },
        ],
      };
      const proposalHash = journeyProposalRevisionHash(
        complexModel.threads[0]!.journey!,
        "proposal",
      );
      const start = (proposalRevisionHash?: string, model = simpleModel) =>
        decide(
          {
            type: "journey.attempt.start.request",
            commandId: CommandId.makeUnsafe(
              `start-implementation-${proposalRevisionHash ?? "simple"}`,
            ),
            fence: {
              threadId,
              runId: "implementation",
              nodeId: "goal",
              attempt: 1,
            },
            capabilities: ["graph.read", "repository.write"],
            canonicalWorkspaceId: workspaceRoot,
            ...(proposalRevisionHash ? { proposalRevisionHash } : {}),
            createdAt: now,
          },
          state,
          model,
        );
      expect(start().map((candidate) => candidate.type)).toEqual([
        "journey.writer-lease-claimed",
        "journey.attempt-start-requested",
      ]);
      expect(() => start(proposalHash, complexModel)).toThrow("current revision approval");
      const approved: JourneyDomainState = {
        threads: state.threads.map((projection) =>
          Object.assign({}, projection, {
            approvals: [
              {
                interactionId: "approval",
                proposalNodeId: "proposal",
                proposalRevisionHash: proposalHash,
                actor: { kind: "user" as const, id: "user" },
                answer: "approved" as const,
                timestamp: now,
              },
            ],
          }),
        ),
      };
      expect(
        decide(
          {
            type: "journey.attempt.start.request",
            commandId: CommandId.makeUnsafe("start-approved"),
            fence: {
              threadId,
              runId: "implementation",
              nodeId: "goal",
              attempt: 1,
            },
            capabilities: ["graph.read", "repository.write"],
            canonicalWorkspaceId: workspaceRoot,
            proposalRevisionHash: proposalHash,
            createdAt: now,
          },
          approved,
          complexModel,
        ).map((candidate) => candidate.type),
      ).toEqual(["journey.writer-lease-claimed", "journey.attempt-start-requested"]);

      const conflicting: JourneyDomainState = {
        threads: [
          ...state.threads,
          {
            threadId: ThreadId.makeUnsafe("other-journey"),
            journeyRevision: 1,
            globalEventWatermark: 1,
            runs: [],
            attempts: [],
            approvals: [],
            decisions: [],
            waits: [],
            permits: [],
            writerLeases: [
              {
                leaseId: "other-writer",
                canonicalWorkspaceId: canonicalJourneyWorkspaceIdentity(workspaceRoot),
                fence: {
                  threadId: ThreadId.makeUnsafe("other-journey"),
                  runId: "implementation",
                  nodeId: "other-node",
                  attempt: 1,
                },
              },
            ],
            decidedInteractionIds: [],
            recoveryAuthorizedRunIds: [],
            reconciliations: [],
          },
        ],
      };
      expect(() =>
        decide(
          {
            type: "journey.attempt.start.request",
            commandId: CommandId.makeUnsafe("start-conflicting-writer"),
            fence: {
              threadId,
              runId: "implementation",
              nodeId: "goal",
              attempt: 1,
            },
            capabilities: ["graph.read", "repository.write"],
            canonicalWorkspaceId: workspaceRoot,
            createdAt: now,
          },
          conflicting,
        ),
      ).toThrow("is leased");
    });
  });

  it("invalidates approved revisions atomically with material graph mutation", async () => {
    const model = readModel();
    const currentNode = model.threads[0]!.journey!.nodes[0]!;
    const state: JourneyDomainState = {
      threads: [
        {
          threadId,
          journeyRevision: 1,
          globalEventWatermark: 1,
          runs: [],
          attempts: [],
          approvals: [
            {
              interactionId: "approval",
              proposalNodeId: "goal",
              proposalRevisionHash: "a".repeat(64),
              actor: { kind: "user", id: "user" },
              answer: "approved",
              timestamp: now,
            },
          ],
          decisions: [],
          waits: [],
          permits: [],
          writerLeases: [],
          decidedInteractionIds: [],
          recoveryAuthorizedRunIds: [],
          reconciliations: [],
        },
      ],
    };
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.journey.mutate",
          commandId: CommandId.makeUnsafe("material-mutation"),
          threadId,
          mutation: { nodes: [{ ...currentNode, summary: "materially changed scope" }] },
          createdAt: now,
        },
        readModel: model,
        journeyDomainState: state,
      }),
    );
    expect("type" in result ? [result.type] : result.map((candidate) => candidate.type)).toEqual([
      "thread.journey-updated",
      "journey.approval-invalidated",
    ]);
  });

  it("wakes for failed child observation without treating the success dependency as ready", () => {
    let state = requestRun(createEmptyJourneyDomainState());
    const fence = { threadId, runId: "run-1", nodeId: "goal", attempt: 1 } as const;
    state = apply(
      state,
      decide(
        {
          type: "journey.attempt.start.request",
          commandId: CommandId.makeUnsafe("start-observation"),
          fence,
          capabilities: ["graph.read", "graph.mutate"],
          createdAt: now,
        },
        state,
      ),
      2,
    );
    state = apply(
      state,
      decide(
        {
          type: "journey.attempt.started",
          commandId: CommandId.makeUnsafe("started-observation"),
          fence,
          adapterEventId: "started-observation",
          resumableHarnessIdentity: null,
          createdAt: now,
        },
        state,
      ),
      3,
    );
    state = {
      threads: [
        Object.assign({}, state.threads[0]!, {
          runs: [
            ...state.threads[0]!.runs,
            {
              ...state.threads[0]!.runs[0]!,
              runId: "failed-child",
              nodeId: "research",
              role: "researchWorker" as const,
              status: "failed" as const,
              capabilities: ["graph.read" as const],
            },
          ],
        }),
      ],
    };
    const failedChildOutcome = {
      kind: "waitForDependencies" as const,
      successDependencyNodeIds: ["research"],
      observeTerminalRunIds: ["failed-child"],
      reason: "handle child failure",
    };
    const requestEvents = decide(
      {
        type: "journey.attempt.quiesce.request",
        commandId: CommandId.makeUnsafe("observe-failed-child"),
        fence,
        adapterEventId: "observe-failed-child",
        outcome: failedChildOutcome,
        createdAt: now,
      },
      state,
      readModel("running"),
    );
    const quiescingState = apply(state, requestEvents, 4);
    const events = decide(
      {
        type: "journey.attempt.quiesced",
        commandId: CommandId.makeUnsafe("observe-failed-child-quiesced"),
        fence,
        adapterEventId: "observe-failed-child-quiesced",
        outcome: failedChildOutcome,
        createdAt: now,
      },
      quiescingState,
      readModel("running"),
    );
    expect(events.map((candidate) => candidate.type)).toContain("journey.wait-wake-accepted");
    const completedChildState: JourneyDomainState = {
      ...state,
      threads: state.threads.map((projection) =>
        Object.assign({}, projection, {
          runs: projection.runs.map((run) =>
            run.runId === "failed-child"
              ? Object.assign({}, run, { status: "completed" as const })
              : run,
          ),
        }),
      ),
    };
    const completedChildOutcome = {
      kind: "waitForDependencies" as const,
      successDependencyNodeIds: ["research"],
      observeTerminalRunIds: ["failed-child"],
      reason: "continue after child completion",
    };
    const completedRequestEvents = decide(
      {
        type: "journey.attempt.quiesce.request",
        commandId: CommandId.makeUnsafe("observe-completed-child"),
        fence,
        adapterEventId: "observe-completed-child",
        outcome: completedChildOutcome,
        createdAt: now,
      },
      completedChildState,
      readModel("running"),
    );
    const completedQuiescingState = apply(completedChildState, completedRequestEvents, 5);
    const completedEvents = decide(
      {
        type: "journey.attempt.quiesced",
        commandId: CommandId.makeUnsafe("observe-completed-child-quiesced"),
        fence,
        adapterEventId: "observe-completed-child-quiesced",
        outcome: completedChildOutcome,
        createdAt: now,
      },
      completedQuiescingState,
      readModel("running"),
    );
    expect(completedEvents.map((candidate) => candidate.type)).toContain(
      "journey.wait-wake-accepted",
    );
  });
});
