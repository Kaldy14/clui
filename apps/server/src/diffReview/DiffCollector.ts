import { parsePatchFiles } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs";
import { Effect } from "effect";

import { normalizeGitPathArgument, runGitProcess } from "../gitProcess.ts";
import { DiffReviewError } from "./Services/DiffReview.ts";

const DEFAULT_BRANCH_NAMES = new Set(["main", "master"]);
const MAX_FILE_PATCH_CHARS = 30_000;
const LOW_SIGNAL_SUMMARY_MAX_CHARS = 45_000;

export interface GitExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface GitCommandRunner {
  readonly runGitStdout: (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: { readonly allowNonZero?: boolean },
  ) => Effect.Effect<string, DiffReviewError>;
}

export interface CollectedDiffContext {
  readonly cwd: string;
  readonly diffPatch: string;
  readonly diffStat: string;
  readonly sourceLabel: string;
  readonly baseBranch: string | null;
  readonly headBranch: string | null;
  readonly defaultBranchSafety: boolean;
}

export interface DiffReviewPromptContext {
  readonly promptDiff: string;
  readonly totalFileCount: number;
  readonly coveredFileCount: number;
  readonly summarizedFileCount: number;
}

export interface DiffReviewFilePriority {
  readonly filePath: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changeType: string;
  readonly riskScore: number;
  readonly hunkHeaders: ReadonlyArray<string>;
}

interface ParsedDiffReviewFiles {
  readonly files: ReadonlyArray<FileDiffMetadata>;
  readonly sections: ReadonlyArray<string>;
  readonly summaries: ReadonlyArray<DiffReviewFilePriority>;
}

interface DiffReviewChunk {
  readonly id: string;
  readonly filePath: string;
  readonly hunkHeader: string | null;
  readonly patchText: string;
  readonly additions: number;
  readonly deletions: number;
  readonly riskScore: number;
}

function diffReviewError(operation: string, detail: string, cause?: unknown): DiffReviewError {
  return new DiffReviewError({ operation, detail, ...(cause === undefined ? {} : { cause }) });
}

function normalizeGitCommandError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export const nodeGitCommandRunner: GitCommandRunner = {
  runGitStdout: (operation, cwd, args, options = {}) =>
    Effect.tryPromise({
      try: async (signal) => {
        const result = await runGitProcess({
          cwd,
          args,
          maxBufferBytes: 30 * 1024 * 1024,
          signal,
        });
        if (result.code !== 0 && options.allowNonZero !== true) {
          const detail = result.stderr.trim() || `git exited with code ${result.code}`;
          throw new Error(detail);
        }
        return result.stdout.trim();
      },
      catch: (cause) =>
        diffReviewError(
          operation,
          `git ${args.join(" ")} failed: ${normalizeGitCommandError(cause)}`,
          cause,
        ),
    }),
};

function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

function trimToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function branchNameFromRemoteRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return null;
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex < 0) return trimmed;
  const branch = trimmed.slice(slashIndex + 1).trim();
  return branch.length > 0 ? branch : null;
}

function remoteRefForBranch(branch: string | null): string | null {
  if (!branch) return null;
  if (branch.includes("/")) return branch;
  return `origin/${branch}`;
}

function uniqueStrings(values: ReadonlyArray<string | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function summarizeUnifiedDiff(diff: string): string {
  const normalized = diff.trim();
  if (normalized.length === 0) return "No changes";

  try {
    const parsedPatches = parsePatchFiles(normalized);
    const files = parsedPatches.flatMap((patch) => patch.files);
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      for (const hunk of file.hunks) {
        additions += hunk.additionLines;
        deletions += hunk.deletionLines;
      }
    }
    const fileLabel = files.length === 1 ? "file" : "files";
    return `${files.length} ${fileLabel} changed, ${additions} insertions(+), ${deletions} deletions(-)`;
  } catch {
    const diffHeaders = normalized.match(/^diff --git /gm)?.length ?? 0;
    return diffHeaders > 0 ? `${diffHeaders} files changed` : "Patch available";
  }
}

function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "unknown";
  if (raw.startsWith("a/") || raw.startsWith("b/")) return raw.slice(2);
  return raw;
}

function splitPatchIntoFileSections(diff: string): string[] {
  const headers = Array.from(diff.matchAll(/^diff --git .*$/gm));
  if (headers.length === 0) return diff.trim().length > 0 ? [diff] : [];

  const sections: string[] = [];
  for (let index = 0; index < headers.length; index += 1) {
    const start = headers[index]?.index ?? 0;
    const end = headers[index + 1]?.index ?? diff.length;
    const section = diff.slice(start, end).trimEnd();
    if (section.trim().length > 0) sections.push(section);
  }
  return sections;
}

