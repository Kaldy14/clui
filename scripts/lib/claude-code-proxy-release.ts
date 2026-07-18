import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CLAUDE_CODE_PROXY_VERSION = "0.1.21";

type ProxyPlatform = "mac" | "linux" | "win";
type ProxyArch = "arm64" | "x64";

interface ReleaseArtifact {
  readonly archiveName: string;
  readonly sha256: string;
  readonly binaryName: "claude-code-proxy" | "claude-code-proxy.exe";
}

const RELEASE_ARTIFACTS: Record<`${ProxyPlatform}-${ProxyArch}`, ReleaseArtifact> = {
  "mac-x64": {
    archiveName: "claude-code-proxy-darwin-amd64.tar.gz",
    sha256: "1b4a1259dc74da299ee2cd72832f7b18cd5b82dc056cb19cd21fd940ebd6bf1c",
    binaryName: "claude-code-proxy",
  },
  "mac-arm64": {
    archiveName: "claude-code-proxy-darwin-arm64.tar.gz",
    sha256: "12c340342f0dcd476a29041272eb65476c5d73054f00c9bba1ca9300020cf267",
    binaryName: "claude-code-proxy",
  },
  "linux-x64": {
    archiveName: "claude-code-proxy-linux-amd64.tar.gz",
    sha256: "f27f01aeec673f33a1f8690137e4f736d96e66f23f7578f778083585bf486fe1",
    binaryName: "claude-code-proxy",
  },
  "linux-arm64": {
    archiveName: "claude-code-proxy-linux-arm64.tar.gz",
    sha256: "18b15eccca713eafb07f2016f4b4ec939684b8ff92aa69a37200d0afb828a59c",
    binaryName: "claude-code-proxy",
  },
  "win-x64": {
    archiveName: "claude-code-proxy-windows-amd64.zip",
    sha256: "99f5dce0bc84043241aa20b7c4c870e71f55ee0a424156f2385de1e06c62ebbe",
    binaryName: "claude-code-proxy.exe",
  },
  "win-arm64": {
    archiveName: "claude-code-proxy-windows-arm64.zip",
    sha256: "ed3a3cb2dd9a390f70eaba944a6d4f481f73572fe26e58a0a104ad816b23f191",
    binaryName: "claude-code-proxy.exe",
  },
};

export function resolveClaudeCodeProxyReleaseArtifact(
  platform: ProxyPlatform,
  arch: ProxyArch,
): ReleaseArtifact {
  return RELEASE_ARTIFACTS[`${platform}-${arch}`];
}

export async function stageClaudeCodeProxy(input: {
  readonly platform: ProxyPlatform;
  readonly arch: ProxyArch;
  readonly destinationDir: string;
}): Promise<string> {
  const artifact = resolveClaudeCodeProxyReleaseArtifact(input.platform, input.arch);
  const releaseUrl =
    `https://github.com/raine/claude-code-proxy/releases/download/` +
    `v${CLAUDE_CODE_PROXY_VERSION}/${artifact.archiveName}`;
  const response = await fetch(releaseUrl);
  if (!response.ok) {
    throw new Error(`Proxy download failed (${response.status} ${response.statusText}).`);
  }

  const archiveBytes = Buffer.from(await response.arrayBuffer());
  const actualSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  if (actualSha256 !== artifact.sha256) {
    throw new Error(
      `Proxy checksum mismatch for ${artifact.archiveName}: expected ${artifact.sha256}, got ${actualSha256}.`,
    );
  }

  const temporaryDir = await mkdtemp(join(tmpdir(), "clui-claude-code-proxy-"));
  try {
    const archivePath = join(temporaryDir, artifact.archiveName);
    const extractedDir = join(temporaryDir, "extracted");
    await mkdir(extractedDir, { recursive: true });
    await writeFile(archivePath, archiveBytes);

    const extraction = spawnSync("tar", ["-xf", archivePath, "-C", extractedDir], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (extraction.status !== 0) {
      throw new Error(
        extraction.stderr.trim() || `Could not extract ${artifact.archiveName} with tar.`,
      );
    }

    const extractedBinary = join(extractedDir, artifact.binaryName);
    await stat(extractedBinary);
    // Release staging can copy a host-development binary into the target
    // resources first. Replace the directory so cross-platform builds never
    // ship a second binary for the build host.
    await rm(input.destinationDir, { recursive: true, force: true });
    await mkdir(input.destinationDir, { recursive: true });
    const destinationPath = join(input.destinationDir, artifact.binaryName);
    await copyFile(extractedBinary, destinationPath);
    if (input.platform !== "win") {
      await chmod(destinationPath, 0o755);
    }
    return destinationPath;
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

export function detectHostProxyTarget(): { platform: ProxyPlatform; arch: ProxyArch } {
  const platform =
    process.platform === "darwin"
      ? "mac"
      : process.platform === "linux"
        ? "linux"
        : process.platform === "win32"
          ? "win"
          : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!platform || !arch) {
    throw new Error(`Unsupported proxy host target: ${process.platform}/${process.arch}.`);
  }
  return { platform, arch };
}
