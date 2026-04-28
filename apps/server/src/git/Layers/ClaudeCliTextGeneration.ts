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
import { sanitizeGeneratedThreadTitle } from "../threadTitleGeneration.ts";
import {
  type BranchNameGenerationResult,
  type CommitMessageGenerationResult,
  type PrContentGenerationResult,
  type ThreadTitleGenerationResult,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";

const SONNET_MODEL = "sonnet";
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

function extractClaudeCliJsonErrorDetail(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;

  const record = value as Record<string, unknown>;
  const result = typeof record.result === "string" ? record.result.trim() : "";
  if (result.length === 0) return null;

  const status = record.api_error_status;
  if (typeof status === "number" || typeof status === "string") {
    return `${result} (Claude API status ${status})`;
  }
  return result;
}

function extractClaudeCliFailureDetail(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const parsedDetail = extractClaudeCliJsonErrorDetail(parsed);
    if (parsedDetail) return parsedDetail;
  } catch {
    // Non-JSON stderr/stdout is already a useful CLI failure detail.
  }

  return trimmed;
}

function formatClaudeCliFailure(stderr: string, stdout: string, exitCode: number): string {
  const rawDetail = stderr.trim().length > 0 ? stderr : stdout;
  const detail = extractClaudeCliFailureDetail(rawDetail);
  return detail.length > 0
    ? `Claude CLI failed: ${detail}`
    : `Claude CLI failed with code ${exitCode}.`;
}

export const makeClaudeCliTextGeneration = Effect.gen(function* () {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const codexTextGeneration = yield* makeCodexTextGeneration;

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

  const withCodexFallback = <A, R1, R2>(
    operation: string,
    claudeEffect: Effect.Effect<A, TextGenerationError, R1>,
    codexEffect: Effect.Effect<A, TextGenerationError, R2>,
  ): Effect.Effect<A, TextGenerationError, R1 | R2> =>
    claudeEffect.pipe(
      Effect.catch((claudeError) =>
        codexEffect.pipe(
          Effect.catch((codexError) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: `Claude generation failed (${claudeError.detail}); Codex CLI fallback failed (${codexError.detail})`,
                cause: codexError,
              }),
            ),
          ),
        ),
      ),
    );

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
      // Pipe prompt via stdin (like Codex does) to avoid OS arg length limits
      // and use /tmp as cwd to prevent claude from loading project CLAUDE.md files
      const command = ChildProcess.make(
        "claude",
        [
          "-p",
          "--output-format", "json",
          "--model", model,
          "--tools", "",
          "--max-turns", "1",
          "--effort", "low",
          "--system-prompt", `${systemPrompt}\n\nRespond with ONLY a valid JSON object matching the requested schema. No markdown, no code fences, no extra text.`,
          "--no-session-persistence",
          "-",
        ],
        {
          cwd: cwd ?? "/tmp",
          shell: process.platform === "win32",
          stdin: {
            stream: Stream.make(new TextEncoder().encode(userPrompt)),
          },
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
        return yield* new TextGenerationError({
          operation,
          detail: formatClaudeCliFailure(stderr, stdout, exitCode),
        });
      }

      const parsed = yield* Effect.try({
        try: () => JSON.parse(stdout) as Record<string, unknown>,
        catch: () =>
          new TextGenerationError({
            operation,
            detail: "Claude CLI returned invalid JSON output.",
          }),
      });

      if (parsed.is_error === true) {
        return yield* new TextGenerationError({
          operation,
          detail: formatClaudeCliFailure("", stdout, exitCode),
        });
      }

      // Extract result string, strip markdown code fences, parse as JSON
      const resultValue = parsed.result;
      let resultObj: unknown;

      if (typeof resultValue === "string" && resultValue.trim().length > 0) {
        const cleaned = resultValue.trim()
          .replace(/^```(?:json)?\s*/, "")
          .replace(/\s*```$/, "")
          .trim();
        resultObj = yield* Effect.try({
          try: () => JSON.parse(cleaned),
          catch: () =>
            new TextGenerationError({
              operation,
              detail: "Claude CLI result is not valid JSON.",
            }),
        });
      } else if (typeof resultValue === "object" && resultValue !== null) {
        resultObj = resultValue;
      } else {
        return yield* new TextGenerationError({
          operation,
          detail: "Claude CLI returned no result.",
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

    return withCodexFallback(
      "generateCommitMessage",
      runClaudeJson({
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
      ),
      codexTextGeneration.generateCommitMessage(input),
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

    return withCodexFallback(
      "generatePrContent",
      runClaudeJson({
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
      ),
      codexTextGeneration.generatePrContent(input),
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

    return withCodexFallback(
      "generateBranchName",
      runClaudeJson({
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
      ),
      codexTextGeneration.generateBranchName(input),
    );
  };

  // ── Thread titles ────────────────────────────────────────────────────

  const TITLE_TIMEOUT_MS = 30_000;

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = (input) => {
    const generateWithClaude = Effect.gen(function* () {
      const command = ChildProcess.make(
        "claude",
        [
          "-p",
          "--output-format", "json",
          "--model", SONNET_MODEL,
          "--tools", "",
          "--max-turns", "1",
          "--effort", "low",
          "--system-prompt", "Generate a concise title (max 60 chars) for a coding session. Summarize the intent in title case. Respond with ONLY the title text, nothing else.",
          "--no-session-persistence",
          "-",
        ],
        {
          cwd: "/tmp",
          shell: process.platform === "win32",
          stdin: {
            stream: Stream.make(new TextEncoder().encode(limitSection(input.promptText, 500))),
          },
        },
      );

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(Effect.mapError((cause) =>
          normalizeError("generateThreadTitle", cause, "Failed to spawn Claude CLI"),
        ));

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString("generateThreadTitle", child.stdout),
          readStreamAsString("generateThreadTitle", child.stderr),
          child.exitCode.pipe(
            Effect.map((value) => Number(value)),
            Effect.mapError((cause) =>
              normalizeError("generateThreadTitle", cause, "Failed to read exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        return yield* new TextGenerationError({
          operation: "generateThreadTitle",
          detail: formatClaudeCliFailure(stderr, stdout, exitCode),
        });
      }

      const parsed = yield* Effect.try({
        try: () => JSON.parse(stdout) as Record<string, unknown>,
        catch: () =>
          new TextGenerationError({
            operation: "generateThreadTitle",
            detail: `Claude CLI returned invalid JSON. stdout length=${stdout.length}`,
          }),
      });
      if (parsed.is_error === true) {
        return yield* new TextGenerationError({
          operation: "generateThreadTitle",
          detail: formatClaudeCliFailure("", stdout, exitCode),
        });
      }

      const title = sanitizeGeneratedThreadTitle(
        typeof parsed.result === "string" ? parsed.result : null,
      );

      if (!title) {
        return yield* new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "Claude CLI did not generate a usable thread title.",
        });
      }

      return { title } satisfies ThreadTitleGenerationResult;
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(TITLE_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new TextGenerationError({ operation: "generateThreadTitle", detail: "Title generation timed out." })),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    return withCodexFallback(
      "generateThreadTitle",
      generateWithClaude,
      codexTextGeneration.generateThreadTitle(input),
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
