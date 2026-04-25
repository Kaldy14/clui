import type { Thread } from "../types";

type ThreadCompletionFields = Pick<Thread, "latestTurn" | "lastCompletedAt">;
type ThreadVisitFields = ThreadCompletionFields & Pick<Thread, "lastVisitedAt">;

export interface ThreadCompletionMarker {
  completedAt: string;
  completedAtMs: number;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function getThreadCompletionMarker(
  thread: ThreadCompletionFields,
): ThreadCompletionMarker | null {
  const completionCandidates = [thread.latestTurn?.completedAt, thread.lastCompletedAt];
  for (const completedAt of completionCandidates) {
    const completedAtMs = parseTimestamp(completedAt);
    if (completedAt && completedAtMs !== null) {
      return { completedAt, completedAtMs };
    }
  }
  return null;
}

export function getUnreadVisitedAtForThread(thread: ThreadCompletionFields): string | null {
  const completion = getThreadCompletionMarker(thread);
  return completion ? new Date(completion.completedAtMs - 1).toISOString() : null;
}

export function hasUnseenCompletion(thread: ThreadVisitFields): boolean {
  const completion = getThreadCompletionMarker(thread);
  if (!completion) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAtMs = parseTimestamp(thread.lastVisitedAt);
  if (lastVisitedAtMs === null) return true;
  return completion.completedAtMs > lastVisitedAtMs;
}
