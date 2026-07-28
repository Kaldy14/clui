import {
  DEFAULT_CLAUDE_CODE_BACKEND,
  type ClaudeCodeBackend,
  type CodingHarness,
  type CommandId,
  type NativeApi,
  type ProjectId,
  type ThreadId,
} from "@clui/contracts";

import type { Thread } from "../types";
import { DEFAULT_RUNTIME_MODE } from "../types";
import {
  claudeTerminalStatusPill,
  hookStatusPill,
  type ThreadStatusPill,
  workingStatusPill,
} from "../lib/threadStatus";
import {
  hasSeenCompletion as hasSeenThreadCompletion,
  hasUnseenCompletion as hasUnseenThreadCompletion,
} from "../lib/threadUnread";
import { findLatestProposedPlan, isLatestTurnSettled } from "../session-logic";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";

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

export type SidebarV2Status = "approval" | "input" | "working" | "failed" | "ready";

export interface SidebarV2TopStatus {
  readonly label: string;
  readonly icon: "working" | null;
  readonly className: string;
}

type SidebarV2StatusInput = Pick<
  Thread,
  "activityStatus" | "hookStatus" | "session" | "terminalStatus"
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
  navigate: (input: {
    to: "/$threadId";
    params: { threadId: ThreadId };
    replace?: boolean;
  }) => Promise<unknown>;
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
  replace?: boolean;
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
    ...(input.replace === undefined ? {} : { replace: input.replace }),
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

/**
 * Maps Clui's terminal-backed lifecycle into t3code's Sidebar v2 status model.
 * Activity details such as "Thinking" and "Using Tool" intentionally remain
 * inside the thread view; the sidebar exposes only the stable high-level state.
 */
export function resolveSidebarV2Status(input: {
  thread: SidebarV2StatusInput;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
}): SidebarV2Status {
  const { hasPendingApprovals, hasPendingUserInput, thread } = input;
  const terminalIsActive = thread.terminalStatus === "active";

  if (thread.hookStatus === "pendingApproval" || (!terminalIsActive && hasPendingApprovals)) {
    return "approval";
  }
  if (thread.hookStatus === "needsInput" || (!terminalIsActive && hasPendingUserInput)) {
    return "input";
  }
  if (thread.hookStatus === "error" || thread.session?.status === "error") {
    return "failed";
  }
  if (
    thread.hookStatus === "working" ||
    thread.session?.status === "running" ||
    thread.session?.status === "connecting"
  ) {
    return "working";
  }
  return "ready";
}

export function resolveSidebarV2TopStatus(status: SidebarV2Status): SidebarV2TopStatus | null {
  switch (status) {
    case "working": {
      const pill = hookStatusPill("working");
      return {
        label: pill.label,
        icon: "working",
        className: `animate-sidebar-working-text motion-reduce:animate-none ${pill.colorClass}`,
      };
    }
    case "approval": {
      const pill = hookStatusPill("pendingApproval");
      return {
        label: pill.label,
        icon: null,
        className: pill.colorClass,
      };
    }
    case "input": {
      const pill = hookStatusPill("needsInput");
      return {
        label: pill.label,
        icon: null,
        className: pill.colorClass,
      };
    }
    case "failed": {
      const pill = hookStatusPill("error");
      return {
        label: pill.label,
        icon: null,
        className: pill.colorClass,
      };
    }
    case "ready":
      return null;
  }
}

function firstValidTimestamp(
  ...candidates: ReadonlyArray<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    if (!Number.isNaN(Date.parse(candidate))) return candidate;
  }
  return null;
}

/**
 * Uses t3code's active-turn/session timing anchors. `lastInteractedAt` is the
 * terminal-harness fallback because Clui keeps one PTY session across turns.
 */
export function resolveWorkingStartedAt(
  thread: Pick<Thread, "lastInteractedAt" | "latestTurn" | "session">,
): string | null {
  const turn = thread.latestTurn;
  if (turn && turn.completedAt === null) {
    return firstValidTimestamp(
      turn.startedAt,
      turn.requestedAt,
      thread.lastInteractedAt,
      thread.session?.updatedAt,
    );
  }
  return firstValidTimestamp(thread.lastInteractedAt, thread.session?.updatedAt);
}

export function formatWorkingDurationLabel(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
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
      tone: "working",
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
      return hookStatusPill("pendingApproval");
    }

    if (hasPendingUserInput) {
      return hookStatusPill("needsInput");
    }
  }

  if (thread.session?.status === "running" && !suppressReadCompletedHookStatus) {
    return workingStatusPill(thread.activityStatus);
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
      tone: "plan",
    };
  }

  if (hasUnseenCompletion(thread)) {
    return hookStatusPill("completed");
  }

  return null;
}
