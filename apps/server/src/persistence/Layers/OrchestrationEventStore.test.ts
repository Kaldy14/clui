import { CommandId, EventId, ProjectId, ThreadId } from "@clui/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventStore", (it) => {
  it.effect("stores json columns as strings and replays decoded events", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      const appended = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-store-roundtrip"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-roundtrip"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-store-roundtrip"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-store-roundtrip"),
        metadata: {
          adapterKey: "codex",
        },
        payload: {
          projectId: ProjectId.makeUnsafe("project-roundtrip"),
          title: "Roundtrip Project",
          workspaceRoot: "/tmp/project-roundtrip",
          defaultModel: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const storedRows = yield* sql<{
        readonly payloadJson: string;
        readonly metadataJson: string;
      }>`
        SELECT
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE event_id = ${appended.eventId}
      `;
      assert.equal(storedRows.length, 1);
      assert.equal(typeof storedRows[0]?.payloadJson, "string");
      assert.equal(typeof storedRows[0]?.metadataJson, "string");

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0]?.type, "project.created");
      assert.equal(replayed[0]?.metadata.adapterKey, "codex");
    }),
  );

  it.effect("replays legacy terminal status events missing piSessionFile", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.makeUnsafe("evt-store-legacy-terminal")},
          ${"thread"},
          ${ThreadId.makeUnsafe("thread-legacy-terminal")},
          ${0},
          ${"thread.terminal-status-changed"},
          ${now},
          ${CommandId.makeUnsafe("cmd-store-legacy-terminal")},
          ${null},
          ${null},
          ${"server"},
          ${JSON.stringify({
            threadId: "thread-legacy-terminal",
            terminalStatus: "active",
            claudeSessionId: "sess-legacy",
            updatedAt: now,
          })},
          ${"{}"}
        )
      `;

      const insertedRows = yield* sql<{ readonly sequence: number }>`
        SELECT sequence
        FROM orchestration_events
        WHERE event_id = ${EventId.makeUnsafe("evt-store-legacy-terminal")}
      `;
      const insertedSequence = insertedRows[0]?.sequence ?? 0;

      const replayed = yield* Stream.runCollect(
        eventStore.readFromSequence(Math.max(0, insertedSequence - 1), 1),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0]?.type, "thread.terminal-status-changed");
      if (replayed[0]?.type === "thread.terminal-status-changed") {
        assert.equal(replayed[0].payload.piSessionFile, null);
      }
    }),
  );

  it.effect("skips retired journey events while preserving replay limits", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();
      const legacyThreadId = ThreadId.makeUnsafe("thread-retired-journey");

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.makeUnsafe("evt-store-retired-journey")},
          ${"thread"},
          ${legacyThreadId},
          ${0},
          ${"thread.journey-updated"},
          ${now},
          ${CommandId.makeUnsafe("cmd-store-retired-journey")},
          ${null},
          ${null},
          ${"client"},
          ${JSON.stringify({
            threadId: legacyThreadId,
            journey: { nodes: [], edges: [] },
            updatedAt: now,
          })},
          ${"{}"}
        )
      `;

      const legacyRows = yield* sql<{ readonly sequence: number }>`
        SELECT sequence
        FROM orchestration_events
        WHERE event_id = ${EventId.makeUnsafe("evt-store-retired-journey")}
      `;
      const legacySequence = legacyRows[0]?.sequence ?? 0;

      const currentEvent = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-store-after-retired-journey"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-after-retired-journey"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-store-after-retired-journey"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-after-retired-journey"),
          title: "Project after retired journey event",
          workspaceRoot: "/tmp/project-after-retired-journey",
          defaultModel: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const replayed = yield* Stream.runCollect(
        eventStore.readFromSequence(Math.max(0, legacySequence - 1), 1),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));

      assert.deepStrictEqual(
        replayed.map((event) => event.eventId),
        [currentEvent.eventId],
      );
    }),
  );

  it.effect("fails with PersistenceDecodeError when stored json is invalid", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.makeUnsafe("evt-store-invalid-json")},
          ${"project"},
          ${ProjectId.makeUnsafe("project-invalid-json")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.makeUnsafe("cmd-store-invalid-json")},
          ${null},
          ${null},
          ${"server"},
          ${"{"},
          ${"{}"}
        )
      `;

      const replayResult = yield* Effect.result(
        Stream.runCollect(eventStore.readFromSequence(0, 10)),
      );
      assert.equal(replayResult._tag, "Failure");
      if (replayResult._tag === "Failure") {
        assert.ok(Schema.is(PersistenceDecodeError)(replayResult.failure));
        assert.ok(
          replayResult.failure.operation.includes(
            "OrchestrationEventStore.readFromSequence:decodeRows",
          ),
        );
      }
    }),
  );
});
