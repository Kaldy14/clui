import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { OrchestrationReactor } from "../Services/OrchestrationReactor.ts";
import { JourneyReactor } from "../Services/JourneyReactor.ts";
import { makeOrchestrationReactor } from "./OrchestrationReactor.ts";

describe("OrchestrationReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<OrchestrationReactor, never> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  it("starts checkpoint and Journey reactors", async () => {
    const started: string[] = [];

    runtime = ManagedRuntime.make(
      Layer.effect(OrchestrationReactor, makeOrchestrationReactor).pipe(
        Layer.provideMerge(
          Layer.succeed(CheckpointReactor, {
            start: Effect.sync(() => {
              started.push("checkpoint-reactor");
            }),
            ensureBaseline: () => Effect.void,
            captureTerminalTurnCheckpoint: () => Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(JourneyReactor, {
            start: Effect.sync(() => {
              started.push("journey-reactor");
            }),
          }),
        ),
      ),
    );

    const reactor = await runtime.runPromise(Effect.service(OrchestrationReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start.pipe(Scope.provide(scope)));

    expect(started).toEqual(["checkpoint-reactor", "journey-reactor"]);

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
