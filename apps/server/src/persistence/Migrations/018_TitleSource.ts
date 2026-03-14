import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Check existing columns to make migration idempotent
  const columns = yield* sql`PRAGMA table_info(projection_threads)`;
  const columnNames = new Set(
    (columns as ReadonlyArray<{ name: string }>).map((c) => c.name),
  );

  if (!columnNames.has("title_source")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN title_source TEXT NOT NULL DEFAULT 'auto'
    `;
  }
});
