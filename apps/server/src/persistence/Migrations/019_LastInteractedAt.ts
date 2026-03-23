import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql`PRAGMA table_info(projection_threads)`;
  const columnNames = new Set(
    (columns as ReadonlyArray<{ name: string }>).map((c) => c.name),
  );

  if (!columnNames.has("last_interacted_at")) {
    // Default to updated_at for existing rows so they keep their current sort order
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN last_interacted_at TEXT
    `;
    yield* sql`
      UPDATE projection_threads
      SET last_interacted_at = updated_at
      WHERE last_interacted_at IS NULL
    `;
  }
});
