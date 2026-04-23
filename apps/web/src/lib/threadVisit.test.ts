import { ThreadId } from "@clui/contracts";
import { describe, expect, it } from "vitest";

import { getViewedThreadCompletionVisit } from "./threadVisit";

describe("threadVisit", () => {
  const threadId = ThreadId.makeUnsafe("thread-1");

  it("ignores threads without a viewed completion signal", () => {
    expect(
      getViewedThreadCompletionVisit({
        threadId,
        hookStatus: null,
        completedAt: null,
        lastHandledKey: null,
      }),
    ).toBeNull();
  });

  it("marks an in-view completed hook even before latestTurn.completedAt arrives", () => {
    expect(
      getViewedThreadCompletionVisit({
        threadId,
        hookStatus: "completed",
        completedAt: null,
        lastHandledKey: null,
      }),
    ).toEqual({
      key: `${threadId}:__pending-completion__`,
      visitedAt: undefined,
    });
  });

  it("deduplicates the same completion signal", () => {
    expect(
      getViewedThreadCompletionVisit({
        threadId,
        hookStatus: "completed",
        completedAt: null,
        lastHandledKey: `${threadId}:__pending-completion__`,
      }),
    ).toBeNull();
  });

  it("handles the later completedAt snapshot as a distinct visit key", () => {
    expect(
      getViewedThreadCompletionVisit({
        threadId,
        hookStatus: null,
        completedAt: "2026-04-23T18:22:00.000Z",
        lastHandledKey: `${threadId}:__pending-completion__`,
      }),
    ).toEqual({
      key: `${threadId}:2026-04-23T18:22:00.000Z`,
      visitedAt: "2026-04-23T18:22:00.000Z",
    });
  });
});
