import { assert, describe, it } from "@effect/vitest";
import { expect } from "vitest";

// @ts-expect-error The production helper is JavaScript so electron-builder can load it directly.
import { notarizeMacosApp } from "./notarize-macos-app.mjs";

interface RecordedCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly captureOutput: boolean;
}

function createHarness(options?: {
  readonly statuses?: ReadonlyArray<string>;
  readonly infoFailures?: number;
  readonly stapleFailures?: number;
  readonly processingTimeoutMs?: number;
}) {
  const calls: RecordedCall[] = [];
  const waits: number[] = [];
  const removedDirectories: string[] = [];
  const statuses = options?.statuses ?? ["Accepted"];
  let statusIndex = 0;
  let remainingInfoFailures = options?.infoFailures ?? 0;
  let remainingStapleFailures = options?.stapleFailures ?? 0;

  const execute = (command: string, args: ReadonlyArray<string>, captureOutput = false) => {
    calls.push({ command, args, captureOutput });

    if (command === "xcrun" && args[0] === "notarytool" && args[1] === "submit") {
      return JSON.stringify({ id: "submission-123" });
    }
    if (command === "xcrun" && args[0] === "notarytool" && args[1] === "info") {
      if (remainingInfoFailures > 0) {
        remainingInfoFailures -= 1;
        throw new Error("Notary Service unavailable");
      }
      const status = statuses[Math.min(statusIndex, statuses.length - 1)] ?? "Accepted";
      statusIndex += 1;
      return JSON.stringify({ status });
    }
    if (command === "xcrun" && args[0] === "stapler" && remainingStapleFailures > 0) {
      remainingStapleFailures -= 1;
      throw new Error("stapler unavailable");
    }

    return "";
  };

  const run = () =>
    notarizeMacosApp({
      appPath: "/tmp/Clui.app",
      environment: {
        APPLE_API_KEY_PATH: "/tmp/AuthKey_TEST.p8",
        APPLE_API_KEY_ID: "TEST",
        APPLE_API_ISSUER: "issuer",
      },
      execute,
      wait: async (milliseconds: number) => {
        waits.push(milliseconds);
      },
      now: () => 100,
      exists: () => true,
      makeTemporaryDirectory: () => "/tmp/clui-notarize-test",
      removeTemporaryDirectory: (path: string) => {
        removedDirectories.push(path);
      },
      output: { write: () => true },
      errorOutput: { write: () => true },
      processingTimeoutMs: options?.processingTimeoutMs,
    });

  return { calls, removedDirectories, run, waits };
}

describe("notarize-macos-app", () => {
  it("submits, polls, staples, and cleans up an accepted app", async () => {
    const harness = createHarness({ statuses: ["In Progress", "Accepted"] });

    await harness.run();

    assert.ok(
      harness.calls.some(
        ({ command, args }) =>
          command === "codesign" && args.join(" ").includes("--verify --deep --strict"),
      ),
    );
    assert.ok(
      harness.calls.some(
        ({ command, args }) =>
          command === "xcrun" &&
          args[0] === "notarytool" &&
          args[1] === "submit" &&
          args.includes("--no-wait"),
      ),
    );
    assert.ok(
      harness.calls.some(({ command, args }) => command === "xcrun" && args[0] === "stapler"),
    );
    assert.deepStrictEqual(harness.waits, [30_000]);
    assert.deepStrictEqual(harness.removedDirectories, ["/tmp/clui-notarize-test"]);
  });

  it("retries transient notarization status failures", async () => {
    const harness = createHarness({ infoFailures: 1 });

    await harness.run();

    const infoCalls = harness.calls.filter(
      ({ command, args }) => command === "xcrun" && args[0] === "notarytool" && args[1] === "info",
    );
    assert.equal(infoCalls.length, 2);
    assert.deepStrictEqual(harness.waits, [30_000]);
  });

  it("prints the Apple log and cleans up when notarization is rejected", async () => {
    const harness = createHarness({ statuses: ["Rejected"] });

    await expect(harness.run()).rejects.toThrow(
      "Apple rejected notarization submission submission-123",
    );

    assert.ok(
      harness.calls.some(
        ({ command, args }) => command === "xcrun" && args[0] === "notarytool" && args[1] === "log",
      ),
    );
    assert.deepStrictEqual(harness.removedDirectories, ["/tmp/clui-notarize-test"]);
  });

  it("times out a submission that remains in progress", async () => {
    const harness = createHarness({ statuses: ["In Progress"], processingTimeoutMs: 0 });

    await expect(harness.run()).rejects.toThrow("still In Progress after 0 minutes");

    assert.deepStrictEqual(harness.waits, []);
    assert.deepStrictEqual(harness.removedDirectories, ["/tmp/clui-notarize-test"]);
  });

  it("retries stapling up to four attempts", async () => {
    const harness = createHarness({ stapleFailures: 3 });

    await harness.run();

    const stapleCalls = harness.calls.filter(
      ({ command, args }) => command === "xcrun" && args[0] === "stapler",
    );
    assert.equal(stapleCalls.length, 4);
    assert.deepStrictEqual(harness.waits, [5_000, 5_000, 5_000]);
  });

  it("fails before invoking tools when a required credential is missing", async () => {
    let executeCalled = false;

    await expect(
      notarizeMacosApp({
        appPath: "/tmp/Clui.app",
        environment: {},
        execute: () => {
          executeCalled = true;
          return "";
        },
      }),
    ).rejects.toThrow("APPLE_API_KEY_PATH is required");

    assert.equal(executeCalled, false);
  });
});
