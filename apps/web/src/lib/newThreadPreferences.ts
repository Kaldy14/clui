const STORAGE_KEY = "clui:new-thread-preferences:v1";

export type NewThreadEnvMode = "local" | "worktree";

export interface NewThreadPreference {
  envMode: NewThreadEnvMode;
  branch: string;
  /** Persisted Fast mode default for new pi threads in this project. */
  fastMode: boolean;
}

export interface PartialNewThreadPreference {
  envMode?: NewThreadEnvMode;
  branch?: string;
  fastMode?: boolean;
}

function safeBranch(branch: string | null | undefined): string | null {
  const trimmed = branch?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function safeProjectCwd(projectCwd: string): string | null {
  const trimmed = projectCwd.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getStorage(): Storage | null {
  if (typeof localStorage !== "undefined") return localStorage;
  if (typeof window !== "undefined") return window.localStorage ?? null;
  return null;
}

function readRaw(): Record<string, PartialNewThreadPreference> {
  const storage = getStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, PartialNewThreadPreference>;
    }
  } catch {
    // fall through
  }
  return {};
}

function writeRaw(value: Record<string, PartialNewThreadPreference>): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Ignore storage errors.
  }
}

export function readNewThreadPreference(projectCwd: string): NewThreadPreference | null {
  const cwd = safeProjectCwd(projectCwd);
  if (!cwd) return null;
  const raw = readRaw()[cwd];
  const branch = safeBranch(raw?.branch);
  if (!raw || (raw.envMode !== "local" && raw.envMode !== "worktree") || !branch) {
    return null;
  }
  return { envMode: raw.envMode, branch, fastMode: raw.fastMode === true };
}

export function writeNewThreadPreference(
  projectCwd: string,
  preference: PartialNewThreadPreference,
): void {
  const cwd = safeProjectCwd(projectCwd);
  if (!cwd) return;

  const existing = readRaw()[cwd];
  const nextEnvMode = preference.envMode ?? existing?.envMode;
  const branch = preference.branch !== undefined
    ? safeBranch(preference.branch)
    : safeBranch(existing?.branch);
  if (!branch || (nextEnvMode !== "local" && nextEnvMode !== "worktree")) return;

  const all = readRaw();
  all[cwd] = {
    envMode: nextEnvMode,
    branch,
    fastMode: preference.fastMode ?? existing?.fastMode ?? false,
  };
  writeRaw(all);
}

export function writeNewThreadFastModePreference(
  projectCwd: string,
  fastMode: boolean,
): void {
  const cwd = safeProjectCwd(projectCwd);
  if (!cwd) return;

  const existing = readRaw()[cwd];
  const envMode =
    existing?.envMode === "local" || existing?.envMode === "worktree"
      ? existing.envMode
      : "local";
  const all = readRaw();
  all[cwd] = {
    envMode,
    branch: safeBranch(existing?.branch) ?? "",
    fastMode,
  };
  writeRaw(all);
}

export function readNewThreadFastModePreference(projectCwd: string): boolean | null {
  const cwd = safeProjectCwd(projectCwd);
  if (!cwd) return null;
  const existing = readRaw()[cwd];
  if (!existing) return null;
  if (existing.fastMode === true) return true;
  if (existing.fastMode === false) return false;
  return null;
}
