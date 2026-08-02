import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  JourneyApprovalSubmission,
  JourneyAttemptFence,
  JourneyCoordinatorOutcome,
  JourneyImplementationResult,
  JourneyLogicalRun,
  JourneyMaterialProposalRevisionInput,
  JourneyOutputReadResult,
  JourneyProjectionDelta,
  JourneyResearchResult,
  JourneySnapshot,
  canonicalizeJourneyMaterialProposalRevisionInput,
} from "./journey";
import {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationGetJourneyDeltasResult,
} from "./orchestration";

const now = "2026-08-02T12:00:00.000Z";
const fence = {
  threadId: "thread-1",
  runId: "run-1",
  nodeId: "node-1",
  attempt: 1,
};

const exitOf = <S extends Schema.Top>(schema: S, input: unknown) =>
  Effect.exit(Schema.decodeUnknownEffect(schema as never)(input));

it.effect("keeps Journey v1 snapshots backward compatible", () =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(JourneySnapshot)({
      version: 1,
      destination: "Ship the feature",
      layoutDirection: "TB",
      nodes: [],
      edges: [],
      activeNodeId: null,
      updatedAt: now,
    });

    assert.strictEqual(decoded.version, 1);
    assert.deepStrictEqual(decoded.nodes, []);
  }),
);

it.effect("accepts a fully fenced research run with least-privilege capabilities", () =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(JourneyLogicalRun)({
      ...fence,
      role: "researchWorker",
      harness: "codexCli",
      status: "running",
      capabilities: ["graph.read", "research.read"],
      parentRunId: "coordinator-1",
      coordinatorRunId: "coordinator-1",
      canonicalWorkspaceLeaseId: null,
      outputStreamId: "output-1",
      failureReason: null,
      resumableHarnessIdentity: null,
      createdAt: now,
      updatedAt: now,
    });

    assert.strictEqual(decoded.role, "researchWorker");
    assert.strictEqual(decoded.attempt, 1);
  }),
);

it.effect("rejects write and orchestration capabilities for research workers", () =>
  Effect.gen(function* () {
    for (const capability of [
      "graph.mutate",
      "research.start",
      "implementation.start",
      "repository.write",
    ]) {
      const result = yield* exitOf(JourneyLogicalRun, {
        ...fence,
        role: "researchWorker",
        harness: "pi",
        status: "running",
        capabilities: ["graph.read", capability],
        parentRunId: "coordinator-1",
        coordinatorRunId: "coordinator-1",
        canonicalWorkspaceLeaseId: null,
        outputStreamId: "output-1",
        failureReason: null,
        resumableHarnessIdentity: null,
        createdAt: now,
        updatedAt: now,
      });
      assert.strictEqual(result._tag, "Failure");
    }
  }),
);

it.effect("requires the full attempt fence", () =>
  Effect.gen(function* () {
    const missingNode = yield* exitOf(JourneyAttemptFence, {
      threadId: "thread-1",
      runId: "run-1",
      attempt: 1,
    });
    const zeroAttempt = yield* exitOf(JourneyAttemptFence, { ...fence, attempt: 0 });

    assert.strictEqual(missingNode._tag, "Failure");
    assert.strictEqual(zeroAttempt._tag, "Failure");
  }),
);

it.effect("decodes exactly the three coordinator outcome variants", () =>
  Effect.gen(function* () {
    const complete = yield* Schema.decodeUnknownEffect(JourneyCoordinatorOutcome)({
      kind: "complete",
      summary: "Done",
    });
    const wait = yield* Schema.decodeUnknownEffect(JourneyCoordinatorOutcome)({
      kind: "waitForDependencies",
      successDependencyNodeIds: ["research-1"],
      observeTerminalRunIds: ["run-research-1"],
      reason: "Need evidence",
    });
    const malformed = yield* exitOf(JourneyCoordinatorOutcome, {
      kind: "waitForUser",
      interactionId: "interaction-1",
      reason: "Missing decision node",
    });

    assert.strictEqual(complete.kind, "complete");
    assert.strictEqual(wait.kind, "waitForDependencies");
    assert.strictEqual(malformed._tag, "Failure");
  }),
);

