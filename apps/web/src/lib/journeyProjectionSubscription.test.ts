import {
  ThreadId,
  type JourneyProjectionDelta,
  type JourneyProjectionSnapshot,
  type NativeApi,
} from "@clui/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  applyJourneyProjectionDelta,
  subscribeJourneyProjection,
} from "./journeyProjectionSubscription";

const threadId = ThreadId.makeUnsafe("journey-projection-client");

function snapshot(revision: number, title = "Journey"): JourneyProjectionSnapshot {
  return {
    threadId,
    journeyRevision: revision,
    globalEventWatermark: revision * 10,
    journey: {
      version: 1,
      destination: title,
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

function delta(fromRevision: number, title: string, watermark = 100): JourneyProjectionDelta {
  return {
    threadId,
    fromRevision,
    toRevision: fromRevision + 1,
    globalEventWatermark: watermark,
    changedEntities: { journey: snapshot(fromRevision + 1, title).journey },
  };
}

describe("Journey projection subscription", () => {
  it("applies contiguous deltas, ignores duplicates and identifies genuine gaps", () => {
    const current = snapshot(2);
    expect(applyJourneyProjectionDelta(current, delta(1, "duplicate")).kind).toBe("duplicate");
    expect(applyJourneyProjectionDelta(current, delta(3, "gap")).kind).toBe("gap");
    const applied = applyJourneyProjectionDelta(current, delta(2, "next", 999));
    expect(applied).toMatchObject({
      kind: "applied",
      snapshot: { journeyRevision: 3, globalEventWatermark: 999, journey: { destination: "next" } },
    });
    const baseSteeringDelta = delta(2, "next", 1_000);
    const steeringDelta: JourneyProjectionDelta = {
      ...baseSteeringDelta,
      changedEntities: {
        ...baseSteeringDelta.changedEntities,
        steering: [
          {
            id: "steer-1",
            threadId,
            runId: "run-1",
            nodeId: "node-1",
            prompt: "Refine this",
            sequence: 1,
            status: "queued",
            createdAt: "2026-08-02T00:00:00.000Z",
            deliveredAt: null,
          },
        ],
      },
    };
    expect(applyJourneyProjectionDelta(current, steeringDelta)).toMatchObject({
      kind: "applied",
      snapshot: { steering: [{ id: "steer-1", status: "queued" }] },
    });
  });

  it("uses Journey-only catch-up and reset without dispatching work", async () => {
    let listener: ((value: JourneyProjectionDelta) => void) | null = null;
    const getJourneyProjection = vi.fn().mockResolvedValue(snapshot(1, "initial"));
    const getJourneyDeltas = vi
      .fn()
      .mockResolvedValue({ kind: "reset", snapshot: snapshot(4, "reset") });
    const dispatchCommand = vi.fn();
    const api = {
      orchestration: {
        getJourneyProjection,
        getJourneyDeltas,
        dispatchCommand,
        onJourneyProjection: (callback: (value: JourneyProjectionDelta) => void) => {
          listener = callback;
          return () => {
            listener = null;
          };
        },
      },
    } as unknown as NativeApi;
    const onSnapshot = vi.fn();
    const subscription = subscribeJourneyProjection({ api, threadId, onSnapshot });
    await subscription.ready;
    listener!(delta(3, "missed"));
    await subscription.catchUp();

    expect(getJourneyDeltas).toHaveBeenCalledWith({ threadId, afterJourneyRevision: 1 });
    expect(onSnapshot).toHaveBeenLastCalledWith(snapshot(4, "reset"));
    expect(dispatchCommand).not.toHaveBeenCalled();
    subscription.dispose();
  });
});
