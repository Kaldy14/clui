import type { JourneyProjectionSnapshot, ThreadId } from "@clui/contracts";
import { ThreadId as ThreadIdSchema } from "@clui/contracts";
import { describe, expect, it } from "vitest";

import { JourneyProjectionDeltaStore } from "./journeyProjectionDeltas.ts";

function snapshot(
  threadId: ThreadId,
  revision: number,
  watermark: number,
): JourneyProjectionSnapshot {
  return {
    threadId,
    journeyRevision: revision,
    globalEventWatermark: watermark,
    journey: {
      version: 1,
      destination: `journey-${threadId}`,
      layoutDirection: "TB",
      activeNodeId: null,
      nodes: [],
      edges: [],
      updatedAt: "2026-08-02T00:00:00.000Z",
    },
    runs: [],
    attempts: [],
    approvals: [],
    steering: [],
  };
}

describe("JourneyProjectionDeltaStore", () => {
  it("keeps revisions contiguous per Journey despite global watermark interleaving", () => {
    const store = new JourneyProjectionDeltaStore();
    const threadA = ThreadIdSchema.makeUnsafe("journey-a");
    const threadB = ThreadIdSchema.makeUnsafe("journey-b");
    store.record(0, snapshot(threadA, 1, 10));
    store.record(0, snapshot(threadB, 1, 11));
    store.record(1, snapshot(threadA, 2, 14));

    const result = store.catchUp(threadA, 0, snapshot(threadA, 2, 14));
    expect(result.kind).toBe("deltas");
    if (result.kind === "deltas") {
      expect(
        result.deltas.map(({ fromRevision, toRevision, globalEventWatermark }) => ({
          fromRevision,
          toRevision,
          globalEventWatermark,
        })),
      ).toEqual([
        { fromRevision: 0, toRevision: 1, globalEventWatermark: 10 },
        { fromRevision: 1, toRevision: 2, globalEventWatermark: 14 },
      ]);
    }
  });

  it("returns idempotent empty catch-up at current revision", () => {
    const store = new JourneyProjectionDeltaStore();
    const threadId = ThreadIdSchema.makeUnsafe("journey-current");
    const current = snapshot(threadId, 1, 2);
    store.record(0, current);
    expect(store.catchUp(threadId, 1, current)).toEqual({ kind: "deltas", deltas: [] });
  });

  it("resets to a full snapshot when retained history cannot bridge a real gap", () => {
    const store = new JourneyProjectionDeltaStore(2);
    const threadId = ThreadIdSchema.makeUnsafe("journey-gap");
    store.record(0, snapshot(threadId, 1, 1));
    store.record(1, snapshot(threadId, 2, 2));
    const current = snapshot(threadId, 3, 3);
    store.record(2, current);
    expect(store.catchUp(threadId, 0, current)).toEqual({ kind: "reset", snapshot: current });
  });
});
