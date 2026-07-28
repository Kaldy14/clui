import {
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
  type OrchestrationGetWorkingTreeDiffResult,
} from "@clui/contracts";
import { Effect, Layer, Schema } from "effect";

import { normalizeGitPathArgument, runGitProcess } from "../../gitProcess.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CheckpointInvariantError, CheckpointUnavailableError } from "../Errors.ts";
import {
  CheckpointDiffQuery,
  type CheckpointDiffQueryShape,
} from "../Services/CheckpointDiffQuery.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { checkpointRefForThreadTurn, resolveThreadWorkspaceCwd } from "../Utils.ts";

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult);
const WORKING_TREE_DIFF_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const GET_WORKING_TREE_DIFF_OPERATION = "CheckpointDiffQuery.getWorkingTreeDiff";

function runGitForWorkingTreeDiff(cwd: string, args: readonly string[]) {
  return Effect.tryPromise({
    try: (signal) =>
      runGitProcess({
        cwd,
        args,
        maxBufferBytes: WORKING_TREE_DIFF_MAX_BUFFER_BYTES,
        signal,
      }).then((result) => {
        if (result.code !== 0 && result.stdout.length === 0) {
          throw new Error(result.stderr || `git exited with code ${result.code}`);
        }
        return result.stdout;
      }),
    catch: (error) =>
      new CheckpointInvariantError({
        operation: GET_WORKING_TREE_DIFF_OPERATION,
        detail: error instanceof Error ? error.message : String(error),
      }),
  });
}

const normalizeDiffPart = (part: string) => part.trimEnd();

const combineDiffParts = (parts: readonly string[]) => {
  const diff = parts
    .map(normalizeDiffPart)
    .filter((part) => part.length > 0)
    .join("\n");
  return diff.length > 0 ? `${diff}\n` : "";
};

const makeUntrackedFileDiff = (cwd: string, filePath: string) =>
  runGitForWorkingTreeDiff(cwd, [
    "diff",
    "--no-index",
    "--patch",
    "--minimal",
    "--no-color",
    "--",
    "/dev/null",
    normalizeGitPathArgument(filePath),
  ]);

