import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CLAUDE_CODE_BACKEND, DEFAULT_CLAUDE_CODE_PROXY_MODEL } from "@clui/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { getServerSettingsPath, loadServerSettings, saveServerSettings } from "./serverSettings";

const temporaryDirectories: string[] = [];

async function makeStateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clui-server-settings-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("server settings", () => {
  it("decodes proxy defaults from historical settings files", async () => {
    const stateDirectory = await makeStateDirectory();
    await writeFile(
      getServerSettingsPath(stateDirectory),
      JSON.stringify({ titleGenerationProvider: "codex" }),
      "utf8",
    );

    const settings = await loadServerSettings(stateDirectory);

    expect(settings.defaultClaudeCodeBackend).toBe(DEFAULT_CLAUDE_CODE_BACKEND);
    expect(settings.defaultClaudeCodeProxyModel).toBe(DEFAULT_CLAUDE_CODE_PROXY_MODEL);
  });

  it("persists the default Claude Code backend and Codex model", async () => {
    const stateDirectory = await makeStateDirectory();

    const saved = await saveServerSettings(stateDirectory, {
      defaultClaudeCodeBackend: "codex",
      defaultClaudeCodeProxyModel: "gpt-5.6-terra",
    });
    const reloaded = await loadServerSettings(stateDirectory);

    expect(saved).toMatchObject({
      defaultClaudeCodeBackend: "codex",
      defaultClaudeCodeProxyModel: "gpt-5.6-terra",
    });
    expect(reloaded).toEqual(saved);
  });
});
