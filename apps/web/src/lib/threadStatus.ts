import type {
  AgentActivityStatus,
  ClaudeHookStatus,
  GitStatusResult,
  TerminalStatus,
} from "@clui/contracts";
import { AGENT_ACTIVITY_LABELS } from "@clui/shared/agentActivity";
import type { Thread } from "../types";
import {
  hasSeenCompletion as hasSeenThreadCompletion,
  hasUnseenCompletion as hasUnseenThreadCompletion,
} from "./threadUnread";

export type ThreadStatusTone = "working" | "input" | "approval" | "error" | "completed" | "plan";

export interface ThreadStatusPill {
  label: string;
  colorClass: string;
  dotClass: string;
  pulse: boolean;
  tone: ThreadStatusTone;
}

export interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

export interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  tooltip: string;
  url: string;
}

export type ThreadPr = GitStatusResult["pr"];

export function settledPrHoverColorClass(state: NonNullable<ThreadPr>["state"]): string {
  switch (state) {
    case "open":
      return "group-hover/v2-row:text-emerald-600 dark:group-hover/v2-row:text-emerald-300/90";
    case "merged":
      return "group-hover/v2-row:text-violet-600 dark:group-hover/v2-row:text-violet-300/90";
    case "closed":
      return "group-hover/v2-row:text-red-600 dark:group-hover/v2-row:text-red-300/90";
  }
}

export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function hasUnseenCompletion(thread: Thread): boolean {
  return hasUnseenThreadCompletion(thread);
}

export function threadStatusPill(
  thread: Thread,
  hasPendingApprovals: boolean,
  hasPendingUserInput: boolean,
): ThreadStatusPill | null {
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
  const pill = claudeTerminalStatusPill(
    thread.terminalStatus,
    thread.hookStatus,
    thread.activityStatus,
  );
  if (pill && !suppressReadCompletedHookStatus) return pill;

  // Activity-based badges are only shown when the terminal is NOT active.
  // For active terminals, hookStatus (checked above) is the authoritative
  // real-time source — stale unresolved activities must not re-trigger badges.
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

  if (hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
      tone: "completed",
    };
  }

  return null;
}

export function claudeTerminalStatusPill(
  terminalStatus: TerminalStatus | undefined,
  hookStatus?: ClaudeHookStatus | null,
  activityStatus?: AgentActivityStatus | null,
): ThreadStatusPill | null {
  if (terminalStatus === "active") {
    // Rich hook-derived status when available.
    // When hookStatus is null (idle at prompt), show no badge —
    // the terminal being alive is obvious from the terminal content.
    if (hookStatus) {
      return hookStatusPill(hookStatus, activityStatus);
    }
    return null;
  }
  if (terminalStatus === "dormant") {
    // No badge for dormant terminals — "Paused" state is obvious from
    // the dormant terminal view and adds visual noise to the sidebar.
    return null;
  }
  return null;
}

export function workingStatusPill(activityStatus?: AgentActivityStatus | null): ThreadStatusPill {
  return {
    label: activityStatus ? AGENT_ACTIVITY_LABELS[activityStatus] : "Working",
    colorClass: "text-sky-600 dark:text-sky-300/80",
    dotClass: "bg-sky-500 dark:bg-sky-300/80",
    pulse: true,
    tone: "working",
  };
}

export function hookStatusPill(
  hookStatus: ClaudeHookStatus,
  activityStatus?: AgentActivityStatus | null,
): ThreadStatusPill {
  switch (hookStatus) {
    case "working":
      return workingStatusPill(activityStatus);
    case "needsInput":
      return {
        label: "Needs Input",
        colorClass: "text-yellow-600 dark:text-yellow-300",
        dotClass: "bg-yellow-500 dark:bg-yellow-300",
        pulse: false,
        tone: "input",
      };
    case "pendingApproval":
      return {
        label: "Pending Approval",
        colorClass: "text-amber-600 dark:text-amber-300/90",
        dotClass: "bg-amber-500 dark:bg-amber-300/90",
        pulse: false,
        tone: "approval",
      };
    case "error":
      return {
        label: "Error",
        colorClass: "text-red-600 dark:text-red-400/90",
        dotClass: "bg-red-500 dark:bg-red-400/90",
        pulse: false,
        tone: "error",
      };
    case "completed":
      return {
        label: "Completed",
        colorClass: "text-emerald-600 dark:text-emerald-300/90",
        dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
        pulse: false,
        tone: "completed",
      };
  }
}

export function terminalStatusFromRunningIds(
  runningTerminalIds: string[],
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

const BRANCH_PREFIXES_TO_STRIP = [
  "feature/",
  "feat/",
  "bugfix/",
  "fix/",
  "hotfix/",
  "chore/",
  "release/",
  "refactor/",
  "docs/",
  "test/",
  "ci/",
  "dependabot/",
];

export function formatBranchForDisplay(branch: string): string {
  let name = branch;
  for (const prefix of BRANCH_PREFIXES_TO_STRIP) {
    if (name.toLowerCase().startsWith(prefix)) {
      name = name.slice(prefix.length);
      break;
    }
  }
  return name;
}

export function prStatusIndicator(pr: ThreadPr): PrStatusIndicator | null {
  if (!pr) return null;

  if (pr.state === "open") {
    return {
      label: "PR open",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `PR #${pr.number} - Open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: "PR closed",
      colorClass: "text-red-600 dark:text-red-300/90",
      tooltip: `PR #${pr.number} - Closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: "PR merged",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `PR #${pr.number} - Merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}
