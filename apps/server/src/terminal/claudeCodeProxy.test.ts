import { describe, expect, it } from "vitest";

import { findClaudeCodeProxyAuthorizationUrl } from "./claudeCodeProxy";

describe("Claude Code proxy authentication", () => {
  it("extracts the HTTPS authorization URL printed by the proxy", () => {
    expect(
      findClaudeCodeProxyAuthorizationUrl(
        "Open this URL in your browser to authorize:\n\n  https://auth.openai.com/oauth/authorize?state=abc&code_challenge=xyz\n",
      ),
    ).toBe("https://auth.openai.com/oauth/authorize?state=abc&code_challenge=xyz");
  });

  it("does not accept non-HTTPS output as an authorization URL", () => {
    expect(
      findClaudeCodeProxyAuthorizationUrl(
        "Open http://127.0.0.1:1455/auth/callback or file:///tmp/token",
      ),
    ).toBeNull();
  });

  it("ignores ordinary command output", () => {
    expect(findClaudeCodeProxyAuthorizationUrl("Not authenticated")).toBeNull();
  });
});
