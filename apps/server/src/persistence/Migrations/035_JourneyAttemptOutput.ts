import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS journey_attempt_output (
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      current INTEGER NOT NULL DEFAULT 0 CHECK (current IN (0, 1)),
      active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
      first_cursor INTEGER NOT NULL DEFAULT 0 CHECK (first_cursor >= 0),
      next_cursor INTEGER NOT NULL DEFAULT 0 CHECK (next_cursor >= first_cursor),
      retained_base64 TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (thread_id, run_id, node_id, attempt)
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_journey_attempt_output_current_run
    ON journey_attempt_output(thread_id, run_id)
    WHERE current = 1
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_journey_attempt_output_active_run
    ON journey_attempt_output(thread_id, run_id)
    WHERE active = 1
  `;
});
