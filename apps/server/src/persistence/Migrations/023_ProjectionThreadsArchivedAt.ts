import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

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

  if (!columnNames.has("archived_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN archived_at TEXT
    `;
  }
});
