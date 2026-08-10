import { describe, expect, it } from "vitest";

import {
  PI_TERMINAL_LINE_HEIGHT,
  TERMINAL_LINE_HEIGHT,
  terminalLineHeightForHarness,
} from "./terminalSurfaceTheme";

describe("terminalLineHeightForHarness", () => {
  it.each(["pi", "omp"] as const)("uses tighter spacing for %s terminals", (harness) => {
    expect(terminalLineHeightForHarness(harness)).toBe(PI_TERMINAL_LINE_HEIGHT);
    expect(PI_TERMINAL_LINE_HEIGHT).toBeLessThan(TERMINAL_LINE_HEIGHT);
  });

  it.each(["claudeCode", "codexCli"] as const)(
    "keeps the default spacing for %s terminals",
    (harness) => {
      expect(terminalLineHeightForHarness(harness)).toBe(TERMINAL_LINE_HEIGHT);
    },
  );
});
