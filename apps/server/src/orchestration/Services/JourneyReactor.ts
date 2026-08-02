import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface JourneyReactorShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
}

export class JourneyReactor extends ServiceMap.Service<JourneyReactor, JourneyReactorShape>()(
  "clui/orchestration/Services/JourneyReactor",
) {}
