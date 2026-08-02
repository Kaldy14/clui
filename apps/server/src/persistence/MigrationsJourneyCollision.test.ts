import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import * as SqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("Journey migration collision repair", (it) => {
  it.effect("restores settled columns when journey was previously recorded as migration 31", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY,
          surface TEXT NOT NULL DEFAULT 'terminal',
          journey_json TEXT
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
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (31, ${"ProjectionThreadsJourney"})
      `;

      yield* runMigrations;

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const columnNames = new Set(columns.map((column) => column.name));
      assert.equal(columnNames.has("settled_override"), true);
      assert.equal(columnNames.has("settled_at"), true);
      assert.equal(columnNames.has("snoozed_until"), true);
      assert.equal(columnNames.has("snoozed_at"), true);

      const migrationRows = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id = 34
      `;
      assert.equal(migrationRows[0]?.name, "ProjectionThreadsLifecycleCollisionRepair");
    }),
  );
});
