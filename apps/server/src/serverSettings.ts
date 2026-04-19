import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import { Schema } from "effect";
import { ServerSettings } from "@clui/contracts";

const SERVER_SETTINGS_FILE_NAME = "server-settings.json";
const DEFAULT_SERVER_SETTINGS = ServerSettings.makeUnsafe({});
const decodeServerSettingsJson = Schema.decodeSync(Schema.fromJsonString(ServerSettings));
const decodeServerSettings = Schema.decodeSync(ServerSettings);

export function getServerSettingsPath(stateDir: string): string {
  return path.join(stateDir, SERVER_SETTINGS_FILE_NAME);
}

export async function loadServerSettings(stateDir: string): Promise<ServerSettings> {
  try {
    const raw = await readFile(getServerSettingsPath(stateDir), "utf8");
    return decodeServerSettingsJson(raw);
  } catch {
    return DEFAULT_SERVER_SETTINGS;
  }
}

export async function saveServerSettings(
  stateDir: string,
  patch: Partial<ServerSettings>,
): Promise<ServerSettings> {
  const next = decodeServerSettings({
    ...(await loadServerSettings(stateDir)),
    ...patch,
  });
  const settingsPath = getServerSettingsPath(stateDir);
  const tempPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;

  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(tempPath, settingsPath);

  return next;
}
