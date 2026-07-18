import { describe, expect, it } from "vitest";

import {
  CLAUDE_CODE_PROXY_VERSION,
  resolveClaudeCodeProxyReleaseArtifact,
} from "./claude-code-proxy-release";

describe("Claude Code proxy release", () => {
  it("pins the integrated proxy version", () => {
    expect(CLAUDE_CODE_PROXY_VERSION).toBe("0.1.21");
  });

  it.each([
    ["mac", "arm64", "claude-code-proxy-darwin-arm64.tar.gz"],
    ["mac", "x64", "claude-code-proxy-darwin-amd64.tar.gz"],
    ["linux", "arm64", "claude-code-proxy-linux-arm64.tar.gz"],
    ["linux", "x64", "claude-code-proxy-linux-amd64.tar.gz"],
    ["win", "arm64", "claude-code-proxy-windows-arm64.zip"],
    ["win", "x64", "claude-code-proxy-windows-amd64.zip"],
  ] as const)("maps %s/%s to a checksummed release asset", (platform, arch, archiveName) => {
    const artifact = resolveClaudeCodeProxyReleaseArtifact(platform, arch);

    expect(artifact.archiveName).toBe(archiveName);
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.binaryName).toBe(
      platform === "win" ? "claude-code-proxy.exe" : "claude-code-proxy",
    );
  });
});