it.effect("requires research evidence or an explicit no-finding rationale", () =>
  Effect.gen(function* () {
    const missingEvidence = yield* exitOf(JourneyResearchResult, {
      kind: "research",
      summary: "Nothing returned",
      evidence: [],
      unresolved: [],
    });
    const noFinding = yield* Schema.decodeUnknownEffect(JourneyResearchResult)({
      kind: "research",
      summary: "No matching API exists",
      evidence: [],
      unresolved: [],
      noFinding: true,
      noFindingRationale: "Repository and upstream API searches returned no matches",
    });

    assert.strictEqual(missingEvidence._tag, "Failure");
    assert.strictEqual(noFinding.noFinding, true);
  }),
);

it.effect("rejects implementation results without changed files or verification", () =>
  Effect.gen(function* () {
    const noFiles = yield* exitOf(JourneyImplementationResult, {
      kind: "implementation",
      summary: "Implemented",
      changedFiles: [],
      verification: [{ command: "bun typecheck", outcome: "passed", passed: true }],
      unresolved: [],
    });
    const noVerification = yield* exitOf(JourneyImplementationResult, {
      kind: "implementation",
      summary: "Implemented",
      changedFiles: ["src/index.ts"],
      verification: [],
      unresolved: [],
    });

    assert.strictEqual(noFiles._tag, "Failure");
    assert.strictEqual(noVerification._tag, "Failure");
  }),
);

it.effect("projects only material proposal fields for canonical revision hashing", () =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(JourneyMaterialProposalRevisionInput)({
      node: {
        id: "proposal-1",
        type: "proposal",
        title: "Adopt the scheduler",
        summary: "Server-owned scheduling",
        detailMarkdown: "Implementation scope",
        status: "completed",
        todos: [{ id: "todo-1", title: "Implement", note: "One owner", completed: true }],
        interaction: null,
        activity: [{ id: "ignored" }],
      },
      dependencies: [{ source: "proposal-1", target: "research-1", relation: "dependsOn" }],
    });

    assert.deepStrictEqual(decoded.node.todos, [
      { id: "todo-1", title: "Implement", note: "One owner" },
    ]);
    assert.strictEqual("status" in decoded.node, false);
    assert.strictEqual("activity" in decoded.node, false);
  }),
);

it.effect("binds approvals to a canonical SHA-256 proposal revision", () =>
  Effect.gen(function* () {
    const valid = yield* Schema.decodeUnknownEffect(JourneyApprovalSubmission)({
      threadId: "thread-1",
      interactionId: "interaction-1",
      proposalNodeId: "proposal-1",
      proposalRevisionHash: "a".repeat(64),
      actor: { kind: "user", id: "local-user" },
      answer: "approved",
      timestamp: now,
    });
    const invalidHash = yield* exitOf(JourneyApprovalSubmission, {
      ...valid,
      proposalRevisionHash: "not-a-sha256",
    });

    assert.strictEqual(valid.answer, "approved");
    assert.strictEqual(invalidHash._tag, "Failure");
  }),
);

it.effect("canonical proposal revisions ignore dependency order and track material changes", () =>
  Effect.gen(function* () {
    const decode = Schema.decodeUnknownEffect(JourneyMaterialProposalRevisionInput);
    const base = {
      node: {
        id: "proposal-1",
        type: "proposal",
        title: "Adopt server scheduling",
        summary: "One authority",
        detailMarkdown: "Use durable lifecycle events",
        todos: [{ id: "todo-1", title: "Implement", note: "One writer" }],
        interaction: null,
      },
      dependencies: [
        { source: "proposal-1", target: "research-b", relation: "dependsOn" },
        { source: "proposal-1", target: "research-a", relation: "dependsOn" },
      ],
    } as const;
    const first = yield* decode(base);
    const reordered = yield* decode({ ...base, dependencies: base.dependencies.toReversed() });
    const changed = yield* decode({
      ...base,
      node: { ...base.node, detailMarkdown: "Use a browser-owned scheduler" },
    });
    const hash = (input: typeof first) =>
      createHash("sha256")
        .update(canonicalizeJourneyMaterialProposalRevisionInput(input), "utf8")
        .digest("hex");

    assert.strictEqual(hash(first), hash(reordered));
    assert.notStrictEqual(hash(first), hash(changed));
  }),
);

