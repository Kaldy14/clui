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
  readonly runId?: string;
  readonly nodeId?: string;
  readonly attempt?: number;
  readonly resumableIdentity?: string;
  readonly pid: number;
  readonly ownerPid: number;
  readonly updatedAt: string;
}

export function getSessionProcessRegistryDir(stateDir: string): string {
  return path.join(stateDir, SESSION_PROCESS_REGISTRY_DIR_NAME);
}

export interface JourneySessionProcessIdentity {
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
}

function entryFileName(
  harness: SessionProcessHarness,
  threadId: string,
  journey?: JourneySessionProcessIdentity,
): string {
  const identity = journey
    ? `${threadId}\0${journey.runId}\0${journey.nodeId}\0${journey.attempt}`
    : threadId;
  return `${harness}-${Buffer.from(identity).toString("base64url")}.json`;
}

function entryPath(
  registryDir: string,
  harness: SessionProcessHarness,
  threadId: string,
  journey?: JourneySessionProcessIdentity,
): string {
  return path.join(registryDir, entryFileName(harness, threadId, journey));
}

export function writeSessionProcessRegistryEntry(
  registryDir: string,
  input: Omit<SessionProcessRegistryEntry, "ownerPid" | "updatedAt">,
): void {
  if (!Number.isSafeInteger(input.pid) || input.pid <= 0) return;
  const hasJourneyIdentity =
    input.runId !== undefined || input.nodeId !== undefined || input.attempt !== undefined;
  if (
    hasJourneyIdentity &&
    (!input.runId || !input.nodeId || !Number.isSafeInteger(input.attempt) || input.attempt! <= 0)
  ) {
    throw new Error(
      "Journey process registry entries require runId, nodeId, and positive attempt.",
    );
  }
  const journey = hasJourneyIdentity
    ? { runId: input.runId!, nodeId: input.nodeId!, attempt: input.attempt! }
    : undefined;
  mkdirSync(registryDir, { recursive: true });
  const entry: SessionProcessRegistryEntry = {
    ...input,
    ownerPid: process.pid,
    updatedAt: new Date().toISOString(),
  };
  const targetPath = entryPath(registryDir, input.harness, input.threadId, journey);
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(entry)}\n`, "utf8");
  renameSync(tempPath, targetPath);
}

export function removeSessionProcessRegistryEntry(
  registryDir: string,
  harness: SessionProcessHarness,
  threadId: string,
  journey?: JourneySessionProcessIdentity,
): void {
  rmSync(entryPath(registryDir, harness, threadId, journey), { force: true });
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
        typeof parsed.updatedAt === "string" &&
        ((parsed.runId === undefined &&
          parsed.nodeId === undefined &&
          parsed.attempt === undefined) ||
          (typeof parsed.runId === "string" &&
            parsed.runId.length > 0 &&
            typeof parsed.nodeId === "string" &&
            parsed.nodeId.length > 0 &&
            typeof parsed.attempt === "number" &&
            Number.isSafeInteger(parsed.attempt) &&
            parsed.attempt > 0)) &&
        (parsed.resumableIdentity === undefined || typeof parsed.resumableIdentity === "string")
      ) {
        entries.push({
          harness: parsed.harness,
          threadId: parsed.threadId,
          ...(parsed.runId === undefined
            ? {}
            : { runId: parsed.runId, nodeId: parsed.nodeId!, attempt: parsed.attempt! }),
          ...(parsed.resumableIdentity === undefined
            ? {}
            : { resumableIdentity: parsed.resumableIdentity }),
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
