import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer, Path as EffectPath } from "effect";
import { describe, expect } from "vitest";

import { ServerConfig } from "../../config.ts";
import { getServerSettingsPath } from "../../serverSettings.ts";
import { makeHarnessTextGeneration } from "./HarnessTextGeneration.ts";

interface FakeTitleCliOptions {
  readonly claudeTitle?: string;
  readonly codexTitle?: string;
  readonly claudeExitCode?: number;
  readonly codexExitCode?: number;
}

function writeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, "utf8");
  if (process.platform !== "win32") {
    fs.chmodSync(filePath, 0o755);
  }
}

function makeFakeTitleCliBin(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clui-title-cli-"));
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });

  writeExecutable(
    path.join(binDir, "claude"),
    [
      "#!/bin/sh",
      'if [ "${T3_FAKE_CLAUDE_EXIT_CODE:-0}" != "0" ]; then',
      '  printf "%s\\n" "claude failed" >&2',
      '  exit "$T3_FAKE_CLAUDE_EXIT_CODE"',
      "fi",
      'printf "%s\\n" "$T3_FAKE_CLAUDE_OUTPUT"',
      "",
    ].join("\n"),
  );

  writeExecutable(
    path.join(binDir, "codex"),
    [
      "#!/bin/sh",
      'output_path=""',
      "while [ $# -gt 0 ]; do",
      '  if [ "$1" = "--output-last-message" ]; then',
      "    shift",
      '    output_path="$1"',
      "  fi",
      "  shift",
      "done",
      "cat >/dev/null",
      'if [ "${T3_FAKE_CODEX_EXIT_CODE:-0}" != "0" ]; then',
      '  printf "%s\\n" "codex failed" >&2',
      '  exit "$T3_FAKE_CODEX_EXIT_CODE"',
      "fi",
      'if [ -n "$output_path" ]; then',
      '  printf "%s" "$T3_FAKE_CODEX_OUTPUT" > "$output_path"',
      "fi",
      "",
    ].join("\n"),
  );

  return root;
}

function withTempStateDir<A, E, R>(effect: (stateDir: string) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "clui-title-state-"))),
    effect,
    (stateDir) => Effect.sync(() => fs.rmSync(stateDir, { recursive: true, force: true })),
  );
}

function withFakeTitleCliEnv<A, E, R>(
  options: FakeTitleCliOptions,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const root = makeFakeTitleCliBin();
      const previousPath = process.env.PATH;
      const previousClaudeOutput = process.env.T3_FAKE_CLAUDE_OUTPUT;
      const previousClaudeExitCode = process.env.T3_FAKE_CLAUDE_EXIT_CODE;
      const previousCodexOutput = process.env.T3_FAKE_CODEX_OUTPUT;
      const previousCodexExitCode = process.env.T3_FAKE_CODEX_EXIT_CODE;

      process.env.PATH = `${path.join(root, "bin")}${path.delimiter}${previousPath ?? ""}`;
      process.env.T3_FAKE_CLAUDE_OUTPUT = JSON.stringify({
        result: options.claudeTitle ?? "Claude Title",
      });
      process.env.T3_FAKE_CODEX_OUTPUT = JSON.stringify({
        title: options.codexTitle ?? "Codex Title",
      });
      if (options.claudeExitCode !== undefined) {
        process.env.T3_FAKE_CLAUDE_EXIT_CODE = String(options.claudeExitCode);
      } else {
        delete process.env.T3_FAKE_CLAUDE_EXIT_CODE;
      }
      if (options.codexExitCode !== undefined) {
        process.env.T3_FAKE_CODEX_EXIT_CODE = String(options.codexExitCode);
      } else {
        delete process.env.T3_FAKE_CODEX_EXIT_CODE;
      }

      return {
        root,
        previousPath,
        previousClaudeOutput,
        previousClaudeExitCode,
        previousCodexOutput,
        previousCodexExitCode,
      };
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous.previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previous.previousPath;
        if (previous.previousClaudeOutput === undefined) delete process.env.T3_FAKE_CLAUDE_OUTPUT;
        else process.env.T3_FAKE_CLAUDE_OUTPUT = previous.previousClaudeOutput;
        if (previous.previousClaudeExitCode === undefined)
          delete process.env.T3_FAKE_CLAUDE_EXIT_CODE;
        else process.env.T3_FAKE_CLAUDE_EXIT_CODE = previous.previousClaudeExitCode;
        if (previous.previousCodexOutput === undefined) delete process.env.T3_FAKE_CODEX_OUTPUT;
        else process.env.T3_FAKE_CODEX_OUTPUT = previous.previousCodexOutput;
        if (previous.previousCodexExitCode === undefined)
          delete process.env.T3_FAKE_CODEX_EXIT_CODE;
        else process.env.T3_FAKE_CODEX_EXIT_CODE = previous.previousCodexExitCode;
        fs.rmSync(previous.root, { recursive: true, force: true });
      }),
  );
}

function generateTitle(stateDir: string, promptText = "fix title generation") {
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), stateDir).pipe(
    Layer.provide(EffectPath.layer),
  );

  return makeHarnessTextGeneration.pipe(
    Effect.flatMap((textGeneration) => textGeneration.generateThreadTitle({ promptText })),
    Effect.provide(Layer.mergeAll(serverConfigLayer, NodeServices.layer, EffectPath.layer)),
  );
}

describe("HarnessTextGeneration", () => {
  it.effect("uses Claude as the default thread title provider", () =>
    withTempStateDir((stateDir) =>
      withFakeTitleCliEnv(
        { claudeTitle: "Claude Primary", codexTitle: "Codex Fallback" },
        Effect.gen(function* () {
          const result = yield* generateTitle(stateDir);
          expect(result.title).toBe("Claude Primary");
        }),
      ),
    ),
  );

  it.effect("falls back to Codex when the default Claude provider fails", () =>
    withTempStateDir((stateDir) =>
      withFakeTitleCliEnv(
        { claudeTitle: "Claude Primary", codexTitle: "Codex Fallback", claudeExitCode: 2 },
        Effect.gen(function* () {
          const result = yield* generateTitle(stateDir);
          expect(result.title).toBe("Codex Fallback");
        }),
      ),
    ),
  );

  it.effect("uses Codex first when selected in persisted server settings", () =>
    withTempStateDir((stateDir) =>
      withFakeTitleCliEnv(
        { claudeTitle: "Claude Fallback", codexTitle: "Codex Primary" },
        Effect.gen(function* () {
          fs.writeFileSync(
            getServerSettingsPath(stateDir),
            JSON.stringify({ titleGenerationProvider: "codex" }),
            "utf8",
          );

          const result = yield* generateTitle(stateDir);
          expect(result.title).toBe("Codex Primary");
        }),
      ),
    ),
  );

  it.effect("falls back to Claude when Codex is selected but fails", () =>
    withTempStateDir((stateDir) =>
      withFakeTitleCliEnv(
        { claudeTitle: "Claude Fallback", codexTitle: "Codex Primary", codexExitCode: 2 },
        Effect.gen(function* () {
          fs.writeFileSync(
            getServerSettingsPath(stateDir),
            JSON.stringify({ titleGenerationProvider: "codex" }),
            "utf8",
          );

          const result = yield* generateTitle(stateDir);
          expect(result.title).toBe("Claude Fallback");
        }),
      ),
    ),
  );
});
