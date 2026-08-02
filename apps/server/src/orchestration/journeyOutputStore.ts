import type { JourneyAttemptFence, JourneyOutputReadResult } from "@clui/contracts";
import { Effect, Layer, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const DEFAULT_JOURNEY_OUTPUT_RETENTION_BYTES = 2 * 1024 * 1024;

interface AttemptOutput {
  readonly fence: JourneyAttemptFence;
  firstCursor: number;
  nextCursor: number;
  retained: Buffer;
}

function runKey(fence: Pick<JourneyAttemptFence, "threadId" | "runId">): string {
  return JSON.stringify([fence.threadId, fence.runId]);
}

function attemptKey(fence: JourneyAttemptFence): string {
  return JSON.stringify([fence.threadId, fence.runId, fence.nodeId, fence.attempt]);
}

function sameFence(left: JourneyAttemptFence, right: JourneyAttemptFence): boolean {
  return (
    left.threadId === right.threadId &&
    left.runId === right.runId &&
    left.nodeId === right.nodeId &&
    left.attempt === right.attempt
  );
}

function utf8Boundary(buffer: Buffer, requestedStart: number): number {
  let start = requestedStart;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return start;
}

/**
 * Bounded high-volume output storage keyed by the complete physical-attempt fence.
 * The active-fence registry rejects output from replaced attempts before any bytes
 * are retained. Output deliberately stays outside the orchestration event log.
 */
export class JourneyOutputStore {
  readonly #retentionBytes: number;
  readonly #activeFenceByRun = new Map<string, JourneyAttemptFence>();
  readonly #currentFenceByRun = new Map<string, JourneyAttemptFence>();
  readonly #outputByAttempt = new Map<string, AttemptOutput>();

  constructor(retentionBytes = DEFAULT_JOURNEY_OUTPUT_RETENTION_BYTES) {
    if (!Number.isSafeInteger(retentionBytes) || retentionBytes < 1) {
      throw new Error("Journey output retention must be a positive integer.");
    }
    this.#retentionBytes = retentionBytes;
  }

  beginAttempt(fence: JourneyAttemptFence): void {
    const key = runKey(fence);
    const current = this.#currentFenceByRun.get(key);
    if (current) {
      if (sameFence(current, fence)) {
        this.#activeFenceByRun.set(key, { ...fence });
        return;
      }
      if (fence.attempt <= current.attempt) {
        throw new Error(`Cannot activate stale or mismatched Journey attempt ${fence.attempt}.`);
      }
      if (fence.nodeId !== current.nodeId) {
        throw new Error("A newer Journey attempt cannot change its run's node identity.");
      }
    }
    this.#currentFenceByRun.set(key, { ...fence });
    this.#activeFenceByRun.set(key, { ...fence });
    const outputKey = attemptKey(fence);
    if (!this.#outputByAttempt.has(outputKey)) {
      this.#outputByAttempt.set(outputKey, {
        fence: { ...fence },
        firstCursor: 0,
        nextCursor: 0,
        retained: Buffer.alloc(0),
      });
    }
  }

  append(fence: JourneyAttemptFence, data: string): { firstCursor: number; nextCursor: number } {
    const active = this.#activeFenceByRun.get(runKey(fence));
    if (!active || !sameFence(active, fence)) {
      throw new Error(`Rejected output from stale or inactive Journey attempt '${fence.runId}'.`);
    }
    const output = this.#outputByAttempt.get(attemptKey(fence));
    if (!output) throw new Error("Journey attempt output was not initialized.");
    const encoded = Buffer.from(data, "utf8");
    const startCursor = output.nextCursor;
    output.nextCursor += encoded.byteLength;
    output.retained = Buffer.concat([output.retained, encoded]);
    if (output.retained.byteLength > this.#retentionBytes) {
      const requestedStart = output.retained.byteLength - this.#retentionBytes;
      const start = utf8Boundary(output.retained, requestedStart);
      output.retained = output.retained.subarray(start);
      output.firstCursor = output.nextCursor - output.retained.byteLength;
    }
    return { firstCursor: startCursor, nextCursor: output.nextCursor };
  }

  read(fence: JourneyAttemptFence, afterCursor: number): JourneyOutputReadResult {
    const output = this.#outputByAttempt.get(attemptKey(fence));
    if (!output) {
      return { fence: { ...fence }, reset: false, firstCursor: 0, nextCursor: 0, data: "" };
    }
    const reset = afterCursor < output.firstCursor || afterCursor > output.nextCursor;
    const effectiveCursor = reset ? output.firstCursor : afterCursor;
    const relativeOffset = effectiveCursor - output.firstCursor;
    return {
      fence: { ...output.fence },
      reset,
      firstCursor: output.firstCursor,
      nextCursor: output.nextCursor,
      data: output.retained.subarray(relativeOffset).toString("utf8"),
    };
  }

  deactivate(fence: JourneyAttemptFence): void {
    const key = runKey(fence);
    const active = this.#activeFenceByRun.get(key);
    if (active && sameFence(active, fence)) this.#activeFenceByRun.delete(key);
  }
}

