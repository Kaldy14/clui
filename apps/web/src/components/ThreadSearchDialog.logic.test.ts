import { MessageId, ProjectId, ThreadId } from "@clui/contracts";
import { describe, expect, it } from "vitest";

import type { Project, Thread } from "../types";
import { searchThreads } from "./ThreadSearchDialog.logic";

const projectId = ProjectId.makeUnsafe("project-1");

const project: Project = {
  id: projectId,
  name: "Clui",
  cwd: "/workspace/clui",
  model: "gpt-5-codex",
  expanded: true,
  scripts: [],
  prompts: [],
};

function isoMinute(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
}

function makeThread(index: number, overrides: Partial<Thread> = {}): Thread {
  const id = ThreadId.makeUnsafe(`thread-${index}`);
  const createdAt = isoMinute(index);
  return {
    id,
    projectId,
    title: `Thread ${index}`,
    model: "gpt-5-codex",
    harness: "claudeCode",
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt,
    updatedAt: createdAt,
    lastInteractedAt: createdAt,
    archivedAt: null,
    latestTurn: null,
    lastVisitedAt: undefined,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    terminalStatus: "new",
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

describe("searchThreads", () => {
  it("returns every thread for an empty query instead of capping the recent list", () => {
    const archivedAt = "2026-01-02T00:00:00.000Z";
    const threads = Array.from({ length: 120 }, (_, index) =>
      makeThread(index, { archivedAt: index === 3 ? archivedAt : null }),
    );

    const results = searchThreads(threads, [project], "");

    expect(results).toHaveLength(120);
    expect(results.some((result) => result.thread.archivedAt === archivedAt)).toBe(true);
    expect(results[0]?.thread.id).toBe(ThreadId.makeUnsafe("thread-119"));
  });

  it("searches across every matching thread instead of stopping at a fixed result cap", () => {
    const threads = Array.from({ length: 75 }, (_, index) =>
      makeThread(index, { title: `Legacy migration thread ${index}` }),
    );

    expect(searchThreads(threads, [project], "legacy migration")).toHaveLength(75);
  });

  it("can match user messages beyond the first user message in a thread", () => {
    const thread = makeThread(1, {
      messages: [
        {
          id: MessageId.makeUnsafe("message-1"),
          role: "user",
          text: "first prompt",
          createdAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:00.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("message-2"),
          role: "assistant",
          text: "assistant reply",
          createdAt: "2026-01-01T00:01:00.000Z",
          completedAt: "2026-01-01T00:01:00.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("message-3"),
          role: "user",
          text: "please revisit the archived onboarding notes",
          createdAt: "2026-01-01T00:02:00.000Z",
          completedAt: "2026-01-01T00:02:00.000Z",
          streaming: false,
        },
      ],
    });

    const results = searchThreads([thread], [project], "onboarding notes");

    expect(results).toHaveLength(1);
    expect(results[0]?.matchField).toBe("message");
  });
});
