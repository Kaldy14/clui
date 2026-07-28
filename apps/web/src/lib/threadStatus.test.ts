import { ProjectId, ThreadId } from "@clui/contracts";
import { describe, expect, it } from "vitest";

import type { Thread } from "../types";
import { threadStatusPill } from "./threadStatus";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    model: "gpt-5-codex",
    harness: "pi",
    claudeCodeBackend: "anthropic",
    piRenderMode: "terminal",
    runtimeMode: "full-access",
    interactionMode: "default",
    session: {
      provider: "codex",
      status: "running",
      orchestrationStatus: "running",
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
    },
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    lastInteractedAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    latestTurn: null,
    lastVisitedAt: undefined,
    lastCompletedAt: undefined,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    terminalStatus: "active",
    dormantReason: null,
    claudeSessionId: null,
    piSessionFile: null,
    scrollbackSnapshot: null,
    titleSource: "auto",
    bookmarked: false,
    hookStatus: null,
    ...overrides,
  };
}

describe("threadStatusPill", () => {
  it("keeps a read completion hidden even if hookStatus remains completed", () => {
    const pill = threadStatusPill(
      makeThread({
        hookStatus: "completed",
        lastCompletedAt: "2026-03-09T10:05:00.000Z",
        lastVisitedAt: "2026-03-09T10:06:00.000Z",
      }),
      false,
      false,
    );

    expect(pill).toBeNull();
  });

  it("shows an unread completion from hookStatus", () => {
    const pill = threadStatusPill(
      makeThread({
        hookStatus: "completed",
        lastCompletedAt: "2026-03-09T10:05:00.000Z",
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
      }),
      false,
      false,
    );

    expect(pill).toMatchObject({ label: "Completed", pulse: false });
  });

  it("uses activity labels for working threads", () => {
    const pill = threadStatusPill(
      makeThread({ hookStatus: "working", activityStatus: "coding" }),
      false,
      false,
    );

    expect(pill).toMatchObject({ label: "Coding", pulse: true });
  });

  it("shows thinking while the agent is reasoning", () => {
    const pill = threadStatusPill(
      makeThread({ hookStatus: "working", activityStatus: "thinking" }),
      false,
      false,
    );

    expect(pill).toMatchObject({ label: "Thinking", pulse: true });
  });
});