function getFileStats(fileDiff: FileDiffMetadata): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of fileDiff.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { additions, deletions };
}

function scorePathRisk(filePath: string): number {
  const lower = filePath.toLowerCase();
  let score = 0;
  if (
    /(^|\/)(package\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|package-lock\.json)$/u.test(lower)
  ) {
    score += 35;
  }
  if (/(^|\/)(migrations?|schema|db|database|sql)(\/|\.|$)/u.test(lower)) score += 35;
  if (/(^|\/)(auth|security|permission|permissions|session|token|oauth)(\/|\.|$)/u.test(lower)) {
    score += 35;
  }
  if (/(^|\/)(contracts?|api|routes?|server)(\/|\.|$)/u.test(lower)) score += 22;
  if (/(^|\/)(\.github\/workflows|dockerfile|compose|config|settings)(\/|\.|$)/u.test(lower)) {
    score += 18;
  }
  if (/\.(sql|ya?ml|json|toml|env|lock)$/u.test(lower)) score += 8;
  if (/\.(test|spec)\.[jt]sx?$/u.test(lower)) score -= 8;
  if (/\.(md|mdx|txt)$/u.test(lower)) score -= 12;
  return score;
}

function scorePatchRisk(patchText: string): number {
  const lower = patchText.toLowerCase();
  let score = 0;
  for (const keyword of [
    "password",
    "secret",
    "token",
    "auth",
    "permission",
    "migration",
    "schema",
    "transaction",
    "concurrency",
    "race",
    "delete",
    "drop table",
    "rollback",
  ]) {
    if (lower.includes(keyword)) score += 10;
  }
  return score;
}

function scoreChangeType(type: FileDiffMetadata["type"]): number {
  switch (type) {
    case "new":
    case "deleted":
      return 16;
    case "rename-changed":
      return 12;
    case "rename-pure":
      return 4;
    default:
      return 0;
  }
}

function summarizeFile(fileDiff: FileDiffMetadata, section: string): DiffReviewFilePriority {
  const stats = getFileStats(fileDiff);
  const filePath = resolveFileDiffPath(fileDiff);
  const hunkHeaders = fileDiff.hunks
    .map((hunk) => hunk.hunkSpecs?.trim() ?? null)
    .filter((value): value is string => value !== null && value.length > 0);
  const churnScore = Math.min(30, Math.ceil((stats.additions + stats.deletions) / 20));
  const riskScore =
    scorePathRisk(filePath) +
    scorePatchRisk(section) +
    scoreChangeType(fileDiff.type) +
    churnScore +
    Math.min(20, stats.deletions);

  return {
    filePath,
    additions: stats.additions,
    deletions: stats.deletions,
    changeType: fileDiff.type,
    riskScore,
    hunkHeaders,
  };
}

function splitSectionIntoHunkPatches(
  section: string,
): Array<{ hunkHeader: string | null; patchText: string }> {
  const hunkMatches = Array.from(section.matchAll(/^@@ .*$/gm));
  if (hunkMatches.length === 0) return [{ hunkHeader: null, patchText: section }];

  const fileHeader = section.slice(0, hunkMatches[0]?.index ?? 0).trimEnd();
  return hunkMatches.map((match, index) => {
    const start = match.index ?? 0;
    const end = hunkMatches[index + 1]?.index ?? section.length;
    const hunkText = section.slice(start, end).trimEnd();
    return {
      hunkHeader: match[0],
      patchText: `${fileHeader}\n${hunkText}`.trimEnd(),
    };
  });
}