it.effect("rejects invalid output ranges and non-contiguous projection revisions", () =>
  Effect.gen(function* () {
    const invalidOutput = yield* exitOf(JourneyOutputReadResult, {
      fence,
      reset: true,
      firstCursor: 20,
      nextCursor: 10,
      data: "retained",
    });
    const invalidDelta = yield* exitOf(JourneyProjectionDelta, {
      threadId: "thread-1",
      fromRevision: 3,
      toRevision: 5,
      globalEventWatermark: 99,
      changedEntities: {},
    });

    assert.strictEqual(invalidOutput._tag, "Failure");
    assert.strictEqual(invalidDelta._tag, "Failure");
  }),
);

it.effect("decodes current and reset output cursors plus delta catch-up/reset results", () =>
  Effect.gen(function* () {
    const current = yield* Schema.decodeUnknownEffect(JourneyOutputReadResult)({
      fence,
      reset: false,
      firstCursor: 0,
      nextCursor: 12,
      data: "current data",
    });
    const reset = yield* Schema.decodeUnknownEffect(JourneyOutputReadResult)({
      fence,
      reset: true,
      firstCursor: 100,
      nextCursor: 112,
      data: "retained data",
    });
    const catchUp = yield* Schema.decodeUnknownEffect(OrchestrationGetJourneyDeltasResult)({
      kind: "deltas",
      deltas: [
        {
          threadId: "thread-1",
          fromRevision: 1,
          toRevision: 2,
          globalEventWatermark: 20,
          changedEntities: {
            steering: [
              {
                id: "steer-1",
                threadId: "thread-1",
                runId: "run-1",
                nodeId: "node-1",
                prompt: "Refine",
                sequence: 1,
                status: "queued",
                createdAt: "2026-08-02T00:00:00.000Z",
                deliveredAt: null,
              },
            ],
          },
        },
      ],
    });

    assert.strictEqual(current.reset, false);
    assert.strictEqual(reset.firstCursor, 100);
    assert.strictEqual(catchUp.kind, "deltas");
    if (catchUp.kind === "deltas") {
      assert.strictEqual(catchUp.deltas[0]?.changedEntities.steering?.[0]?.id, "steer-1");
    }
  }),
);

it.effect("round-trips explicit approval commands and fenced lifecycle events", () =>
  Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(OrchestrationCommand)({
      type: "journey.approval.submit",
      commandId: "command-1",
      submission: {
        threadId: "thread-1",
        interactionId: "interaction-1",
        proposalNodeId: "proposal-1",
        proposalRevisionHash: "b".repeat(64),
        actor: { kind: "user", id: "local-user" },
        answer: "approved",
        timestamp: now,
      },
    });
    const event = yield* Schema.decodeUnknownEffect(OrchestrationEvent)({
      sequence: 7,
      eventId: "event-7",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "journey.attempt-started",
      occurredAt: now,
      commandId: "command-2",
      causationEventId: null,
      correlationId: "command-1",
      metadata: {},
      payload: { fence, resumableHarnessIdentity: "session-1" },
    });

    assert.strictEqual(command.type, "journey.approval.submit");
    assert.strictEqual(event.type, "journey.attempt-started");
  }),
);

it.effect("rejects invalid role capabilities at the run-request command boundary", () =>
  Effect.gen(function* () {
    const result = yield* exitOf(OrchestrationCommand, {
      type: "journey.run.request",
      commandId: "command-run-1",
      threadId: "thread-1",
      runId: "research-run-1",
      nodeId: "research-node-1",
      role: "researchWorker",
      harness: "pi",
      capabilities: ["graph.read", "repository.write"],
      parentRunId: "coordinator-1",
      coordinatorRunId: "coordinator-1",
      prompt: "Inspect the repository",
      createdAt: now,
    });

    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes one server-owned composite child start without caller lifecycle fields", () =>
  Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(OrchestrationCommand)({
      type: "journey.child.start",
      commandId: "command-child-start",
      parentFence: fence,
      childKind: "implementation",
      runId: "implementation-1",
      nodeId: "implementation-node",
      title: "Implement the approved slice",
      instructions: "Make the bounded change and verify it.",
      harness: "codexCli",
      canonicalWorkspaceIdentity: "/trusted/worktree#1:2",
      proposalRevisionHash: "a".repeat(64),
      createdAt: now,
    });

    assert.strictEqual(command.type, "journey.child.start");
    assert.strictEqual(command.parentFence.attempt, 1);
    assert.ok(!("status" in command));
    assert.ok(!("capabilities" in command));
  }),
);

