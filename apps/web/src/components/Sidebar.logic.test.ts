import {
  CommandId,
  ProjectId,
  ThreadId,
  type CodingHarness,
  type TerminalStatus,
} from "@clui/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createThreadAndNavigate,
  formatWorkingDurationLabel,
  getActiveHarnessSessionStats,
  hasUnseenCompletion,
  resolveSidebarV2Status,
  resolveThreadStatusPill,
  resolveWorkingStartedAt,
  shouldClearThreadSelectionOnMouseDown,
} from "./Sidebar.logic";

function makeLatestTurn(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
}): Parameters<typeof hasUnseenCompletion>[0]["latestTurn"] {
  return {
    turnId: "turn-1" as never,
    state: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt:
      overrides?.startedAt === undefined ? "2026-03-09T10:00:00.000Z" : overrides.startedAt,
    completedAt:
      overrides?.completedAt === undefined ? "2026-03-09T10:05:00.000Z" : overrides.completedAt,
  };
}

function makeHarnessSessionStatsThread(harness: CodingHarness, terminalStatus: TerminalStatus) {
  return { harness, terminalStatus };
}

describe("getActiveHarnessSessionStats", () => {
  it("counts active sessions globally and by harness", () => {
    expect(
      getActiveHarnessSessionStats({
        maxActivePerHarness: 10,
        threads: [
          makeHarnessSessionStatsThread("claudeCode", "active"),
          makeHarnessSessionStatsThread("claudeCode", "active"),
          makeHarnessSessionStatsThread("claudeCode", "dormant"),
          makeHarnessSessionStatsThread("pi", "active"),
          makeHarnessSessionStatsThread("pi", "new"),
          makeHarnessSessionStatsThread("codexCli", "active"),
          makeHarnessSessionStatsThread("codexCli", "dormant"),
        ],
      }),
    ).toEqual({
      activeByHarness: {
        claudeCode: 2,
        pi: 1,
        codexCli: 1,
      },
      busiestHarness: "claudeCode",
      busiestHarnessActive: 2,
      maxActivePerHarness: 10,
      totalActive: 4,
    });
  });

  it("does not clamp over-cap active session counts", () => {
    const threads = Array.from({ length: 25 }, () => makeHarnessSessionStatsThread("pi", "active"));

    expect(getActiveHarnessSessionStats({ maxActivePerHarness: 20, threads })).toMatchObject({
      activeByHarness: { claudeCode: 0, pi: 25, codexCli: 0 },
      busiestHarness: "pi",
      busiestHarnessActive: 25,
      maxActivePerHarness: 20,
      totalActive: 25,
    });
  });
});

