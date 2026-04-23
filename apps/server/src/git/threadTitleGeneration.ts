import { randomUUID } from "node:crypto";

import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { TextGenerationError } from "./Errors.ts";
import type { ThreadTitleGenerationResult } from "./Services/TextGeneration.ts";

const TITLE_MAX_LENGTH = 60;
const TITLE_PROMPT_MAX_CHARS = 500;
const CODEX_MODEL = "gpt-5.3-codex";
const CODEX_REASONING_EFFORT = "low";
const CODEX_TITLE_TIMEOUT_MS = 45_000;

const tempDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp";

function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

function toCodexOutputJsonSchema(schema: Schema.Top): unknown {
  const document = Schema.toJsonSchemaDocument(schema);
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return {
      ...document.schema,
      $defs: document.definitions,
    };
  }
  return document.schema;
}

export function sanitizeGeneratedThreadTitle(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;

  let title = raw.trim();
  if (title.length === 0) return null;

  title = title.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();

  if (title.startsWith("{") && title.endsWith("}")) {
    try {
      const parsed = JSON.parse(title) as Record<string, unknown>;
      if (typeof parsed.title === "string") {
        title = parsed.title.trim();
      }
    } catch {
      // Best-effort cleanup only.
    }
  }

  title = title.replace(/^["']|["']$/g, "").trim();
  title = title.split(/\r?\n/g)[0]?.trim() ?? "";
  if (title.length === 0) return null;
  if (title.length > TITLE_MAX_LENGTH) {
    title = `${title.slice(0, TITLE_MAX_LENGTH - 1)}\u2026`;
  }
  return title;
}

function normalizeCodexTitleError(error: unknown, fallback: string): TextGenerationError {
  if (Schema.is(TextGenerationError)(error)) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes("Command not found: codex") ||
      lower.includes("spawn codex") ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Codex CLI (`codex`) is required for title-generation fallback but is not available on PATH.",
        cause: error,
      });
    }
    return new TextGenerationError({
      operation: "generateThreadTitle",
      detail: `${fallback}: ${error.message}`,
      cause: error,
    });
  }

  return new TextGenerationError({
    operation: "generateThreadTitle",
    detail: fallback,
    cause: error,
  });
}

export const generateThreadTitleWithCodex = (
  promptText: string,
): Effect.Effect<
  ThreadTitleGenerationResult,
  TextGenerationError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const readStreamAsString = <E>(
      stream: Stream.Stream<Uint8Array, E>,
    ): Effect.Effect<string, TextGenerationError> =>
      Effect.gen(function* () {
        let text = "";
        yield* Stream.runForEach(stream, (chunk) =>
          Effect.sync(() => {
            text += Buffer.from(chunk).toString("utf8");
          }),
        ).pipe(
          Effect.mapError((cause) =>
            normalizeCodexTitleError(cause, "Failed to collect Codex CLI output"),
          ),
        );
        return text;
      });

    const writeTempFile = (
      prefix: string,
      content: string,
    ): Effect.Effect<string, TextGenerationError> => {
      const filePath = path.join(tempDir, `clui-${prefix}-${process.pid}-${randomUUID()}.tmp`);
      return fileSystem.writeFileString(filePath, content).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: `Failed to write temp file at ${filePath}.`,
              cause,
            }),
        ),
        Effect.as(filePath),
      );
    };

    const safeUnlink = (filePath: string): Effect.Effect<void, never> =>
      fileSystem.remove(filePath).pipe(Effect.catch(() => Effect.void));

    const outputSchema = Schema.Struct({ title: Schema.String });
    const schemaPath = yield* writeTempFile(
      "codex-title-schema",
      JSON.stringify(toCodexOutputJsonSchema(outputSchema)),
    );
    const outputPath = yield* writeTempFile("codex-title-output", "");

    const cleanup = Effect.all([schemaPath, outputPath].map((filePath) => safeUnlink(filePath)), {
      concurrency: "unbounded",
    }).pipe(Effect.asVoid);

    const runCodexCommand = Effect.gen(function* () {
      const command = ChildProcess.make(
        "codex",
        [
          "exec",
          "--ephemeral",
          "-s",
          "read-only",
          "--model",
          CODEX_MODEL,
          "--config",
          `model_reasoning_effort=\"${CODEX_REASONING_EFFORT}\"`,
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          "-",
        ],
        {
          cwd: tempDir,
          shell: process.platform === "win32",
          stdin: {
            stream: Stream.make(
              new TextEncoder().encode(
                [
                  "You generate concise titles for coding sessions.",
                  "Return a JSON object with key: title.",
                  "Rules:",
                  "- Summarize the user's intent, not the literal wording.",
                  "- Use title case.",
                  "- Do not wrap the title in quotes.",
                  "- Keep it under 60 characters.",
                  "",
                  "User prompt:",
                  limitSection(promptText, TITLE_PROMPT_MAX_CHARS),
                ].join("\n"),
              ),
            ),
          },
        },
      );

      const child = yield* commandSpawner.spawn(command).pipe(
        Effect.mapError((cause) =>
          normalizeCodexTitleError(cause, "Failed to spawn Codex CLI process"),
        ),
      );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(child.stdout),
          readStreamAsString(child.stderr),
          child.exitCode.pipe(
            Effect.map((value) => Number(value)),
            Effect.mapError((cause) =>
              normalizeCodexTitleError(cause, "Failed to read Codex CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation: "generateThreadTitle",
          detail:
            detail.length > 0
              ? `Codex CLI command failed: ${detail}`
              : `Codex CLI command failed with code ${exitCode}.`,
        });
      }
    });

    return yield* Effect.gen(function* () {
      yield* runCodexCommand.pipe(
        Effect.scoped,
        Effect.timeoutOption(CODEX_TITLE_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: "generateThreadTitle",
                  detail: "Codex CLI title-generation fallback timed out.",
                }),
              ),
            onSome: () => Effect.void,
          }),
        ),
      );

      const generated = yield* fileSystem.readFileString(outputPath).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "Failed to read Codex title output file.",
              cause,
            }),
        ),
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(outputSchema))),
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "Codex returned invalid structured title output.",
              cause,
            }),
          ),
        ),
      );

      const title = sanitizeGeneratedThreadTitle(generated.title);
      if (!title) {
        return yield* new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "Codex did not generate a usable thread title.",
        });
      }

      return { title } satisfies ThreadTitleGenerationResult;
    }).pipe(Effect.ensuring(cleanup));
  });
