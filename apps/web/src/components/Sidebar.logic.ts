import type { Thread } from "../types";
import { claudeTerminalStatusPill } from "../lib/threadStatus";
import { findLatestProposedPlan, isLatestTurnSettled } from "../session-logic";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Needs Input"
    | "Plan Ready"
    | "Running"
    | "Paused"
    | "Error";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

type ThreadStatusInput = Pick<
  Thread,
  "interactionMode" | "latestTurn" | "lastVisitedAt" | "proposedPlans" | "session" | "terminalStatus" | "hookStatus"
>;

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

/**
 * Whether a thread is actively busy (running terminal or awaiting user action).
 * Busy threads are pinned to the top of the sidebar thread list.
 */
function isThreadBusy(
  thread: Pick<Thread, "terminalStatus" | "hookStatus">,
): boolean {
  if (thread.terminalStatus === "active") return true;
  const busyHookStates: ReadonlySet<string> = new Set([
    "working",
    "needsInput",
    "pendingApproval",
  ]);
  return thread.hookStatus !== null && busyHookStates.has(thread.hookStatus);
}

type ThreadSortInput = Pick<Thread, "id" | "updatedAt" | "terminalStatus" | "hookStatus">;

/**
 * Sort comparator for sidebar threads.
 *
 * Tier 0 — busy threads (active terminal or actionable hook status) pinned to top.
 * Tier 1 — everything else.
 * Within each tier: most-recently-updated first, then ID as tiebreaker.
 */
export function compareThreadsForSidebar(a: ThreadSortInput, b: ThreadSortInput): number {
  const aBusy = isThreadBusy(a);
  const bBusy = isThreadBusy(b);
  if (aBusy && !bBusy) return -1;
  if (!aBusy && bBusy) return 1;

  const byDate = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  if (byDate !== 0) return byDate;
  return b.id.localeCompare(a.id);
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
}): ThreadStatusPill | null {
  const { hasPendingApprovals, hasPendingUserInput, thread } = input;

  if (hasPendingApprovals) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (hasPendingUserInput) {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }

  if (thread.session?.status === "running") {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (thread.session?.status === "connecting") {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  const hasPlanReadyPrompt =
    !hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId ?? null) !== null;
  if (hasPlanReadyPrompt) {
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
    };
  }

  // Claude terminal status (hook-derived rich status or basic active/dormant).
  // Checked before hasUnseenCompletion so real-time hook status ("working",
  // "needsInput", etc.) takes priority over a stale completion marker from
  // a previous turn that hasn't been cleared yet.
  const terminalPill = claudeTerminalStatusPill(thread.terminalStatus, thread.hookStatus);
  if (terminalPill) return terminalPill;

  if (hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}
