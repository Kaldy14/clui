import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  EventId,
  ProjectId,
  ThreadId,
  type JourneyAttemptFence,
  type JourneyLogicalRun,
  type JourneyProjectionSnapshot,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@clui/contracts";
import { describe, expect, it } from "vitest";

import type {
  JourneyHarnessInspection,
  JourneyHarnessLifecycleEvent,
  JourneyHarnessObserver,
  JourneyHarnessProfile,
} from "../journeyHarnessAdapter.ts";
import { JourneyHarnessOwnershipUncertainError } from "../journeyHarnessAdapter.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import {
  JourneyReactorRuntime,
  type JourneyReactorAdapter,
  type JourneyReactorAuthorizer,
  type JourneyReactorClock,
  type JourneyReactorEngine,
} from "./JourneyReactor.ts";

const now = "2026-08-02T12:00:00.000Z";
const threadId = ThreadId.makeUnsafe("journey-reactor-thread");
const projectId = ProjectId.makeUnsafe("journey-reactor-project");
const fence: JourneyAttemptFence = {
  threadId,
  runId: "run-1",
  nodeId: "node-1",
  attempt: 1,
};

function run(overrides: Partial<JourneyLogicalRun> = {}): JourneyLogicalRun {
  return {
    threadId,
    runId: fence.runId,
    nodeId: fence.nodeId,
    role: "researchWorker",
    harness: "codexCli",
    status: "starting",
    attempt: 1,
    capabilities: ["graph.read"],
    parentRunId: null,
    coordinatorRunId: null,
    canonicalWorkspaceLeaseId: null,
    outputStreamId: "output-1",
    failureReason: null,
    resumableHarnessIdentity: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function projection(currentRun = run()): JourneyProjectionSnapshot {
  return {
    threadId,
    journeyRevision: 1,
    globalEventWatermark: 1,
    journey: {
      version: 1,
      destination: "Test reactor",
      layoutDirection: "TB",
      activeNodeId: fence.nodeId,
      nodes: [
        {
          id: fence.nodeId,
          type: "research",
          status: "running",
          title: "Research the repository",
          summary: "",
          detailMarkdown: "",
          todos: [],
          interaction: null,
          activity: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
      edges: [],
      updatedAt: now,
    },
    runs: [currentRun],
    attempts: [
      {
        fence: {
          threadId: currentRun.threadId,
          runId: currentRun.runId,
          nodeId: currentRun.nodeId,
          attempt: currentRun.attempt,
        },
        status: currentRun.status === "running" ? "running" : "starting",
        capabilities: currentRun.capabilities,
        credentialId: null,
        startedAt: null,
        completedAt: null,
        failureReason: null,
      },
    ],
    approvals: [],
    steering: [],
  };
}

function readModel(workspaceRoot: string): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: now,
    projects: [{ id: projectId, workspaceRoot }],
    threads: [
      {
        id: threadId,
        projectId,
        surface: "journey",
        journey: projection().journey,
        worktreePath: null,
      },
    ],
  } as unknown as OrchestrationReadModel;
}

function event(type: OrchestrationEvent["type"], payload: unknown, sequence = 1) {
  return {
    sequence,
    eventId: EventId.makeUnsafe(`reactor-event-${sequence}`),
    type,
    payload,
  } as unknown as OrchestrationEvent;
}

class FakeClock implements JourneyReactorClock {
  readonly timers: Array<() => void> = [];
  now = () => now;
  schedule = (_delayMs: number, callback: () => void) => {
    this.timers.push(callback);
    return () => {
      const index = this.timers.indexOf(callback);
      if (index >= 0) this.timers.splice(index, 1);
    };
  };
  fireAll() {
    for (const callback of this.timers.splice(0)) callback();
  }
}

class FakeAdapter implements JourneyReactorAdapter {
  observer: JourneyHarnessObserver | null = null;
  profile: JourneyHarnessProfile | null = null;
  prompt: string | null = null;
  starts = 0;
  cancels = 0;
  quiesces = 0;
  interrupts = 0;
  registered = false;
  alive = false;
  failStart: Error | null = null;
  hasAttempt = false;
  readonly order: string[];

  constructor(order: string[]) {
    this.order = order;
  }

  async start(input: {
    fence: JourneyAttemptFence;
    profile: JourneyHarnessProfile;
    prompt: string;
    cwd: string;
    observer?: JourneyHarnessObserver;
  }): Promise<JourneyHarnessInspection> {
    this.order.push("adapter.start");
    this.starts += 1;
    this.hasAttempt = true;
    this.observer = input.observer ?? null;
    this.profile = input.profile;
    this.prompt = input.prompt;
    if (this.failStart) throw this.failStart;
    return this.inspection("starting");
  }

  cancel(): JourneyHarnessInspection | null {
    this.order.push("adapter.cancel");
    this.cancels += 1;
    return this.inspection("cancelling");
  }
  quiesce(): JourneyHarnessInspection | null {
    this.quiesces += 1;
    return this.inspection("cancelling");
  }
  inspect(): JourneyHarnessInspection | null {
    return this.hasAttempt ? this.inspection("running") : null;
  }
  interrupt(): JourneyHarnessInspection | null {
    this.interrupts += 1;
    return this.inspection("interrupted");
  }
  inspectRegistered(): { pid: number } | null {
    return this.registered ? { pid: 123 } : null;
  }
  registeredProcessAlive(): boolean {
    return this.alive;
  }
  terminateRegistered(): "absent" | "signalled" | "denied" {
    this.alive = false;
    return this.registered ? "signalled" : "absent";
  }
  forgetRegistered(): void {
    this.registered = false;
  }

  emit(event: JourneyHarnessLifecycleEvent) {
    this.observer?.onLifecycle?.(event);
  }

  private inspection(state: JourneyHarnessInspection["state"]): JourneyHarnessInspection {
    return {
      fence,
      harness: "codexCli",
      role: "researchWorker",
      state,
      pid: 123,
      nextOutputCursor: 0,
      resumableIdentity: null,
      result: null,
      failureReason: null,
      retainedOutputBytes: 0,
    };
  }
}

function setup(currentProjection = projection()) {
  const workspace = mkdtempSync(path.join(tmpdir(), "clui-journey-reactor-"));
  const commands: OrchestrationCommand[] = [];
  const order: string[] = [];
  let issueError: Error | null = null;
  let failNextDispatchType: OrchestrationCommand["type"] | null = null;
  let admissionDeferred = false;
  const output = { published: [] as string[], deactivated: 0 };
  const revocations: number[] = [];
  let snapshot = currentProjection;
  const engine: JourneyReactorEngine = {
    dispatch: async (command) => {
      if (failNextDispatchType === command.type) {
        failNextDispatchType = null;
        throw new Error(`transient ${command.type} failure`);
      }
      if (command.type === "journey.attempt.start.request" && admissionDeferred) {
        throw new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Research start is not the next fair scheduler admission.",
        });
      }
      commands.push(command);
      if (command.type === "journey.attempt.start.request") {
        snapshot = {
          ...snapshot,
          runs: snapshot.runs.map((candidate) =>
            candidate.runId === command.fence.runId
              ? { ...candidate, status: "starting" as const, attempt: command.fence.attempt }
              : candidate,
          ),
        };
      }
      if (command.type === "journey.attempt.started") {
        snapshot = projection(run({ status: "running" }));
      }
      if (command.type === "journey.run.cancelled") {
        snapshot = {
          ...snapshot,
          runs: snapshot.runs.map((candidate) =>
            candidate.runId === command.fence.runId
              ? Object.assign({}, candidate, { status: "cancelled" as const })
              : candidate,
          ),
          attempts: snapshot.attempts.map((candidate) =>
            candidate.fence.runId === command.fence.runId &&
            candidate.fence.attempt === command.fence.attempt
              ? Object.assign({}, candidate, { status: "cancelled" as const })
              : candidate,
          ),
        };
      }
      return { sequence: commands.length };
    },
    getJourneyProjection: async () => snapshot,
    getReadModel: async () => readModel(workspace),
    beginJourneyRunOutput: async () => {
      order.push("output.begin");
    },
    appendJourneyRunOutput: async (_fence, data) => {
      output.published.push(data);
    },
    deactivateJourneyRunOutput: async () => {
      output.deactivated += 1;
    },
  };
  const adapter = new FakeAdapter(order);
  const authorizer: JourneyReactorAuthorizer = {
    issue: ({ fence: issuedFence }) => {
      order.push("authorizer.issue");
      if (issueError) throw issueError;
      return {
        fence: issuedFence,
        role: "researchWorker",
        capabilities: ["graph.read"],
        token: "journey-token",
      };
    },
    revokeFence: () => {
      revocations.push(commands.length);
      order.push("authorizer.revoke");
    },
    revokeRun: () => order.push("authorizer.revoke-run"),
  };
  const clock = new FakeClock();
  const runtime = new JourneyReactorRuntime({
    engine,
    adapter,
    authorizer,
    stateDir: workspace,
    clock,
    resolveExecutable: () => "/usr/bin/true",
    inspectWorkspaceClean: async () => true,
  });
  return {
    runtime,
    adapter,
    clock,
    commands,
    output,
    order,
    revocations,
    setProjection: (value: JourneyProjectionSnapshot) => (snapshot = value),
    rejectIssue: (error: Error) => (issueError = error),
    failNextDispatch: (type: OrchestrationCommand["type"]) => (failNextDispatchType = type),
    setAdmissionDeferred: (value: boolean) => (admissionDeferred = value),
  };
}

