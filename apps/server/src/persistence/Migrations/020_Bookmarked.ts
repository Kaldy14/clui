import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql`PRAGMA table_info(projection_threads)`;
  const columnNames = new Set(
    (columns as ReadonlyArray<{ name: string }>).map((c) => c.name),
  );

  if (!columnNames.has("bookmarked")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN bookmarked INTEGER NOT NULL DEFAULT 0
    `;
  }
});
