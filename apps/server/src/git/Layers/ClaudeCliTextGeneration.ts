/**
 * ClaudeCliTextGeneration — text generation via `claude` CLI.
 *
 * Shells out to `claude -p` with `--json-schema` for structured output,
 * using the user's existing Claude Code subscription. No API key needed.
 *
 * @module ClaudeCliTextGeneration
 */

import { Effect, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@clui/shared/git";

import { TextGenerationError } from "../Errors.ts";
import {
  type BranchNameGenerationInput,
  type BranchNameGenerationResult,
  type CommitMessageGenerationResult,
  type PrContentGenerationResult,
  type ThreadTitleGenerationResult,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";

const SONNET_MODEL = "sonnet";
const HAIKU_MODEL = "haiku";
const TIMEOUT_MS = 120_000;

function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) return "Update project files";
  if (withoutTrailingPeriod.length <= 72) return withoutTrailingPeriod;
  return withoutTrailingPeriod.slice(0, 72).trimEnd();
}

function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  return singleLine.length > 0 ? singleLine : "Update project changes";
}

function normalizeError(
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (Schema.is(TextGenerationError)(error)) return error;
  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes("Command not found: claude") ||
      lower.includes("spawn claude") ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: "Claude CLI (`claude`) is required but not available on PATH.",
        cause: error,
      });
    }
    return new TextGenerationError({
      operation,
      detail: `${fallback}: ${error.message}`,
      cause: error,
    });
  }
  return new TextGenerationError({ operation, detail: fallback, cause: error });
}

function effectSchemaToJsonSchemaString(schema: Schema.Top): string {
  const document = Schema.toJsonSchemaDocument(schema);
  const jsonSchema =
    document.definitions && Object.keys(document.definitions).length > 0
      ? { ...document.schema, $defs: document.definitions }
      : document.schema;
  return JSON.stringify(jsonSchema);
}

