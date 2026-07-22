import {
  DEFAULT_CLAUDE_CODE_BACKEND,
  type ClaudeCodeBackend,
  type CodingHarness,
  type CommandId,
  type NativeApi,
  type ProjectId,
  type ThreadId,
} from "@clui/contracts";
import { AGENT_ACTIVITY_LABELS } from "@clui/shared/agentActivity";

import type { Thread } from "../types";
import { DEFAULT_RUNTIME_MODE } from "../types";
import { claudeTerminalStatusPill } from "../lib/threadStatus";
import {
  hasSeenCompletion as hasSeenThreadCompletion,
  hasUnseenCompletion as hasUnseenThreadCompletion,
} from "../lib/threadUnread";
import { findLatestProposedPlan, isLatestTurnSettled } from "../session-logic";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";

export interface ThreadStatusPill {
  label: string;
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
  | "activityStatus"
>;

type HarnessSessionStatsThread = Pick<Thread, "harness" | "terminalStatus">;

export interface ActiveHarnessSessionStats {
  activeByHarness: Record<CodingHarness, number>;
  totalActive: number;
  maxActivePerHarness: number;
  busiestHarness: CodingHarness;
  busiestHarnessActive: number;
}

export function getActiveHarnessSessionStats(input: {
  threads: Iterable<HarnessSessionStatsThread>;
  maxActivePerHarness: number;
}): ActiveHarnessSessionStats {
  const activeByHarness: Record<CodingHarness, number> = {
    claudeCode: 0,
    pi: 0,
    codexCli: 0,
  };

  for (const thread of input.threads) {
    if (thread.terminalStatus !== "active") continue;
    activeByHarness[thread.harness] += 1;
  }

  let busiestHarness: CodingHarness = "claudeCode";
  let busiestHarnessActive = activeByHarness.claudeCode;
  for (const [harness, activeCount] of Object.entries(activeByHarness) as [
    CodingHarness,
    number,
  ][]) {
    if (activeCount > busiestHarnessActive) {
      busiestHarness = harness;
      busiestHarnessActive = activeCount;
    }
  }

  return {
    activeByHarness,
    totalActive: activeByHarness.claudeCode + activeByHarness.pi + activeByHarness.codexCli,
    maxActivePerHarness: input.maxActivePerHarness,
    busiestHarness,
    busiestHarnessActive,
  };
}

export async function createThreadAndNavigate(input: {
  api: {
    orchestration: Pick<NativeApi["orchestration"], "dispatchCommand">;
  };
  navigate: (input: { to: "/$threadId"; params: { threadId: ThreadId } }) => Promise<unknown>;
  addOptimisticThread: (input: {
    id: ThreadId;
    projectId: ProjectId;
    title: string;
    model: string;
    harness: CodingHarness;
    claudeCodeBackend: ClaudeCodeBackend;
    branch: string | null;
    worktreePath: string | null;
    createdAt: string;
  }) => void;
  commandId: CommandId;
  threadId: ThreadId;
  projectId: ProjectId;
  model: string;
  harness: CodingHarness;
  claudeCodeBackend?: ClaudeCodeBackend;
  createdAt: string;
  branch?: string | null;
  worktreePath?: string | null;
}): Promise<ThreadId> {
  const branch = input.branch ?? null;
  const worktreePath = input.worktreePath ?? null;
  const claudeCodeBackend = input.claudeCodeBackend ?? DEFAULT_CLAUDE_CODE_BACKEND;

  await input.api.orchestration.dispatchCommand({
    type: "thread.create",
    commandId: input.commandId,
    threadId: input.threadId,
    projectId: input.projectId,
    title: "New thread",
    model: input.model,
    harness: input.harness,
    claudeCodeBackend,
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
    model: input.model,
    harness: input.harness,
    claudeCodeBackend,
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

  const suppressReadCompletedHookStatus =
    thread.hookStatus === "completed" && hasSeenThreadCompletion(thread);

  // Real-time hook status is the most authoritative signal when set.
  // Check it before activity-based pending approvals so that stale
  // "approval.requested" activities (whose "approval.resolved" event
  // hasn't arrived yet) don't override a live "Working" badge.
  const terminalPill = claudeTerminalStatusPill(
    thread.terminalStatus,
    thread.hookStatus,
    thread.activityStatus,
  );
  if (terminalPill && !suppressReadCompletedHookStatus) return terminalPill;

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

  if (thread.session?.status === "running" && !suppressReadCompletedHookStatus) {
    return {
      label: thread.activityStatus ? AGENT_ACTIVITY_LABELS[thread.activityStatus] : "Working",
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
