import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readSessionProcessRegistryEntries,
  writeSessionProcessRegistryEntry,
} from "./sessionProcessRegistry";

describe("sessionProcessRegistry", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists and reads OMP processes", () => {
    const registryDir = mkdtempSync(path.join(tmpdir(), "clui-omp-process-registry-"));
    tempDirs.push(registryDir);

    writeSessionProcessRegistryEntry(registryDir, {
      harness: "omp",
      threadId: "thread-1",
      pid: 1234,
    });

    expect(readSessionProcessRegistryEntries(registryDir)).toEqual([
      expect.objectContaining({
        harness: "omp",
        threadId: "thread-1",
        pid: 1234,
        ownerPid: process.pid,
      }),
    ]);
  });
});
