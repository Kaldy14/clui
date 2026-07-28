import { ProjectId, ThreadId } from "@clui/contracts";
import { describe, expect, it } from "vitest";

import { findReusableNewThreadForProject, prioritizeActiveProject } from "./NewThreadView.logic";

const projectId = (value: string) => ProjectId.makeUnsafe(value);
const threadId = (value: string) => ThreadId.makeUnsafe(value);

describe("prioritizeActiveProject", () => {
  it("promotes the current project while preserving the other project order", () => {
    const projects = [
      { id: projectId("alpha"), name: "Alpha" },
      { id: projectId("beta"), name: "Beta" },
      { id: projectId("gamma"), name: "Gamma" },
    ];

    expect(
      prioritizeActiveProject(projects, projectId("beta")).map((project) => project.name),
    ).toEqual(["Beta", "Alpha", "Gamma"]);
    expect(projects.map((project) => project.name)).toEqual(["Alpha", "Beta", "Gamma"]);
  });
});

describe("findReusableNewThreadForProject", () => {
  it("returns the newest unarchived new thread for the selected project", () => {
    const threads = [
      {
        id: threadId("older"),
        projectId: projectId("beta"),
        terminalStatus: "new" as const,
        archivedAt: null,
        createdAt: "2026-07-28T10:00:00.000Z",
      },
      {
        id: threadId("newer"),
        projectId: projectId("beta"),
        terminalStatus: "new" as const,
        archivedAt: null,
        createdAt: "2026-07-28T11:00:00.000Z",
      },
      {
        id: threadId("active"),
        projectId: projectId("beta"),
        terminalStatus: "active" as const,
        archivedAt: null,
        createdAt: "2026-07-28T12:00:00.000Z",
      },
      {
        id: threadId("other-project"),
        projectId: projectId("alpha"),
        terminalStatus: "new" as const,
        archivedAt: null,
        createdAt: "2026-07-28T13:00:00.000Z",
      },
    ];

    expect(findReusableNewThreadForProject(threads, projectId("beta"))?.id).toBe(threadId("newer"));
  });

  it("ignores archived drafts", () => {
    expect(
      findReusableNewThreadForProject(
        [
          {
            id: threadId("archived"),
            projectId: projectId("beta"),
            terminalStatus: "new",
            archivedAt: "2026-07-28T12:00:00.000Z",
            createdAt: "2026-07-28T11:00:00.000Z",
          },
        ],
        projectId("beta"),
      ),
    ).toBeNull();
  });
});
