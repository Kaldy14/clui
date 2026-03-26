import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadInput,
  GetProjectionThreadInput,
  ListProjectionThreadsByProjectInput,
  ProjectionThread,
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "../Services/ProjectionThreads.ts";

const makeProjectionThreadRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadRow = SqlSchema.void({
    Request: ProjectionThread,
    execute: (row) =>
      sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          claude_session_id,
          terminal_status,
          scrollback_snapshot,
          title_source,
          bookmarked,
          latest_turn_id,
          created_at,
          updated_at,
          last_interacted_at,
          deleted_at
        )
        VALUES (
          ${row.threadId},
          ${row.projectId},
          ${row.title},
          ${row.model},
          ${row.runtimeMode},
          ${row.interactionMode},
          ${row.branch},
          ${row.worktreePath},
          ${row.claudeSessionId},
          ${row.terminalStatus},
          ${row.scrollbackSnapshot},
          ${row.titleSource},
          ${row.bookmarked ? 1 : 0},
          ${row.latestTurnId},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.lastInteractedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          model = excluded.model,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          branch = excluded.branch,
          worktree_path = excluded.worktree_path,
          claude_session_id = excluded.claude_session_id,
          terminal_status = excluded.terminal_status,
          scrollback_snapshot = excluded.scrollback_snapshot,
          title_source = excluded.title_source,
          bookmarked = excluded.bookmarked,
          latest_turn_id = excluded.latest_turn_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          last_interacted_at = excluded.last_interacted_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionThreadRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadInput,
    Result: ProjectionThread,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model,
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          claude_session_id AS "claudeSessionId",
          terminal_status AS "terminalStatus",
          scrollback_snapshot AS "scrollbackSnapshot",
          title_source AS "titleSource",
          bookmarked,
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          last_interacted_at AS "lastInteractedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const listProjectionThreadRows = SqlSchema.findAll({
    Request: ListProjectionThreadsByProjectInput,
    Result: ProjectionThread,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model,
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          claude_session_id AS "claudeSessionId",
          terminal_status AS "terminalStatus",
          scrollback_snapshot AS "scrollbackSnapshot",
          title_source AS "titleSource",
          bookmarked,
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          last_interacted_at AS "lastInteractedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE project_id = ${projectId}
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const deleteProjectionThreadRow = SqlSchema.void({
    Request: DeleteProjectionThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.upsert:query")),
    );

  const getById: ProjectionThreadRepositoryShape["getById"] = (input) =>
    getProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.getById:query")),
    );

  const listByProjectId: ProjectionThreadRepositoryShape["listByProjectId"] = (input) =>
    listProjectionThreadRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.listByProjectId:query")),
    );

  const deleteById: ProjectionThreadRepositoryShape["deleteById"] = (input) =>
    deleteProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.deleteById:query")),
    );

  const clearScrollbackSnapshotBulk: ProjectionThreadRepositoryShape["clearScrollbackSnapshotBulk"] =
    (input) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (input.excludeThreadIds.length === 0) {
            yield* sql`
              UPDATE projection_threads
              SET scrollback_snapshot = NULL
              WHERE deleted_at IS NULL
                AND scrollback_snapshot IS NOT NULL
            `;
          } else {
            const ids = input.excludeThreadIds;
            yield* sql`
              UPDATE projection_threads
              SET scrollback_snapshot = NULL
              WHERE deleted_at IS NULL
                AND scrollback_snapshot IS NOT NULL
                AND thread_id NOT IN (${sql.in(ids)})
            `;
          }
          // changes() must run on the same connection as the UPDATE — transaction ensures this
          const [row] = yield* sql<{ count: number }>`SELECT changes() AS count`;
          return row?.count ?? 0;
        }),
      ).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadRepository.clearScrollbackSnapshotBulk:query"),
        ),
      );

  return {
    upsert,
    getById,
    listByProjectId,
    deleteById,
    clearScrollbackSnapshotBulk,
  } satisfies ProjectionThreadRepositoryShape;
});

export const ProjectionThreadRepositoryLive = Layer.effect(
  ProjectionThreadRepository,
  makeProjectionThreadRepository,
);
