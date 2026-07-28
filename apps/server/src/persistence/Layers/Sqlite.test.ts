import { describe, expect, it } from "vitest";

import { shouldCompactDatabase } from "./Sqlite";

describe("shouldCompactDatabase", () => {
  it("compacts a large database dominated by free pages", () => {
    expect(
      shouldCompactDatabase({
        pageCount: 160_000,
        freePageCount: 155_000,
        pageSize: 4_096,
      }),
    ).toBe(true);
  });

  it("does not compact small or normally utilized databases", () => {
    expect(
      shouldCompactDatabase({
        pageCount: 10_000,
        freePageCount: 9_000,
        pageSize: 4_096,
      }),
    ).toBe(false);
    expect(
      shouldCompactDatabase({
        pageCount: 160_000,
        freePageCount: 40_000,
        pageSize: 4_096,
      }),
    ).toBe(false);
  });
});
