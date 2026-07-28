import { describe, expect, it } from "vitest";
import { TurnId } from "@clui/contracts";

import {
  CHANGE_REQUEST_SETTLE_IDLE_MS,
  DEFAULT_AUTO_SETTLE_AFTER_DAYS,
  canSettleThread,
  canSnoozeThread,
  effectiveSettled,
  effectiveSnoozed,
  threadWokeAt,
  type ThreadLifecycleBlockers,
  type ThreadLifecycleView,
} from "./threadLifecycle";

const NOW = "2026-07-28T12:00:00.000Z";
const NO_BLOCKERS: ThreadLifecycleBlockers = {
  hasPendingApprovals: false,
  hasPendingUserInput: false,
};

function makeThread(overrides: Partial<ThreadLifecycleView> = {}): ThreadLifecycleView {
  return {
    createdAt: "2026-07-01T12:00:00.000Z",
    updatedAt: "2026-07-28T11:00:00.000Z",
    lastInteractedAt: "2026-07-28T11:00:00.000Z",
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    latestTurn: null,
    session: null,
    messages: [],
    hookStatus: null,
    ...overrides,
  };
}

describe("effectiveSettled", () => {
  it("uses the explicit settled and active overrides first", () => {
    const inactiveAt = "2026-07-01T12:00:00.000Z";
    expect(
      effectiveSettled(
        makeThread({ settledOverride: "settled", settledAt: inactiveAt }),
        NO_BLOCKERS,
        { now: NOW, autoSettleAfterDays: null },
      ),
    ).toBe(true);
    expect(
      effectiveSettled(
        makeThread({
          settledOverride: "active",
          updatedAt: inactiveAt,
          lastInteractedAt: inactiveAt,
        }),
        NO_BLOCKERS,
        { now: NOW, autoSettleAfterDays: DEFAULT_AUTO_SETTLE_AFTER_DAYS },
      ),
    ).toBe(false);
  });

  it("auto-settles after the configured inactivity window", () => {
    const stale = makeThread({
      updatedAt: NOW,
      lastInteractedAt: "2026-07-24T11:59:59.000Z",
    });
    const boundary = makeThread({
      updatedAt: NOW,
      lastInteractedAt: "2026-07-25T12:00:00.000Z",
    });

    expect(
      effectiveSettled(stale, NO_BLOCKERS, {
        now: NOW,
        autoSettleAfterDays: DEFAULT_AUTO_SETTLE_AFTER_DAYS,
      }),
    ).toBe(true);
    expect(
      effectiveSettled(boundary, NO_BLOCKERS, {
        now: NOW,
        autoSettleAfterDays: DEFAULT_AUTO_SETTLE_AFTER_DAYS,
      }),
    ).toBe(false);
  });

  it("settles merged and closed pull requests after one idle hour", () => {
    const idleAt = new Date(Date.parse(NOW) - CHANGE_REQUEST_SETTLE_IDLE_MS - 1).toISOString();
    const thread = makeThread({ updatedAt: idleAt, lastInteractedAt: idleAt });

    expect(
      effectiveSettled(thread, NO_BLOCKERS, {
        now: NOW,
        autoSettleAfterDays: null,
        changeRequestState: "merged",
      }),
    ).toBe(true);
    expect(
      effectiveSettled(thread, NO_BLOCKERS, {
        now: NOW,
        autoSettleAfterDays: null,
        changeRequestState: "closed",
      }),
    ).toBe(true);
    expect(
      effectiveSettled(thread, NO_BLOCKERS, {
        now: NOW,
        autoSettleAfterDays: null,
        changeRequestState: "open",
      }),
    ).toBe(false);
  });

  it("does not settle queued or blocked work", () => {
    const queued = makeThread({
      messages: [{ role: "user", createdAt: "2026-07-28T11:59:30.000Z" }],
    });
    expect(canSettleThread(queued, NO_BLOCKERS, { now: NOW })).toBe(false);
    expect(
      effectiveSettled(
        makeThread({ settledOverride: "settled" }),
        { ...NO_BLOCKERS, hasPendingApprovals: true },
        { now: NOW, autoSettleAfterDays: null },
      ),
    ).toBe(false);
  });
});

describe("snooze lifecycle", () => {
  it("stays snoozed until the deadline and then reports its wake time", () => {
    const thread = makeThread({
      snoozedAt: "2026-07-28T11:00:00.000Z",
      snoozedUntil: "2026-07-28T13:00:00.000Z",
    });

    expect(effectiveSnoozed(thread, NO_BLOCKERS, { now: NOW })).toBe(true);
    expect(threadWokeAt(thread, NO_BLOCKERS, { now: NOW })).toBeNull();
    expect(threadWokeAt(thread, NO_BLOCKERS, { now: "2026-07-28T13:00:01.000Z" })).toBe(
      "2026-07-28T13:00:00.000Z",
    );
  });

  it("wakes early when completed work raises its hand", () => {
    const completedAt = "2026-07-28T11:30:00.000Z";
    const thread = makeThread({
      snoozedAt: "2026-07-28T11:00:00.000Z",
      snoozedUntil: "2026-07-28T13:00:00.000Z",
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "completed",
        requestedAt: "2026-07-28T10:00:00.000Z",
        startedAt: "2026-07-28T10:00:01.000Z",
        completedAt,
        assistantMessageId: null,
      },
    });

    expect(effectiveSnoozed(thread, NO_BLOCKERS, { now: NOW })).toBe(false);
    expect(threadWokeAt(thread, NO_BLOCKERS, { now: NOW })).toBe(completedAt);
  });

  it("allows running background work to be snoozed but not approval-blocked work", () => {
    const running = makeThread({
      session: { status: "running", updatedAt: "2026-07-28T11:59:00.000Z" },
    });
    expect(canSnoozeThread(running, NO_BLOCKERS, { now: NOW })).toBe(true);
    expect(
      canSnoozeThread(running, { ...NO_BLOCKERS, hasPendingUserInput: true }, { now: NOW }),
    ).toBe(false);
  });
});
