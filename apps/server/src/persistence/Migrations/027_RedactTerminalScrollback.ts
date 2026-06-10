import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET scrollback_snapshot = NULL
    WHERE scrollback_snapshot IS NOT NULL
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_remove(payload_json, '$.scrollbackSnapshot')
    WHERE event_type = 'thread.terminal-status-changed'
      AND json_type(payload_json, '$.scrollbackSnapshot') IS NOT NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_visibility_order
    ON projection_threads(deleted_at, archived_at, last_interacted_at DESC, updated_at DESC, thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_project_visibility_order
    ON projection_threads(project_id, deleted_at, archived_at, last_interacted_at DESC, updated_at DESC, thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_project_created
    ON projection_threads(project_id, created_at, thread_id)
  `;
});
