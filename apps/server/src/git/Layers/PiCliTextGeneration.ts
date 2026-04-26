import { Effect, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@clui/shared/git";

import { TextGenerationError } from "../Errors.ts";
import {
  type BranchNameGenerationResult,
  type CommitMessageGenerationResult,
  type PrContentGenerationResult,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";

const TIMEOUT_MS = 180_000;

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

function normalizePiError(
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (Schema.is(TextGenerationError)(error)) return error;
  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes("Command not found: pi") ||
      lower.includes("spawn pi") ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: "pi CLI (`pi`) is required but not available on PATH.",
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

function stripMarkdownJsonFences(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
}

function parseJsonCandidate(value: string): unknown {
  const cleaned = stripMarkdownJsonFences(value);
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error("No JSON object found in pi output.");
  }
}

export const makePiCliTextGeneration = Effect.gen(function* () {
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
          normalizePiError(operation, cause, "Failed to collect process output"),
        ),
      );
      return text;
    });

  const runPiJson = <S extends Schema.Top>({
    operation,
    systemPrompt,
    userPrompt,
    outputSchema,
    cwd,
  }: {
    operation: string;
    systemPrompt: string;
    userPrompt: string;
    outputSchema: S;
    cwd: string;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const command = ChildProcess.make(
        "pi",
        [
          "--print",
          "--no-session",
          "--no-tools",
          "--no-context-files",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--system-prompt",
          `${systemPrompt}\n\nRespond with ONLY a valid JSON object matching the requested schema. No markdown, no code fences, no extra text.`,
          "Generate the requested JSON object from the provided input.",
        ],
        {
          cwd,
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
            normalizePiError(operation, cause, "Failed to spawn pi CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.map((value) => Number(value)),
            Effect.mapError((cause) =>
              normalizePiError(operation, cause, "Failed to read pi CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const detail = stderr.trim() || stdout.trim();
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0 ? `pi CLI failed: ${detail}` : `pi CLI failed with code ${exitCode}.`,
        });
      }

      const resultObj = yield* Effect.try({
        try: () => parseJsonCandidate(stdout),
        catch: (cause) =>
          new TextGenerationError({
            operation,
            detail: "pi CLI returned invalid JSON output.",
            cause,
          }),
      });

      return yield* Schema.decodeEffect(outputSchema)(resultObj).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "pi CLI returned invalid structured output.",
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
              new TextGenerationError({ operation, detail: "pi CLI request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = (input) => {
    const wantsBranch = input.includeBranch === true;

    const systemPrompt = [
      "You write concise git commit messages.",
      "IMPORTANT: Do NOT add any Co-Authored-By lines or attribution to AI/pi in commit messages.",
      wantsBranch
        ? "Return a JSON object with keys: subject, body, branch."
        : "Return a JSON object with keys: subject, body.",
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

    return runPiJson({
      operation: "generateCommitMessage",
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

  const generatePrContent: TextGenerationShape["generatePrContent"] = (input) => {
    const systemPrompt = [
      "You write GitHub pull request content.",
      "Return a JSON object with keys: title, body.",
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

    return runPiJson({
      operation: "generatePrContent",
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

  const generateBranchName: TextGenerationShape["generateBranchName"] = (input) => {
    const systemPrompt = [
      "You generate concise git branch names.",
      "Return a JSON object with key: branch.",
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

    return runPiJson({
      operation: "generateBranchName",
      systemPrompt,
      userPrompt: promptSections.join("\n"),
      outputSchema: Schema.Struct({ branch: Schema.String }),
      cwd: input.cwd,
    }).pipe(
      Effect.map(
        (generated) =>
          ({
            branch: sanitizeBranchFragment(generated.branch),
          }) satisfies BranchNameGenerationResult,
      ),
    );
  };

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "pi CLI text generation does not implement thread-title generation.",
      }),
    );

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

export const PiCliTextGenerationLive = Layer.effect(TextGeneration, makePiCliTextGeneration);
