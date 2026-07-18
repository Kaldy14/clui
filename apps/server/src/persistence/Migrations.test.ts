import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import * as SqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("Migrations", (it) => {
  it.effect("repairs projection schema when older local migrations used colliding ids", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY,
          project_id TEXT,
          created_at TEXT,
          updated_at TEXT,
          last_interacted_at TEXT,
          archived_at TEXT,
          deleted_at TEXT,
          scrollback_snapshot TEXT
        )
      `;
      yield* sql`
        CREATE TABLE orchestration_events (
          event_id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL
        )
      `;
      yield* sql`
        CREATE TABLE effect_sql_migrations (
          migration_id INTEGER PRIMARY KEY NOT NULL,
          created_at DATETIME NOT NULL DEFAULT current_timestamp,
          name VARCHAR(255) NOT NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (thread_id, scrollback_snapshot)
        VALUES (${"thread-1"}, ${"screen"})
      `;
      yield* sql`
        INSERT INTO orchestration_events (event_id, event_type, payload_json)
        VALUES (
          ${"event-1"},
          ${"thread.terminal-status-changed"},
          ${JSON.stringify({ scrollbackSnapshot: "screen", status: "active" })}
        )
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (27, ${"CoworkTasks"}), (28, ${"CoworkArtifactVersions"})
      `;

      yield* runMigrations;

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.equal(
        columns.some((column) => column.name === "pi_render_mode"),
        true,
      );
      assert.equal(
        columns.some((column) => column.name === "claude_code_backend"),
        true,
      );

      const threads = yield* sql<{
        readonly scrollback_snapshot: string | null;
        readonly claude_code_backend: string;
      }>`
        SELECT scrollback_snapshot, claude_code_backend
        FROM projection_threads
        WHERE thread_id = ${"thread-1"}
      `;
      assert.equal(threads[0]?.scrollback_snapshot, null);
      assert.equal(threads[0]?.claude_code_backend, "anthropic");

      const events = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_events WHERE event_id = ${"event-1"}
      `;
      assert.deepEqual(JSON.parse(events[0]?.payload_json ?? "{}"), { status: "active" });

      const migrationRows = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id = 29
      `;
      assert.equal(migrationRows[0]?.name, "ProjectionThreadsCollisionRepair");

      const proxyMigrationRows = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id = 30
      `;
      assert.equal(proxyMigrationRows[0]?.name, "ProjectionThreadsClaudeCodeBackend");
    }),
  );
});