describe("JourneyReactorRuntime", () => {
  it.each(["node", "thread"] as const)(
    "drains an interrupted %s deletion after fenced registry absence without resurrection",
    async (deletionKind) => {
      const baseInterrupted = projection(run({ status: "interrupted" }));
      const interrupted: JourneyProjectionSnapshot = {
        ...baseInterrupted,
        attempts: baseInterrupted.attempts.map((attempt) =>
          Object.assign({}, attempt, { status: "interrupted" as const }),
        ),
      };
      const system = setup(interrupted);
      system.runtime.rememberHistoricalEvent(
        deletionKind === "node"
          ? event("journey.node-deletion-requested", {
              threadId,
              nodeId: fence.nodeId,
              requestedAt: now,
            })
          : event("journey.thread-deletion-requested", {
              threadId,
              requestedAt: now,
            }),
      );

      await system.runtime.reconcileStartup();

      const finalCommandType = deletionKind === "node" ? "journey.node.delete" : "thread.delete";
      expect(system.commands.map((command) => command.type)).toEqual([
        "journey.reconcile.observe",
        "journey.run.cancelled",
        finalCommandType,
      ]);
      expect(system.commands[0]).toMatchObject({
        type: "journey.reconcile.observe",
        observation: "processAbsent",
        fence,
      });
      expect(system.revocations).toEqual([1]);

      await system.runtime.handleEvent(
        event("journey.attempt-start-requested", {
          fence,
          capabilities: ["graph.read"],
        }),
      );
      expect(system.adapter.starts).toBe(0);
      expect(system.commands.map((command) => command.type)).toEqual([
        "journey.reconcile.observe",
        "journey.run.cancelled",
        finalCommandType,
      ]);
    },
  );

  it("starts a queued root run but does not duplicate a composite child start", async () => {
    const rootRun = run({ status: "queued", attempt: 0, role: "coordinator" });
    const root = setup(projection(rootRun));
    await root.runtime.handleEvent(
      event("journey.run-requested", { run: rootRun, prompt: "Coordinate" }),
    );
    expect(root.commands).toHaveLength(1);
    expect(root.commands[0]).toMatchObject({
      type: "journey.attempt.start.request",
      fence: { attempt: 1 },
    });

    const composite = setup(projection(run({ status: "starting", attempt: 1 })));
    await composite.runtime.handleEvent(
      event("journey.run-requested", {
        run: run({ status: "queued", attempt: 0 }),
        prompt: "Child",
      }),
    );
    expect(composite.commands).toEqual([]);
  });

  it("keeps a capacity-blocked research run queued and admits it after permit release", async () => {
    const queued = run({ status: "queued", attempt: 0, role: "researchWorker" });
    const system = setup(projection(queued));
    system.setAdmissionDeferred(true);

    await system.runtime.handleEvent(
      event("journey.run-requested", { run: queued, prompt: "Research later" }),
    );
    expect(system.commands).toEqual([]);

    system.setAdmissionDeferred(false);
    await system.runtime.handleEvent(
      event(
        "journey.permit-released",
        {
          fence,
          permitId: "released-permit",
        },
        2,
      ),
    );
    expect(system.commands).toHaveLength(1);
    expect(system.commands[0]).toMatchObject({
      type: "journey.attempt.start.request",
      fence: { runId: queued.runId, attempt: 1 },
    });
  });

  it("does not finalize a node deletion until every descendant run is terminal", async () => {
    const root = run({ runId: "root-run", nodeId: "node-1", status: "cancelled" });
    const child = run({
      runId: "child-run",
      nodeId: "node-2",
      status: "cancelling",
      parentRunId: root.runId,
      coordinatorRunId: root.runId,
    });
    const base = projection(root);
    const withChild: JourneyProjectionSnapshot = {
      ...base,
      journey: {
        ...base.journey,
        nodes: [...base.journey.nodes, { ...base.journey.nodes[0]!, id: "node-2", title: "Child" }],
      },
      runs: [root, child],
      attempts: [
        ...base.attempts,
        { ...base.attempts[0]!, fence: { ...fence, runId: child.runId, nodeId: child.nodeId } },
      ],
    };
    const system = setup(withChild);
    system.runtime.rememberHistoricalEvent(
      event("journey.node-deletion-requested", {
        threadId,
        nodeId: root.nodeId,
        requestedAt: now,
      }),
    );

    await system.runtime.handleEvent(
      event("journey.run-cancelled", {
        fence: { ...fence, runId: root.runId, nodeId: root.nodeId },
        status: "cancelled",
        reason: null,
      }),
    );
    expect(system.commands.some((command) => command.type === "journey.node.delete")).toBe(false);

    system.setProjection({
      ...withChild,
      runs: withChild.runs.map((candidate) =>
        Object.assign({}, candidate, { status: "cancelled" as const }),
      ),
    });
    await system.runtime.handleEvent(
      event(
        "journey.run-cancelled",
        {
          fence: { ...fence, runId: child.runId, nodeId: child.nodeId },
          status: "cancelled",
          reason: null,
        },
        2,
      ),
    );
    expect(
      system.commands.filter((command) => command.type === "journey.node.delete"),
    ).toHaveLength(1);
  });

  it("commits before launch, passes the capability token, and deduplicates callbacks", async () => {
    const { runtime, adapter, commands, order } = setup();
    await runtime.handleEvent(
      event("journey.attempt-start-requested", { fence, capabilities: ["graph.read"] }),
    );

    expect(order.slice(0, 3)).toEqual(["output.begin", "authorizer.issue", "adapter.start"]);
    expect(adapter.profile?.baseEnv).toMatchObject({ CLUI_JOURNEY_TOOL_TOKEN: "journey-token" });

    const started: JourneyHarnessLifecycleEvent = {
      type: "started",
      fence,
      pid: 123,
      resumableIdentity: "session-1",
    };
    adapter.emit(started);
    adapter.emit(started);
    await runtime.flush();
    adapter.observer?.onResult?.({
      fence,
      result: {
        kind: "research",
        summary: "Found it",
        evidence: [{ source: "repo", finding: "Evidence" }],
        unresolved: [],
      },
    });
    adapter.observer?.onResult?.({
      fence,
      result: {
        kind: "research",
        summary: "Found it",
        evidence: [{ source: "repo", finding: "Evidence" }],
        unresolved: [],
      },
    });
    await runtime.flush();

    expect(commands.filter(({ type }) => type === "journey.attempt.started")).toHaveLength(1);
    expect(commands.filter(({ type }) => type === "journey.attempt.result.submit")).toHaveLength(1);
    expect(commands.some(({ type }) => type === "journey.attempt.quiesce.request")).toBe(false);
  });

  it("compensates a missing start acknowledgement without reporting a running attempt", async () => {
    const { runtime, adapter, clock, commands } = setup();
    await runtime.handleEvent(
      event("journey.attempt-start-requested", { fence, capabilities: ["graph.read"] }),
    );
    clock.fireAll();
    await runtime.flush();

    expect(adapter.interrupts).toBe(1);
    expect(commands.map(({ type }) => type)).toEqual(["journey.attempt.fail"]);
    expect(commands[0]).toMatchObject({ failureKind: "startAckTimeout" });
  });

  it("keeps start acknowledgement retryable until durable dispatch succeeds", async () => {
    const retrying = setup();
    await retrying.runtime.handleEvent(
      event("journey.attempt-start-requested", { fence, capabilities: ["graph.read"] }),
    );
    retrying.failNextDispatch("journey.attempt.started");
    const started: JourneyHarnessLifecycleEvent = {
      type: "started",
      fence,
      pid: 123,
      resumableIdentity: null,
    };
    retrying.adapter.emit(started);
    retrying.adapter.emit(started);
    await retrying.runtime.flush();

    expect(retrying.commands.filter(({ type }) => type === "journey.attempt.started")).toHaveLength(
      1,
    );
  });

  it("revokes the attempt grant before cancellation side effects", async () => {
    const { runtime, adapter, order, commands } = setup(projection(run({ status: "cancelling" })));
    await runtime.handleEvent(
      event("journey.run-cancellation-requested", {
        threadId,
        runId: fence.runId,
        reason: "Stop",
      }),
    );

    expect(adapter.cancels).toBe(1);
    expect(order.slice(0, 2)).toEqual(["authorizer.revoke", "adapter.cancel"]);
    expect(commands[0]).toMatchObject({
      type: "journey.run.interrupt",
      orphanProcessPossible: true,
    });
  });

  it("rejects stale callbacks and fails closed when launch throws", async () => {
    const started = setup();
    await started.runtime.handleEvent(
      event("journey.attempt-start-requested", { fence, capabilities: ["graph.read"] }),
    );
    started.setProjection(projection(run({ attempt: 2 })));
    started.adapter.emit({ type: "started", fence, pid: 123, resumableIdentity: null });
    await started.runtime.flush();
    expect(started.commands).toEqual([]);

    const failed = setup();
    failed.adapter.failStart = new Error("spawn exploded");
    await failed.runtime.handleEvent(
      event("journey.attempt-start-requested", { fence, capabilities: ["graph.read"] }),
    );
    expect(failed.commands).toHaveLength(1);
    expect(failed.commands[0]).toMatchObject({
      type: "journey.attempt.fail",
      failureKind: "spawnFailed",
    });
    expect(failed.order).toEqual([
      "output.begin",
      "authorizer.issue",
      "adapter.start",
      "authorizer.revoke",
    ]);
  });

  it("does not launch when capability authorization rejects the attempt", async () => {
    const { runtime, adapter, commands, rejectIssue } = setup();
    rejectIssue(new Error("capability denied"));

    await runtime.handleEvent(
      event("journey.attempt-start-requested", { fence, capabilities: ["graph.read"] }),
    );

    expect(adapter.starts).toBe(0);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "journey.attempt.fail",
      failureKind: "launchRejected",
      reason: "capability denied",
    });
  });

  it("retains ownership when spawn succeeds but durable registration is uncertain", async () => {
    const uncertain = setup();
    uncertain.adapter.failStart = new JourneyHarnessOwnershipUncertainError(
      fence,
      123,
      "registration failed",
    );

    await uncertain.runtime.handleEvent(
      event("journey.attempt-start-requested", { fence, capabilities: ["graph.read"] }),
    );

    expect(uncertain.commands).toHaveLength(1);
    expect(uncertain.commands[0]).toMatchObject({
      type: "journey.run.interrupt",
      orphanProcessPossible: true,
      reason: expect.stringContaining("pid 123"),
    });
    uncertain.setProjection(projection(run({ status: "interrupted" })));
    uncertain.adapter.emit({
      type: "exitConfirmed",
      fence,
      exitCode: null,
      signal: "SIGTERM",
    });
    await uncertain.runtime.flush();
    expect(uncertain.commands.map(({ type }) => type)).toEqual([
      "journey.run.interrupt",
      "journey.reconcile.observe",
      "journey.attempt.start.request",
    ]);
  });

  it("reconciles registered research orphans and retries only after confirmed absence", async () => {
    const interruptedRun = run({ status: "running" });
    const { runtime, adapter, commands } = setup(projection(interruptedRun));
    adapter.registered = true;
    adapter.alive = true;

    await runtime.reconcileStartup();

    expect(commands.map(({ type }) => type)).toEqual([
      "journey.run.interrupt",
      "journey.reconcile.observe",
      "journey.attempt.start.request",
    ]);
    expect(commands.at(-1)).toMatchObject({ fence: { attempt: 2 } });
  });

  it("fails closed across restart when no registered process can prove absence", async () => {
    const { runtime, commands } = setup(projection(run({ status: "running" })));

    await runtime.reconcileStartup();

    expect(commands.map(({ type }) => type)).toEqual(["journey.run.interrupt"]);
  });

  it("submits coordinator outcomes to quiescence instead of inventing completion", async () => {
    const { runtime, adapter, commands, output } = setup(
      projection(run({ role: "coordinator", capabilities: ["graph.read"] })),
    );
    await runtime.handleEvent(
      event("journey.attempt-start-requested", { fence, capabilities: ["graph.read"] }),
    );
    adapter.emit({ type: "started", fence, pid: 123, resumableIdentity: null });
    await runtime.flush();
    adapter.observer?.onResult?.({
      fence,
      result: {
        kind: "waitForDependencies",
        successDependencyNodeIds: ["research-a", "research-b"],
        observeTerminalRunIds: ["run-a", "run-b"],
        reason: "Wait for both branches",
      },
    });
    await runtime.flush();

    expect(commands.at(-1)).toMatchObject({
      type: "journey.attempt.quiesce.request",
      outcome: { kind: "waitForDependencies" },
    });
    expect(adapter.quiesces).toBe(1);
    expect(output.deactivated).toBe(0);

    adapter.emit({
      type: "exited",
      fence,
      exitCode: 0,
      signal: null,
      cancelled: false,
      quiesced: true,
    });
    await runtime.flush();
    expect(commands.at(-1)).toMatchObject({
      type: "journey.attempt.quiesced",
      outcome: { kind: "waitForDependencies" },
    });
    expect(output.deactivated).toBe(1);
  });

  it("interrupts and retains ownership when quiescence exit acknowledgement times out", async () => {
    const { runtime, adapter, commands, clock } = setup(
      projection(run({ role: "coordinator", capabilities: ["graph.read"] })),
    );
    await runtime.handleEvent(
      event("journey.attempt-start-requested", { fence, capabilities: ["graph.read"] }),
    );
    adapter.emit({ type: "started", fence, pid: 123, resumableIdentity: null });
    await runtime.flush();
    adapter.observer?.onResult?.({
      fence,
      result: { kind: "complete", summary: "Done" },
    });
    await runtime.flush();
    clock.fireAll();
    await runtime.flush();

    expect(commands.map(({ type }) => type)).toEqual([
      "journey.attempt.started",
      "journey.attempt.quiesce.request",
      "journey.run.interrupt",
    ]);
    expect(commands.at(-1)).toMatchObject({ orphanProcessPossible: true });
  });

  it("buffers output until start is durable and fails closed on 64 KiB overflow", async () => {
    const buffered = setup();
    await buffered.runtime.handleEvent(
      event("journey.attempt-start-requested", { fence, capabilities: ["graph.read"] }),
    );
    buffered.adapter.observer?.onOutput?.({
      fence,
      data: "before-start",
      firstCursor: 0,
      nextCursor: 12,
    });
    await buffered.runtime.flush();
    expect(buffered.output.published).toEqual([]);
    buffered.adapter.emit({ type: "started", fence, pid: 123, resumableIdentity: null });
    await buffered.runtime.flush();
    expect(buffered.output.published).toEqual(["before-start"]);

    const overflow = setup();
    await overflow.runtime.handleEvent(
      event("journey.attempt-start-requested", { fence, capabilities: ["graph.read"] }),
    );
    overflow.adapter.observer?.onOutput?.({
      fence,
      data: "x".repeat(64 * 1024 + 1),
      firstCursor: 0,
      nextCursor: 64 * 1024 + 1,
    });
    await overflow.runtime.flush();
    expect(overflow.output.published).toEqual([]);
    expect(overflow.adapter.interrupts).toBe(1);
    expect(overflow.commands[0]).toMatchObject({
      type: "journey.attempt.fail",
      failureKind: "outputOverflow",
    });
  });

  it("interrupts when cancellation cannot confirm process exit before timeout", async () => {
    const active = setup();
    await active.runtime.handleEvent(
      event("journey.attempt-start-requested", { fence, capabilities: ["graph.read"] }),
    );
    active.adapter.emit({ type: "started", fence, pid: 123, resumableIdentity: null });
    await active.runtime.flush();
    active.setProjection(projection(run({ status: "cancelling" })));
    await active.runtime.handleEvent(
      event(
        "journey.run-cancellation-requested",
        { threadId, runId: fence.runId, reason: "Stop" },
        2,
      ),
    );
    active.clock.fireAll();
    await active.runtime.flush();

    expect(active.commands.at(-1)).toMatchObject({
      type: "journey.run.interrupt",
      orphanProcessPossible: true,
    });
    expect(active.adapter.interrupts).toBe(1);
  });

  it("delivers the FIFO steering head as a continuation and acknowledges it after start", async () => {
    const steering = [
      {
        id: "steer-1",
        threadId,
        runId: fence.runId,
        nodeId: fence.nodeId,
        prompt: "First queued direction",
        sequence: 1,
        status: "queued" as const,
        createdAt: now,
        deliveredAt: null,
      },
      {
        id: "steer-2",
        threadId,
        runId: fence.runId,
        nodeId: fence.nodeId,
        prompt: "Second queued direction",
        sequence: 2,
        status: "queued" as const,
        createdAt: now,
        deliveredAt: null,
      },
    ];
    const initial = { ...projection(run({ status: "running", attempt: 1 })), steering };
    const { runtime, adapter, commands, setProjection } = setup(initial);

    await runtime.handleEvent(event("journey.steering-enqueued", steering[0]));
    expect(commands).toEqual([]);

    const continuationFence = { ...fence, attempt: 2 };
    const starting = { ...projection(run({ attempt: 2 })), steering };
    setProjection(starting);
    await runtime.handleEvent(
      event(
        "journey.attempt-start-requested",
        { fence: continuationFence, capabilities: ["graph.read"] },
        2,
      ),
    );
    expect(adapter.prompt).toBe("First queued direction");
    adapter.emit({
      type: "started",
      fence: continuationFence,
      pid: 123,
      resumableIdentity: null,
    });
    await runtime.flush();
    expect(commands.at(-1)).toMatchObject({
      type: "journey.steering.acknowledge",
      itemId: "steer-1",
      sequence: 1,
    });
  });
});
