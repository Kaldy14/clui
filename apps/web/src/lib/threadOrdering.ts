import type { ProjectId, ThreadId } from "@clui/contracts";

import type { Project, Thread } from "../types";

export type ThreadOrderByProject = Record<string, ThreadId[]>;

type ThreadOrderingInput = Pick<Thread, "id" | "projectId" | "createdAt">;

type PersistedThreadOrderByProjectCwd = ReadonlyMap<string, readonly string[]>;

export function compareThreadsByCreatedAtDesc(
  left: Pick<Thread, "id" | "createdAt">,
  right: Pick<Thread, "id" | "createdAt">,
): number {
  const leftCreatedAt = Date.parse(left.createdAt);
  const rightCreatedAt = Date.parse(right.createdAt);
  const bothFinite = Number.isFinite(leftCreatedAt) && Number.isFinite(rightCreatedAt);
  if (bothFinite && rightCreatedAt !== leftCreatedAt) {
    return rightCreatedAt - leftCreatedAt;
  }
  return right.id.localeCompare(left.id);
}

export function orderThreadsForProject<T extends ThreadOrderingInput>(
  projectThreads: readonly T[],
  manualOrder: readonly ThreadId[] | undefined,
): T[] {
  if (projectThreads.length <= 1) return [...projectThreads];

  const orderedThreadsById = new Map(projectThreads.map((thread) => [thread.id, thread] as const));
  const seen = new Set<ThreadId>();
  const explicitlyOrdered: T[] = [];

  for (const threadId of manualOrder ?? []) {
    const thread = orderedThreadsById.get(threadId);
    if (!thread || seen.has(thread.id)) continue;
    explicitlyOrdered.push(thread);
    seen.add(thread.id);
  }

  const newThreads = projectThreads
    .filter((thread) => !seen.has(thread.id))
    .toSorted(compareThreadsByCreatedAtDesc);

  return [...newThreads, ...explicitlyOrdered];
}

export function getTopThreadForProject<T extends ThreadOrderingInput>(
  projectThreads: readonly T[],
  manualOrder: readonly ThreadId[] | undefined,
): T | null {
  return orderThreadsForProject(projectThreads, manualOrder)[0] ?? null;
}

export function reorderThreadsWithinProject(input: {
  projectId: ProjectId;
  threads: readonly ThreadOrderingInput[];
  threadOrderByProject: ThreadOrderByProject;
  draggedThreadId: ThreadId;
  targetThreadId: ThreadId;
}): ThreadOrderByProject {
  const { draggedThreadId, projectId, targetThreadId, threadOrderByProject, threads } = input;
  if (draggedThreadId === targetThreadId) return threadOrderByProject;

  const projectThreads = threads.filter((thread) => thread.projectId === projectId);
  if (projectThreads.length === 0) return threadOrderByProject;

  const orderedProjectThreads = orderThreadsForProject(
    projectThreads,
    threadOrderByProject[projectId],
  );
  const draggedIndex = orderedProjectThreads.findIndex((thread) => thread.id === draggedThreadId);
  const targetIndex = orderedProjectThreads.findIndex((thread) => thread.id === targetThreadId);
  if (draggedIndex < 0 || targetIndex < 0) return threadOrderByProject;

  const nextOrderedThreadIds = orderedProjectThreads.map((thread) => thread.id);
  const [draggedThread] = nextOrderedThreadIds.splice(draggedIndex, 1);
  if (!draggedThread) return threadOrderByProject;
  nextOrderedThreadIds.splice(targetIndex, 0, draggedThread);

  const previousOrder = threadOrderByProject[projectId] ?? [];
  if (
    previousOrder.length === nextOrderedThreadIds.length &&
    previousOrder.every((threadId, index) => threadId === nextOrderedThreadIds[index])
  ) {
    return threadOrderByProject;
  }

  return {
    ...threadOrderByProject,
    [projectId]: nextOrderedThreadIds,
  };
}

export function pruneThreadOrderByProject(
  threadOrderByProject: ThreadOrderByProject,
  threads: readonly ThreadOrderingInput[],
): ThreadOrderByProject {
  const validThreadIdsByProject = new Map<ProjectId, Set<ThreadId>>();
  for (const thread of threads) {
    const existing = validThreadIdsByProject.get(thread.projectId);
    if (existing) {
      existing.add(thread.id);
      continue;
    }
    validThreadIdsByProject.set(thread.projectId, new Set([thread.id]));
  }

  let changed = false;
  const nextThreadOrderByProject: ThreadOrderByProject = {};

  for (const [projectId, order] of Object.entries(threadOrderByProject)) {
    const validThreadIds = validThreadIdsByProject.get(projectId as ProjectId);
    if (!validThreadIds) {
      changed = true;
      continue;
    }

    const nextOrder: ThreadId[] = [];
    const seen = new Set<ThreadId>();
    for (const threadId of order) {
      if (!validThreadIds.has(threadId) || seen.has(threadId)) {
        changed = true;
        continue;
      }
      nextOrder.push(threadId);
      seen.add(threadId);
    }

    if (nextOrder.length > 0) {
      nextThreadOrderByProject[projectId] = nextOrder;
    }

    if (nextOrder.length !== order.length) {
      changed = true;
    }
  }

  return changed ? nextThreadOrderByProject : threadOrderByProject;
}

export function hydrateThreadOrderByProjectFromPersistence(
  projects: readonly Project[],
  persistedThreadOrderByProjectCwd: PersistedThreadOrderByProjectCwd,
): ThreadOrderByProject {
  const nextThreadOrderByProject: ThreadOrderByProject = {};

  for (const project of projects) {
    const persistedOrder = persistedThreadOrderByProjectCwd.get(project.cwd);
    if (!persistedOrder || persistedOrder.length === 0) continue;

    const uniqueThreadIds: ThreadId[] = [];
    const seen = new Set<ThreadId>();
    for (const rawThreadId of persistedOrder) {
      if (typeof rawThreadId !== "string" || rawThreadId.length === 0) continue;
      const threadId = rawThreadId as ThreadId;
      if (seen.has(threadId)) continue;
      seen.add(threadId);
      uniqueThreadIds.push(threadId);
    }

    if (uniqueThreadIds.length > 0) {
      nextThreadOrderByProject[project.id] = uniqueThreadIds;
    }
  }

  return nextThreadOrderByProject;
}
