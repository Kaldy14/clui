import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { JourneyAttemptFence, JourneyCapability, JourneyRunRole } from "@clui/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { readSessionProcessRegistryEntries } from "../terminal/sessionProcessRegistry";

import {
  CLUI_JOURNEY_ATTEMPT_ENV,
  CLUI_JOURNEY_CAPABILITIES_ENV,
  CLUI_JOURNEY_NODE_ID_ENV,
  CLUI_JOURNEY_ROLE_ENV,
  CLUI_JOURNEY_RUN_ID_ENV,
  JourneyHarnessAdapter,
  JourneyHarnessOwnershipUncertainError,
  type JourneyHarnessLifecycleEvent,
  type JourneyHarnessOutputChunk,
  type JourneyHarnessProcess,
  type JourneyHarnessProcessCallbacks,
  type JourneyHarnessProcessFactory,
  type JourneyHarnessProfile,
  type JourneyHarnessValidatedResult,
} from "./journeyHarnessAdapter";

interface FakeLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

class FakeProcess implements JourneyHarnessProcess {
  readonly killedWith: NodeJS.Signals[] = [];

  constructor(
    readonly pid: number,
    private readonly callbacks: JourneyHarnessProcessCallbacks,
  ) {}

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.killedWith.push(signal);
  }

  output(data: string): void {
    this.callbacks.onOutput(data);
  }

  exit(exitCode: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.callbacks.onExit({ exitCode, signal });
  }

  error(message: string): void {
    this.callbacks.onError(new Error(message));
  }
}

class FakeProcessFactory implements JourneyHarnessProcessFactory {
  readonly launches: FakeLaunch[] = [];
  readonly processes: FakeProcess[] = [];

