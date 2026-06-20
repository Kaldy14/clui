import * as Effect from "effect/Effect";

import RedactTerminalScrollback from "./027_RedactTerminalScrollback.ts";
import ProjectionThreadsPiRenderMode from "./028_ProjectionThreadsPiRenderMode.ts";

export default Effect.gen(function* () {
  // Some development databases already recorded migration ids 27/28 for an older
  // Cowork branch. Re-run these idempotent migrations under a fresh id so those
  // databases receive the current projection schema too.
  yield* RedactTerminalScrollback;
  yield* ProjectionThreadsPiRenderMode;
});
