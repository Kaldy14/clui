import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Hard-delete projection data for soft-deleted threads
  yield* sql`DELETE FROM projection_thread_messages
    WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE deleted_at IS NOT NULL)`;
  yield* sql`DELETE FROM projection_thread_activities
    WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE deleted_at IS NOT NULL)`;
  yield* sql`DELETE FROM projection_turns
    WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE deleted_at IS NOT NULL)`;
  yield* sql`DELETE FROM projection_thread_sessions
    WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE deleted_at IS NOT NULL)`;
  yield* sql`DELETE FROM projection_pending_approvals
    WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE deleted_at IS NOT NULL)`;
  yield* sql`DELETE FROM projection_thread_proposed_plans
    WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE deleted_at IS NOT NULL)`;
  yield* sql`DELETE FROM checkpoint_diff_blobs
    WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE deleted_at IS NOT NULL)`;

  // Clear scrollback on soft-deleted threads
  yield* sql`UPDATE projection_threads SET scrollback_snapshot = NULL WHERE deleted_at IS NOT NULL`;
});
