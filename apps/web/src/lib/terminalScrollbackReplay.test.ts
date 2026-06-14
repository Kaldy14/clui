import { describe, expect, it } from "vitest";

import { resolveScrollbackReplay } from "./terminalScrollbackReplay";

describe("resolveScrollbackReplay", () => {
  it("keeps full replay for reset responses", () => {
    expect(
      resolveScrollbackReplay({
        scrollback: "abcdef",
        resultOffset: 6,
        reset: true,
        sinceOffset: 3,
        lastServerOffset: 4,
      }),
    ).toEqual({ scrollback: "abcdef", nextLastServerOffset: 6 });
  });

  it("keeps full replay when no sinceOffset was requested despite cached offset", () => {
    expect(
      resolveScrollbackReplay({
        scrollback: "abcdef",
        resultOffset: 6,
        reset: false,
        sinceOffset: undefined,
        lastServerOffset: 4,
      }),
    ).toEqual({ scrollback: "abcdef", nextLastServerOffset: 6 });
  });

  it("does not replay stale reset responses or move offsets backwards", () => {
    expect(
      resolveScrollbackReplay({
        scrollback: "abcdef",
        resultOffset: 6,
        reset: true,
        sinceOffset: 2,
        lastServerOffset: 8,
      }),
    ).toEqual({ scrollback: "", nextLastServerOffset: 8 });
  });

  it("does not replay stale deltas or move offsets backwards", () => {
    expect(
      resolveScrollbackReplay({
        scrollback: "cdef",
        resultOffset: 6,
        reset: false,
        sinceOffset: 2,
        lastServerOffset: 8,
      }),
    ).toEqual({ scrollback: "", nextLastServerOffset: 8 });
  });

  it("trims text already received as live output", () => {
    expect(
      resolveScrollbackReplay({
        scrollback: "abcdef",
        resultOffset: 6,
        reset: false,
        sinceOffset: 0,
        lastServerOffset: 3,
      }),
    ).toEqual({ scrollback: "def", nextLastServerOffset: 6 });
  });

  it("keeps a delta when no overlap exists", () => {
    expect(
      resolveScrollbackReplay({
        scrollback: "def",
        resultOffset: 6,
        reset: false,
        sinceOffset: 0,
        lastServerOffset: 2,
      }),
    ).toEqual({ scrollback: "def", nextLastServerOffset: 6 });
  });
});
