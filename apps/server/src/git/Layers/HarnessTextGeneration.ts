import { Effect, Layer } from "effect";
import type { CodingHarness } from "@clui/contracts";

import { TextGeneration, type TextGenerationShape } from "../Services/TextGeneration.ts";
import { makeClaudeCliTextGeneration } from "./ClaudeCliTextGeneration.ts";
import { makePiCliTextGeneration } from "./PiCliTextGeneration.ts";

export const makeHarnessTextGeneration = Effect.gen(function* () {
  const claude = yield* makeClaudeCliTextGeneration;
  const pi = yield* makePiCliTextGeneration;

  const select = (harness: CodingHarness | undefined): TextGenerationShape =>
    harness === "pi" ? pi : claude;

  return {
    generateCommitMessage: (input) => select(input.harness).generateCommitMessage(input),
    generatePrContent: (input) => select(input.harness).generatePrContent(input),
    generateBranchName: (input) => select(input.harness).generateBranchName(input),
    // Thread titles are still generated through the existing Claude/Codex path.
    // They are not tied to a user-selected terminal harness.
    generateThreadTitle: (input) => claude.generateThreadTitle(input),
  } satisfies TextGenerationShape;
});

export const HarnessTextGenerationLive = Layer.effect(TextGeneration, makeHarnessTextGeneration);
