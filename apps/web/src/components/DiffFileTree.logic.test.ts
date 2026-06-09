import type { FileDiffMetadata } from "@pierre/diffs/react";
import { FileTree } from "@pierre/trees";
import { describe, expect, it } from "vitest";

import { buildDiffTreeData } from "./DiffFileTree";

function makeFileDiff(name: string, type: FileDiffMetadata["type"] = "change"): FileDiffMetadata {
  return {
    additionLines: [],
    deletionLines: [],
    hunks: [],
    isPartial: false,
    name,
    splitLineCount: 0,
    type,
    unifiedLineCount: 0,
  };
}

describe("buildDiffTreeData", () => {
  it("builds FileTree-compatible prepared input for unsorted diff paths", () => {
    const treeData = buildDiffTreeData(
      [makeFileDiff("src/zeta.ts"), makeFileDiff("README.md"), makeFileDiff("src/alpha.ts")],
      (fileDiff) => fileDiff.name,
      () => ({ additions: 1, deletions: 0 }),
    );

    expect(() => {
      const tree = new FileTree({
        flattenEmptyDirectories: true,
        paths: treeData.paths,
        preparedInput: treeData.preparedInput,
      });
      tree.cleanUp();
    }).not.toThrow();
  });
});
