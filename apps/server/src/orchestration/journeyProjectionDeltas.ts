import type {
  JourneyProjectionDelta,
  JourneyProjectionSnapshot,
  OrchestrationGetJourneyDeltasResult,
  ThreadId,
} from "@clui/contracts";

const DEFAULT_RETAINED_DELTAS_PER_JOURNEY = 256;

function fullChangedEntities(snapshot: JourneyProjectionSnapshot) {
  return {
    journey: snapshot.journey,
    runs: snapshot.runs,
    attempts: snapshot.attempts,
    approvals: snapshot.approvals,
    steering: snapshot.steering,
  };
}

/** In-memory delivery history. Authoritative state remains the event-backed projection. */
export class JourneyProjectionDeltaStore {
  readonly #limit: number;
  readonly #deltasByThread = new Map<ThreadId, JourneyProjectionDelta[]>();

  constructor(limit = DEFAULT_RETAINED_DELTAS_PER_JOURNEY) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("Journey delta retention must be a positive integer.");
    }
    this.#limit = limit;
  }

  record(previousRevision: number, snapshot: JourneyProjectionSnapshot): JourneyProjectionDelta {
    if (snapshot.journeyRevision !== previousRevision + 1) {
      throw new Error(
        `Journey delta must be contiguous (${previousRevision} -> ${snapshot.journeyRevision}).`,
      );
    }
    const delta: JourneyProjectionDelta = {
      threadId: snapshot.threadId,
      fromRevision: previousRevision,
      toRevision: snapshot.journeyRevision,
      globalEventWatermark: snapshot.globalEventWatermark,
      changedEntities: fullChangedEntities(snapshot),
    };
    const retained = [...(this.#deltasByThread.get(snapshot.threadId) ?? []), delta];
    this.#deltasByThread.set(snapshot.threadId, retained.slice(-this.#limit));
    return delta;
  }

  catchUp(
    threadId: ThreadId,
    afterJourneyRevision: number,
    snapshot: JourneyProjectionSnapshot,
  ): OrchestrationGetJourneyDeltasResult {
    if (afterJourneyRevision === snapshot.journeyRevision) return { kind: "deltas", deltas: [] };
    if (afterJourneyRevision > snapshot.journeyRevision) return { kind: "reset", snapshot };
    const retained = this.#deltasByThread.get(threadId) ?? [];
    const first = retained.findIndex((delta) => delta.fromRevision === afterJourneyRevision);
    if (first < 0) return { kind: "reset", snapshot };
    const deltas = retained.slice(first);
    let revision = afterJourneyRevision;
    for (const delta of deltas) {
      if (delta.fromRevision !== revision) return { kind: "reset", snapshot };
      revision = delta.toRevision;
    }
    return revision === snapshot.journeyRevision
      ? { kind: "deltas", deltas }
      : { kind: "reset", snapshot };
  }
}
