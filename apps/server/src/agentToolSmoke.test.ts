import { describe, expect, it } from "vitest";

const normalizeLabels = (labels: Array<string>) =>
  labels.map((label) => label.trim()).filter((label) => label.length > 0);

describe("agent tool smoke test", () => {
  it("normalizes labels by trimming blanks", () => {
    expect(normalizeLabels([" alpha ", "", " beta", "   "])).toEqual(["alpha", "beta"]);
  });
});
