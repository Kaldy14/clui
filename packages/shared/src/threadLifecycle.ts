import type {
  ClaudeHookStatus,
  OrchestrationLatestTurn,
  OrchestrationSessionStatus,
} from "@clui/contracts";

export type ChangeRequestState = "open" | "closed" | "merged";
export type SettledOverride = "settled" | "active" | null;

export const MIN_AUTO_SETTLE_AFTER_DAYS = 1;
export const MAX_AUTO_SETTLE_AFTER_DAYS = 90;
export const DEFAULT_AUTO_SETTLE_AFTER_DAYS = 3;
export const CHANGE_REQUEST_SETTLE_IDLE_MS = 60 * 60 * 1_000;
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

export interface ThreadLifecycleView {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastInteractedAt: string;
  readonly settledOverride: SettledOverride;
  readonly settledAt: string | null;
  readonly snoozedUntil: string | null;
  readonly snoozedAt: string | null;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly session: {
    readonly status: OrchestrationSessionStatus | "disconnected" | "connecting" | "closed";
    readonly updatedAt: string;
  } | null;
  readonly messages: ReadonlyArray<{
    readonly role: string;
    readonly createdAt: string;
  }>;
  readonly hookStatus?: ClaudeHookStatus | null;
}

export interface ThreadLifecycleBlockers {
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
}

function parseTime(value: string | null | undefined): number | null {
  if (value == null) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function latestUserMessageAt(thread: ThreadLifecycleView): string | null {
  let latest: string | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const message of thread.messages) {
    if (message.role !== "user") continue;
    const time = parseTime(message.createdAt);
    if (time !== null && time > latestTime) {
      latest = message.createdAt;
      latestTime = time;
    }
  }
  return latest;
}

export function threadLastActivityAt(thread: ThreadLifecycleView): string | null {
  const candidates = [
    thread.lastInteractedAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  ];
  let latest: string | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const time = parseTime(candidate);
    if (time !== null && time > latestTime) {
      latest = candidate ?? null;
      latestTime = time;
    }
  }
  return latest;
}

export function hasQueuedTurnStart(
  thread: ThreadLifecycleView,
  options: { readonly now: string },
): boolean {
  const messageAtValue = latestUserMessageAt(thread);
  const messageAt = parseTime(messageAtValue);
  const now = parseTime(options.now);
  if (messageAt === null || now === null) return false;
  if (Math.abs(now - messageAt) > QUEUED_TURN_START_GRACE_MS) return false;
  if (thread.session?.status === "error") return false;
  if (thread.latestTurn === null) return true;
  return [
    thread.latestTurn.requestedAt,
    thread.latestTurn.startedAt,
    thread.latestTurn.completedAt,
  ].every((candidate) => {
    const candidateTime = parseTime(candidate);
    return candidateTime === null || candidateTime < messageAt;
  });
}

export function canSettleThread(
  thread: ThreadLifecycleView,
  blockers: ThreadLifecycleBlockers,
  options: { readonly now: string },
): boolean {
  if (blockers.hasPendingApprovals || blockers.hasPendingUserInput) return false;
  if (thread.session?.status === "starting" || thread.session?.status === "running") return false;
  if (thread.latestTurn?.state === "running") return false;
  if (
    thread.hookStatus === "working" ||
    thread.hookStatus === "pendingApproval" ||
    thread.hookStatus === "needsInput"
  ) {
    return false;
  }
  return !hasQueuedTurnStart(thread, options);
}

export function canSnoozeThread(
  thread: ThreadLifecycleView,
  blockers: ThreadLifecycleBlockers,
  options: { readonly now: string },
): boolean {
  if (blockers.hasPendingApprovals || blockers.hasPendingUserInput) return false;
  if (thread.hookStatus === "pendingApproval" || thread.hookStatus === "needsInput") return false;
  return !hasQueuedTurnStart(thread, options);
}

function threadRaisedHandWhileSnoozed(
  thread: ThreadLifecycleView,
  blockers: ThreadLifecycleBlockers,
): boolean {
  if (blockers.hasPendingApprovals || blockers.hasPendingUserInput) return true;
  const snoozedAt = parseTime(thread.snoozedAt);
  if (thread.session?.status === "error") {
    const sessionUpdatedAt = parseTime(thread.session.updatedAt);
    if (snoozedAt === null || (sessionUpdatedAt !== null && sessionUpdatedAt > snoozedAt)) {
      return true;
    }
  }
  const completedAt = parseTime(thread.latestTurn?.completedAt);
  return (
    snoozedAt !== null &&
    thread.latestTurn?.state === "completed" &&
    completedAt !== null &&
    completedAt > snoozedAt
  );
}

export function effectiveSnoozed(
  thread: ThreadLifecycleView,
  blockers: ThreadLifecycleBlockers,
  options: { readonly now: string },
): boolean {
  const wakeAt = parseTime(thread.snoozedUntil);
  const now = parseTime(options.now);
  if (wakeAt === null || now === null || wakeAt <= now) return false;
  return !threadRaisedHandWhileSnoozed(thread, blockers);
}

export function threadWokeAt(
  thread: ThreadLifecycleView,
  blockers: ThreadLifecycleBlockers,
  options: { readonly now: string },
): string | null {
  const wakeAt = parseTime(thread.snoozedUntil);
  const now = parseTime(options.now);
  if (wakeAt === null || now === null || thread.snoozedUntil === null) return null;
  if (threadRaisedHandWhileSnoozed(thread, blockers)) {
    const completedAt = parseTime(thread.latestTurn?.completedAt);
    const snoozedAt = parseTime(thread.snoozedAt);
    if (
      thread.latestTurn?.state === "completed" &&
      completedAt !== null &&
      snoozedAt !== null &&
      completedAt > snoozedAt
    ) {
      return thread.latestTurn.completedAt;
    }
    return thread.session?.updatedAt ?? thread.snoozedAt;
  }
  return wakeAt <= now ? thread.snoozedUntil : null;
}

export function effectiveSettled(
  thread: ThreadLifecycleView,
  blockers: ThreadLifecycleBlockers,
  options: {
    readonly now: string;
    readonly autoSettleAfterDays: number | null;
    readonly changeRequestState?: ChangeRequestState | null;
  },
): boolean {
  if (!canSettleThread(thread, blockers, { now: options.now })) return false;
  if (thread.settledOverride === "settled") return true;
  if (thread.settledOverride === "active") return false;

  const lastActivityAt = threadLastActivityAt(thread);
  const lastActivityTime = parseTime(lastActivityAt);
  const now = parseTime(options.now);
  if (now === null) return false;

  if (options.changeRequestState === "merged" || options.changeRequestState === "closed") {
    if (lastActivityTime === null || lastActivityTime < now - CHANGE_REQUEST_SETTLE_IDLE_MS) {
      return true;
    }
  }
  if (options.autoSettleAfterDays === null || lastActivityTime === null) return false;
  return lastActivityTime < now - options.autoSettleAfterDays * 24 * 60 * 60 * 1_000;
}
