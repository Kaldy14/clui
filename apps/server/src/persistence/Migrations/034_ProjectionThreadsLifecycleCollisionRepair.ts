import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Repairs databases that recorded the first Journey migration as id 31 before
 * the branch was rebased over the settled/snoozed thread migrations. In those
 * databases the migration ledger skips the current id-31 settled migration,
 * even though its columns were never added.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("settled_override")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN settled_override TEXT
    `;
  }

  if (!columnNames.has("settled_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN settled_at TEXT
    `;
  }

  if (!columnNames.has("snoozed_until")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN snoozed_until TEXT
    `;
  }

  if (!columnNames.has("snoozed_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN snoozed_at TEXT
    `;
  }
});
