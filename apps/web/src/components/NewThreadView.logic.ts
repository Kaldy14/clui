import type { ProjectId, ThreadId } from "@clui/contracts";

type ProjectPickerProject = {
  readonly id: ProjectId;
};

type ReusableDraftThread = {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly terminalStatus: "new" | "active" | "dormant";
  readonly archivedAt: string | null;
  readonly createdAt: string;
};

export function prioritizeActiveProject<T extends ProjectPickerProject>(
  projects: readonly T[],
  activeProjectId: ProjectId,
): T[] {
  const activeIndex = projects.findIndex((project) => project.id === activeProjectId);
  if (activeIndex <= 0) return [...projects];

  const activeProject = projects[activeIndex];
  if (!activeProject) return [...projects];

  return [activeProject, ...projects.slice(0, activeIndex), ...projects.slice(activeIndex + 1)];
}

export function findReusableNewThreadForProject<T extends ReusableDraftThread>(
  threads: readonly T[],
  projectId: ProjectId,
): T | null {
  return (
    threads
      .filter(
        (thread) =>
          thread.projectId === projectId &&
          thread.terminalStatus === "new" &&
          thread.archivedAt === null,
      )
      .toSorted(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
          right.id.localeCompare(left.id),
      )[0] ?? null
  );
}
