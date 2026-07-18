import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODING_HARNESS,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@clui/contracts";

import { findAutoArchivableThreads, shouldAutoArchiveThread } from "./autoArchiveThreads";

const NOW = new Date("2026-05-13T12:00:00.000Z");
const OLD = "2026-04-28T11:59:59.000Z";
const RECENT = "2026-05-01T12:00:01.000Z";

let threadCounter = 0;

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  threadCounter += 1;
  const id = overrides.id ?? ThreadId.makeUnsafe(`thread-${threadCounter}`);
  const projectId = overrides.projectId ?? ProjectId.makeUnsafe("project-1");
  return {
    id,
    projectId,
    title: "Thread title",
    model: "claude-opus-4-6",
    harness: DEFAULT_CODING_HARNESS,
    claudeCodeBackend: "anthropic",
    piRenderMode: "terminal",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    claudeSessionId: null,
    piSessionFile: null,
    terminalStatus: "dormant",
    scrollbackSnapshot: null,
    titleSource: "auto",
    bookmarked: false,
    latestTurn: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: OLD,
    lastInteractedAt: "2026-04-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

describe("auto archive thread selection", () => {
  it("selects inactive unarchived threads whose updatedAt is past the day threshold", () => {
    const oldThread = makeThread({ id: ThreadId.makeUnsafe("old-thread"), updatedAt: OLD });
    const recentThread = makeThread({
      id: ThreadId.makeUnsafe("recent-thread"),
      updatedAt: RECENT,
    });

    expect(findAutoArchivableThreads([oldThread, recentThread], 14, NOW)).toEqual([oldThread.id]);
  });

  it("does not select archived, deleted, active, or running threads", () => {
    const archivedThread = makeThread({ archivedAt: "2026-05-01T00:00:00.000Z" });
    const deletedThread = makeThread({ deletedAt: "2026-05-01T00:00:00.000Z" });
    const activeThread = makeThread({ terminalStatus: "active" });
    const runningTurnThread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "running",
        requestedAt: OLD,
        startedAt: OLD,
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const runningSessionThread = makeThread({
      session: {
        threadId: ThreadId.makeUnsafe("running-session-thread"),
        status: "running",
        providerName: "claudeCode",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: OLD,
      },
    });

    expect(
      findAutoArchivableThreads(
        [archivedThread, deletedThread, activeThread, runningTurnThread, runningSessionThread],
        14,
        NOW,
      ),
    ).toEqual([]);
  });

  it("treats zero days as disabled", () => {
    expect(shouldAutoArchiveThread(makeThread(), 0, NOW)).toBe(false);
  });
});
