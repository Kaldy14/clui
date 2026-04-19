import { ProjectId, ThreadId } from "@clui/contracts";
import { describe, expect, it } from "vitest";

import {
  orderThreadsForProject,
  pruneThreadOrderByProject,
  reorderThreadsWithinProject,
  type ThreadOrderByProject,
} from "./threadOrdering";

const projectId = ProjectId.makeUnsafe("project-1");

function makeThread(input: { id: string; createdAt: string; projectId?: ProjectId }) {
  return {
    id: ThreadId.makeUnsafe(input.id),
    projectId: input.projectId ?? projectId,
    createdAt: input.createdAt,
  };
}

describe("threadOrdering", () => {
  it("defaults to createdAt desc when no manual order exists", () => {
    const threads = [
      makeThread({ id: "thread-1", createdAt: "2026-04-01T10:00:00.000Z" }),
      makeThread({ id: "thread-2", createdAt: "2026-04-01T12:00:00.000Z" }),
      makeThread({ id: "thread-3", createdAt: "2026-04-01T11:00:00.000Z" }),
    ];

    const ordered = orderThreadsForProject(threads, undefined);

    expect(ordered.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-3"),
      ThreadId.makeUnsafe("thread-1"),
    ]);
  });

  it("keeps newly created threads above the manually ordered list", () => {
    const threads = [
      makeThread({ id: "thread-1", createdAt: "2026-04-01T10:00:00.000Z" }),
      makeThread({ id: "thread-2", createdAt: "2026-04-01T11:00:00.000Z" }),
      makeThread({ id: "thread-3", createdAt: "2026-04-01T12:00:00.000Z" }),
    ];

    const ordered = orderThreadsForProject(threads, [
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-1"),
    ]);

    expect(ordered.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-3"),
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-1"),
    ]);
  });

  it("captures a full manual order after drag-reordering within a project", () => {
    const threads = [
      makeThread({ id: "thread-1", createdAt: "2026-04-01T10:00:00.000Z" }),
      makeThread({ id: "thread-2", createdAt: "2026-04-01T11:00:00.000Z" }),
      makeThread({ id: "thread-3", createdAt: "2026-04-01T12:00:00.000Z" }),
    ];
    const initialOrder: ThreadOrderByProject = {};

    const nextOrder = reorderThreadsWithinProject({
      projectId,
      threads,
      threadOrderByProject: initialOrder,
      draggedThreadId: ThreadId.makeUnsafe("thread-1"),
      targetThreadId: ThreadId.makeUnsafe("thread-3"),
    });

    expect(nextOrder[projectId]).toEqual([
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-3"),
      ThreadId.makeUnsafe("thread-2"),
    ]);
  });

  it("prunes deleted thread ids from persisted project order", () => {
    const threadOrderByProject: ThreadOrderByProject = {
      [projectId]: [
        ThreadId.makeUnsafe("thread-2"),
        ThreadId.makeUnsafe("thread-1"),
        ThreadId.makeUnsafe("thread-ghost"),
      ],
    };

    const nextOrder = pruneThreadOrderByProject(threadOrderByProject, [
      makeThread({ id: "thread-1", createdAt: "2026-04-01T10:00:00.000Z" }),
      makeThread({ id: "thread-2", createdAt: "2026-04-01T11:00:00.000Z" }),
    ]);

    expect(nextOrder[projectId]).toEqual([
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-1"),
    ]);
  });
});