it.effect("decodes historical Journey graph events unchanged", () =>
  Effect.gen(function* () {
    const event = yield* Schema.decodeUnknownEffect(OrchestrationEvent)({
      sequence: 1,
      eventId: "event-old-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.journey-updated",
      occurredAt: now,
      commandId: "command-old-1",
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        threadId: "thread-1",
        journey: {
          version: 1,
          destination: "Legacy destination",
          layoutDirection: "TB",
          nodes: [],
          edges: [],
          activeNodeId: null,
          updatedAt: now,
        },
        updatedAt: now,
      },
    });

    assert.strictEqual(event.type, "thread.journey-updated");
  }),
);

it.effect("decodes explicit wait evaluation, wake, and wake-accepted lifecycle", () =>
  Effect.gen(function* () {
    const identity = { threadId: "thread-1", runId: "run-1", nodeId: "node-1" };
    for (const type of ["journey.wait.evaluate", "journey.wait.wake"] as const) {
      const command = yield* Schema.decodeUnknownEffect(OrchestrationCommand)({
        type,
        commandId: `command-${type}`,
        ...identity,
        waitGeneration: 2,
        triggerEventSequence: 42,
        createdAt: now,
      });
      assert.strictEqual(command.type, type);
    }

    const event = yield* Schema.decodeUnknownEffect(OrchestrationEvent)({
      sequence: 43,
      eventId: "event-wake-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "journey.wait-wake-accepted",
      occurredAt: now,
      commandId: "command-journey.wait.wake",
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        fence,
        waitGeneration: 2,
        acceptedWakeGeneration: 2,
        triggerEventSequence: 42,
      },
    });
    assert.strictEqual(event.type, "journey.wait-wake-accepted");
  }),
);

it.effect("requires positive full fences on terminal lifecycle events", () =>
  Effect.gen(function* () {
    const terminalEvents = [
      { type: "journey.run-completed", status: "completed", reason: null },
      { type: "journey.run-failed", status: "failed", reason: "failed" },
      { type: "journey.run-cancelled", status: "cancelled", reason: null },
    ] as const;

    for (const [index, terminal] of terminalEvents.entries()) {
      const result = yield* exitOf(OrchestrationEvent, {
        sequence: 50 + index,
        eventId: `event-terminal-${index}`,
        aggregateKind: "thread",
        aggregateId: "thread-1",
        type: terminal.type,
        occurredAt: now,
        commandId: `command-terminal-${index}`,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          fence: { ...fence, attempt: 0 },
          status: terminal.status,
          reason: terminal.reason,
        },
      });
      assert.strictEqual(result._tag, "Failure");
    }
  }),
);

it.effect("decodes the broader fenced lifecycle command union", () =>
  Effect.gen(function* () {
    const callback = {
      commandId: "command-callback",
      fence,
      adapterEventId: "adapter-1",
      createdAt: now,
    };
    const commands = [
      {
        type: "journey.attempt.start.request",
        commandId: "command-start-request",
        fence,
        capabilities: ["graph.read"],
        createdAt: now,
      },
      {
        type: "journey.attempt.started",
        ...callback,
        resumableHarnessIdentity: "session-1",
      },
      {
        type: "journey.attempt.quiesce.request",
        ...callback,
        outcome: { kind: "complete", summary: "Complete" },
      },
      {
        type: "journey.attempt.result.submit",
        ...callback,
        resultSequence: 1,
        result: {
          kind: "research",
          summary: "Found evidence",
          evidence: [{ source: "src/a.ts", finding: "Owns lifecycle" }],
          unresolved: [],
        },
      },
      {
        type: "journey.attempt.fail",
        ...callback,
        failureKind: "adapterError",
        reason: "Adapter failed",
      },
      {
        type: "journey.run.cancelled",
        ...callback,
      },
      {
        type: "journey.run.interrupt",
        ...callback,
        reason: "Process identity uncertain",
        orphanProcessPossible: true,
      },
      {
        type: "journey.permit.claim",
        commandId: "command-permit",
        fence,
        permitId: "permit-1",
        createdAt: now,
      },
      {
        type: "journey.writer-lease.claim",
        commandId: "command-lease",
        fence,
        leaseId: "lease-1",
        canonicalWorkspaceId: "workspace-1",
        createdAt: now,
      },
      {
        type: "journey.reconcile.observe",
        ...callback,
        observation: "processAbsent",
        detail: "No matching process",
      },
    ] as const;

    for (const command of commands) {
      const decoded = yield* Schema.decodeUnknownEffect(OrchestrationCommand)(command);
      assert.strictEqual(decoded.type, command.type);
    }
  }),
);