const makeClaudeCliTextGeneration = Effect.gen(function* () {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const readStreamAsString = <E>(
    operation: string,
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
          normalizeError(operation, cause, "Failed to collect process output"),
        ),
      );
      return text;
    });

  const runClaudeJson = <S extends Schema.Top>({
    operation,
    model,
    systemPrompt,
    userPrompt,
    outputSchema,
    cwd,
  }: {
    operation: string;
    model: string;
    systemPrompt: string;
    userPrompt: string;
    outputSchema: S;
    cwd?: string;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const jsonSchemaStr = effectSchemaToJsonSchemaString(outputSchema);

      const command = ChildProcess.make(
        "claude",
        [
          "-p",
          "--output-format", "json",
          "--model", model,
          "--system-prompt", systemPrompt,
          "--json-schema", jsonSchemaStr,
          "--no-session-persistence",
          userPrompt,
        ],
        {
          cwd: cwd ?? process.cwd(),
          shell: process.platform === "win32",
        },
      );

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeError(operation, cause, "Failed to spawn Claude CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.map((value) => Number(value)),
            Effect.mapError((cause) =>
              normalizeError(operation, cause, "Failed to read Claude CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const detail = stderr.trim() || stdout.trim();
        return yield* new TextGenerationError({
          operation,
          detail: detail.length > 0
            ? `Claude CLI failed: ${detail}`
            : `Claude CLI failed with code ${exitCode}.`,
        });
      }

      // --output-format json returns { result: "..." , ... }
      // The result field contains the JSON matching our schema.
      const parsed = yield* Effect.try({
        try: () => JSON.parse(stdout) as Record<string, unknown>,
        catch: () =>
          new TextGenerationError({
            operation,
            detail: "Claude CLI returned invalid JSON output.",
          }),
      });

      // Extract the result — it may be a string (needs parsing) or already an object
      const resultValue = parsed.result;
      let resultObj: unknown;

      if (typeof resultValue === "string") {
        resultObj = yield* Effect.try({
          try: () => JSON.parse(resultValue),
          catch: () =>
            new TextGenerationError({
              operation,
              detail: "Claude CLI result field is not valid JSON.",
            }),
        });
      } else if (typeof resultValue === "object" && resultValue !== null) {
        resultObj = resultValue;
      } else {
        return yield* new TextGenerationError({
          operation,
          detail: "Claude CLI returned no result field in output.",
        });
      }

      return yield* Schema.decodeEffect(outputSchema)(resultObj).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Claude CLI returned invalid structured output.",
              cause,
            }),
          ),
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Claude CLI request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

  // ── Commit messages ──────────────────────────────────────────────────

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = (input) => {
    const wantsBranch = input.includeBranch === true;

    const systemPrompt = [
      "You write concise git commit messages.",
      "IMPORTANT: Do NOT add any Co-Authored-By lines or attribution to AI/Claude in commit messages.",
      "Rules:",
      "- subject must be imperative, <= 72 chars, and no trailing period",
      "- body can be empty string or short bullet points",
      ...(wantsBranch
        ? ["- branch must be a short semantic git branch fragment for this change"]
        : []),
      "- capture the primary user-visible or developer-visible change",
    ].join("\n");

    const userPrompt = [
      `Branch: ${input.branch ?? "(detached)"}`,
      "",
      "Staged files:",
      limitSection(input.stagedSummary, 6_000),
      "",
      "Staged patch:",
      limitSection(input.stagedPatch, 40_000),
    ].join("\n");

    const outputSchema = wantsBranch
      ? Schema.Struct({
          subject: Schema.String,
          body: Schema.String,
          branch: Schema.String,
        })
      : Schema.Struct({
          subject: Schema.String,
          body: Schema.String,
        });

    return runClaudeJson({
      operation: "generateCommitMessage",
      model: SONNET_MODEL,
      systemPrompt,
      userPrompt,
      outputSchema,
      cwd: input.cwd,
    }).pipe(
      Effect.map(
        (generated) =>
          ({
            subject: sanitizeCommitSubject(generated.subject),
            body: generated.body.trim(),
            ...("branch" in generated && typeof generated.branch === "string"
              ? { branch: sanitizeFeatureBranchName(generated.branch) }
              : {}),
          }) satisfies CommitMessageGenerationResult,
      ),
    );
  };

  // ── PR content ───────────────────────────────────────────────────────

  const generatePrContent: TextGenerationShape["generatePrContent"] = (input) => {
    const systemPrompt = [
      "You write GitHub pull request content.",
      "Rules:",
      "- title should be concise and specific",
      "- body must be markdown and include headings '## Summary' and '## Testing'",
      "- under Summary, provide short bullet points",
      "- under Testing, include bullet points with concrete checks or 'Not run' where appropriate",
    ].join("\n");

    const userPrompt = [
      `Base branch: ${input.baseBranch}`,
      `Head branch: ${input.headBranch}`,
      "",
      "Commits:",
      limitSection(input.commitSummary, 12_000),
      "",
      "Diff stat:",
      limitSection(input.diffSummary, 12_000),
      "",
      "Diff patch:",
      limitSection(input.diffPatch, 40_000),
    ].join("\n");

    return runClaudeJson({
      operation: "generatePrContent",
      model: SONNET_MODEL,
      systemPrompt,
      userPrompt,
      outputSchema: Schema.Struct({
        title: Schema.String,
        body: Schema.String,
      }),
      cwd: input.cwd,
    }).pipe(
      Effect.map(
        (generated) =>
          ({
            title: sanitizePrTitle(generated.title),
            body: generated.body.trim(),
          }) satisfies PrContentGenerationResult,
      ),
    );
  };

  // ── Branch names ─────────────────────────────────────────────────────

  const generateBranchName: TextGenerationShape["generateBranchName"] = (input) => {
    const systemPrompt = [
      "You generate concise git branch names.",
      "Rules:",
      "- Branch should describe the requested work from the user message.",
      "- Keep it short and specific (2-6 words).",
      "- Use plain words only, no issue prefixes and no punctuation-heavy text.",
    ].join("\n");

    const promptSections = ["User message:", limitSection(input.message, 8_000)];
    const attachmentLines = (input.attachments ?? []).map(
      (attachment) =>
        `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
    );
    if (attachmentLines.length > 0) {
      promptSections.push(
        "",
        "Attachment metadata:",
        limitSection(attachmentLines.join("\n"), 4_000),
      );
    }

    return runClaudeJson({
      operation: "generateBranchName",
      model: SONNET_MODEL,
      systemPrompt,
      userPrompt: promptSections.join("\n"),
      outputSchema: Schema.Struct({ branch: Schema.String }),
      cwd: input.cwd,
    }).pipe(
      Effect.map(
        (generated) =>
          ({ branch: sanitizeBranchFragment(generated.branch) }) satisfies BranchNameGenerationResult,
      ),
    );
  };

  // ── Thread titles ────────────────────────────────────────────────────

  const TITLE_MAX_LENGTH = 60;

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = (input) => {
    const systemPrompt = [
      "Generate a concise title (max 60 chars) for a coding session based on the user's first message.",
      "Rules:",
      "- Summarize the intent, not the literal words.",
      "- Use title case.",
      "- Do not wrap in quotes.",
    ].join("\n");

    return runClaudeJson({
      operation: "generateThreadTitle",
      model: HAIKU_MODEL,
      systemPrompt,
      userPrompt: limitSection(input.promptText, 500),
      outputSchema: Schema.Struct({ title: Schema.String }),
    }).pipe(
      Effect.map((generated) => {
        let title = generated.title.trim();
        if (title.length > TITLE_MAX_LENGTH) {
          title = `${title.slice(0, TITLE_MAX_LENGTH - 1)}\u2026`;
        }
        return { title } satisfies ThreadTitleGenerationResult;
      }),
    );
  };

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

export const ClaudeCliTextGenerationLive = Layer.effect(
  TextGeneration,
  makeClaudeCliTextGeneration,
);