const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const checkpointStore = yield* CheckpointStore;

  const getTurnDiff: CheckpointDiffQueryShape["getTurnDiff"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointDiffQuery.getTurnDiff";

      if (input.fromTurnCount === input.toTurnCount) {
        const emptyDiff: OrchestrationGetTurnDiffResultType = {
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          diff: "",
        };
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointInvariantError({
            operation,
            detail: "Computed turn diff result does not satisfy contract schema.",
          });
        }
        return emptyDiff;
      }

      const snapshot = yield* projectionSnapshotQuery.getSnapshot();
      const thread = snapshot.threads.find((entry) => entry.id === input.threadId);
      if (!thread) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Thread '${input.threadId}' not found.`,
        });
      }

      const maxTurnCount = thread.checkpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
        0,
      );
      if (input.toTurnCount > maxTurnCount) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Turn diff range exceeds current turn count: requested ${input.toTurnCount}, current ${maxTurnCount}.`,
        });
      }

      const workspaceCwd = resolveThreadWorkspaceCwd({
        thread,
        projects: snapshot.projects,
      });
      if (!workspaceCwd) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Workspace path missing for thread '${input.threadId}' when computing turn diff.`,
        });
      }

      const fromCheckpointRef =
        input.fromTurnCount === 0
          ? checkpointRefForThreadTurn(input.threadId, 0)
          : thread.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === input.fromTurnCount,
            )?.checkpointRef;
      if (!fromCheckpointRef) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          detail: `Checkpoint ref is unavailable for turn ${input.fromTurnCount}.`,
        });
      }

      const toCheckpointRef = thread.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === input.toTurnCount,
      )?.checkpointRef;
      if (!toCheckpointRef) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Checkpoint ref is unavailable for turn ${input.toTurnCount}.`,
        });
      }

      const [fromExists, toExists] = yield* Effect.all(
        [
          checkpointStore.hasCheckpointRef({
            cwd: workspaceCwd,
            checkpointRef: fromCheckpointRef,
          }),
          checkpointStore.hasCheckpointRef({
            cwd: workspaceCwd,
            checkpointRef: toCheckpointRef,
          }),
        ],
        { concurrency: "unbounded" },
      );

      if (!fromExists) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          detail: `Filesystem checkpoint is unavailable for turn ${input.fromTurnCount}.`,
        });
      }

      if (!toExists) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Filesystem checkpoint is unavailable for turn ${input.toTurnCount}.`,
        });
      }

      const diff = yield* checkpointStore.diffCheckpoints({
        cwd: workspaceCwd,
        fromCheckpointRef,
        toCheckpointRef,
        fallbackFromToHead: false,
      });

      const turnDiff: OrchestrationGetTurnDiffResultType = {
        threadId: input.threadId,
        fromTurnCount: input.fromTurnCount,
        toTurnCount: input.toTurnCount,
        diff,
      };
      if (!isTurnDiffResult(turnDiff)) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: "Computed turn diff result does not satisfy contract schema.",
        });
      }

      return turnDiff;
    });

  const getFullThreadDiff: CheckpointDiffQueryShape["getFullThreadDiff"] = (
    input: OrchestrationGetFullThreadDiffInput,
  ) =>
    getTurnDiff({
      threadId: input.threadId,
      fromTurnCount: 0,
      toTurnCount: input.toTurnCount,
    }).pipe(Effect.map((result): OrchestrationGetFullThreadDiffResult => result));

  const getWorkingTreeDiff: CheckpointDiffQueryShape["getWorkingTreeDiff"] = (input) =>
    Effect.gen(function* () {
      const snapshot = yield* projectionSnapshotQuery.getSnapshot();
      const thread = snapshot.threads.find((entry) => entry.id === input.threadId);
      if (!thread) {
        return yield* new CheckpointInvariantError({
          operation: GET_WORKING_TREE_DIFF_OPERATION,
          detail: `Thread '${input.threadId}' not found.`,
        });
      }

      const workspaceCwd = resolveThreadWorkspaceCwd({
        thread,
        projects: snapshot.projects,
      });
      if (!workspaceCwd) {
        return yield* new CheckpointInvariantError({
          operation: GET_WORKING_TREE_DIFF_OPERATION,
          detail: `Workspace path missing for thread '${input.threadId}'.`,
        });
      }

      const isGit = yield* checkpointStore.isGitRepository(workspaceCwd);
      if (!isGit) {
        const result: OrchestrationGetWorkingTreeDiffResult = {
          threadId: input.threadId,
          diff: "",
        };
        return result;
      }

      const trackedDiff = yield* runGitForWorkingTreeDiff(workspaceCwd, [
        "diff",
        "HEAD",
        "--patch",
        "--minimal",
        "--no-color",
      ]);
      const untrackedFilesOutput = yield* runGitForWorkingTreeDiff(workspaceCwd, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ]);
      const untrackedFiles = untrackedFilesOutput
        .split("\0")
        .filter((filePath) => filePath.length > 0);
      const untrackedDiffs = yield* Effect.forEach(
        untrackedFiles,
        (filePath) => makeUntrackedFileDiff(workspaceCwd, filePath),
        { concurrency: 4 },
      );
      const diff = combineDiffParts([trackedDiff, ...untrackedDiffs]);

      const result: OrchestrationGetWorkingTreeDiffResult = {
        threadId: input.threadId,
        diff,
      };
      return result;
    });

  return {
    getTurnDiff,
    getFullThreadDiff,
    getWorkingTreeDiff,
  } satisfies CheckpointDiffQueryShape;
});

export const CheckpointDiffQueryLive = Layer.effect(CheckpointDiffQuery, make);