export interface JourneyOutputStoreShape {
  readonly beginAttempt: (fence: JourneyAttemptFence) => Effect.Effect<void, Error>;
  readonly append: (
    fence: JourneyAttemptFence,
    data: string,
  ) => Effect.Effect<{ firstCursor: number; nextCursor: number }, Error>;
  readonly read: (
    fence: JourneyAttemptFence,
    afterCursor: number,
  ) => Effect.Effect<JourneyOutputReadResult, Error>;
  readonly deactivate: (fence: JourneyAttemptFence) => Effect.Effect<void, Error>;
}

export class JourneyOutputStoreService extends ServiceMap.Service<
  JourneyOutputStoreService,
  JourneyOutputStoreShape
>()("clui/orchestration/JourneyOutputStore") {}

export function makeJourneyOutputStoreLayer(retentionBytes?: number) {
  return Layer.effect(
    JourneyOutputStoreService,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const limit = retentionBytes ?? DEFAULT_JOURNEY_OUTPUT_RETENTION_BYTES;
      if (!Number.isSafeInteger(limit) || limit < 1) {
        return yield* Effect.fail(
          new Error("Journey output retention must be a positive integer."),
        );
      }

      type OutputRow = {
        readonly threadId: string;
        readonly runId: string;
        readonly nodeId: string;
        readonly attempt: number;
        readonly current: number;
        readonly active: number;
        readonly firstCursor: number;
        readonly nextCursor: number;
        readonly retainedBase64: string;
      };
      const findCurrent = (fence: JourneyAttemptFence) =>
        sql<OutputRow>`
          SELECT thread_id AS "threadId", run_id AS "runId", node_id AS "nodeId",
            attempt, current, active, first_cursor AS "firstCursor",
            next_cursor AS "nextCursor", retained_base64 AS "retainedBase64"
          FROM journey_attempt_output
          WHERE thread_id = ${fence.threadId} AND run_id = ${fence.runId} AND current = 1
          LIMIT 1
        `;
      const findExact = (fence: JourneyAttemptFence) =>
        sql<OutputRow>`
          SELECT thread_id AS "threadId", run_id AS "runId", node_id AS "nodeId",
            attempt, current, active, first_cursor AS "firstCursor",
            next_cursor AS "nextCursor", retained_base64 AS "retainedBase64"
          FROM journey_attempt_output
          WHERE thread_id = ${fence.threadId} AND run_id = ${fence.runId}
            AND node_id = ${fence.nodeId} AND attempt = ${fence.attempt}
          LIMIT 1
        `;
      const rowFence = (row: OutputRow): JourneyAttemptFence => ({
        threadId: row.threadId as JourneyAttemptFence["threadId"],
        runId: row.runId,
        nodeId: row.nodeId,
        attempt: row.attempt,
      });
      const beginAttempt: JourneyOutputStoreShape["beginAttempt"] = (fence) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const [current] = yield* findCurrent(fence);
              if (current) {
                const currentFence = rowFence(current);
                if (!sameFence(currentFence, fence)) {
                  if (fence.attempt <= current.attempt) {
                    return yield* Effect.fail(
                      new Error(
                        `Cannot activate stale or mismatched Journey attempt ${fence.attempt}.`,
                      ),
                    );
                  }
                  if (fence.nodeId !== current.nodeId) {
                    return yield* Effect.fail(
                      new Error("A newer Journey attempt cannot change its run's node identity."),
                    );
                  }
                } else {
                  yield* sql`
                  UPDATE journey_attempt_output SET active = 1
                  WHERE thread_id = ${fence.threadId} AND run_id = ${fence.runId}
                    AND node_id = ${fence.nodeId} AND attempt = ${fence.attempt}
                `;
                  return;
                }
              }
              yield* sql`
              INSERT OR IGNORE INTO journey_attempt_output (
                thread_id, run_id, node_id, attempt, current, active,
                first_cursor, next_cursor, retained_base64
              ) VALUES (${fence.threadId}, ${fence.runId}, ${fence.nodeId}, ${fence.attempt}, 0, 0, 0, 0, '')
            `;
              yield* sql`
              UPDATE journey_attempt_output SET current = 0, active = 0
              WHERE thread_id = ${fence.threadId} AND run_id = ${fence.runId}
            `;
              yield* sql`
              UPDATE journey_attempt_output SET current = 1, active = 1
              WHERE thread_id = ${fence.threadId} AND run_id = ${fence.runId}
                AND node_id = ${fence.nodeId} AND attempt = ${fence.attempt}
            `;
            }),
          )
          .pipe(
            Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
          );

      const append: JourneyOutputStoreShape["append"] = (fence, data) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const [row] = yield* findExact(fence);
              if (!row || row.current !== 1 || row.active !== 1) {
                return yield* Effect.fail(
                  new Error(
                    `Rejected output from stale or inactive Journey attempt '${fence.runId}'.`,
                  ),
                );
              }
              const encoded = Buffer.from(data, "utf8");
              const startCursor = row.nextCursor;
              const nextCursor = row.nextCursor + encoded.byteLength;
              let retained = Buffer.concat([Buffer.from(row.retainedBase64, "base64"), encoded]);
              let firstCursor = row.firstCursor;
              if (retained.byteLength > limit) {
                const start = utf8Boundary(retained, retained.byteLength - limit);
                retained = retained.subarray(start);
                firstCursor = nextCursor - retained.byteLength;
              }
              yield* sql`
              UPDATE journey_attempt_output
              SET first_cursor = ${firstCursor}, next_cursor = ${nextCursor},
                retained_base64 = ${retained.toString("base64")}
              WHERE thread_id = ${fence.threadId} AND run_id = ${fence.runId}
                AND node_id = ${fence.nodeId} AND attempt = ${fence.attempt}
                AND current = 1 AND active = 1
            `;
              return { firstCursor: startCursor, nextCursor };
            }),
          )
          .pipe(
            Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
          );

      const read: JourneyOutputStoreShape["read"] = (fence, afterCursor) =>
        Effect.gen(function* () {
          const [row] = yield* findExact(fence);
          if (!row) {
            return { fence: { ...fence }, reset: false, firstCursor: 0, nextCursor: 0, data: "" };
          }
          const retained = Buffer.from(row.retainedBase64, "base64");
          const reset = afterCursor < row.firstCursor || afterCursor > row.nextCursor;
          const effectiveCursor = reset ? row.firstCursor : afterCursor;
          return {
            fence: rowFence(row),
            reset,
            firstCursor: row.firstCursor,
            nextCursor: row.nextCursor,
            data: retained.subarray(effectiveCursor - row.firstCursor).toString("utf8"),
          };
        }).pipe(
          Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
        );

      const deactivate: JourneyOutputStoreShape["deactivate"] = (fence) =>
        sql`
          UPDATE journey_attempt_output SET active = 0
          WHERE thread_id = ${fence.threadId} AND run_id = ${fence.runId}
            AND node_id = ${fence.nodeId} AND attempt = ${fence.attempt} AND current = 1
        `.pipe(
          Effect.asVoid,
          Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
        );

      return {
        beginAttempt,
        append,
        read,
        deactivate,
      };
    }),
  );
}

export const JourneyOutputStoreLive = makeJourneyOutputStoreLayer();
