import { Effect, Layer } from "effect";
import type { CodingHarness } from "@clui/contracts";

import { ServerConfig } from "../../config.ts";
import { loadServerSettings } from "../../serverSettings.ts";
import { TextGeneration, type TextGenerationShape } from "../Services/TextGeneration.ts";
import { makeClaudeCliTextGeneration } from "./ClaudeCliTextGeneration.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
import { makePiCliTextGeneration } from "./PiCliTextGeneration.ts";

export const makeHarnessTextGeneration = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const claude = yield* makeClaudeCliTextGeneration;
  const codex = yield* makeCodexTextGeneration;
  const pi = yield* makePiCliTextGeneration;

  const select = (harness: CodingHarness | undefined): TextGenerationShape =>
    harness === "pi" ? pi : claude;

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = (input) =>
    Effect.promise(() => loadServerSettings(serverConfig.stateDir)).pipe(
      Effect.flatMap((settings) =>
        settings.titleGenerationProvider === "codex"
          ? codex
              .generateThreadTitle(input)
              .pipe(Effect.catch(() => claude.generateThreadTitle(input)))
          : claude
              .generateThreadTitle(input)
              .pipe(Effect.catch(() => codex.generateThreadTitle(input))),
      ),
    );

  return {
    generateCommitMessage: (input) => select(input.harness).generateCommitMessage(input),
    generatePrContent: (input) => select(input.harness).generatePrContent(input),
    generateBranchName: (input) => select(input.harness).generateBranchName(input),
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

export const HarnessTextGenerationLive = Layer.effect(TextGeneration, makeHarnessTextGeneration);
