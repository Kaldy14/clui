import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readNewThreadFastModePreference,
  readNewThreadPiRenderModePreference,
  readNewThreadPreference,
  writeNewThreadFastModePreference,
  writeNewThreadPiRenderModePreference,
  writeNewThreadPreference,
  type NewThreadPreference,
} from "./newThreadPreferences";

const STORAGE_KEY = "clui:new-thread-preferences:v1";

function createMockStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

describe("newThreadPreferences", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: createMockStorage(),
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  });

  it("returns null when no preference is stored", () => {
    expect(readNewThreadPreference("/repo")).toBeNull();
  });

  it("round-trips a local branch preference", () => {
    const preference: NewThreadPreference = {
      envMode: "local",
      branch: "main",
      fastMode: false,
      piRenderMode: "terminal",
    };
    writeNewThreadPreference("/repo", preference);
    expect(readNewThreadPreference("/repo")).toEqual(preference);
  });

  it("round-trips a worktree branch preference", () => {
    const preference: NewThreadPreference = {
      envMode: "worktree",
      branch: "origin/main",
      fastMode: false,
      piRenderMode: "terminal",
    };
    writeNewThreadPreference("/repo", preference);
    expect(readNewThreadPreference("/repo")).toEqual(preference);
  });

  it("keeps preferences isolated per project cwd", () => {
    writeNewThreadPreference("/repo-a", { envMode: "local", branch: "main", fastMode: false });
    writeNewThreadPreference("/repo-b", {
      envMode: "worktree",
      branch: "origin/main",
      fastMode: false,
    });
    expect(readNewThreadPreference("/repo-a")).toEqual({
      envMode: "local",
      branch: "main",
      fastMode: false,
      piRenderMode: "terminal",
    });
    expect(readNewThreadPreference("/repo-b")).toEqual({
      envMode: "worktree",
      branch: "origin/main",
      fastMode: false,
      piRenderMode: "terminal",
    });
  });

  it("preserves fast mode and pi render mode when updating branch/env without them", () => {
    writeNewThreadPreference("/repo", {
      envMode: "local",
      branch: "main",
      fastMode: true,
      piRenderMode: "html",
    });
    writeNewThreadPreference("/repo", { envMode: "worktree", branch: "origin/main" });
    expect(readNewThreadPreference("/repo")).toEqual({
      envMode: "worktree",
      branch: "origin/main",
      fastMode: true,
      piRenderMode: "html",
    });
  });

  it("writes fast mode independently and preserves branch/env/render mode", () => {
    writeNewThreadPreference("/repo", {
      envMode: "local",
      branch: "main",
      fastMode: false,
      piRenderMode: "html",
    });
    writeNewThreadFastModePreference("/repo", true);
    expect(readNewThreadFastModePreference("/repo")).toBe(true);
    expect(readNewThreadPreference("/repo")).toEqual({
      envMode: "local",
      branch: "main",
      fastMode: true,
      piRenderMode: "html",
    });
  });

  it("writes pi render mode independently and preserves branch/env/fast mode", () => {
    writeNewThreadPreference("/repo", { envMode: "local", branch: "main", fastMode: true });
    writeNewThreadPiRenderModePreference("/repo", "html");
    expect(readNewThreadPiRenderModePreference("/repo")).toBe("html");
    expect(readNewThreadPreference("/repo")).toEqual({
      envMode: "local",
      branch: "main",
      fastMode: true,
      piRenderMode: "html",
    });
  });

  it("does not read fast mode preference when nothing is stored", () => {
    expect(readNewThreadFastModePreference("/repo")).toBeNull();
  });

  it("does not read pi render mode preference when nothing is stored", () => {
    expect(readNewThreadPiRenderModePreference("/repo")).toBeNull();
  });

  it("ignores invalid envMode values", () => {
    globalThis.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ "/repo": { envMode: "remote", branch: "main" } }),
    );
    expect(readNewThreadPreference("/repo")).toBeNull();
  });

  it("ignores empty or missing branch values", () => {
    globalThis.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ "/repo": { envMode: "local", branch: "" } }),
    );
    expect(readNewThreadPreference("/repo")).toBeNull();
  });

  it("trims branch and project cwd values", () => {
    writeNewThreadPreference(" /repo ", { envMode: "local", branch: " main " });
    expect(readNewThreadPreference("/repo")).toEqual({
      envMode: "local",
      branch: "main",
      fastMode: false,
      piRenderMode: "terminal",
    });
  });

  it("round-trips fast mode", () => {
    writeNewThreadPreference("/repo", { envMode: "local", branch: "main", fastMode: true });
    expect(readNewThreadPreference("/repo")).toEqual({
      envMode: "local",
      branch: "main",
      fastMode: true,
      piRenderMode: "terminal",
    });
  });

  it("round-trips pi render mode", () => {
    writeNewThreadPreference("/repo", { envMode: "local", branch: "main", piRenderMode: "html" });
    expect(readNewThreadPreference("/repo")).toEqual({
      envMode: "local",
      branch: "main",
      fastMode: false,
      piRenderMode: "html",
    });
  });

  it("writes fast mode before a branch is selected", () => {
    writeNewThreadFastModePreference("/repo", true);
    expect(readNewThreadFastModePreference("/repo")).toBe(true);
    expect(readNewThreadPreference("/repo")).toBeNull();
  });

  it("writes pi render mode before a branch is selected", () => {
    writeNewThreadPiRenderModePreference("/repo", "html");
    expect(readNewThreadPiRenderModePreference("/repo")).toBe("html");
    expect(readNewThreadPreference("/repo")).toBeNull();
  });

  it("does not write preferences with an empty branch", () => {
    writeNewThreadPreference("/repo", { envMode: "local", branch: "" });
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("does not write preferences with an empty project cwd", () => {
    writeNewThreadPreference("", { envMode: "local", branch: "main" });
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
