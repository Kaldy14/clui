import { type ClaudeHookStatus, type ThreadId } from "@clui/contracts";

const PENDING_COMPLETION_VISIT_KEY = "__pending-completion__";

export interface ViewedThreadCompletionVisit {
  key: string;
  visitedAt?: string;
}

export function getViewedThreadCompletionVisit(input: {
  threadId: ThreadId;
  hookStatus: ClaudeHookStatus | null;
  completedAt: string | null;
  lastHandledKey: string | null;
}): ViewedThreadCompletionVisit | null {
  if (input.hookStatus !== "completed" && input.completedAt === null) {
    return null;
  }

  const key = `${input.threadId}:${input.completedAt ?? PENDING_COMPLETION_VISIT_KEY}`;
  if (key === input.lastHandledKey) {
    return null;
  }

  return input.completedAt === null
    ? { key }
    : {
        key,
        visitedAt: input.completedAt,
      };
}
