import { TurnId } from "@clui/contracts";

export interface DiffRouteSearch {
  diff?: "1";
  diffTurnId?: TurnId;
  diffFilePath?: string;
  diffAiReview?: "1";
  diffAiReviewRun?: string;
}

function isDiffOpenValue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function stripAiReviewSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "diffAiReview" | "diffAiReviewRun"> {
  const { diffAiReview: _diffAiReview, diffAiReviewRun: _diffAiReviewRun, ...rest } = params;
  return rest as Omit<T, "diffAiReview" | "diffAiReviewRun">;
}

export function stripDiffSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "diff" | "diffTurnId" | "diffFilePath" | "diffAiReview" | "diffAiReviewRun"> {
  const {
    diff: _diff,
    diffTurnId: _diffTurnId,
    diffFilePath: _diffFilePath,
    diffAiReview: _diffAiReview,
    diffAiReviewRun: _diffAiReviewRun,
    ...rest
  } = params;
  return rest as Omit<T, "diff" | "diffTurnId" | "diffFilePath" | "diffAiReview" | "diffAiReviewRun">;
}

export function parseDiffRouteSearch(search: Record<string, unknown>): DiffRouteSearch {
  const diff = isDiffOpenValue(search.diff) ? "1" : undefined;
  const diffTurnIdRaw = diff ? normalizeSearchString(search.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.makeUnsafe(diffTurnIdRaw) : undefined;
  const diffFilePath = diff && diffTurnId ? normalizeSearchString(search.diffFilePath) : undefined;
  const diffAiReview = diff && isDiffOpenValue(search.diffAiReview) ? "1" : undefined;
  const diffAiReviewRun = diffAiReview ? normalizeSearchString(search.diffAiReviewRun) : undefined;

  return {
    ...(diff ? { diff } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
    ...(diffAiReview ? { diffAiReview } : {}),
    ...(diffAiReviewRun ? { diffAiReviewRun } : {}),
  };
}
