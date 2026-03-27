import type { OrchestrationThreadActivity, OrchestrationSessionStatus, ClaudeHookStatus } from "@clui/contracts";

export function requestNotificationPermission(): void {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    void Notification.requestPermission();
  }
}

function canNotify(): boolean {
  if (!("Notification" in window)) return false;
  if (Notification.permission !== "granted") return false;
  return true;
}

/** True when the app window is in the foreground and visible. */
function isWindowFocused(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

function fireNotification(title: string, body: string, tag: string, onNavigate?: () => void): void {
  const n = new Notification(title, { body, tag });
  n.addEventListener("click", () => {
    window.focus();
    onNavigate?.();
    n.close();
  });
  setTimeout(() => n.close(), 8_000);
}

// ── Activity-based notifications (approvals, user input) ─────────────

function buildActivityNotification(
  activity: OrchestrationThreadActivity,
  threadTitle: string,
): { title: string; body: string } | null {
  switch (activity.kind) {
    case "approval.requested": {
      const payload = activity.payload as { requestKind?: string } | null;
      const detail = payload?.requestKind ? ` (${payload.requestKind})` : "";
      return { title: `Approval needed${detail}`, body: threadTitle };
    }
    case "user-input.requested": {
      return { title: "Input requested", body: threadTitle };
    }
    default:
      return null;
  }
}

export function dispatchActivityNotification(
  activity: OrchestrationThreadActivity,
  threadTitle: string,
  isCurrentThread: boolean,
  onNavigate?: () => void,
): void {
  if ((isCurrentThread && isWindowFocused()) || !canNotify()) return;
  const notification = buildActivityNotification(activity, threadTitle);
  if (!notification) return;
  fireNotification(
    notification.title,
    notification.body,
    activity.turnId ?? activity.id,
    onNavigate,
  );
}

// ── Session-set notifications (turn finished) ────────────────────────

/**
 * Notify when a session transitions from "running" to a settled state,
 * indicating the turn has finished.
 */
export function dispatchSessionSetNotification(
  threadId: string,
  threadTitle: string,
  status: OrchestrationSessionStatus,
  previousStatus: OrchestrationSessionStatus | null,
  isCurrentThread: boolean,
  onNavigate?: () => void,
): void {
  if ((isCurrentThread && isWindowFocused()) || !canNotify()) return;
  if (previousStatus !== "running") return;

  let title: string;
  switch (status) {
    case "ready":
      title = "Turn completed";
      break;
    case "error":
      title = "Turn failed";
      break;
    case "stopped":
      title = "Session stopped";
      break;
    default:
      return;
  }

  fireNotification(title, threadTitle, `session:${threadId}`, onNavigate);
}

// ── Hook-based notifications (Claude Code lifecycle) ──────────────────

/**
 * Notify when a Claude Code hook fires a notification (needs input, approval, error).
 * Only fires when the thread is not focused or the window is hidden.
 */
export function dispatchHookNotification(
  subtitle: string,
  body: string,
  threadTitle: string,
  isCurrentThread: boolean,
  onNavigate?: () => void,
): void {
  if ((isCurrentThread && isWindowFocused()) || !canNotify()) return;
  fireNotification(
    `${subtitle} — ${threadTitle}`,
    body,
    `hook:${Date.now()}`,
    onNavigate,
  );
}

// ── Dock badge (macOS) ────────────────────────────────────────────────

const BADGE_HOOK_STATUSES: ReadonlySet<ClaudeHookStatus> = new Set([
  "pendingApproval",
  "needsInput",
]);

/**
 * Update the macOS dock badge to show how many threads need attention.
 * Call after any hookStatus change. No-ops gracefully outside Electron.
 */
export function updateDockBadge(threads: ReadonlyArray<{ hookStatus: ClaudeHookStatus | null }>): void {
  const count = threads.filter((t) => t.hookStatus !== null && BADGE_HOOK_STATUSES.has(t.hookStatus)).length;
  window.desktopBridge?.setBadgeCount(count);
}

// ── Turn-completed notifications (hook lifecycle) ─────────────────────

/**
 * Notify when a Claude turn finishes (hookStatus transitions to "completed"
 * from a working/active state). This covers terminal-based sessions where
 * orchestration session-set events are not emitted.
 */
export function dispatchTurnCompletedNotification(
  threadId: string,
  threadTitle: string,
  isCurrentThread: boolean,
  onNavigate?: () => void,
): void {
  if ((isCurrentThread && isWindowFocused()) || !canNotify()) return;
  fireNotification("Turn completed", threadTitle, `turn:${threadId}`, onNavigate);
}