  async spawn(launch: FakeLaunch, callbacks: JourneyHarnessProcessCallbacks): Promise<FakeProcess> {
    this.launches.push(launch);
    const process = new FakeProcess(1_000 + this.processes.length, callbacks);
    this.processes.push(process);
    return process;
  }
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

function fence(runId: string, attempt = 1): JourneyAttemptFence {
  return {
    threadId: "thread-1" as JourneyAttemptFence["threadId"],
    runId,
    nodeId: `node-${runId}`,
    attempt,
  };
}

function profile(input?: {
  harness?: "pi" | "codexCli";
  role?: JourneyRunRole;
  capabilities?: ReadonlyArray<JourneyCapability>;
  runtimeRoot?: string;
  resumeIdentity?: string;
  codexConfigArgs?: ReadonlyArray<string>;
  trustedPiExtensionPaths?: ReadonlyArray<string>;
  trustedPiToolNames?: ReadonlyArray<string>;
}): JourneyHarnessProfile {
  const role = input?.role ?? "researchWorker";
  return {
    harness: input?.harness ?? "codexCli",
    role,
    capabilities:
      input?.capabilities ??
      (role === "implementationOwner"
        ? ["graph.read", "decision.request", "repository.write"]
        : ["graph.read", "research.read"]),
    executable: input?.harness === "pi" ? "/usr/local/bin/pi" : "/usr/local/bin/codex",
    ...(input?.runtimeRoot ? { runtimeRoot: input.runtimeRoot } : {}),
    ...(input?.resumeIdentity ? { resumeIdentity: input.resumeIdentity } : {}),
    ...(input?.codexConfigArgs ? { codexConfigArgs: input.codexConfigArgs } : {}),
    ...(input?.trustedPiExtensionPaths
      ? { trustedPiExtensionPaths: input.trustedPiExtensionPaths }
      : {}),
    ...(input?.trustedPiToolNames ? { trustedPiToolNames: input.trustedPiToolNames } : {}),
  };
}

function validResearchResult(): JourneyHarnessValidatedResult {
  return {
    kind: "research",
    summary: "Found the adapter boundary.",
    evidence: [{ source: "journeyHarnessAdapter.ts", finding: "Attempts use full fences." }],
    unresolved: [],
  };
}

function validImplementationResult(): JourneyHarnessValidatedResult {
  return {
    kind: "implementation",
    summary: "Implemented adapter.",
    changedFiles: ["journeyHarnessAdapter.ts"],
    verification: [{ command: "vitest", outcome: "passed", passed: true }],
    unresolved: [],
  };
}

function resultLine(result: JourneyHarnessValidatedResult): string {
  return `CLUI_JOURNEY_RESULT:${JSON.stringify(result)}\n`;
}

describe("JourneyHarnessAdapter", () => {
  it("keeps concurrent attempts under one thread isolated by their full fence", async () => {
    const factory = new FakeProcessFactory();
    const adapter = new JourneyHarnessAdapter(factory);

    await Promise.all([
      adapter.start({ fence: fence("run-a"), profile: profile(), prompt: "A", cwd: "/repo" }),
      adapter.start({ fence: fence("run-b"), profile: profile(), prompt: "B", cwd: "/repo" }),
    ]);

    expect(factory.processes).toHaveLength(2);
    expect(factory.processes[0]!.killedWith).toEqual([]);
    expect(adapter.inspect(fence("run-a"))?.pid).toBe(1_000);
    expect(adapter.inspect(fence("run-b"))?.pid).toBe(1_001);
    expect(factory.launches.every((launch) => !launch.args.includes("thread-1"))).toBe(true);
    expect(factory.launches[0]!.env).toMatchObject({
      CLUI_JOURNEY_THREAD_ID: "thread-1",
      [CLUI_JOURNEY_RUN_ID_ENV]: "run-a",
      [CLUI_JOURNEY_NODE_ID_ENV]: "node-run-a",
      [CLUI_JOURNEY_ATTEMPT_ENV]: "1",
      [CLUI_JOURNEY_ROLE_ENV]: "researchWorker",
      [CLUI_JOURNEY_CAPABILITIES_ENV]: JSON.stringify(["graph.read", "research.read"]),
    });
  });

  it("routes callbacks to the complete fence and ignores duplicate terminal callbacks", async () => {
    const factory = new FakeProcessFactory();
    const lifecycle: JourneyHarnessLifecycleEvent[] = [];
    const results: JourneyHarnessValidatedResult[] = [];
    const adapter = new JourneyHarnessAdapter(factory);
    const attemptFence = fence("run-a", 2);
    await adapter.start({
      fence: attemptFence,
      profile: profile(),
      prompt: "Inspect",
      cwd: "/repo",
      observer: {
        onLifecycle: (event) => lifecycle.push(event),
        onResult: ({ result }) => results.push(result),
      },
    });
    factory.processes[0]!.output(resultLine(validResearchResult()));
    factory.processes[0]!.exit(0);
    factory.processes[0]!.exit(0);
    factory.processes[0]!.error("late error");

    expect(results).toHaveLength(1);
    expect(lifecycle.map((event) => event.type)).toEqual(["started", "exited"]);
    expect(lifecycle.every((event) => event.fence === attemptFence)).toBe(false);
    expect(
      lifecycle.every((event) => event.fence.runId === "run-a" && event.fence.attempt === 2),
    ).toBe(true);
  });

  it("emits UTF-8 byte cursors monotonically and discovers resumable identity", async () => {
    const factory = new FakeProcessFactory();
    const chunks: JourneyHarnessOutputChunk[] = [];
    const adapter = new JourneyHarnessAdapter(factory);
    await adapter.start({
      fence: fence("run-a"),
      profile: profile(),
      prompt: "Inspect",
      cwd: "/repo",
      observer: { onOutput: (chunk) => chunks.push(chunk) },
    });
    factory.processes[0]!.output('{"thread_id":"codex-session-1"}\n');
    factory.processes[0]!.output("žlutý");

    expect(chunks.map(({ firstCursor, nextCursor }) => [firstCursor, nextCursor])).toEqual([
      [0, 32],
      [32, 39],
    ]);
    expect(adapter.inspect(fence("run-a"))?.resumableIdentity).toBe("codex-session-1");
  });

  it("supports idempotent inspect, start, and cancellation", async () => {
    const factory = new FakeProcessFactory();
    const adapter = new JourneyHarnessAdapter(factory);
    const attemptFence = fence("run-a");
    await adapter.start({
      fence: attemptFence,
      profile: profile(),
      prompt: "Inspect",
      cwd: "/repo",
    });
    await adapter.start({ fence: attemptFence, profile: profile(), prompt: "Again", cwd: "/repo" });
    expect(adapter.cancel(fence("run-a", 2))).toBeNull();
    expect(factory.processes[0]!.killedWith).toEqual([]);
    adapter.cancel(attemptFence);
    adapter.cancel(attemptFence);

    expect(factory.launches).toHaveLength(1);
    expect(factory.processes[0]!.killedWith).toEqual(["SIGTERM"]);
    expect(adapter.inspect(attemptFence)).toMatchObject({ state: "cancelling", pid: 1_000 });
    expect(adapter.inspect(fence("missing"))).toBeNull();
  });

  it("reports synchronous launch rejection only to the caller", async () => {
    const factory = new FakeProcessFactory();
    const lifecycle: JourneyHarnessLifecycleEvent[] = [];
    const adapter = new JourneyHarnessAdapter(factory);
    const attemptFence = fence("launch-rejected");

    await expect(
      adapter.start({
        fence: attemptFence,
        profile: profile({
          codexConfigArgs: ["-c", 'approval_policy="on-request"'],
        }),
        prompt: "Inspect",
        cwd: "/repo",
        observer: { onLifecycle: (event) => lifecycle.push(event) },
      }),
    ).rejects.toThrow("cannot override sandbox or approval config");

    expect(lifecycle).toEqual([]);
    expect(adapter.inspect(attemptFence)).toMatchObject({
      state: "failed",
      failureReason: expect.stringContaining("cannot override sandbox or approval config"),
    });
  });

  it("distinguishes quiescence termination from user cancellation", async () => {
    const factory = new FakeProcessFactory();
    const lifecycle: JourneyHarnessLifecycleEvent[] = [];
    const adapter = new JourneyHarnessAdapter(factory);
    const attemptFence = fence("quiesce");
    await adapter.start({
      fence: attemptFence,
      profile: profile({ role: "coordinator" }),
      prompt: "Coordinate",
      cwd: "/repo",
      observer: { onLifecycle: (event) => lifecycle.push(event) },
    });

    adapter.quiesce(attemptFence);
    factory.processes[0]!.exit(null, "SIGTERM");

    expect(factory.processes[0]!.killedWith).toEqual(["SIGTERM"]);
    expect(lifecycle.at(-1)).toMatchObject({
      type: "exited",
      cancelled: false,
      quiesced: true,
    });
  });

  it("records cancellation before the first await and prevents process spawn", async () => {
    const factory = new FakeProcessFactory();
    const adapter = new JourneyHarnessAdapter(factory);
    const attemptFence = fence("run-a");

    const starting = adapter.start({
      fence: attemptFence,
      profile: profile(),
      prompt: "Inspect",
      cwd: "/repo",
    });
    expect(adapter.cancel(attemptFence)).toMatchObject({ state: "cancelling", pid: null });
    await expect(starting).resolves.toMatchObject({ state: "exited", pid: null });
    expect(factory.processes).toEqual([]);
  });

  it("coalesces concurrent duplicate starts for the same full fence", async () => {
    const factory = new FakeProcessFactory();
    const adapter = new JourneyHarnessAdapter(factory);
    const attemptFence = fence("run-a");
    const [first, second] = await Promise.all([
      adapter.start({ fence: attemptFence, profile: profile(), prompt: "One", cwd: "/repo" }),
      adapter.start({ fence: attemptFence, profile: profile(), prompt: "Two", cwd: "/repo" }),
    ]);

    expect(factory.processes).toHaveLength(1);
    expect(first).toEqual(second);
  });

  it("registers and removes processes by run and attempt without replacing siblings", async () => {
    const factory = new FakeProcessFactory();
    const adapter = new JourneyHarnessAdapter(factory);
    const registryDir = await mkdtemp(path.join(os.tmpdir(), "clui-journey-registry-"));
    temporaryRoots.push(registryDir);
    const registryProfile = { ...profile(), processRegistryDir: registryDir };

    await adapter.start({
      fence: fence("run-a"),
      profile: registryProfile,
      prompt: "A",
      cwd: "/repo",
    });
    await adapter.start({
      fence: fence("run-b"),
      profile: registryProfile,
      prompt: "B",
      cwd: "/repo",
    });
    expect(readSessionProcessRegistryEntries(registryDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: "run-a", attempt: 1, pid: 1_000 }),
        expect.objectContaining({ runId: "run-b", attempt: 1, pid: 1_001 }),
      ]),
    );

    factory.processes[0]!.output(resultLine(validResearchResult()));
    factory.processes[0]!.exit(0);
    expect(readSessionProcessRegistryEntries(registryDir)).toEqual([
      expect.objectContaining({ runId: "run-b", attempt: 1, pid: 1_001 }),
    ]);
  });

  it("reports spawned-but-unregistered ownership as typed interruption evidence", async () => {
    const factory = new FakeProcessFactory();
    const adapter = new JourneyHarnessAdapter(factory);
    const invalidRegistry = path.join(
      await mkdtemp(path.join(os.tmpdir(), "clui-journey-invalid-registry-")),
      "not-a-directory",
    );
    temporaryRoots.push(path.dirname(invalidRegistry));
    await writeFile(invalidRegistry, "file", "utf8");
    const attemptFence = fence("registry-failure");
    const lifecycle: JourneyHarnessLifecycleEvent[] = [];

    await expect(
      adapter.start({
        fence: attemptFence,
        profile: { ...profile(), processRegistryDir: invalidRegistry },
        prompt: "Inspect",
        cwd: "/repo",
        observer: { onLifecycle: (event) => lifecycle.push(event) },
      }),
    ).rejects.toBeInstanceOf(JourneyHarnessOwnershipUncertainError);

    expect(factory.processes[0]!.killedWith).toEqual(["SIGTERM"]);
    expect(adapter.inspect(attemptFence)).toMatchObject({
      state: "interrupted",
      pid: 1_000,
      failureReason: expect.stringContaining("ownership registration failed"),
    });
    factory.processes[0]!.exit(null, "SIGTERM");
    expect(lifecycle.at(-1)).toMatchObject({ type: "exitConfirmed", signal: "SIGTERM" });
  });

  it("persists discovered resumable identity and recreates registry inspection", async () => {
    const factory = new FakeProcessFactory();
    const lifecycle: JourneyHarnessLifecycleEvent[] = [];
    const adapter = new JourneyHarnessAdapter(factory);
    const registryDir = await mkdtemp(path.join(os.tmpdir(), "clui-journey-identity-"));
    temporaryRoots.push(registryDir);
    const attemptFence = fence("run-a");
    await adapter.start({
      fence: attemptFence,
      profile: { ...profile(), processRegistryDir: registryDir },
      prompt: "Inspect",
      cwd: "/repo",
      observer: { onLifecycle: (event) => lifecycle.push(event) },
    });
    factory.processes[0]!.output('{"thread_id":"codex-session-1"}\n');

    expect(lifecycle.at(-1)).toEqual({
      type: "identity",
      fence: attemptFence,
      resumableIdentity: "codex-session-1",
    });
    const recreatedAdapter = new JourneyHarnessAdapter(new FakeProcessFactory());
    expect(recreatedAdapter.inspectRegistered(attemptFence, registryDir)).toMatchObject({
      runId: "run-a",
      nodeId: "node-run-a",
      attempt: 1,
      resumableIdentity: "codex-session-1",
      pid: 1_000,
    });
  });

  it("retains registry ownership for interruption and post-spawn process errors", async () => {
    const factory = new FakeProcessFactory();
    const adapter = new JourneyHarnessAdapter(factory);
    const registryDir = await mkdtemp(path.join(os.tmpdir(), "clui-journey-interrupt-"));
    temporaryRoots.push(registryDir);
    const registryProfile = { ...profile(), processRegistryDir: registryDir };
    const interruptedFence = fence("interrupted");
    const erroredFence = fence("errored");
    await adapter.start({
      fence: interruptedFence,
      profile: registryProfile,
      prompt: "A",
      cwd: "/repo",
    });
    await adapter.start({
      fence: erroredFence,
      profile: registryProfile,
      prompt: "B",
      cwd: "/repo",
    });

    adapter.interrupt(interruptedFence, "start acknowledgement timed out");
    factory.processes[1]!.error("process channel failed");

    expect(adapter.inspect(interruptedFence)).toMatchObject({
      state: "interrupted",
      pid: 1_000,
      failureReason: "start acknowledgement timed out",
    });
    expect(adapter.inspect(erroredFence)).toMatchObject({
      state: "interrupted",
      pid: 1_001,
      failureReason: "process channel failed",
    });
    expect(readSessionProcessRegistryEntries(registryDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: "interrupted", pid: 1_000 }),
        expect.objectContaining({ runId: "errored", pid: 1_001 }),
      ]),
    );

    factory.processes[0]!.exit(null, "SIGTERM");
    expect(readSessionProcessRegistryEntries(registryDir)).toEqual([
      expect.objectContaining({ runId: "errored", pid: 1_001 }),
    ]);
  });

  it("fails a zero exit with a missing or malformed role result", async () => {
    const factory = new FakeProcessFactory();
    const lifecycle: JourneyHarnessLifecycleEvent[] = [];
    const adapter = new JourneyHarnessAdapter(factory);
    await adapter.start({
      fence: fence("run-a"),
      profile: profile(),
      prompt: "Inspect",
      cwd: "/repo",
      observer: { onLifecycle: (event) => lifecycle.push(event) },
    });
    factory.processes[0]!.output("ordinary final prose\n");
    factory.processes[0]!.exit(0);

    expect(adapter.inspect(fence("run-a"))).toMatchObject({
      state: "failed",
      result: null,
      failureReason: expect.stringContaining("CLUI_JOURNEY_RESULT"),
    });
    expect(lifecycle.map((event) => event.type)).toEqual(["started", "error", "exited"]);
  });

  it("drops output and results delivered after cancellation begins", async () => {
    const factory = new FakeProcessFactory();
    const chunks: JourneyHarnessOutputChunk[] = [];
    const results: JourneyHarnessValidatedResult[] = [];
    const adapter = new JourneyHarnessAdapter(factory);
    const attemptFence = fence("run-a");
    await adapter.start({
      fence: attemptFence,
      profile: profile(),
      prompt: "Inspect",
      cwd: "/repo",
      observer: {
        onOutput: (chunk) => chunks.push(chunk),
        onResult: ({ result }) => results.push(result),
      },
    });
    factory.processes[0]!.output("accepted before cancel\n");
    adapter.cancel(attemptFence);
    factory.processes[0]!.output(resultLine(validResearchResult()));
    factory.processes[0]!.exit(0);

    expect(chunks).toHaveLength(1);
    expect(results).toEqual([]);
    expect(adapter.inspect(attemptFence)).toMatchObject({
      state: "exited",
      nextOutputCursor: Buffer.byteLength("accepted before cancel\n"),
      result: null,
    });
  });

  it("extracts a structured result nested inside JSONL harness events", async () => {
    const factory = new FakeProcessFactory();
    const adapter = new JourneyHarnessAdapter(factory);
    const attemptFence = fence("run-a");
    await adapter.start({
      fence: attemptFence,
      profile: profile(),
      prompt: "Inspect",
      cwd: "/repo",
    });
    factory.processes[0]!.output(
      `${JSON.stringify({ type: "item.completed", item: { text: resultLine(validResearchResult()) } })}\n`,
    );
    factory.processes[0]!.exit(0);
    expect(adapter.inspect(attemptFence)?.result).toEqual(validResearchResult());
  });

  it("builds equivalent non-interactive Pi and Codex research launches", async () => {
    const factory = new FakeProcessFactory();
    const adapter = new JourneyHarnessAdapter(factory);
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "clui-journey-adapter-"));
    temporaryRoots.push(runtimeRoot);

    await adapter.start({
      fence: fence("pi"),
      profile: profile({ harness: "pi", runtimeRoot }),
      prompt: "Research Pi",
      cwd: "/repo",
    });
    await adapter.start({
      fence: fence("codex"),
      profile: profile({ harness: "codexCli" }),
      prompt: "Research Codex",
      cwd: "/repo",
    });

    const [piLaunch, codexLaunch] = factory.launches;
    expect(piLaunch!.command).toBe("/usr/bin/sandbox-exec");
    expect(piLaunch!.args).toEqual(expect.arrayContaining(["--tools", "read,grep,find,ls"]));
    expect(piLaunch!.args.join(" ")).toContain("CLUI_JOURNEY_RESULT:");
    expect(codexLaunch!.command).toBe("/usr/local/bin/codex");
    expect(codexLaunch!.args).toEqual(expect.arrayContaining(["exec", "--sandbox", "read-only"]));
    expect(codexLaunch!.args.join(" ")).toContain("CLUI_JOURNEY_RESULT:");
  });

  it("prevents coordinators from waiting again on terminal dependency runs", async () => {
    const factory = new FakeProcessFactory();
    const adapter = new JourneyHarnessAdapter(factory);

    await adapter.start({
      fence: fence("coordinator-contract"),
      profile: profile({ role: "coordinator" }),
      prompt: "Coordinate",
      cwd: "/repo",
    });

    const launchPrompt = factory.launches[0]!.args.join(" ");
    expect(launchPrompt).toContain("Never wait for dependencies that are already terminal");
    expect(launchPrompt).toContain("without launching a redundant synthesis worker");
    expect(launchPrompt).toContain("return waitForUser or complete");
  });

  it("places trusted Journey tool adapters where each harness can load them", async () => {
    const factory = new FakeProcessFactory();
    const adapter = new JourneyHarnessAdapter(factory);
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "clui-journey-tools-"));
    temporaryRoots.push(runtimeRoot);
    const piExtension = "/clui-runtime/clui-journey-pi-extension.js";
    const codexConfigArgs = [
      "-c",
      'mcp_servers.clui_journey.command="/usr/bin/node"',
      "-c",
      "mcp_servers.clui_journey.required=true",
    ];

    await adapter.start({
      fence: fence("pi-tools"),
      profile: profile({
        harness: "pi",
        runtimeRoot,
        trustedPiExtensionPaths: [piExtension],
        trustedPiToolNames: ["journey_get", "journey_research_get"],
      }),
      prompt: "Coordinate with Pi",
      cwd: "/repo",
    });
    await adapter.start({
      fence: fence("codex-tools"),
      profile: profile({ harness: "codexCli", codexConfigArgs }),
      prompt: "Coordinate with Codex",
      cwd: "/repo",
    });

    const [piLaunch, codexLaunch] = factory.launches;
    expect(piLaunch!.args).toEqual(expect.arrayContaining(["--extension", piExtension]));
    expect(piLaunch!.args).toEqual(
      expect.arrayContaining(["--tools", "read,grep,find,ls,journey_get,journey_research_get"]),
    );
    expect(codexLaunch!.args).toEqual(expect.arrayContaining(codexConfigArgs));
    expect(codexLaunch!.args.indexOf("-c")).toBeLessThan(codexLaunch!.args.indexOf("exec"));
    expect(codexLaunch!.args).toEqual(expect.arrayContaining(["--ask-for-approval", "never"]));
  });

  it("loads Journey tools for Codex implementation owners without interactive approvals", async () => {
    const factory = new FakeProcessFactory();
    const adapter = new JourneyHarnessAdapter(factory);
    const codexConfigArgs = ["-c", 'mcp_servers.clui_journey.command="/usr/bin/node"'];

    await adapter.start({
      fence: fence("codex-implementation-tools"),
      profile: profile({
        harness: "codexCli",
        role: "implementationOwner",
        codexConfigArgs,
      }),
      prompt: "Implement the approved node",
      cwd: "/repo",
    });

    const [launch] = factory.launches;
    expect(launch!.args).toEqual(expect.arrayContaining(codexConfigArgs));
    expect(launch!.args.indexOf("-c")).toBeLessThan(launch!.args.indexOf("exec"));
    expect(launch!.args).toEqual(expect.arrayContaining(["--ask-for-approval", "never"]));
    expect(launch!.args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write"]));
  });

  it("validates coordinator and implementation results by role for both harnesses", async () => {
    const factory = new FakeProcessFactory();
    const adapter = new JourneyHarnessAdapter(factory);
    const cases = [
      {
        fence: fence("coordinator"),
        profile: profile({ role: "coordinator" }),
        result: { kind: "complete", summary: "Journey ready." } as const,
      },
      {
        fence: fence("implementation"),
        profile: profile({ harness: "pi", role: "implementationOwner" }),
        result: validImplementationResult(),
      },
    ];
    for (const item of cases) {
      await adapter.start({
        fence: item.fence,
        profile: item.profile,
        prompt: "Work",
        cwd: "/repo",
      });
      const process = factory.processes.at(-1)!;
      process.output(resultLine(item.result));
      process.exit(0);
      expect(adapter.inspect(item.fence)?.result).toEqual(item.result);
    }
  });

  it("rejects research results from implementation owners and implementation results from researchers", async () => {
    const factory = new FakeProcessFactory();
    const adapter = new JourneyHarnessAdapter(factory);
    const cases = [
      {
        fence: fence("research-cross-role"),
        profile: profile({ role: "researchWorker" }),
        wrongResult: validImplementationResult(),
      },
      {
        fence: fence("implementation-cross-role"),
        profile: profile({ role: "implementationOwner" }),
        wrongResult: validResearchResult(),
      },
    ];
    for (const item of cases) {
      await adapter.start({
        fence: item.fence,
        profile: item.profile,
        prompt: "Work",
        cwd: "/repo",
      });
      const process = factory.processes.at(-1)!;
      process.output(resultLine(item.wrongResult));
      process.exit(0);
      expect(adapter.inspect(item.fence)).toMatchObject({
        state: "failed",
        result: null,
        failureReason: expect.stringContaining(item.profile.role),
      });
    }
  });

  it("bounds captured parsing memory while preserving monotonic output cursors", async () => {
    const factory = new FakeProcessFactory();
    const adapter = new JourneyHarnessAdapter(factory, { maxCaptureBytes: 512 });
    const attemptFence = fence("bounded");
    await adapter.start({
      fence: attemptFence,
      profile: profile(),
      prompt: "Inspect",
      cwd: "/repo",
    });
    factory.processes[0]!.output("x".repeat(1_024));
    factory.processes[0]!.output(resultLine(validResearchResult()));
    factory.processes[0]!.exit(0);

    expect(adapter.inspect(attemptFence)).toMatchObject({
      state: "exited",
      nextOutputCursor: 1_024 + Buffer.byteLength(resultLine(validResearchResult())),
      retainedOutputBytes: expect.any(Number),
      result: validResearchResult(),
    });
    expect(adapter.inspect(attemptFence)!.retainedOutputBytes).toBeLessThanOrEqual(512);
  });

  it("evicts only terminal attempts and preserves interrupted registry evidence", async () => {
    const factory = new FakeProcessFactory();
    const adapter = new JourneyHarnessAdapter(factory);
    const registryDir = await mkdtemp(path.join(os.tmpdir(), "clui-journey-cleanup-"));
    temporaryRoots.push(registryDir);
    const activeFence = fence("active");
    const interruptedFence = fence("interrupted");
    await adapter.start({
      fence: activeFence,
      profile: profile(),
      prompt: "A",
      cwd: "/repo",
    });
    await adapter.start({
      fence: interruptedFence,
      profile: { ...profile(), processRegistryDir: registryDir },
      prompt: "B",
      cwd: "/repo",
    });
    expect(adapter.evict(activeFence)).toBe(false);
    adapter.interrupt(interruptedFence, "ambiguous owner");

    expect(adapter.cleanupTerminalAttempts()).toBe(1);
    expect(adapter.inspect(interruptedFence)).toBeNull();
    expect(adapter.inspectRegistered(interruptedFence, registryDir)).toMatchObject({
      runId: "interrupted",
      pid: 1_001,
    });

    factory.processes[0]!.output(resultLine(validResearchResult()));
    factory.processes[0]!.exit(0);
    expect(adapter.evict(activeFence)).toBe(true);
  });

  it("rejects invalid role capabilities before spawning", async () => {
    const factory = new FakeProcessFactory();
    const adapter = new JourneyHarnessAdapter(factory);
    await expect(
      adapter.start({
        fence: fence("bad"),
        profile: profile({ capabilities: ["graph.read", "repository.write"] }),
        prompt: "Research",
        cwd: "/repo",
      }),
    ).rejects.toThrow("mutating capabilities");
    expect(factory.launches).toEqual([]);
  });
});
