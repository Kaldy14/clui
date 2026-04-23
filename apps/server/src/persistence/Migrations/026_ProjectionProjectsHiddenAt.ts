import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  try {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN hidden_at TEXT
    `;
  } catch {
    // Column already exists on upgraded databases.
  }
});
