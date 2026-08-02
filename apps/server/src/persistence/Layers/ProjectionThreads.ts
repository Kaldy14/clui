import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { JourneySnapshot } from "@clui/contracts";
import { Effect, Layer, Schema, Struct } from "effect";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadInput,
  GetProjectionThreadInput,
  ListProjectionThreadsByProjectInput,
  ProjectionThread,
  ProjectionThreadRepository,
  ProjectionThreadWorkspaceBinding,
  type ProjectionThreadRepositoryShape,
} from "../Services/ProjectionThreads.ts";

const ProjectionThreadDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    journey: Schema.NullOr(Schema.fromJsonString(JourneySnapshot)),
  }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionThreadRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadRow = SqlSchema.void({
    Request: ProjectionThreadDbRowSchema,
    execute: (row) =>
      sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model,
          surface,
          journey_json,
          harness,
          claude_code_backend,
          pi_render_mode,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          claude_session_id,
          pi_session_file,
          terminal_status,
          scrollback_snapshot,
          title_source,
          bookmarked,
          latest_turn_id,
          created_at,
          updated_at,
          last_interacted_at,
          archived_at,
          settled_override,
          settled_at,
          snoozed_until,
          snoozed_at,
          deleted_at
        )
        VALUES (
          ${row.threadId},
          ${row.projectId},
          ${row.title},
          ${row.model},
          ${row.surface},
          ${row.journey},
          ${row.harness},
          ${row.claudeCodeBackend},
          ${row.piRenderMode},
          ${row.runtimeMode},
          ${row.interactionMode},
          ${row.branch},
          ${row.worktreePath},
          ${row.claudeSessionId},
          ${row.piSessionFile},
          ${row.terminalStatus},
          ${row.scrollbackSnapshot},
          ${row.titleSource},
          ${row.bookmarked ? 1 : 0},
          ${row.latestTurnId},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.lastInteractedAt},
          ${row.archivedAt},
          ${row.settledOverride},
          ${row.settledAt},
          ${row.snoozedUntil},
          ${row.snoozedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          model = excluded.model,
          surface = excluded.surface,
          journey_json = excluded.journey_json,
          harness = excluded.harness,
          claude_code_backend = excluded.claude_code_backend,
          pi_render_mode = excluded.pi_render_mode,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          branch = excluded.branch,
          worktree_path = excluded.worktree_path,
          claude_session_id = excluded.claude_session_id,
          pi_session_file = excluded.pi_session_file,
          terminal_status = excluded.terminal_status,
          scrollback_snapshot = excluded.scrollback_snapshot,
          title_source = excluded.title_source,
          bookmarked = excluded.bookmarked,
          latest_turn_id = excluded.latest_turn_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          last_interacted_at = excluded.last_interacted_at,
          archived_at = excluded.archived_at,
          settled_override = excluded.settled_override,
          settled_at = excluded.settled_at,
          snoozed_until = excluded.snoozed_until,
          snoozed_at = excluded.snoozed_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionThreadRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model,
          surface,
          journey_json AS "journey",
          harness,
          claude_code_backend AS "claudeCodeBackend",
          pi_render_mode AS "piRenderMode",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          claude_session_id AS "claudeSessionId",
          pi_session_file AS "piSessionFile",
          terminal_status AS "terminalStatus",
          scrollback_snapshot AS "scrollbackSnapshot",
          title_source AS "titleSource",
          bookmarked,
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          last_interacted_at AS "lastInteractedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const getProjectionThreadWorkspaceBindingRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadInput,
    Result: ProjectionThreadWorkspaceBinding,
    execute: ({ threadId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          worktree_path AS "worktreePath"
        FROM projection_threads
        WHERE thread_id = ${threadId}
          AND deleted_at IS NULL
      `,
  });

  const listProjectionThreadRows = SqlSchema.findAll({
    Request: ListProjectionThreadsByProjectInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model,
          surface,
          journey_json AS "journey",
          harness,
          claude_code_backend AS "claudeCodeBackend",
          pi_render_mode AS "piRenderMode",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          claude_session_id AS "claudeSessionId",
          pi_session_file AS "piSessionFile",
          terminal_status AS "terminalStatus",
          scrollback_snapshot AS "scrollbackSnapshot",
          title_source AS "titleSource",
          bookmarked,
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          last_interacted_at AS "lastInteractedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
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
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadRepository.upsert:query",
          "ProjectionThreadRepository.upsert:encode",
        ),
      ),
    );

  const getById: ProjectionThreadRepositoryShape["getById"] = (input) =>
    getProjectionThreadRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadRepository.getById:query",
          "ProjectionThreadRepository.getById:decode",
        ),
      ),
    );

  const getWorkspaceBindingById: ProjectionThreadRepositoryShape["getWorkspaceBindingById"] = (
    input,
  ) =>
    getProjectionThreadWorkspaceBindingRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadRepository.getWorkspaceBindingById:query"),
      ),
    );

  const listByProjectId: ProjectionThreadRepositoryShape["listByProjectId"] = (input) =>
    listProjectionThreadRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadRepository.listByProjectId:query",
          "ProjectionThreadRepository.listByProjectId:decode",
        ),
      ),
    );

  const deleteById: ProjectionThreadRepositoryShape["deleteById"] = (input) =>
    deleteProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.deleteById:query")),
    );

  const clearScrollbackSnapshotBulk: ProjectionThreadRepositoryShape["clearScrollbackSnapshotBulk"] =
    (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            if (input.excludeThreadIds.length === 0) {
              yield* sql`
              UPDATE projection_threads
              SET scrollback_snapshot = NULL
              WHERE deleted_at IS NULL
                AND scrollback_snapshot IS NOT NULL
            `;
              // changes() must run on the same connection as the UPDATE — transaction ensures this
              const [row] = yield* sql<{ count: number }>`SELECT changes() AS count`;
              return row?.count ?? 0;
            }

            const excludedThreadIds = new Set(input.excludeThreadIds);
            const rows = yield* sql<{ thread_id: string }>`
            SELECT thread_id
            FROM projection_threads
            WHERE deleted_at IS NULL
              AND scrollback_snapshot IS NOT NULL
          `;
            const threadIdsToClear = rows
              .map((row) => row.thread_id)
              .filter((threadId) => !excludedThreadIds.has(threadId));
            for (const threadId of threadIdsToClear) {
              yield* sql`
              UPDATE projection_threads
              SET scrollback_snapshot = NULL
              WHERE thread_id = ${threadId}
            `;
            }
            return threadIdsToClear.length;
          }),
        )
        .pipe(
          Effect.mapError(
            toPersistenceSqlError("ProjectionThreadRepository.clearScrollbackSnapshotBulk:query"),
          ),
        );

  return {
    upsert,
    getById,
    getWorkspaceBindingById,
    listByProjectId,
    deleteById,
    clearScrollbackSnapshotBulk,
  } satisfies ProjectionThreadRepositoryShape;
});

export const ProjectionThreadRepositoryLive = Layer.effect(
  ProjectionThreadRepository,
  makeProjectionThreadRepository,
);
