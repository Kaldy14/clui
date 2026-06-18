import type { ThreadId } from "@clui/contracts";

export const THREAD_SELECTED_EVENT = "clui:thread-selected";

export interface ThreadSelectedEventDetail {
  threadId: ThreadId;
}

export function dispatchThreadSelectedEvent(threadId: ThreadId): void {
  window.dispatchEvent(
    new CustomEvent<ThreadSelectedEventDetail>(THREAD_SELECTED_EVENT, { detail: { threadId } }),
  );
}

export function isThreadSelectedEventFor(event: Event, threadId: ThreadId): boolean {
  const detail = (event as CustomEvent<ThreadSelectedEventDetail>).detail;
  return detail?.threadId === threadId;
}