describe("createThreadAndNavigate", () => {
  it("waits for the server thread.create ack before adding local state or navigating", async () => {
    const events: string[] = [];
    let resolveDispatch = (): void => {
      throw new Error("dispatch promise was not captured");
    };

    const api = {
      orchestration: {
        dispatchCommand: vi.fn(
          () =>
            new Promise<{ sequence: number }>((resolve) => {
              events.push("dispatch:start");
              resolveDispatch = () => {
                events.push("dispatch:resolved");
                resolve({ sequence: 1 });
              };
            }),
        ),
      },
    };
    const addOptimisticThread = vi.fn(() => {
      events.push("optimistic");
    });
    const navigate = vi.fn(async () => {
      events.push("navigate");
    });

    const pending = createThreadAndNavigate({
      api,
      navigate,
      addOptimisticThread,
      commandId: CommandId.makeUnsafe("cmd-thread-create"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      projectId: ProjectId.makeUnsafe("project-1"),
      model: "gpt-5.6-sol",
      harness: "claudeCode",
      claudeCodeBackend: "codex",
      createdAt: "2026-04-23T10:00:00.000Z",
      branch: null,
      worktreePath: null,
      replace: true,
    });

    expect(events).toEqual(["dispatch:start"]);
    expect(addOptimisticThread).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    resolveDispatch();
    await pending;

    expect(events).toEqual(["dispatch:start", "dispatch:resolved", "optimistic", "navigate"]);
    expect(api.orchestration.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.6-sol",
        claudeCodeBackend: "codex",
      }),
    );
    expect(addOptimisticThread).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.6-sol",
        claudeCodeBackend: "codex",
      }),
    );
    expect(navigate).toHaveBeenCalledWith({
      to: "/$threadId",
      params: { threadId: ThreadId.makeUnsafe("thread-1") },
      replace: true,
    });
  });

  it("does not add local state or navigate when thread.create fails", async () => {
    const addOptimisticThread = vi.fn();
    const navigate = vi.fn(async () => undefined);
    const api = {
      orchestration: {
        dispatchCommand: vi.fn(async (): Promise<{ sequence: number }> => {
          throw new Error("thread.create failed");
        }),
      },
    };

    await expect(
      createThreadAndNavigate({
        api,
        navigate,
        addOptimisticThread,
        commandId: CommandId.makeUnsafe("cmd-thread-create-fail"),
        threadId: ThreadId.makeUnsafe("thread-2"),
        projectId: ProjectId.makeUnsafe("project-1"),
        model: "gpt-5-codex",
        harness: "claudeCode",
        createdAt: "2026-04-23T10:00:00.000Z",
        branch: null,
        worktreePath: null,
      }),
    ).rejects.toThrow("thread.create failed");

    expect(addOptimisticThread).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("hasUnseenCompletion", () => {
  it("returns true when a thread completed after its last visit", () => {
    expect(
      hasUnseenCompletion({
        latestTurn: makeLatestTurn(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
      }),
    ).toBe(true);
  });

  it("uses terminal completion markers when there is no orchestration turn", () => {
    expect(
      hasUnseenCompletion({
        latestTurn: null,
        lastCompletedAt: "2026-03-09T10:05:00.000Z",
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
      }),
    ).toBe(true);
  });
});

describe("Sidebar v2 status parity", () => {
  const session = {
    provider: "codex" as const,
    status: "running" as const,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:02:00.000Z",
    orchestrationStatus: "running" as const,
  };
  const idleThread = {
    hookStatus: null,
    session,
    terminalStatus: "new" as const,
  };

  it("uses t3code's high-level Working state instead of the activity detail", () => {
    expect(
      resolveSidebarV2Status({
        thread: {
          ...idleThread,
          activityStatus: "thinking",
          hookStatus: "working",
          terminalStatus: "active",
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toBe("working");
  });

  it("prioritizes authoritative approval and input hooks", () => {
    expect(
      resolveSidebarV2Status({
        thread: { ...idleThread, hookStatus: "pendingApproval", terminalStatus: "active" },
        hasPendingApprovals: false,
        hasPendingUserInput: true,
      }),
    ).toBe("approval");
    expect(
      resolveSidebarV2Status({
        thread: { ...idleThread, hookStatus: "needsInput", terminalStatus: "active" },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toBe("input");
  });

  it("does not let stale derived blockers override an active working hook", () => {
    expect(
      resolveSidebarV2Status({
        thread: { ...idleThread, hookStatus: "working", terminalStatus: "active" },
        hasPendingApprovals: true,
        hasPendingUserInput: true,
      }),
    ).toBe("working");
  });

  it("maps connecting, errors, and idle sessions to the t3code states", () => {
    expect(
      resolveSidebarV2Status({
        thread: { ...idleThread, session: { ...session, status: "connecting" } },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toBe("working");
    expect(
      resolveSidebarV2Status({
        thread: { ...idleThread, hookStatus: "error", terminalStatus: "active" },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toBe("failed");
    expect(
      resolveSidebarV2Status({
        thread: { ...idleThread, session: { ...session, status: "ready" } },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toBe("ready");
  });
});

describe("resolveWorkingStartedAt", () => {
  const session = {
    provider: "codex" as const,
    status: "running" as const,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:02:00.000Z",
    orchestrationStatus: "running" as const,
  };

  it("uses the active turn start, then its request time", () => {
    expect(
      resolveWorkingStartedAt({
        latestTurn: makeLatestTurn({ completedAt: null }),
        lastInteractedAt: "2026-03-09T10:01:00.000Z",
        session,
      }),
    ).toBe("2026-03-09T10:00:00.000Z");
    expect(
      resolveWorkingStartedAt({
        latestTurn: makeLatestTurn({ completedAt: null, startedAt: null }),
        lastInteractedAt: "2026-03-09T10:01:00.000Z",
        session,
      }),
    ).toBe("2026-03-09T10:00:00.000Z");
  });

  it("uses Clui's turn interaction time before the long-lived PTY session timestamp", () => {
    expect(
      resolveWorkingStartedAt({
        latestTurn: null,
        lastInteractedAt: "2026-03-09T10:01:00.000Z",
        session,
      }),
    ).toBe("2026-03-09T10:01:00.000Z");
  });

  it("falls through malformed timestamps", () => {
    expect(
      resolveWorkingStartedAt({
        latestTurn: null,
        lastInteractedAt: "not-a-date",
        session,
      }),
    ).toBe("2026-03-09T10:02:00.000Z");
  });
});

describe("formatWorkingDurationLabel", () => {
  it("matches t3code's seconds, minutes, and hours formatting", () => {
    expect(formatWorkingDurationLabel(0)).toBe("0s");
    expect(formatWorkingDurationLabel(42_000)).toBe("42s");
    expect(formatWorkingDurationLabel(5 * 60_000)).toBe("5m");
    expect(formatWorkingDurationLabel(90 * 60_000)).toBe("1h 30m");
  });

  it("clamps negative and non-finite durations", () => {
    expect(formatWorkingDurationLabel(-5_000)).toBe("0s");
    expect(formatWorkingDurationLabel(Number.NaN)).toBe("0s");
  });
});

describe("shouldClearThreadSelectionOnMouseDown", () => {
  it("preserves selection for thread items", () => {
    const child = {
      closest: (selector: string) =>
        selector.includes("[data-thread-item]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(child)).toBe(false);
  });

  it("preserves selection for thread list toggle controls", () => {
    const selectionSafe = {
      closest: (selector: string) =>
        selector.includes("[data-thread-selection-safe]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(selectionSafe)).toBe(false);
  });

  it("clears selection for unrelated sidebar clicks", () => {
    const unrelated = {
      closest: () => null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(unrelated)).toBe(true);
  });
});

describe("resolveThreadStatusPill", () => {
  const baseThread = {
    interactionMode: "plan" as const,
    latestTurn: null,
    lastVisitedAt: undefined,
    proposedPlans: [],
    session: {
      provider: "codex" as const,
      status: "running" as const,
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      orchestrationStatus: "running" as const,
    },
    terminalStatus: "new" as const,
    hookStatus: null,
  };

  it("shows pending approval before all other statuses", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
      }),
    ).toMatchObject({ label: "Pending Approval", pulse: false });
  });

  it("shows needs input when plan mode is blocked on user answers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: false,
        hasPendingUserInput: true,
      }),
    ).toMatchObject({ label: "Needs Input", pulse: false });
  });

  it("falls back to working when the thread is actively running without blockers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("shows the dynamic activity label while working", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          terminalStatus: "active",
          hookStatus: "working",
          activityStatus: "committing",
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Committing", pulse: true });
  });

  it("shows thinking when the agent is reasoning", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          terminalStatus: "active",
          hookStatus: "working",
          activityStatus: "thinking",
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Thinking", pulse: true });
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          proposedPlans: [
            {
              id: "plan-1" as never,
              turnId: "turn-1" as never,
              createdAt: "2026-03-09T10:00:00.000Z",
              updatedAt: "2026-03-09T10:05:00.000Z",
              planMarkdown: "# Plan",
            },
          ],
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Plan Ready", pulse: false });
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestTurn: null,
          lastCompletedAt: "2026-03-09T10:05:00.000Z",
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });

  it("keeps a read completion hidden even if hookStatus remains completed", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestTurn: null,
          lastCompletedAt: "2026-03-09T10:05:00.000Z",
          lastVisitedAt: "2026-03-09T10:06:00.000Z",
          terminalStatus: "active",
          hookStatus: "completed",
          session: {
            ...baseThread.session,
            status: "running",
            orchestrationStatus: "running",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toBeNull();
  });
});
