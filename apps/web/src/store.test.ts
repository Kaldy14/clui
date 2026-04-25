import {
  DEFAULT_MODEL_BY_PROVIDER,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@clui/contracts";
import { describe, expect, it } from "vitest";

import {
  markThreadUnread,
  reorderProjects,
  setThreadArchived,
  syncServerReadModel,
  setTerminalStatus,
  setTerminalLifecycle,
  setThreadHookStatus,
  type AppState,
} from "./store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    model: "gpt-5-codex",
    harness: "claudeCode",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    lastInteractedAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    terminalStatus: "new",
    claudeSessionId: null,
    piSessionFile: null,
    scrollbackSnapshot: null,
    titleSource: "auto" as const,
    bookmarked: false,
    hookStatus: null,
    dormantReason: null,
    ...overrides,
  };
}

function makeState(thread: Thread): AppState {
  return {
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        name: "Project",
        cwd: "/tmp/project",
        model: "gpt-5-codex",
        expanded: true,
        scripts: [],
      },
    ],
    threads: [thread],
    threadsHydrated: true,
    projectOrder: [],
    threadOrderByProject: {},
  };
}

function makeReadModelThread(overrides: Partial<OrchestrationReadModel["threads"][number]>) {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    model: "gpt-5.3-codex",
    harness: "claudeCode",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    claudeSessionId: null,
    piSessionFile: null,
    terminalStatus: "new",
    scrollbackSnapshot: null,
    titleSource: "auto" as const,
    bookmarked: false,
    latestTurn: null,
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    lastInteractedAt: "2026-02-27T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    session: null,
    ...overrides,
  } satisfies OrchestrationReadModel["threads"][number];
}

function makeReadModel(thread: OrchestrationReadModel["threads"][number]): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-02-27T00:00:00.000Z",
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModel: "gpt-5.3-codex",
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        hiddenAt: null,
        deletedAt: null,
        scripts: [],
        prompts: [],
      },
    ],
    threads: [thread],
  };
}

function makeReadModelProject(
  overrides: Partial<OrchestrationReadModel["projects"][number]>,
): OrchestrationReadModel["projects"][number] {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    title: "Project",
    workspaceRoot: "/tmp/project",
    defaultModel: "gpt-5.3-codex",
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    hiddenAt: null,
    deletedAt: null,
    scripts: [],
    prompts: [],
    ...overrides,
  };
}

describe("store pure functions", () => {
  it("markThreadUnread moves lastVisitedAt before completion for a completed thread", () => {
    const latestTurnCompletedAt = "2026-02-25T12:30:00.000Z";
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-02-25T12:28:00.000Z",
          startedAt: "2026-02-25T12:28:30.000Z",
          completedAt: latestTurnCompletedAt,
          assistantMessageId: null,
        },
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    const updatedThread = next.threads[0];
    expect(updatedThread).toBeDefined();
    expect(updatedThread?.lastVisitedAt).toBe("2026-02-25T12:29:59.999Z");
    expect(Date.parse(updatedThread?.lastVisitedAt ?? "")).toBeLessThan(
      Date.parse(latestTurnCompletedAt),
    );
  });

  it("markThreadUnread uses the terminal completion marker for pi threads without completed turns", () => {
    const lastCompletedAt = "2026-02-25T12:30:00.000Z";
    const initialState = makeState(
      makeThread({
        harness: "pi",
        latestTurn: null,
        lastCompletedAt,
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    const updatedThread = next.threads[0];
    expect(updatedThread?.lastVisitedAt).toBe("2026-02-25T12:29:59.999Z");
    expect(Date.parse(updatedThread?.lastVisitedAt ?? "")).toBeLessThan(
      Date.parse(lastCompletedAt),
    );
  });

  it("markThreadUnread does not change a thread without any completion marker", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: null,
        lastCompletedAt: undefined,
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    expect(next).toEqual(initialState);
  });

  it("setThreadHookStatus records a completion marker when terminal hooks complete", () => {
    const completedAt = "2026-02-25T12:30:00.000Z";
    const initialState = makeState(
      makeThread({
        harness: "pi",
        hookStatus: "working",
        lastCompletedAt: undefined,
      }),
    );

    const next = setThreadHookStatus(
      initialState,
      ThreadId.makeUnsafe("thread-1"),
      "completed",
      completedAt,
    );

    expect(next.threads[0]?.hookStatus).toBe("completed");
    expect(next.threads[0]?.lastCompletedAt).toBe(completedAt);
  });

  it("reorderProjects moves a project to a target index", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const state: AppState = {
      projects: [
        {
          id: project1,
          name: "Project 1",
          cwd: "/tmp/project-1",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          expanded: true,
          scripts: [],
        },
        {
          id: project2,
          name: "Project 2",
          cwd: "/tmp/project-2",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          expanded: true,
          scripts: [],
        },
        {
          id: project3,
          name: "Project 3",
          cwd: "/tmp/project-3",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          expanded: true,
          scripts: [],
        },
      ],
      projectOrder: [],
      threadOrderByProject: {},
      threads: [],
      threadsHydrated: true,
    };

    const next = reorderProjects(state, project1, project3);

    expect(next.projects.map((project) => project.id)).toEqual([project2, project3, project1]);
  });
});

