import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Check existing columns to make migration idempotent
  const columns = yield* sql`PRAGMA table_info(projection_threads)`;
  const columnNames = new Set(
    (columns as ReadonlyArray<{ name: string }>).map((c) => c.name),
  );

  if (!columnNames.has("claude_session_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN claude_session_id TEXT
    `;
  }

  if (!columnNames.has("terminal_status")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN terminal_status TEXT NOT NULL DEFAULT 'new'
    `;
  }
});
