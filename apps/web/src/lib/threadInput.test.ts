import { describe, expect, it } from "vitest";

import {
  PI_TUI_NEWLINE_SEQUENCE,
  PI_TUI_SUBMIT_SEQUENCE,
  promptSubmitDataForHarness,
} from "./threadInput";

describe("promptSubmitDataForHarness", () => {
  it("uses carriage return for Claude Code submissions", () => {
    expect(promptSubmitDataForHarness("claudeCode", "fix bug\n")).toBe("fix bug\r");
  });

  it("uses CSI-u Enter for pi submissions", () => {
    expect(promptSubmitDataForHarness("pi", "fix bug\n")).toBe(`fix bug${PI_TUI_SUBMIT_SEQUENCE}`);
  });

  it("uses CSI-u Shift+Enter for pi prompt newlines", () => {
    expect(promptSubmitDataForHarness("pi", "line one\nline two\n")).toBe(
      `line one${PI_TUI_NEWLINE_SEQUENCE}line two${PI_TUI_SUBMIT_SEQUENCE}`,
    );
  });
});
