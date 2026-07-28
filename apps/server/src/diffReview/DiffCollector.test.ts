import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildDiffReviewPromptContext,
  collectBranchDiff,
  collectLocalDiff,
  rankDiffReviewFiles,
} from "./DiffCollector.ts";

const repos: string[] = [];

function git(cwd: string, args: ReadonlyArray<string>, allowNonZero = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Clui Test",
          GIT_AUTHOR_EMAIL: "clui@example.test",
          GIT_COMMITTER_NAME: "Clui Test",
          GIT_COMMITTER_EMAIL: "clui@example.test",
        },
      },
      (error, stdout, stderr) => {
        if (error && !allowNonZero) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "clui-diff-collector-"));
  repos.push(repo);
  await git(repo, ["init"]);
  await git(repo, ["checkout", "-b", "main"]);
  await git(repo, ["config", "user.name", "Clui Test"]);
  await git(repo, ["config", "user.email", "clui@example.test"]);
  await writeFile(path.join(repo, "README.md"), "base\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

async function commitFile(
  repo: string,
  filePath: string,
  contents: string,
  message: string,
): Promise<void> {
  const absolutePath = path.join(repo, filePath);
  await writeFile(absolutePath, contents);
  await git(repo, ["add", filePath]);
  await git(repo, ["commit", "-m", message]);
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => rm(repo, { recursive: true, force: true })));
});

describe("DiffCollector", () => {
  it("collects a feature branch diff against main", async () => {
    const repo = await makeRepo();
    await git(repo, ["checkout", "-b", "feature/review-map"]);
    await commitFile(repo, "feature.txt", "feature change\n", "feature change");

    const result = await Effect.runPromise(collectBranchDiff(repo));

    expect(result.defaultBranchSafety).toBe(false);
    expect(result.baseBranch).toBe("main");
    expect(result.headBranch).toBe("feature/review-map");
    expect(result.diffPatch).toContain("feature.txt");
    expect(result.diffPatch).toContain("feature change");
  });

  it("falls back to local changes only on main", async () => {
    const repo = await makeRepo();
    await writeFile(path.join(repo, "README.md"), "main local edit\n");

    const result = await Effect.runPromise(collectBranchDiff(repo));

    expect(result.defaultBranchSafety).toBe(true);
    expect(result.sourceLabel).toBe("Local changes on main");
    expect(result.diffPatch).toContain("main local edit");
  });

  it("uses main as base when a feature branch has no upstream", async () => {
    const repo = await makeRepo();
    await git(repo, ["checkout", "-b", "feature/no-upstream"]);
    await commitFile(repo, "no-upstream.txt", "branch-only\n", "branch without upstream");

    const result = await Effect.runPromise(collectBranchDiff(repo));

    expect(result.defaultBranchSafety).toBe(false);
    expect(result.baseBranch).toBe("main");
    expect(result.diffPatch).toContain("no-upstream.txt");
    expect(result.diffPatch).toContain("branch-only");
  });

  it("honors configured branch gh-merge-base", async () => {
    const repo = await makeRepo();
    await git(repo, ["checkout", "-b", "release"]);
    await commitFile(repo, "release-only.txt", "release base\n", "release base");
    await git(repo, ["checkout", "-b", "feature/from-release"]);
    await git(repo, ["config", "branch.feature/from-release.gh-merge-base", "release"]);
    await commitFile(repo, "feature-only.txt", "feature from release\n", "feature from release");

    const result = await Effect.runPromise(collectBranchDiff(repo));

    expect(result.defaultBranchSafety).toBe(false);
    expect(result.baseBranch).toBe("release");
    expect(result.diffPatch).toContain("feature-only.txt");
    expect(result.diffPatch).not.toContain("release-only.txt");
  });

  it("includes staged, unstaged, and untracked local changes", async () => {
    const repo = await makeRepo();
    await git(repo, ["checkout", "-b", "feature/local-work"]);
    await commitFile(repo, "committed.txt", "committed change\n", "committed change");

    await writeFile(path.join(repo, "staged.txt"), "staged content\n");
    await git(repo, ["add", "staged.txt"]);
    await writeFile(path.join(repo, "README.md"), "unstaged content\n");
    await writeFile(path.join(repo, "untracked.txt"), "untracked content\n");

    const result = await Effect.runPromise(collectBranchDiff(repo));

    expect(result.defaultBranchSafety).toBe(false);
    expect(result.diffPatch).toContain("committed.txt");
    expect(result.diffPatch).toContain("staged content");
    expect(result.diffPatch).toContain("unstaged content");
    expect(result.diffPatch).toContain("untracked content");
  });

  it("collects an untracked file named dash without waiting for stdin", async () => {
    const repo = await makeRepo();
    await writeFile(path.join(repo, "-"), "dash file\n");

    const result = await Effect.runPromise(collectLocalDiff(repo));

    expect(result.patch).toContain("diff --git a/./- b/./-");
    expect(result.patch).toContain("+dash file");
  });

  it("summarizes low-signal files when prompt context cannot include every chunk", () => {
    const diff = Array.from({ length: 8 }, (_, index) => {
      const filePath = index === 0 ? "apps/server/src/auth/session.ts" : `docs/file-${index}.md`;
      return [
        `diff --git a/${filePath} b/${filePath}`,
        "index 1111111..2222222 100644",
        `--- a/${filePath}`,
        `+++ b/${filePath}`,
        "@@ -1 +1 @@",
        `-old ${index}`,
        `+new ${index} token permission migration`,
      ].join("\n");
    }).join("\n");

    const promptContext = buildDiffReviewPromptContext(diff, 3_200);

    expect(promptContext.totalFileCount).toBe(8);
    expect(promptContext.coveredFileCount).toBeLessThan(8);
    expect(promptContext.summarizedFileCount).toBeGreaterThan(0);
    expect(promptContext.promptDiff).toContain("Summarized low-signal files");
  });

  it("returns deterministic file priorities for fallback review maps", () => {
    const diff = [
      "diff --git a/docs/readme.md b/docs/readme.md",
      "index 1111111..2222222 100644",
      "--- a/docs/readme.md",
      "+++ b/docs/readme.md",
      "@@ -1 +1 @@",
      "-old docs",
      "+new docs",
      "diff --git a/apps/server/src/auth/session.ts b/apps/server/src/auth/session.ts",
      "index 3333333..4444444 100644",
      "--- a/apps/server/src/auth/session.ts",
      "+++ b/apps/server/src/auth/session.ts",
      "@@ -10,2 +10,3 @@",
      "-old token",
      "+new token permission",
      "+audit migration",
    ].join("\n");

    const priorities = rankDiffReviewFiles(diff);

    expect(priorities[0]?.filePath).toBe("apps/server/src/auth/session.ts");
    expect(priorities[0]?.riskScore).toBeGreaterThan(priorities[1]?.riskScore ?? 0);
    expect(priorities[0]?.hunkHeaders).toContain("@@ -10,2 +10,3 @@");
  });
});
