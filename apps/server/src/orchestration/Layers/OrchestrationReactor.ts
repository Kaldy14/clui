import { Effect, Layer } from "effect";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { JourneyReactor } from "../Services/JourneyReactor.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const checkpointReactor = yield* CheckpointReactor;
  const journeyReactor = yield* JourneyReactor;

  const start: OrchestrationReactorShape["start"] = Effect.gen(function* () {
    yield* checkpointReactor.start;
    yield* journeyReactor.start;
  });

  return {
    start,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
