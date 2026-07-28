import { describe, expect, it } from "vitest";

import { isUserInputToolName, normalizeToolName } from "./userInputTools";

describe("userInputTools", () => {
  it("normalizes tool-name punctuation consistently", () => {
    expect(normalizeToolName("Ask_User-Question")).toBe("askuserquestion");
  });

  it("recognizes every supported user-input tool alias", () => {
    expect(isUserInputToolName("questionnaire")).toBe(true);
    expect(isUserInputToolName("plan_review")).toBe(true);
    expect(isUserInputToolName("AskUserQuestion")).toBe(true);
    expect(isUserInputToolName("bash")).toBe(false);
  });
});