function hunkStatsFromPatch(patchText: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patchText.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function buildChunks(
  fileDiff: FileDiffMetadata,
  section: string,
  summary: DiffReviewFilePriority,
): DiffReviewChunk[] {
  const hunkPatches = splitSectionIntoHunkPatches(section);
  return hunkPatches.map((hunkPatch, index) => {
    const stats = hunkStatsFromPatch(hunkPatch.patchText);
    return {
      id: `${summary.filePath}:${index}`,
      filePath: summary.filePath,
      hunkHeader: hunkPatch.hunkHeader,
      patchText: hunkPatch.patchText,
      additions: stats.additions,
      deletions: stats.deletions,
      riskScore:
        summary.riskScore +
        scorePatchRisk(hunkPatch.patchText) +
        Math.min(20, stats.additions + stats.deletions) +
        (fileDiff.hunks.length > 1 ? 3 : 0),
    };
  });
}

function fallbackPromptContext(diffPatch: string, maxChars: number): DiffReviewPromptContext {
  const totalFileCount = Math.max(1, diffPatch.match(/^diff --git /gm)?.length ?? 0);
  return {
    promptDiff: limitSection(diffPatch, maxChars),
    totalFileCount,
    coveredFileCount: totalFileCount,
    summarizedFileCount: 0,
  };
}

function renderSummary(summary: DiffReviewFilePriority): string {
  const hunkList = summary.hunkHeaders.length > 0 ? summary.hunkHeaders.join("; ") : "(none)";
  return `- ${summary.filePath} [${summary.changeType}] +${summary.additions}/-${summary.deletions}, risk ${summary.riskScore}, hunks: ${hunkList}`;
}

function sortByRiskThenPath<T extends { readonly riskScore: number; readonly filePath: string }>(
  items: T[],
): T[] {
  return items.toSorted((left, right) => {
    if (left.riskScore !== right.riskScore) return right.riskScore - left.riskScore;
    return left.filePath.localeCompare(right.filePath, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function parseDiffReviewFiles(normalizedDiff: string): ParsedDiffReviewFiles | null {
  try {
    const parsedPatches = parsePatchFiles(normalizedDiff);
    const files = parsedPatches.flatMap((patch) => patch.files);
    if (files.length === 0) return null;

    const sections = splitPatchIntoFileSections(normalizedDiff);
    const summaries = files.map((fileDiff, index) =>
      summarizeFile(
        fileDiff,
        sections[index] ??
          sections.find((section) => section.includes(resolveFileDiffPath(fileDiff))) ??
          "",
      ),
    );
    return { files, sections, summaries };
  } catch {
    return null;
  }
}

function fallbackFilePathFromSection(section: string, index: number): string {
  const gitHeader = /^diff --git\s+a\/(.*?)\s+b\/(.*?)$/mu.exec(section);
  const fileHeader = /^\+\+\+\s+(?:b\/)?(.+)$/mu.exec(section);
  const raw = gitHeader?.[2] ?? gitHeader?.[1] ?? fileHeader?.[1] ?? `change-${index + 1}`;
  return normalizeReviewPath(raw);
}

function normalizeReviewPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (trimmed === "/dev/null") return "deleted-file";
  return trimmed.startsWith("a/") || trimmed.startsWith("b/") ? trimmed.slice(2) : trimmed;
}

function fallbackPriorityFromSection(section: string, index: number): DiffReviewFilePriority {
  const filePath = fallbackFilePathFromSection(section, index);
  const stats = hunkStatsFromPatch(section);
  const hunkHeaders = Array.from(section.matchAll(/^@@ .*$/gmu)).map((match) => match[0]);
  const churnScore = Math.min(30, Math.ceil((stats.additions + stats.deletions) / 20));
  return {
    filePath,
    additions: stats.additions,
    deletions: stats.deletions,
    changeType: "modified",
    riskScore:
      scorePathRisk(filePath) +
      scorePatchRisk(section) +
      churnScore +
      Math.min(20, stats.deletions),
    hunkHeaders,
  };
}

export function rankDiffReviewFiles(diffPatch: string, limit = 12): DiffReviewFilePriority[] {
  const normalized = diffPatch.trim();
  if (normalized.length === 0) return [];

  const parsed = parseDiffReviewFiles(normalized);
  if (parsed) return sortByRiskThenPath([...parsed.summaries]).slice(0, limit);

  return sortByRiskThenPath(
    splitPatchIntoFileSections(normalized).map(fallbackPriorityFromSection),
  ).slice(0, limit);
}

export function buildDiffReviewPromptContext(
  diffPatch: string,
  maxChars: number,
): DiffReviewPromptContext {
  const normalized = diffPatch.trim();
  if (normalized.length === 0) {
    return {
      promptDiff: "No changes",
      totalFileCount: 0,
      coveredFileCount: 0,
      summarizedFileCount: 0,
    };
  }

  const parsed = parseDiffReviewFiles(normalized);
  if (!parsed) return fallbackPromptContext(normalized, maxChars);

  try {
    const { files, sections, summaries } = parsed;
    const chunks = files.flatMap((fileDiff, index) => {
      const section =
        sections[index] ??
        sections.find((candidate) => candidate.includes(resolveFileDiffPath(fileDiff))) ??
        "";
      return buildChunks(fileDiff, section, summaries[index]!);
    });

    const sortedSummaries = sortByRiskThenPath([...summaries]);
    const sortedChunks = sortByRiskThenPath(chunks);
    const summaryBlock = [
      "Changed files, pre-ranked by review risk:",
      ...sortedSummaries.map(renderSummary),
    ].join("\n");

    const reservedSummary = Math.min(LOW_SIGNAL_SUMMARY_MAX_CHARS, summaryBlock.length + 1_500);
    const chunkBudget = Math.max(1_000, maxChars - reservedSummary);
    const includedChunks: DiffReviewChunk[] = [];
    let usedChars = 0;

    for (const chunk of sortedChunks) {
      const chunkText = limitSection(chunk.patchText, MAX_FILE_PATCH_CHARS);
      const rendered = [
        `### ${chunk.filePath}${chunk.hunkHeader ? ` ${chunk.hunkHeader}` : ""}`,
        `Risk score: ${chunk.riskScore}; hunk stats: +${chunk.additions}/-${chunk.deletions}`,
        "```diff",
        chunkText,
        "```",
      ].join("\n");
      if (includedChunks.length > 0 && usedChars + rendered.length > chunkBudget) continue;
      includedChunks.push({ ...chunk, patchText: rendered });
      usedChars += rendered.length;
      if (usedChars >= chunkBudget) break;
    }

    const coveredFiles = new Set(includedChunks.map((chunk) => chunk.filePath));
    const includedBlock =
      includedChunks.length > 0
        ? [
            "Selected high-signal file/hunk patches:",
            ...includedChunks.map((chunk) => chunk.patchText),
          ].join("\n\n")
        : "Selected high-signal file/hunk patches:\n(none; use summaries only)";

    const summarizedOnly = sortedSummaries.filter((summary) => !coveredFiles.has(summary.filePath));
    const summarizedBlock =
      summarizedOnly.length > 0
        ? [
            "Summarized low-signal files without full patch context:",
            ...summarizedOnly.map(renderSummary),
          ].join("\n")
        : "Summarized low-signal files without full patch context:\n(none)";

    const promptDiff = [
      `Full patch context coverage: ${coveredFiles.size}/${files.length} files.`,
      "The remaining files are still listed in summaries. Rank changes using both the full patches and summaries.",
      "",
      summaryBlock,
      "",
      includedBlock,
      "",
      summarizedBlock,
    ].join("\n");

    return {
      promptDiff: limitSection(promptDiff, maxChars),
      totalFileCount: files.length,
      coveredFileCount: coveredFiles.size,
      summarizedFileCount: summarizedOnly.length,
    };
  } catch {
    return fallbackPromptContext(normalized, maxChars);
  }
}

function untrackedFilesToPatch(
  cwd: string,
  runner: GitCommandRunner,
): Effect.Effect<string, DiffReviewError> {
  return Effect.gen(function* () {
    const raw = yield* runner.runGitStdout(
      "DiffCollector.untrackedFiles",
      cwd,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { allowNonZero: true },
    );
    const files = raw
      .split("\0")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (files.length === 0) return "";

    const patches = yield* Effect.forEach(
      files,
      (filePath) =>
        runner.runGitStdout(
          "DiffCollector.untrackedPatch",
          cwd,
          [
            "diff",
            "--no-index",
            "--patch",
            "--minimal",
            "--no-color",
            "--",
            "/dev/null",
            normalizeGitPathArgument(filePath),
          ],
          { allowNonZero: true },
        ),
      { concurrency: 4 },
    );
    return patches.filter((patch) => patch.trim().length > 0).join("\n");
  });
}

export function collectLocalDiff(
  cwd: string,
  runner: GitCommandRunner = nodeGitCommandRunner,
): Effect.Effect<{ readonly patch: string; readonly stat: string }, DiffReviewError> {
  return Effect.gen(function* () {
    const trackedPatch = yield* runner.runGitStdout(
      "DiffCollector.localPatch",
      cwd,
      ["diff", "HEAD", "--patch", "--minimal", "--no-color"],
      { allowNonZero: true },
    );
    const trackedStat = yield* runner.runGitStdout(
      "DiffCollector.localStat",
      cwd,
      ["diff", "HEAD", "--stat", "--no-color"],
      { allowNonZero: true },
    );
    const untrackedPatch = yield* untrackedFilesToPatch(cwd, runner);
    const patch = [trackedPatch, untrackedPatch]
      .filter((section) => section.trim().length > 0)
      .join("\n");
    return {
      patch,
      stat: trackedStat || summarizeUnifiedDiff(patch),
    };
  });
}

function gitRefExists(
  cwd: string,
  ref: string,
  runner: GitCommandRunner,
): Effect.Effect<boolean, DiffReviewError> {
  return runner
    .runGitStdout("DiffCollector.gitRefExists", cwd, ["rev-parse", "--verify", `${ref}^{commit}`], {
      allowNonZero: true,
    })
    .pipe(Effect.map((stdout) => stdout.length > 0));
}

function firstExistingRef(
  cwd: string,
  refs: ReadonlyArray<string>,
  runner: GitCommandRunner,
): Effect.Effect<string | null, DiffReviewError> {
  return Effect.gen(function* () {
    for (const ref of refs) {
      const exists = yield* gitRefExists(cwd, ref, runner);
      if (exists) return ref;
    }
    return null;
  });
}

export function collectBranchDiff(
  cwd: string,
  runner: GitCommandRunner = nodeGitCommandRunner,
): Effect.Effect<CollectedDiffContext, DiffReviewError> {
  return Effect.gen(function* () {
    const currentBranch = yield* runner
      .runGitStdout(
        "DiffCollector.currentBranch",
        cwd,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        { allowNonZero: true },
      )
      .pipe(Effect.map(trimToNull));

    let configuredBase: string | null = null;
    if (currentBranch) {
      configuredBase = yield* runner
        .runGitStdout(
          "DiffCollector.configuredBase",
          cwd,
          ["config", "--get", `branch.${currentBranch}.gh-merge-base`],
          { allowNonZero: true },
        )
        .pipe(Effect.map(trimToNull));
    }

    const upstreamRef = yield* runner
      .runGitStdout(
        "DiffCollector.upstreamRef",
        cwd,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        { allowNonZero: true },
      )
      .pipe(Effect.map(trimToNull));
    const upstreamBranch = branchNameFromRemoteRef(upstreamRef ?? "");

    const remoteDefaultRef = yield* runner
      .runGitStdout(
        "DiffCollector.remoteDefault",
        cwd,
        ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
        { allowNonZero: true },
      )
      .pipe(Effect.map(trimToNull));
    const remoteDefaultBranch = branchNameFromRemoteRef(remoteDefaultRef ?? "");

    const baseBranch =
      configuredBase ??
      (upstreamBranch && upstreamBranch !== currentBranch ? upstreamBranch : null) ??
      remoteDefaultBranch ??
      "main";
    const safetyBecauseDefaultBranch =
      currentBranch === null ||
      currentBranch === baseBranch ||
      DEFAULT_BRANCH_NAMES.has(currentBranch);

    let baseRef: string | null = null;
    if (!safetyBecauseDefaultBranch) {
      baseRef = yield* firstExistingRef(
        cwd,
        uniqueStrings([
          configuredBase,
          baseBranch,
          remoteRefForBranch(baseBranch),
          remoteDefaultRef,
        ]),
        runner,
      );
    }
    const defaultBranchSafety = safetyBecauseDefaultBranch || baseRef === null;
    const localDiff = yield* collectLocalDiff(cwd, runner);

    if (defaultBranchSafety || !baseRef) {
      const sourceLabel = currentBranch
        ? `Local changes on ${currentBranch}`
        : "Local changes on detached HEAD";
      return {
        cwd,
        diffPatch: localDiff.patch,
        diffStat: localDiff.stat,
        sourceLabel,
        baseBranch,
        headBranch: currentBranch,
        defaultBranchSafety: true,
      };
    }

    const branchPatch = yield* runner.runGitStdout("DiffCollector.branchPatch", cwd, [
      "diff",
      `${baseRef}...HEAD`,
      "--patch",
      "--minimal",
      "--no-color",
    ]);
    const branchStat = yield* runner.runGitStdout("DiffCollector.branchStat", cwd, [
      "diff",
      `${baseRef}...HEAD`,
      "--stat",
      "--no-color",
    ]);
    const combinedPatch = [branchPatch, localDiff.patch]
      .filter((section) => section.trim().length > 0)
      .join("\n");
    const combinedStat = [branchStat, localDiff.stat]
      .filter((section) => section.trim().length > 0)
      .join("\n");

    return {
      cwd,
      diffPatch: combinedPatch,
      diffStat: combinedStat || summarizeUnifiedDiff(combinedPatch),
      sourceLabel: `Branch ${currentBranch ?? "HEAD"} vs ${baseBranch} plus local changes`,
      baseBranch,
      headBranch: currentBranch,
      defaultBranchSafety: false,
    };
  });
}
