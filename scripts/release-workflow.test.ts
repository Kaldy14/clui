import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseWorkflow = readFileSync(resolve(repoRoot, ".github/workflows/release.yml"), "utf8");

describe("desktop release workflow", () => {
  it("builds Windows artifacts on a native Windows runner", () => {
    expect(releaseWorkflow).toMatch(
      /- label: Windows x64\s+runner: windows-2022\s+platform: win\s+target: nsis\s+arch: x64/u,
    );
    expect(releaseWorkflow).not.toContain("Install Wine for Windows packaging");
  });
});