it.effect("decodes representative events across every Journey lifecycle boundary", () =>
  Effect.gen(function* () {
    const identity = { threadId: "thread-1", runId: "run-1", nodeId: "node-1" };
    const approval = {
      threadId: "thread-1",
      interactionId: "interaction-1",
      proposalNodeId: "proposal-1",
      proposalRevisionHash: "c".repeat(64),
      actor: { kind: "user", id: "local-user" },
      answer: "approved",
      timestamp: now,
    };
    const events = [
      {
        type: "journey.run-requested",
        payload: {
          run: {
            ...identity,
            role: "coordinator",
            harness: "codexCli",
            status: "queued",
            attempt: 0,
            capabilities: ["graph.read", "research.start"],
            parentRunId: null,
            coordinatorRunId: null,
            canonicalWorkspaceLeaseId: null,
            outputStreamId: "output-1",
            failureReason: null,
            resumableHarnessIdentity: null,
            createdAt: now,
            updatedAt: now,
          },
          prompt: "Coordinate the Journey",
        },
      },
      {
        type: "journey.attempt-start-requested",
        payload: { fence, capabilities: ["graph.read"] },
      },
      {
        type: "journey.attempt-quiesce-requested",
        payload: {
          fence,
          outcome: { kind: "complete", summary: "Done" },
        },
      },
      {
        type: "journey.run-waiting-for-dependencies",
        payload: {
          fence,
          status: "waitingForDependencies",
          waitGeneration: 1,
          acceptedWakeGeneration: null,
        },
      },
      {
        type: "journey.attempt-result-accepted",
        payload: {
          fence,
          resultSequence: 1,
          result: {
            kind: "research",
            summary: "Evidence",
            evidence: [{ source: "src/a.ts", finding: "Owns state" }],
            unresolved: [],
          },
        },
      },
      {
        type: "journey.attempt-failed",
        payload: { fence, status: "failed", failureKind: "adapterError", reason: "Failed" },
      },
      {
        type: "journey.run-cancellation-requested",
        payload: { ...identity, reason: "User cancelled" },
      },
      {
        type: "journey.run-interrupted",
        payload: { fence, reason: "Identity uncertain", orphanProcessPossible: true },
      },
      {
        type: "journey.decision-recorded",
        payload: {
          threadId: "thread-1",
          interactionId: "interaction-1",
          decisionNodeId: "decision-1",
          answers: { choice: "server" },
          actor: { kind: "user", id: "local-user" },
          submittedAt: now,
        },
      },
      { type: "journey.approval-recorded", payload: approval },
      {
        type: "journey.approval-invalidated",
        payload: {
          threadId: "thread-1",
          interactionId: "interaction-1",
          proposalNodeId: "proposal-1",
          previousRevisionHash: "c".repeat(64),
          nextRevisionHash: "d".repeat(64),
          reason: "Material proposal changed",
        },
      },
      { type: "journey.permit-claimed", payload: { fence, permitId: "permit-1" } },
      {
        type: "journey.writer-lease-claimed",
        payload: {
          fence,
          leaseId: "lease-1",
          canonicalWorkspaceId: "workspace-1",
        },
      },
      {
        type: "journey.reconciled",
        payload: { fence, observation: "processAbsent", detail: "No process" },
      },
    ] as const;

    for (const [index, event] of events.entries()) {
      const decoded = yield* Schema.decodeUnknownEffect(OrchestrationEvent)({
        sequence: 100 + index,
        eventId: `event-lifecycle-${index}`,
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: now,
        commandId: `command-lifecycle-${index}`,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        ...event,
      });
      assert.strictEqual(decoded.type, event.type);
    }
  }),
);
