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

export function hasUnseenCompletion(thread: Pick<Thread, "latestTurn" | "lastVisitedAt">): boolean {
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

// ── Thread sort ─────────────────────────────────────────────────────────

/**
 * Badge-driven tiered sort for sidebar threads.
 *
 * The sort tier mirrors the badge priority so what the user sees (badge)
 * matches where the thread sits in the list:
 *
 *   Tier 0 — NEEDS ACTION  (Pending Approval, Needs Input, Error)
 *   Tier 1 — UNSEEN RESULT (Completed turn the user hasn't visited)
 *   Tier 2 — ACTIVE WORK   (Working / Running)
 *   Tier 3 — IDLE          (everything else)
 *
 * Within each tier threads sort by `updatedAt` desc, with ID as tiebreaker.
 *
 * Key property: merely *viewing* a thread never changes its tier — only
 * real activity (new turn, message, hook status) can promote a thread.
 * Clicking an idle thread resumes its terminal (terminalStatus → active)
 * but hookStatus stays null at the prompt, so it remains Tier 3.
 */

export interface ThreadSortContext {
  pendingApprovalByThreadId: ReadonlyMap<string, boolean>;
  pendingUserInputByThreadId: ReadonlyMap<string, boolean>;
}

type ThreadSortInput = Pick<
  Thread,
  "id" | "updatedAt" | "hookStatus" | "terminalStatus" | "session" | "latestTurn" | "lastVisitedAt"
>;

function threadSortTier(
  thread: ThreadSortInput,
  hasPendingApprovals: boolean,
  hasPendingUserInput: boolean,
): number {
  // Tier 0: Needs user action — most urgent
  // Activity-based flags only count for non-active terminals; for active
  // terminals hookStatus (below) is the authoritative real-time source.
  if (thread.terminalStatus !== "active") {
    if (hasPendingApprovals) return 0;
    if (hasPendingUserInput) return 0;
  }
  if (thread.hookStatus === "pendingApproval" || thread.hookStatus === "needsInput") return 0;
  if (thread.hookStatus === "error") return 0;

  // Tier 1: Unseen completion — check your results
  if (hasUnseenCompletion(thread)) return 1;

  // Tier 2: Active work — Claude is busy, wait
  if (thread.hookStatus === "working") return 2;
  if (thread.session?.status === "running") return 2;

  // Tier 3: Idle — nothing happening
  return 3;
}

export function createThreadSortComparator(ctx: ThreadSortContext) {
  return (a: ThreadSortInput, b: ThreadSortInput): number => {
    const tierA = threadSortTier(
      a,
      ctx.pendingApprovalByThreadId.get(a.id) === true,
      ctx.pendingUserInputByThreadId.get(a.id) === true,
    );
    const tierB = threadSortTier(
      b,
      ctx.pendingApprovalByThreadId.get(b.id) === true,
      ctx.pendingUserInputByThreadId.get(b.id) === true,
    );
    if (tierA !== tierB) return tierA - tierB;

    const byDate = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    if (byDate !== 0) return byDate;
    return b.id.localeCompare(a.id);
  };
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
}): ThreadStatusPill | null {
  const { hasPendingApprovals, hasPendingUserInput, thread } = input;

  if (thread.session?.status === "connecting") {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  // Real-time hook status is the most authoritative signal when set.
  // Check it before activity-based pending approvals so that stale
  // "approval.requested" activities (whose "approval.resolved" event
  // hasn't arrived yet) don't override a live "Working" badge.
  const terminalPill = claudeTerminalStatusPill(thread.terminalStatus, thread.hookStatus);
  if (terminalPill) return terminalPill;

  // Activity-based badges are only shown when the terminal is NOT active.
  // For active terminals, hookStatus (checked above) is the authoritative
  // real-time source.  When hookStatus is null the terminal is idle at the
  // prompt — any unresolved "approval.requested" activities are stale
  // leftovers (e.g. from rejected tools whose approval.resolved was never
  // emitted) and must not re-trigger the badge.
  if (thread.terminalStatus !== "active") {
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
        label: "Needs Input",
        colorClass: "text-amber-600 dark:text-amber-300/90",
        dotClass: "bg-amber-500 dark:bg-amber-300/90",
        pulse: false,
      };
    }
  }

  if (thread.session?.status === "running") {
    return {
      label: "Working",
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
