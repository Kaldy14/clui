import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  OrchestrationGetJourneyDeltasResult,
} from "./orchestration";
import { JourneyWsPush, WS_METHODS, WebSocketRequest, WsResponse } from "./ws";

const decodeWebSocketRequest = Schema.decodeUnknownEffect(WebSocketRequest);

it.effect("accepts getTurnDiff requests when fromTurnCount <= toTurnCount", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWebSocketRequest({
      id: "req-1",
      body: {
        _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
        threadId: "thread-1",
        fromTurnCount: 1,
        toTurnCount: 2,
      },
    });
    assert.strictEqual(parsed.body._tag, ORCHESTRATION_WS_METHODS.getTurnDiff);
  }),
);

it.effect("rejects getTurnDiff requests when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeWebSocketRequest({
        id: "req-1",
        body: {
          _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
          threadId: "thread-1",
          fromTurnCount: 3,
          toTurnCount: 2,
        },
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("trims websocket request id and nested orchestration ids", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWebSocketRequest({
      id: " req-1 ",
      body: {
        _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
        threadId: " thread-1 ",
        fromTurnCount: 0,
        toTurnCount: 0,
      },
    });
    assert.strictEqual(parsed.id, "req-1");
    assert.strictEqual(parsed.body._tag, ORCHESTRATION_WS_METHODS.getTurnDiff);
    if (parsed.body._tag === ORCHESTRATION_WS_METHODS.getTurnDiff) {
      assert.strictEqual(parsed.body.threadId, "thread-1");
    }
  }),
);

it.effect("accepts git.preparePullRequestThread requests", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWebSocketRequest({
      id: "req-pr-1",
      body: {
        _tag: WS_METHODS.gitPreparePullRequestThread,
        cwd: "/repo",
        reference: "#42",
        mode: "worktree",
      },
    });
    assert.strictEqual(parsed.body._tag, WS_METHODS.gitPreparePullRequestThread);
  }),
);

it.effect("decodes Journey projection, delta, and run-output RPC requests over transport", () =>
  Effect.gen(function* () {
    const requests = [
      {
        id: "request-projection",
        body: {
          _tag: ORCHESTRATION_WS_METHODS.getJourneyProjection,
          threadId: "thread-1",
        },
      },
      {
        id: "request-deltas",
        body: {
          _tag: ORCHESTRATION_WS_METHODS.getJourneyDeltas,
          threadId: "thread-1",
          afterJourneyRevision: 4,
        },
      },
      {
        id: "request-output",
        body: {
          _tag: ORCHESTRATION_WS_METHODS.getJourneyRunOutput,
          fence: { threadId: "thread-1", runId: "run-1", nodeId: "node-1", attempt: 1 },
          afterCursor: 12,
        },
      },
      {
        id: "subscribe-output",
        body: {
          _tag: ORCHESTRATION_WS_METHODS.subscribeJourneyRunOutput,
          fence: { threadId: "thread-1", runId: "run-1", nodeId: "node-1", attempt: 1 },
          afterCursor: 12,
        },
      },
      {
        id: "unsubscribe-output",
        body: {
          _tag: ORCHESTRATION_WS_METHODS.unsubscribeJourneyRunOutput,
          fence: { threadId: "thread-1", runId: "run-1", nodeId: "node-1", attempt: 1 },
        },
      },
    ] as const;

    for (const request of requests) {
      const decoded = yield* decodeWebSocketRequest(request);
      assert.strictEqual(decoded.body._tag, request.body._tag);
    }
  }),
);

it.effect("decodes Journey decisions and revision approvals through dispatch transport", () =>
  Effect.gen(function* () {
    const commands = [
      {
        type: "journey.decision.submit",
        commandId: "command-decision-1",
        submission: {
          threadId: "thread-1",
          interactionId: "interaction-1",
          decisionNodeId: "decision-1",
          answers: { choice: "server-owned" },
          actor: { kind: "user", id: "local-user" },
          submittedAt: "2026-08-02T12:00:00.000Z",
        },
      },
      {
        type: "journey.approval.submit",
        commandId: "command-approval-1",
        submission: {
          threadId: "thread-1",
          interactionId: "interaction-2",
          proposalNodeId: "proposal-1",
          proposalRevisionHash: "a".repeat(64),
          actor: { kind: "user", id: "local-user" },
          answer: "approved",
          timestamp: "2026-08-02T12:00:00.000Z",
        },
      },
    ] as const;

    for (const command of commands) {
      const decoded = yield* decodeWebSocketRequest({
        id: `request-${command.type}`,
        body: { _tag: ORCHESTRATION_WS_METHODS.dispatchCommand, command },
      });
      assert.strictEqual(decoded.body._tag, ORCHESTRATION_WS_METHODS.dispatchCommand);
    }
  }),
);

it.effect("decodes typed contiguous Journey projection pushes over transport", () =>
  Effect.gen(function* () {
    const push = {
      type: "push",
      channel: ORCHESTRATION_WS_CHANNELS.journeyProjection,
      data: {
        threadId: "thread-1",
        fromRevision: 2,
        toRevision: 3,
        globalEventWatermark: 40,
        changedEntities: { removedRunIds: ["run-old"] },
      },
    } as const;
    const decodedPush = yield* Schema.decodeUnknownEffect(JourneyWsPush)(push);
    const decodedResponse = yield* Schema.decodeUnknownEffect(WsResponse)(push);
    const invalid = yield* Effect.exit(
      Schema.decodeUnknownEffect(WsResponse)({
        ...push,
        data: { ...push.data, toRevision: 4 },
      }),
    );

    assert.strictEqual(decodedPush.data.toRevision, 3);
    assert.ok("type" in decodedResponse);
    assert.strictEqual(decodedResponse.type, "push");
    assert.strictEqual(invalid._tag, "Failure");
  }),
);

it.effect("decodes full-fence Journey output pushes over transport", () =>
  Effect.gen(function* () {
    const push = {
      type: "push",
      channel: ORCHESTRATION_WS_CHANNELS.journeyRunOutput,
      data: {
        fence: { threadId: "thread-1", runId: "run-1", nodeId: "node-1", attempt: 2 },
        startCursor: 4,
        endCursor: 8,
        data: "next",
      },
    } as const;
    const decoded = yield* Schema.decodeUnknownEffect(WsResponse)(push);
    assert.deepStrictEqual(decoded, push);
  }),
);

it.effect("decodes Journey delta catch-up and full snapshot reset results", () =>
  Effect.gen(function* () {
    const journey = {
      version: 1,
      destination: "Ship adaptive Journey",
      layoutDirection: "TB",
      nodes: [],
      edges: [],
      activeNodeId: null,
      updatedAt: "2026-08-02T12:00:00.000Z",
    } as const;
    const catchUp = yield* Schema.decodeUnknownEffect(OrchestrationGetJourneyDeltasResult)({
      kind: "deltas",
      deltas: [
        {
          threadId: "thread-1",
          fromRevision: 0,
          toRevision: 1,
          globalEventWatermark: 1,
          changedEntities: { journey },
        },
      ],
    });
    const reset = yield* Schema.decodeUnknownEffect(OrchestrationGetJourneyDeltasResult)({
      kind: "reset",
      snapshot: {
        threadId: "thread-1",
        journeyRevision: 8,
        globalEventWatermark: 50,
        journey,
        runs: [],
        attempts: [],
        approvals: [],
      },
    });

    assert.strictEqual(catchUp.kind, "deltas");
    assert.strictEqual(reset.kind, "reset");
  }),
);
