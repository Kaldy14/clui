import type {
  CodingHarness,
  CommandId,
  NativeApi,
  ProjectId,
  ThreadId,
} from "@clui/contracts";

import type { Thread } from "../types";
import { DEFAULT_RUNTIME_MODE } from "../types";
import { claudeTerminalStatusPill } from "../lib/threadStatus";
import { hasUnseenCompletion as hasUnseenThreadCompletion } from "../lib/threadUnread";
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
  | "interactionMode"
  | "latestTurn"
  | "lastVisitedAt"
  | "lastCompletedAt"
  | "proposedPlans"
  | "session"
  | "terminalStatus"
  | "hookStatus"
>;

export async function createThreadAndNavigate(input: {
  api: {
    orchestration: Pick<NativeApi["orchestration"], "dispatchCommand">;
  };
  navigate: (input: { to: "/$threadId"; params: { threadId: ThreadId } }) => Promise<unknown>;
  addOptimisticThread: (input: {
    id: ThreadId;
    projectId: ProjectId;
    title: string;
    harness: CodingHarness;
    branch: string | null;
    worktreePath: string | null;
    createdAt: string;
  }) => void;
  commandId: CommandId;
  threadId: ThreadId;
  projectId: ProjectId;
  model: string;
  harness: CodingHarness;
  createdAt: string;
  branch?: string | null;
  worktreePath?: string | null;
}): Promise<ThreadId> {
  const branch = input.branch ?? null;
  const worktreePath = input.worktreePath ?? null;

  await input.api.orchestration.dispatchCommand({
    type: "thread.create",
    commandId: input.commandId,
    threadId: input.threadId,
    projectId: input.projectId,
    title: "New thread",
    model: input.model,
    harness: input.harness,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: "default",
    branch,
    worktreePath,
    createdAt: input.createdAt,
  });

  // Only expose the thread locally after the server has accepted it.
  // This avoids client-only placeholder threads that can be wiped or
  // race with project-level snapshot syncs during project creation.
  input.addOptimisticThread({
    id: input.threadId,
    projectId: input.projectId,
    title: "New thread",
    harness: input.harness,
    branch,
    worktreePath,
    createdAt: input.createdAt,
  });

  await input.navigate({
    to: "/$threadId",
    params: { threadId: input.threadId },
  });

  return input.threadId;
}

export function hasUnseenCompletion(
  thread: Pick<Thread, "latestTurn" | "lastVisitedAt" | "lastCompletedAt">,
): boolean {
  return hasUnseenThreadCompletion(thread);
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
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
