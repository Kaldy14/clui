import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

import {
  DeleteProjectionProjectInput,
  GetProjectionProjectInput,
  ProjectionProject,
  ProjectionProjectRepository,
  type ProjectionProjectRepositoryShape,
} from "../Services/ProjectionProjects.ts";
import { ProjectPrompt, ProjectScript } from "@clui/contracts";

// Makes sure that the scripts/prompts are parsed from the JSON strings the DB returns
const ProjectionProjectDbRowSchema = ProjectionProject.mapFields(
  Struct.assign({
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
    prompts: Schema.fromJsonString(Schema.Array(ProjectPrompt)),
  }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionProjectRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionProjectRow = SqlSchema.void({
    Request: ProjectionProjectDbRowSchema,
    execute: (row) =>
      sql`
            INSERT INTO projection_projects (
              project_id,
              title,
              workspace_root,
              default_model,
              scripts_json,
              prompts_json,
              created_at,
              updated_at,
              hidden_at,
              deleted_at
            )
            VALUES (
              ${row.projectId},
              ${row.title},
              ${row.workspaceRoot},
              ${row.defaultModel},
              ${row.scripts},
              ${row.prompts},
              ${row.createdAt},
              ${row.updatedAt},
              ${row.hiddenAt},
              ${row.deletedAt}
            )
            ON CONFLICT (project_id)
            DO UPDATE SET
              title = excluded.title,
              workspace_root = excluded.workspace_root,
              default_model = excluded.default_model,
              scripts_json = excluded.scripts_json,
              prompts_json = excluded.prompts_json,
              created_at = excluded.created_at,
              updated_at = excluded.updated_at,
              hidden_at = excluded.hidden_at,
              deleted_at = excluded.deleted_at
          `,
  });

  const getProjectionProjectRow = SqlSchema.findOneOption({
    Request: GetProjectionProjectInput,
    Result: ProjectionProjectDbRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model AS "defaultModel",
          scripts_json AS "scripts",
          prompts_json AS "prompts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          hidden_at AS "hiddenAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE project_id = ${projectId}
      `,
  });

  const listProjectionProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model AS "defaultModel",
          scripts_json AS "scripts",
          prompts_json AS "prompts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          hidden_at AS "hiddenAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const deleteProjectionProjectRow = SqlSchema.void({
    Request: DeleteProjectionProjectInput,
    execute: ({ projectId }) =>
      sql`
        DELETE FROM projection_projects
        WHERE project_id = ${projectId}
      `,
  });

  const upsert: ProjectionProjectRepositoryShape["upsert"] = (row) =>
    upsertProjectionProjectRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionProjectRepository.upsert:query",
          "ProjectionProjectRepository.upsert:encodeRequest",
        ),
      ),
    );

  const getById: ProjectionProjectRepositoryShape["getById"] = (input) =>
    getProjectionProjectRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionProjectRepository.getById:query",
          "ProjectionProjectRepository.getById:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            Effect.succeed(Option.some(row as Schema.Schema.Type<typeof ProjectionProject>)),
        }),
      ),
    );

  const listAll: ProjectionProjectRepositoryShape["listAll"] = () =>
    listProjectionProjectRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionProjectRepository.listAll:query",
          "ProjectionProjectRepository.listAll:decodeRows",
        ),
      ),
      Effect.map((rows) => rows as ReadonlyArray<Schema.Schema.Type<typeof ProjectionProject>>),
    );

  const deleteById: ProjectionProjectRepositoryShape["deleteById"] = (input) =>
    deleteProjectionProjectRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionProjectRepository.deleteById:query")),
    );

  return {
    upsert,
    getById,
    listAll,
    deleteById,
  } satisfies ProjectionProjectRepositoryShape;
});

export const ProjectionProjectRepositoryLive = Layer.effect(
  ProjectionProjectRepository,
  makeProjectionProjectRepository,
);
