import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProjectId, ThreadId } from "@clui/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { CheckpointDiffQuery } from "../checkpointing/Services/CheckpointDiffQuery.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { DiffReviewLive } from "./Layers/DiffReview.ts";
import { DiffReview } from "./Services/DiffReview.ts";

async function withFakePi<T>(output: string, run: () => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clui-diff-review-pi-"));
  const binDir = path.join(tempDir, "bin");
  const piPath = path.join(binDir, "pi");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    piPath,
    [
      "#!/bin/sh",
      "cat >/dev/null",
      'node -e \'process.stdout.write(Buffer.from(process.env.CLUI_FAKE_PI_OUTPUT_B64 || "", "base64").toString("utf8"))\'',
      "",
    ].join("\n"),
  );
  await chmod(piPath, 0o755);

  const previousPath = process.env.PATH;
  const previousOutput = process.env.CLUI_FAKE_PI_OUTPUT_B64;
  process.env.PATH = `${binDir}:${previousPath ?? ""}`;
  process.env.CLUI_FAKE_PI_OUTPUT_B64 = Buffer.from(output, "utf8").toString("base64");

  try {
    return await run();
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousOutput === undefined) {
      delete process.env.CLUI_FAKE_PI_OUTPUT_B64;
    } else {
      process.env.CLUI_FAKE_PI_OUTPUT_B64 = previousOutput;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe("DiffReview", () => {
  it("falls back to deterministic review ranking when pi returns invalid structured output", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "clui-diff-review-cwd-"));
    const threadId = "thread-diff-review" as ThreadId;
    const projectId = "project-diff-review" as ProjectId;
    const diff = [
      "diff --git a/apps/server/src/auth/session.ts b/apps/server/src/auth/session.ts",
      "index 1111111..2222222 100644",
      "--- a/apps/server/src/auth/session.ts",
      "+++ b/apps/server/src/auth/session.ts",
      "@@ -10,2 +10,3 @@",
      "-old token",
      "+new token permission",
      "+audit migration",
    ].join("\n");

    const layer = DiffReviewLive.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getSnapshot: () =>
            Effect.succeed({
              projects: [{ id: projectId, workspaceRoot: cwd }],
              threads: [{ id: threadId, projectId, worktreePath: null }],
            } as never),
          getSessionMetrics: () => Effect.die("unused"),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(CheckpointDiffQuery, {
          getTurnDiff: () =>
            Effect.succeed({
              threadId,
              fromTurnCount: 0,
              toTurnCount: 1,
              diff,
            }),
          getFullThreadDiff: () => Effect.die("unused"),
          getWorkingTreeDiff: () => Effect.die("unused"),
        }),
      ),
    );

    try {
      const result = await withFakePi(
        JSON.stringify({ overview: "missing required nested fields", keyChanges: [{}] }),
        () =>
          Effect.runPromise(
            Effect.gen(function* () {
              const diffReview = yield* DiffReview;
              return yield* diffReview.generateDiffReview({
                threadId,
                scope: { type: "turn", fromTurnCount: 0, toTurnCount: 1 },
              });
            }).pipe(Effect.provide(layer)),
          ),
      );

      expect(result.overview).toContain("Pi output could not be decoded");
      expect(result.keyChanges[0]?.filePath).toBe("apps/server/src/auth/session.ts");
      expect(result.keyChanges[0]?.significance).toBe("high");
      expect(result.keyChanges[0]?.anchors[0]?.hunkHeader).toBe("@@ -10,2 +10,3 @@");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
