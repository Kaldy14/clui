import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CLUI_SESSION_PROCESS_REGISTRY_DIR_ENV = "CLUI_SESSION_PROCESS_REGISTRY_DIR";
export const CLUI_SESSION_PROCESS_REGISTRY_OWNER_PID_ENV =
  "CLUI_SESSION_PROCESS_REGISTRY_OWNER_PID";
const SESSION_PROCESS_REGISTRY_DIR_NAME = "session-processes";

export type SessionProcessHarness = "claudeCode" | "codexCli" | "pi";

export interface SessionProcessRegistryEntry {
  readonly harness: SessionProcessHarness;
  readonly threadId: string;
  readonly pid: number;
  readonly ownerPid: number;
  readonly updatedAt: string;
}

export function getSessionProcessRegistryDir(stateDir: string): string {
  return path.join(stateDir, SESSION_PROCESS_REGISTRY_DIR_NAME);
}

function entryFileName(harness: SessionProcessHarness, threadId: string): string {
  return `${harness}-${Buffer.from(threadId).toString("base64url")}.json`;
}

function entryPath(registryDir: string, harness: SessionProcessHarness, threadId: string): string {
  return path.join(registryDir, entryFileName(harness, threadId));
}

export function writeSessionProcessRegistryEntry(
  registryDir: string,
  input: Omit<SessionProcessRegistryEntry, "ownerPid" | "updatedAt">,
): void {
  if (!Number.isSafeInteger(input.pid) || input.pid <= 0) return;
  mkdirSync(registryDir, { recursive: true });
  const entry: SessionProcessRegistryEntry = {
    ...input,
    ownerPid: process.pid,
    updatedAt: new Date().toISOString(),
  };
  const targetPath = entryPath(registryDir, input.harness, input.threadId);
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(entry)}\n`, "utf8");
  renameSync(tempPath, targetPath);
}

export function removeSessionProcessRegistryEntry(
  registryDir: string,
  harness: SessionProcessHarness,
  threadId: string,
): void {
  rmSync(entryPath(registryDir, harness, threadId), { force: true });
}

export function readSessionProcessRegistryEntries(
  registryDir: string,
): SessionProcessRegistryEntry[] {
  let files: string[];
  try {
    files = readdirSync(registryDir, { encoding: "utf8" });
  } catch {
    return [];
  }

  const entries: SessionProcessRegistryEntry[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(
        readFileSync(path.join(registryDir, file), "utf8"),
      ) as Partial<SessionProcessRegistryEntry>;
      if (
        (parsed.harness === "claudeCode" ||
          parsed.harness === "codexCli" ||
          parsed.harness === "pi") &&
        typeof parsed.threadId === "string" &&
        typeof parsed.pid === "number" &&
        Number.isSafeInteger(parsed.pid) &&
        parsed.pid > 0 &&
        typeof parsed.ownerPid === "number" &&
        Number.isSafeInteger(parsed.ownerPid) &&
        parsed.ownerPid > 0 &&
        typeof parsed.updatedAt === "string"
      ) {
        entries.push({
          harness: parsed.harness,
          threadId: parsed.threadId,
          pid: parsed.pid,
          ownerPid: parsed.ownerPid,
          updatedAt: parsed.updatedAt,
        });
      }
    } catch {
      // Ignore malformed or concurrently replaced files.
    }
  }
  return entries;
}
