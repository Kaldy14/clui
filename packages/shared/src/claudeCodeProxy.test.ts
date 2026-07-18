import { describe, expect, it } from "vitest";

import {
  CLAUDE_CODE_PROXY_MODEL_OPTIONS,
  isClaudeCodeProxyModel,
  resolveClaudeCodeProxyModel,
} from "./claudeCodeProxy";

describe("Claude Code proxy models", () => {
  it("exposes every supported GPT-5.6 model", () => {
    expect(CLAUDE_CODE_PROXY_MODEL_OPTIONS.map((option) => option.value)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
  });

  it("recognizes supported model slugs", () => {
    expect(isClaudeCodeProxyModel("gpt-5.6-sol")).toBe(true);
    expect(isClaudeCodeProxyModel("claude-opus-4-6")).toBe(false);
  });

  it("normalizes proxy suffixes and defaults unsupported models", () => {
    expect(resolveClaudeCodeProxyModel(" gpt-5.6-terra[1m] ")).toBe("gpt-5.6-terra");
    expect(resolveClaudeCodeProxyModel("claude-opus-4-6")).toBe("gpt-5.6-sol");
  });
});
