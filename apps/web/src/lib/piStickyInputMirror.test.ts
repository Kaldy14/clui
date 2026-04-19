import { describe, expect, it } from "vitest";

import { extractPiStickyInputMirrorFromLines } from "./piStickyInputMirror";

describe("extractPiStickyInputMirrorFromLines", () => {
  it("extracts the bottom pi editor block bounded by horizontal rules", () => {
    const lines = [
      "Earlier output",
      "",
      "────────────────────────────────────────────────────────────",
      "Plan the sticky input experiment",
      "────────────────────────────────────────────────────────────",
      "~/IdeaProjects/clui  session-name  claude-sonnet",
    ];

    expect(extractPiStickyInputMirrorFromLines(lines, 60)).toEqual({
      lines: [
        "────────────────────────────────────────────────────────────",
        "Plan the sticky input experiment",
        "────────────────────────────────────────────────────────────",
      ],
    });
  });

  it("accepts editor borders that include scroll indicators", () => {
    const lines = [
      "",
      "─── ↑ 3 more ───────────────────────────────────────────────",
      "Draft line 1",
      "Draft line 2",
      "────────────────────────────────────────────────────────────",
    ];

    expect(extractPiStickyInputMirrorFromLines(lines, 60)).toEqual({
      lines: [
        "─── ↑ 3 more ───────────────────────────────────────────────",
        "Draft line 1",
        "Draft line 2",
        "────────────────────────────────────────────────────────────",
      ],
    });
  });

  it("returns null when no divider-bounded editor block exists", () => {
    const lines = ["normal output", "another line", "final output"];
    expect(extractPiStickyInputMirrorFromLines(lines, 60)).toBeNull();
  });
});
