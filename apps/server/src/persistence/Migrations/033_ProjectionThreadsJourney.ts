import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql`PRAGMA table_info(projection_threads)`;
  const columnNames = new Set(
    columns.map((column) =>
      typeof column === "object" && column !== null && "name" in column
        ? String((column as { name: unknown }).name)
        : "",
    ),
  );

  if (!columnNames.has("surface")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN surface TEXT NOT NULL DEFAULT 'terminal'
    `;
  }

  if (!columnNames.has("journey_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN journey_json TEXT
    `;
  }

  yield* sql`
    UPDATE projection_threads
    SET surface = 'terminal'
    WHERE surface IS NULL
      OR surface NOT IN ('terminal', 'journey')
  `;
});
