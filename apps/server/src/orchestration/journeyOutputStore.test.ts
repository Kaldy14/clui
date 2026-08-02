import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type JourneyAttemptFence } from "@clui/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import {
  JourneyOutputStore,
  JourneyOutputStoreLive,
  JourneyOutputStoreService,
} from "./journeyOutputStore.ts";

function fence(attempt: number, nodeId = "node-a"): JourneyAttemptFence {
  return {
    threadId: ThreadId.makeUnsafe("journey-output-thread"),
    runId: "run-a",
    nodeId,
    attempt,
  };
}

describe("JourneyOutputStore", () => {
  it("uses monotonic byte cursors and duplicate reads are idempotent", () => {
    const store = new JourneyOutputStore(128);
    const current = fence(1);
    store.beginAttempt(current);
    expect(store.append(current, "až")).toEqual({ firstCursor: 0, nextCursor: 3 });
    expect(store.append(current, "b")).toEqual({ firstCursor: 3, nextCursor: 4 });

    const first = store.read(current, 1);
    expect(first).toMatchObject({ reset: false, firstCursor: 0, nextCursor: 4, data: "žb" });
    expect(store.read(current, 1)).toEqual(first);
    expect(store.read(current, 4).data).toBe("");
  });

  it("bounds retained bytes and resets cursors that fell off", () => {
    const store = new JourneyOutputStore(5);
    const current = fence(1);
    store.beginAttempt(current);
    store.append(current, "1234");
    store.append(current, "žlu");

    const reset = store.read(current, 0);
    expect(reset.reset).toBe(true);
    expect(Buffer.byteLength(reset.data, "utf8")).toBeLessThanOrEqual(5);
    expect(reset.firstCursor).toBeGreaterThan(0);
    expect(reset.nextCursor).toBe(8);
    expect(store.read(current, reset.firstCursor)).toEqual({ ...reset, reset: false });
  });

  it("isolates attempts and rejects stale output after replacement", () => {
    const store = new JourneyOutputStore();
    const oldAttempt = fence(1);
    const current = fence(2);
    store.beginAttempt(oldAttempt);
    store.append(oldAttempt, "old");
    store.beginAttempt(current);

    expect(() => store.append(oldAttempt, "late")).toThrow(/stale or inactive/u);
    store.append(current, "new");
    expect(store.read(oldAttempt, 0).data).toBe("old");
    expect(store.read(current, 0).data).toBe("new");
    expect(() => store.beginAttempt(fence(1, "other-node"))).toThrow(/stale or mismatched/u);
    expect(() => store.beginAttempt(fence(3, "other-node"))).toThrow(/node identity/u);
  });

  it("treats an exact-fence begin as idempotent without clearing output", () => {
    const store = new JourneyOutputStore();
    const current = fence(1);
    store.beginAttempt(current);
    store.append(current, "kept");
    store.beginAttempt(current);
    expect(store.read(current, 0).data).toBe("kept");
  });

  it("retains fenced output across service and engine-layer recreation", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clui-journey-output-"));
    const databasePath = path.join(tempDir, "state.sqlite");
    const persistence = makeSqlitePersistenceLive(databasePath).pipe(
      Layer.provide(NodeServices.layer),
    );
    const makeRuntime = () =>
      ManagedRuntime.make(JourneyOutputStoreLive.pipe(Layer.provide(persistence)));
    const current = fence(1);
    const firstRuntime = makeRuntime();
    const firstStore = await firstRuntime.runPromise(Effect.service(JourneyOutputStoreService));
    await firstRuntime.runPromise(firstStore.beginAttempt(current));
    await firstRuntime.runPromise(firstStore.append(current, "survives restart"));
    await firstRuntime.runPromise(firstStore.beginAttempt(current));
    await firstRuntime.dispose();

    const secondRuntime = makeRuntime();
    const secondStore = await secondRuntime.runPromise(Effect.service(JourneyOutputStoreService));
    expect(await secondRuntime.runPromise(secondStore.read(current, 0))).toMatchObject({
      fence: current,
      nextCursor: 16,
      data: "survives restart",
    });
    await expect(
      secondRuntime.runPromise(secondStore.beginAttempt(fence(1, "other-node"))),
    ).rejects.toThrow(/stale or mismatched/u);
    await expect(
      secondRuntime.runPromise(secondStore.beginAttempt(fence(2, "other-node"))),
    ).rejects.toThrow(/node identity/u);
    await secondRuntime.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
