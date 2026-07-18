import {
  CheckpointRef,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@clui/contracts";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { checkpointRefForThreadTurn } from "../Utils.ts";
import { CheckpointDiffQueryLive } from "./CheckpointDiffQuery.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { CheckpointDiffQuery } from "../Services/CheckpointDiffQuery.ts";

function makeSnapshot(input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    projects: [
      {
        id: input.projectId,
        title: "Project",
        workspaceRoot: input.workspaceRoot,
        defaultModel: null,
        scripts: [],
        prompts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        hiddenAt: null,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: input.threadId,
        projectId: input.projectId,
        title: "Thread",
        model: "gpt-5-codex",
        harness: "claudeCode",
        claudeCodeBackend: "anthropic",
        piRenderMode: "terminal",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: input.worktreePath,
        claudeSessionId: null,
        piSessionFile: null,
        terminalStatus: "new",
        scrollbackSnapshot: null,
        titleSource: "auto" as const,
        bookmarked: false,
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:00.000Z",
          assistantMessageId: null,
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastInteractedAt: "2026-01-01T00:00:00.000Z",
        archivedAt: null,
        deletedAt: null,
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [
          {
            turnId: TurnId.makeUnsafe("turn-1"),
            checkpointTurnCount: input.checkpointTurnCount,
            checkpointRef: input.checkpointRef,
            status: "ready",
            files: [],
            assistantMessageId: null,
            completedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        session: null,
      },
    ],
  };
}

function makeCheckpointStore(overrides: Partial<CheckpointStoreShape> = {}): CheckpointStoreShape {
  return {
    isGitRepository: () => Effect.succeed(true),
    captureCheckpoint: () => Effect.void,
    hasCheckpointRef: () => Effect.succeed(true),
    restoreCheckpoint: () => Effect.succeed(true),
    diffCheckpoints: () => Effect.succeed(""),
    deleteCheckpointRefs: () => Effect.void,
    ...overrides,
  };
}

function makeLayer(snapshot: OrchestrationReadModel, checkpointStore: CheckpointStoreShape) {
  return CheckpointDiffQueryLive.pipe(
    Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery, {
        getSnapshot: () => Effect.succeed(snapshot),
        getSessionMetrics: () => Effect.die("not implemented"),
      }),
    ),
  );
}

function git(cwd: string, args: readonly string[]) {
  execFileSync("git", [...args], { cwd, stdio: "ignore" });
}

describe("CheckpointDiffQueryLive", () => {
  it("computes diffs using canonical turn-0 checkpoint refs", async () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    const hasCheckpointRefCalls: Array<CheckpointRef> = [];
    const diffCheckpointsCalls: Array<{
      readonly fromCheckpointRef: CheckpointRef;
      readonly toCheckpointRef: CheckpointRef;
      readonly cwd: string;
    }> = [];

    const snapshot = makeSnapshot({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      worktreePath: null,
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
    });

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      hasCheckpointRef: ({ checkpointRef }) =>
        Effect.sync(() => {
          hasCheckpointRefCalls.push(checkpointRef);
          return true;
        }),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: ({ fromCheckpointRef, toCheckpointRef, cwd }) =>
        Effect.sync(() => {
          diffCheckpointsCalls.push({ fromCheckpointRef, toCheckpointRef, cwd });
          return "diff patch";
        }),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getSnapshot: () => Effect.succeed(snapshot),
          getSessionMetrics: () => Effect.die("not implemented"),
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
        });
      }).pipe(Effect.provide(layer)),
    );

    const expectedFromRef = checkpointRefForThreadTurn(threadId, 0);
    expect(hasCheckpointRefCalls).toEqual([expectedFromRef, toCheckpointRef]);
    expect(diffCheckpointsCalls).toEqual([
      {
        cwd: "/tmp/workspace",
        fromCheckpointRef: expectedFromRef,
        toCheckpointRef,
      },
    ]);
    expect(result).toEqual({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 1,
      diff: "diff patch",
    });
  });

  it("includes untracked files in working tree diffs", async () => {
    const projectId = ProjectId.makeUnsafe("project-working-tree");
    const threadId = ThreadId.makeUnsafe("thread-working-tree");
    const cwd = await mkdtemp(join(tmpdir(), "clui-working-tree-diff-"));

    try {
      git(cwd, ["init"]);
      await writeFile(join(cwd, "tracked.txt"), "before\n");
      git(cwd, ["add", "tracked.txt"]);
      git(cwd, [
        "-c",
        "user.name=Clui Test",
        "-c",
        "user.email=clui@example.invalid",
        "commit",
        "-m",
        "initial",
      ]);

      await writeFile(join(cwd, "tracked.txt"), "after\n");
      await mkdir(join(cwd, "new-dir"));
      await writeFile(join(cwd, "new-dir", "created.txt"), "created\n");

      const snapshot = makeSnapshot({
        projectId,
        threadId,
        workspaceRoot: "/tmp/unused-project-root",
        worktreePath: cwd,
        checkpointTurnCount: 1,
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
      });
      const layer = makeLayer(snapshot, makeCheckpointStore());

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const query = yield* CheckpointDiffQuery;
          return yield* query.getWorkingTreeDiff({ threadId });
        }).pipe(Effect.provide(layer)),
      );

      expect(result.threadId).toBe(threadId);
      expect(result.diff).toContain("diff --git a/tracked.txt b/tracked.txt");
      expect(result.diff).toContain("-before");
      expect(result.diff).toContain("+after");
      expect(result.diff).toContain("diff --git a/new-dir/created.txt b/new-dir/created.txt");
      expect(result.diff).toContain("new file mode");
      expect(result.diff).toContain("+created");
    } finally {
      await rm(cwd, { force: true, recursive: true });
    }
  });

  it("fails when the thread is missing from the snapshot", async () => {
    const threadId = ThreadId.makeUnsafe("thread-missing");

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed(""),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 0,
              projects: [],
              threads: [],
              updatedAt: "2026-01-01T00:00:00.000Z",
            } satisfies OrchestrationReadModel),
          getSessionMetrics: () => Effect.die("not implemented"),
        }),
      ),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const query = yield* CheckpointDiffQuery;
          return yield* query.getTurnDiff({
            threadId,
            fromTurnCount: 0,
            toTurnCount: 1,
          });
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow("Thread 'thread-missing' not found.");
  });
});