describe("store read model sync", () => {
  it("preserves claude model slugs without an active session", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        model: "claude-opus-4-6",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.model).toBe("claude-opus-4-6");
  });

  it("falls back to the codex default for unknown models without an active session", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        model: "unknown-model-xyz",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.model).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("resolves claude aliases when session provider is claudeCode", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        model: "sonnet",
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeCode",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.model).toBe("claude-sonnet-4-6");
  });

  it("resolves cursor aliases when session provider is cursor", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        model: "composer",
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "cursor",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.model).toBe("composer-1.5");
    expect(next.threads[0]?.session?.provider).toBe("cursor");
  });

  it("preserves the current project order when syncing incoming read model updates", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const initialState: AppState = {
      projects: [
        {
          id: project2,
          name: "Project 2",
          cwd: "/tmp/project-2",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          expanded: true,
          scripts: [],
        },
        {
          id: project1,
          name: "Project 1",
          cwd: "/tmp/project-1",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          expanded: true,
          scripts: [],
        },
      ],
      projectOrder: [],
      threadOrderByProject: {},
      threads: [],
      threadsHydrated: true,
    };
    const readModel: OrchestrationReadModel = {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:00:00.000Z",
      projects: [
        makeReadModelProject({
          id: project1,
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
        }),
        makeReadModelProject({
          id: project2,
          title: "Project 2",
          workspaceRoot: "/tmp/project-2",
        }),
        makeReadModelProject({
          id: project3,
          title: "Project 3",
          workspaceRoot: "/tmp/project-3",
        }),
      ],
      threads: [],
    };

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects.map((project) => project.id)).toEqual([project2, project1, project3]);
  });

  it("filters hidden projects and their threads out of the synced store", () => {
    const thread = makeReadModelThread({});
    const readModel = {
      ...makeReadModel(thread),
      projects: [makeReadModelProject({ hiddenAt: "2026-04-23T10:00:00.000Z" })],
    };

    const next = syncServerReadModel(
      {
        projects: [],
        threads: [],
        threadsHydrated: false,
        projectOrder: [],
        threadOrderByProject: {},
      },
      readModel,
    );

    expect(next.projects).toEqual([]);
    expect(next.threads).toEqual([]);
  });
});

describe("archivedAt", () => {
  it("syncServerReadModel preserves a pending local archivedAt update against a stale snapshot", () => {
    const initialState = makeState(makeThread({ archivedAt: null }));
    const threadId = initialState.threads[0]!.id;
    const optimisticState = setThreadArchived(
      initialState,
      threadId,
      "2026-04-19T10:00:00.000Z",
    );
    const staleReadModel = makeReadModel(makeReadModelThread({ archivedAt: null }));

    const next = syncServerReadModel(optimisticState, staleReadModel);

    expect(next.threads[0]?.archivedAt).toBe("2026-04-19T10:00:00.000Z");
  });

  it("syncServerReadModel accepts server archivedAt once the snapshot catches up", () => {
    const initialState = makeState(makeThread({ archivedAt: null }));
    const threadId = initialState.threads[0]!.id;
    const optimisticState = setThreadArchived(
      initialState,
      threadId,
      "2026-04-19T10:00:00.000Z",
    );
    const caughtUpReadModel = makeReadModel(
      makeReadModelThread({ archivedAt: "2026-04-19T10:00:00.000Z" }),
    );

    const next = syncServerReadModel(optimisticState, caughtUpReadModel);

    expect(next.threads[0]?.archivedAt).toBe("2026-04-19T10:00:00.000Z");
  });
});

describe("dormantReason", () => {
  it("syncServerReadModel preserves client dormantReason", () => {
    const initialState = makeState(makeThread({ dormantReason: "hibernated" }));
    const readModel = makeReadModel(makeReadModelThread({}));

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.dormantReason).toBe("hibernated");
  });

  it("syncServerReadModel defaults dormantReason to null for new threads", () => {
    const emptyState: AppState = {
      projects: [],
      threads: [],
      threadsHydrated: false,
      projectOrder: [],
      threadOrderByProject: {},
    };
    const readModel = makeReadModel(makeReadModelThread({}));

    const next = syncServerReadModel(emptyState, readModel);

    expect(next.threads[0]?.dormantReason).toBeNull();
  });

  it("setTerminalStatus clears dormantReason to null", () => {
    const initialState = makeState(
      makeThread({ dormantReason: "hibernated", terminalStatus: "dormant" }),
    );
    const threadId = initialState.threads[0]!.id;

    const next = setTerminalStatus(initialState, threadId, "active");

    expect(next.threads[0]?.dormantReason).toBeNull();
    expect(next.threads[0]?.terminalStatus).toBe("active");
  });

  it("setTerminalLifecycle sets dormantReason when provided", () => {
    const initialState = makeState(makeThread({ dormantReason: null, terminalStatus: "active" }));
    const threadId = initialState.threads[0]!.id;

    const next = setTerminalLifecycle(initialState, threadId, "dormant", null, "hibernated");

    expect(next.threads[0]?.dormantReason).toBe("hibernated");
    expect(next.threads[0]?.terminalStatus).toBe("dormant");
  });

  it("setTerminalLifecycle preserves dormantReason when param is undefined", () => {
    const initialState = makeState(
      makeThread({ dormantReason: "hibernated", terminalStatus: "dormant" }),
    );
    const threadId = initialState.threads[0]!.id;

    const next = setTerminalLifecycle(initialState, threadId, "dormant", null, undefined);

    expect(next.threads[0]?.dormantReason).toBe("hibernated");
  });

  it("setTerminalLifecycle can explicitly set dormantReason to null", () => {
    const initialState = makeState(
      makeThread({ dormantReason: "hibernated", terminalStatus: "dormant" }),
    );
    const threadId = initialState.threads[0]!.id;

    const next = setTerminalLifecycle(initialState, threadId, "active", null, null);

    expect(next.threads[0]?.dormantReason).toBeNull();
  });
});
