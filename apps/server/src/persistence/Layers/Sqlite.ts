import { Effect, Layer, FileSystem, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import { ServerConfig } from "../../config.ts";

const DATABASE_COMPACTION_MIN_BYTES = 256 * 1024 * 1024;
const DATABASE_COMPACTION_MIN_FREE_RATIO = 0.75;

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
};

type Loader = {
  layer: (config: RuntimeSqliteLayerConfig) => Layer.Layer<SqlClient.SqlClient>;
};
const defaultSqliteClientLoaders = {
  bun: () => import("@effect/sql-sqlite-bun/SqliteClient"),
  node: () => import("../NodeSqliteClient.ts"),
} satisfies Record<string, () => Promise<Loader>>;

const makeRuntimeSqliteLayer = (
  config: RuntimeSqliteLayerConfig,
): Layer.Layer<SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const runtime = process.versions.bun !== undefined ? "bun" : "node";
    const loader = defaultSqliteClientLoaders[runtime];
    const clientModule = yield* Effect.promise<Loader>(loader);
    return clientModule.layer(config);
  }).pipe(Layer.unwrap);

export function shouldCompactDatabase(input: {
  readonly pageCount: number;
  readonly freePageCount: number;
  readonly pageSize: number;
}): boolean {
  if (input.pageCount <= 0 || input.freePageCount <= 0 || input.pageSize <= 0) {
    return false;
  }
  const databaseBytes = input.pageCount * input.pageSize;
  const freeRatio = input.freePageCount / input.pageCount;
  return (
    databaseBytes >= DATABASE_COMPACTION_MIN_BYTES &&
    freeRatio >= DATABASE_COMPACTION_MIN_FREE_RATIO
  );
}

const compactDatabaseIfWasteful = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA optimize;`;
  const [pageCountRow] = yield* sql<{ readonly page_count: number }>`PRAGMA page_count;`;
  const [freePageCountRow] = yield* sql<{
    readonly freelist_count: number;
  }>`PRAGMA freelist_count;`;
  const [pageSizeRow] = yield* sql<{ readonly page_size: number }>`PRAGMA page_size;`;
  const pageCount = pageCountRow?.page_count ?? 0;
  const freePageCount = freePageCountRow?.freelist_count ?? 0;
  const pageSize = pageSizeRow?.page_size ?? 0;

  if (!shouldCompactDatabase({ pageCount, freePageCount, pageSize })) return;

  yield* Effect.logInfo("compacting sparse SQLite database", {
    pageCount,
    freePageCount,
    pageSize,
  });
  yield* sql`VACUUM;`;
}).pipe(
  Effect.catch((cause) =>
    Effect.logWarning("SQLite maintenance failed; continuing without compaction", {
      cause,
    }),
  ),
);

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* runMigrations;
    yield* compactDatabaseIfWasteful;
  }),
);

export const makeSqlitePersistenceLive = (dbPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

    return Layer.provideMerge(setup, makeRuntimeSqliteLayer({ filename: dbPath }));
  }).pipe(Layer.unwrap);

export const SqlitePersistenceMemory = Layer.provideMerge(
  setup,
  makeRuntimeSqliteLayer({ filename: ":memory:" }),
);

export const layerConfig = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig;
  const { join } = yield* Path.Path;
  const dbPath = join(stateDir, "state.sqlite");
  return makeSqlitePersistenceLive(dbPath);
}).pipe(Layer.unwrap);
