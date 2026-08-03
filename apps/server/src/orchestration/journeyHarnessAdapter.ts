import { spawn } from "node:child_process";
import path from "node:path";

import {
  JourneyCoordinatorOutcome,
  JourneyImplementationResult,
  JourneyResearchResult,
  type JourneyAttemptFence,
  type JourneyCapability,
  type JourneyRunRole,
  type JourneyImplementationResult as JourneyImplementationResultValue,
  type JourneyResearchResult as JourneyResearchResultValue,
  type JourneyCoordinatorOutcome as JourneyCoordinatorOutcomeValue,
} from "@clui/contracts";
import { Schema } from "effect";

import {
  buildCodexResearchProcessLaunch,
  buildPiResearchProcessLaunch,
  preparePiResearchRuntime,
  type ResearchProcessLaunch,
} from "../terminal/researchHarnessProfile";
import {
  readSessionProcessRegistryEntries,
  removeSessionProcessRegistryEntry,
  writeSessionProcessRegistryEntry,
} from "../terminal/sessionProcessRegistry";

export type JourneyHarness = "pi" | "codexCli";

export interface JourneyHarnessProfile {
  readonly harness: JourneyHarness;
  readonly role: JourneyRunRole;
  readonly capabilities: ReadonlyArray<JourneyCapability>;
  readonly executable: string;
  readonly model?: string;
  readonly runtimeRoot?: string;
  readonly resumeIdentity?: string;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /** Trusted global Codex CLI configuration inserted before `exec`. */
  readonly codexConfigArgs?: ReadonlyArray<string>;
  /** Trusted Pi extensions kept outside caller-controlled extra arguments. */
  readonly trustedPiExtensionPaths?: ReadonlyArray<string>;
  /** Capability-derived custom tools added to Pi's enforced read-only allowlist. */
  readonly trustedPiToolNames?: ReadonlyArray<string>;
  readonly extraArgs?: ReadonlyArray<string>;
  readonly processRegistryDir?: string;
}

export interface JourneyHarnessProcessExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface JourneyHarnessProcess {
  readonly pid: number;
  kill(signal?: NodeJS.Signals): void;
}

export interface JourneyHarnessProcessCallbacks {
  readonly onOutput: (chunk: string) => void;
  readonly onExit: (event: JourneyHarnessProcessExit) => void;
  readonly onError: (error: Error) => void;
}

export interface JourneyHarnessProcessFactory {
  spawn(
    launch: ResearchProcessLaunch & { readonly cwd: string },
    callbacks: JourneyHarnessProcessCallbacks,
  ): Promise<JourneyHarnessProcess>;
}

export type JourneyHarnessValidatedResult =
  | JourneyResearchResultValue
  | JourneyImplementationResultValue
  | JourneyCoordinatorOutcomeValue;

export type JourneyHarnessLifecycleEvent =
  | {
      readonly type: "started";
      readonly fence: JourneyAttemptFence;
      readonly pid: number;
      readonly resumableIdentity: string | null;
    }
  | {
      readonly type: "identity";
      readonly fence: JourneyAttemptFence;
      readonly resumableIdentity: string;
    }
  | {
      readonly type: "exited";
      readonly fence: JourneyAttemptFence;
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly cancelled: boolean;
      readonly quiesced: boolean;
    }
  | {
      readonly type: "error";
      readonly fence: JourneyAttemptFence;
      readonly message: string;
    }
  | {
      readonly type: "interrupted";
      readonly fence: JourneyAttemptFence;
      readonly reason: string;
    }
  | {
      readonly type: "exitConfirmed";
      readonly fence: JourneyAttemptFence;
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
    };

export interface JourneyHarnessOutputChunk {
  readonly fence: JourneyAttemptFence;
  readonly data: string;
  readonly firstCursor: number;
  readonly nextCursor: number;
}

export interface JourneyHarnessObserver {
  readonly onLifecycle?: (event: JourneyHarnessLifecycleEvent) => void;
  readonly onOutput?: (chunk: JourneyHarnessOutputChunk) => void;
  readonly onResult?: (input: {
    readonly fence: JourneyAttemptFence;
    readonly result: JourneyHarnessValidatedResult;
  }) => void;
}

export interface JourneyHarnessInspection {
  readonly fence: JourneyAttemptFence;
  readonly harness: JourneyHarness;
  readonly role: JourneyRunRole;
  readonly state: "starting" | "running" | "cancelling" | "exited" | "failed" | "interrupted";
  readonly pid: number | null;
  readonly nextOutputCursor: number;
  readonly resumableIdentity: string | null;
  readonly result: JourneyHarnessValidatedResult | null;
  readonly failureReason: string | null;
  readonly retainedOutputBytes: number;
}

export type JourneyRegisteredProcessTermination = "absent" | "signalled" | "denied";

export class JourneyHarnessOwnershipUncertainError extends Error {
  override readonly name = "JourneyHarnessOwnershipUncertainError";

  constructor(
    readonly fence: JourneyAttemptFence,
    readonly pid: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface JourneySystemProcessControl {
  readonly isAlive: (pid: number) => boolean;
  readonly terminate: (pid: number) => boolean;
}

interface AttemptEntry {
  fence: JourneyAttemptFence;
  harness: JourneyHarness;
  role: JourneyRunRole;
  state: JourneyHarnessInspection["state"];
  pid: number | null;
  nextOutputCursor: number;
  resumableIdentity: string | null;
  result: JourneyHarnessValidatedResult | null;
  failureReason: string | null;
  readonly observer: JourneyHarnessObserver;
  readonly output: string[];
  outputRetainedBytes: number;
  process: JourneyHarnessProcess | null;
  cancelRequested: boolean;
  quiesceRequested: boolean;
  terminal: boolean;
  processRegistryDir: string | null;
}

const decodeResearchResult = Schema.decodeUnknownSync(JourneyResearchResult);
const decodeImplementationResult = Schema.decodeUnknownSync(JourneyImplementationResult);
const decodeCoordinatorResult = Schema.decodeUnknownSync(JourneyCoordinatorOutcome);
const RESULT_MARKER = "CLUI_JOURNEY_RESULT:";
const IDENTITY_MARKER = "CLUI_JOURNEY_IDENTITY:";
export const CLUI_JOURNEY_RUN_ID_ENV = "CLUI_JOURNEY_RUN_ID";
export const CLUI_JOURNEY_NODE_ID_ENV = "CLUI_JOURNEY_NODE_ID";
export const CLUI_JOURNEY_ATTEMPT_ENV = "CLUI_JOURNEY_ATTEMPT";
export const CLUI_JOURNEY_ROLE_ENV = "CLUI_JOURNEY_ROLE";
export const CLUI_JOURNEY_CAPABILITIES_ENV = "CLUI_JOURNEY_CAPABILITIES";
const FORBIDDEN_RESEARCH_CAPABILITIES = new Set<JourneyCapability>([
  "graph.mutate",
  "research.start",
  "implementation.start",
  "repository.write",
]);
const DEFAULT_MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

function processKey(fence: JourneyAttemptFence): string {
  return JSON.stringify([fence.threadId, fence.runId, fence.nodeId, fence.attempt]);
}

function cloneFence(fence: JourneyAttemptFence): JourneyAttemptFence {
  return { ...fence };
}

function validateProfile(profile: JourneyHarnessProfile): void {
  if (!path.isAbsolute(profile.executable)) {
    throw new Error("Journey harness executable must be an absolute path.");
  }
  for (const extensionPath of profile.trustedPiExtensionPaths ?? []) {
    if (!path.isAbsolute(extensionPath)) {
      throw new Error("Trusted Journey Pi extensions must use absolute paths.");
    }
  }
  if (
    profile.role === "researchWorker" &&
    profile.capabilities.some((capability) => FORBIDDEN_RESEARCH_CAPABILITIES.has(capability))
  ) {
    throw new Error("Journey research workers cannot receive mutating capabilities.");
  }
  if (profile.capabilities.includes("repository.write") && profile.role !== "implementationOwner") {
    throw new Error("Journey repository.write is restricted to implementation owners.");
  }
  if (
    profile.role === "implementationOwner" &&
    !profile.capabilities.includes("repository.write")
  ) {
    throw new Error("Journey implementation owners require repository.write.");
  }
}

function promptWithResultContract(role: JourneyRunRole, prompt: string): string {
  const roleInstructions =
    role === "coordinator"
      ? `Use the available Journey tools to evolve the graph and start concrete research or implementation work. Do not perform repository work in the coordinator process.
Return exactly one of these JSON shapes:
{"kind":"complete","summary":"..."}
{"kind":"waitForDependencies","successDependencyNodeIds":["..."],"observeTerminalRunIds":["..."],"reason":"..."}
{"kind":"waitForUser","interactionId":"...","decisionNodeId":"...","reason":"..."}`
      : role === "researchWorker"
        ? `Return JSON shaped as {"kind":"research","summary":"...","evidence":[{"source":"...","finding":"..."}],"unresolved":["..."]}.`
        : `Return JSON shaped as {"kind":"implementation","summary":"...","changedFiles":["..."],"verification":[{"command":"...","outcome":"...","passed":true}],"unresolved":["..."]}.`;
  return `${prompt.trim()}\n\n${roleInstructions}\nWhen the run has reached its outcome, stop working and print exactly one final line beginning with ${RESULT_MARKER} followed immediately by the JSON.`;
}

function commonArgs(profile: JourneyHarnessProfile): string[] {
  return profile.model ? ["--model", profile.model] : [];
}

async function buildLaunch(
  profile: JourneyHarnessProfile,
  prompt: string,
  fence: JourneyAttemptFence,
): Promise<ResearchProcessLaunch> {
  validateProfile(profile);
  const contractedPrompt = promptWithResultContract(profile.role, prompt);
  const readOnly = profile.role !== "implementationOwner";
  const baseEnv = {
    ...compactEnv(profile.baseEnv),
    CLUI_JOURNEY_THREAD_ID: fence.threadId,
    [CLUI_JOURNEY_RUN_ID_ENV]: fence.runId,
    [CLUI_JOURNEY_NODE_ID_ENV]: fence.nodeId,
    [CLUI_JOURNEY_ATTEMPT_ENV]: String(fence.attempt),
    [CLUI_JOURNEY_ROLE_ENV]: profile.role,
    [CLUI_JOURNEY_CAPABILITIES_ENV]: JSON.stringify(profile.capabilities),
  };

  if (profile.harness === "codexCli") {
    const codexGlobalArgs = [
      ...commonArgs(profile),
      "--ask-for-approval",
      "never",
      ...(profile.codexConfigArgs ?? []),
    ];
    const args = [
      ...codexGlobalArgs,
      "exec",
      "--json",
      "--color",
      "never",
      ...(profile.resumeIdentity ? ["resume", profile.resumeIdentity] : []),
      ...(profile.extraArgs ?? []),
      contractedPrompt,
    ];
    if (readOnly) {
      return buildCodexResearchProcessLaunch({
        codexExecutable: profile.executable,
        codexArgs: args,
        baseEnv,
      });
    }
    return {
      command: profile.executable,
      args: [
        ...codexGlobalArgs,
        "exec",
        "--json",
        "--color",
        "never",
        "--sandbox",
        "workspace-write",
        ...(profile.resumeIdentity ? ["resume", profile.resumeIdentity] : []),
        ...(profile.extraArgs ?? []),
        contractedPrompt,
      ],
      env: baseEnv,
    };
  }

  const piArgs = [
    ...commonArgs(profile),
    ...(profile.resumeIdentity ? ["--session", profile.resumeIdentity] : []),
    "--mode",
    "json",
    "--print",
    ...(profile.extraArgs ?? []),
    contractedPrompt,
  ];
  if (readOnly) {
    if (!profile.runtimeRoot) {
      throw new Error("Read-only Pi Journey profiles require an isolated runtimeRoot.");
    }
    await preparePiResearchRuntime(profile.runtimeRoot);
    return buildPiResearchProcessLaunch({
      piExecutable: profile.executable,
      piArgs,
      ...(profile.trustedPiExtensionPaths
        ? { trustedExtensionPaths: profile.trustedPiExtensionPaths }
        : {}),
      ...(profile.trustedPiToolNames ? { trustedToolNames: profile.trustedPiToolNames } : {}),
      runtimeRoot: profile.runtimeRoot,
      baseEnv,
    });
  }
  return {
    command: profile.executable,
    args: [
      ...(profile.trustedPiExtensionPaths ?? []).flatMap((extensionPath) => [
        "--extension",
        extensionPath,
      ]),
      ...piArgs,
    ],
    env: baseEnv,
  };
}

function compactEnv(
  env: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function parseMarkedValue(output: string, marker: string): string | null {
  const candidates = [output];
  const collectStrings = (value: unknown): void => {
    if (typeof value === "string") {
      candidates.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(collectStrings);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(collectStrings);
    }
  };
  for (const line of output.split(/\r?\n/)) {
    try {
      collectStrings(JSON.parse(line));
    } catch {
      // Some harnesses mix plain text with their JSON event stream.
    }
  }
  for (const candidate of candidates.toReversed()) {
    const index = candidate.lastIndexOf(marker);
    if (index < 0) continue;
    const line = candidate
      .slice(index + marker.length)
      .split(/\r?\n/, 1)[0]
      ?.trim();
    if (line) return line;
  }
  return null;
}

function discoverIdentity(output: string, harness: JourneyHarness): string | null {
  const marked = parseMarkedValue(output, IDENTITY_MARKER);
  if (marked) return marked;
  const keys = harness === "codexCli" ? ["thread_id", "threadId"] : ["session_file", "sessionFile"];
  for (const line of output.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      for (const key of keys) {
        if (typeof value[key] === "string" && value[key]) return value[key];
      }
    } catch {
      // Harness output may contain ordinary text around its JSON event stream.
    }
  }
  return null;
}

function decodeResult(role: JourneyRunRole, output: string): JourneyHarnessValidatedResult {
  const encoded = parseMarkedValue(output, RESULT_MARKER);
  if (!encoded) throw new Error(`Harness output is missing ${RESULT_MARKER}`);
  let unknownResult: unknown;
  try {
    unknownResult = JSON.parse(encoded);
  } catch (cause) {
    throw new Error("Harness returned malformed Journey result JSON.", { cause });
  }
  try {
    if (role === "coordinator") return decodeCoordinatorResult(unknownResult);
    if (role === "researchWorker") return decodeResearchResult(unknownResult);
    return decodeImplementationResult(unknownResult);
  } catch (cause) {
    throw new Error(`Harness returned an invalid ${role} result.`, { cause });
  }
}

export class JourneyHarnessAdapter {
  private readonly attempts = new Map<string, AttemptEntry>();
  private readonly starts = new Map<string, Promise<JourneyHarnessInspection>>();

  private readonly maxCaptureBytes: number;
  private readonly systemProcessControl: JourneySystemProcessControl;

  constructor(
    private readonly processFactory: JourneyHarnessProcessFactory = nodeProcessFactory,
    options?: {
      readonly maxCaptureBytes?: number;
      readonly systemProcessControl?: JourneySystemProcessControl;
    },
  ) {
    this.maxCaptureBytes = options?.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
    if (!Number.isSafeInteger(this.maxCaptureBytes) || this.maxCaptureBytes <= 0) {
      throw new Error("Journey harness maxCaptureBytes must be a positive integer.");
    }
    this.systemProcessControl = options?.systemProcessControl ?? nodeSystemProcessControl;
  }

  start(input: {
    readonly fence: JourneyAttemptFence;
    readonly profile: JourneyHarnessProfile;
    readonly prompt: string;
    readonly cwd: string;
    readonly observer?: JourneyHarnessObserver;
  }): Promise<JourneyHarnessInspection> {
    const key = processKey(input.fence);
    const inFlight = this.starts.get(key);
    if (inFlight) return inFlight;
    const existing = this.attempts.get(key);
    if (existing) return Promise.resolve(this.snapshot(existing));
    const start = this.startOnce(key, input).finally(() => {
      if (this.starts.get(key) === start) this.starts.delete(key);
    });
    this.starts.set(key, start);
    return start;
  }

  private async startOnce(
    key: string,
    input: {
      readonly fence: JourneyAttemptFence;
      readonly profile: JourneyHarnessProfile;
      readonly prompt: string;
      readonly cwd: string;
      readonly observer?: JourneyHarnessObserver;
    },
  ): Promise<JourneyHarnessInspection> {
    if (!path.isAbsolute(input.cwd)) throw new Error("Journey harness cwd must be absolute.");
    validateProfile(input.profile);
    const entry: AttemptEntry = {
      fence: cloneFence(input.fence),
      harness: input.profile.harness,
      role: input.profile.role,
      state: "starting",
      pid: null,
      nextOutputCursor: 0,
      resumableIdentity: input.profile.resumeIdentity ?? null,
      result: null,
      failureReason: null,
      observer: input.observer ?? {},
      output: [],
      outputRetainedBytes: 0,
      process: null,
      cancelRequested: false,
      quiesceRequested: false,
      terminal: false,
      processRegistryDir: input.profile.processRegistryDir ?? null,
    };
    this.attempts.set(key, entry);

    try {
      const launch = await buildLaunch(input.profile, input.prompt, input.fence);
      if (entry.cancelRequested) {
        entry.terminal = true;
        entry.state = "exited";
        entry.observer.onLifecycle?.({
          type: "exited",
          fence: cloneFence(entry.fence),
          exitCode: null,
          signal: null,
          cancelled: true,
          quiesced: false,
        });
        return this.snapshot(entry);
      }
      const process = await this.processFactory.spawn(
        { ...launch, cwd: input.cwd },
        {
          onOutput: (chunk) => this.onOutput(key, entry, chunk),
          onExit: (event) => this.onExit(key, entry, event),
          onError: (error) => this.onError(key, entry, error),
        },
      );
      if (this.attempts.get(key) !== entry || entry.terminal) {
        process.kill("SIGTERM");
        return this.snapshot(entry);
      }
      entry.process = process;
      entry.pid = process.pid;
      if (entry.processRegistryDir) {
        try {
          this.registerProcess(entry);
        } catch (cause) {
          process.kill("SIGTERM");
          throw new JourneyHarnessOwnershipUncertainError(
            cloneFence(entry.fence),
            process.pid,
            "Journey process spawned but durable ownership registration failed.",
            { cause },
          );
        }
      }
      entry.state = entry.cancelRequested ? "cancelling" : "running";
      entry.observer.onLifecycle?.({
        type: "started",
        fence: cloneFence(entry.fence),
        pid: process.pid,
        resumableIdentity: entry.resumableIdentity,
      });
      if (entry.cancelRequested) process.kill("SIGTERM");
      return this.snapshot(entry);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (error instanceof JourneyHarnessOwnershipUncertainError) {
        entry.terminal = true;
        entry.state = "interrupted";
        entry.failureReason = error.message;
        throw error;
      }
      if (entry.process === null) {
        entry.terminal = true;
        entry.state = "failed";
        entry.failureReason = error.message;
        throw error;
      }
      this.onError(key, entry, error);
      throw error;
    }
  }

  cancel(fence: JourneyAttemptFence): JourneyHarnessInspection | null {
    const entry = this.attempts.get(processKey(fence));
    if (!entry) return null;
    if (!entry.terminal && !entry.cancelRequested) {
      entry.cancelRequested = true;
      entry.state = "cancelling";
      entry.process?.kill("SIGTERM");
    }
    return this.snapshot(entry);
  }

  quiesce(fence: JourneyAttemptFence): JourneyHarnessInspection | null {
    const entry = this.attempts.get(processKey(fence));
    if (!entry) return null;
    if (!entry.terminal && !entry.quiesceRequested) {
      entry.quiesceRequested = true;
      entry.state = "cancelling";
      entry.process?.kill("SIGTERM");
    }
    return this.snapshot(entry);
  }

  inspect(fence: JourneyAttemptFence): JourneyHarnessInspection | null {
    const entry = this.attempts.get(processKey(fence));
    return entry ? this.snapshot(entry) : null;
  }

  inspectRegistered(
    fence: JourneyAttemptFence,
    registryDir: string,
  ): ReturnType<typeof readSessionProcessRegistryEntries>[number] | null {
    return (
      readSessionProcessRegistryEntries(registryDir).find(
        (entry) =>
          entry.threadId === fence.threadId &&
          entry.runId === fence.runId &&
          entry.nodeId === fence.nodeId &&
          entry.attempt === fence.attempt,
      ) ?? null
    );
  }

  registeredProcessAlive(fence: JourneyAttemptFence, registryDir: string): boolean {
    const entry = this.inspectRegistered(fence, registryDir);
    return entry !== null && this.systemProcessControl.isAlive(entry.pid);
  }

  terminateRegistered(
    fence: JourneyAttemptFence,
    registryDir: string,
  ): JourneyRegisteredProcessTermination {
    const entry = this.inspectRegistered(fence, registryDir);
    if (!entry || !this.systemProcessControl.isAlive(entry.pid)) return "absent";
    return this.systemProcessControl.terminate(entry.pid) ? "signalled" : "denied";
  }

  forgetRegistered(fence: JourneyAttemptFence, registryDir: string, harness: JourneyHarness): void {
    removeSessionProcessRegistryEntry(registryDir, harness, fence.threadId, {
      runId: fence.runId,
      nodeId: fence.nodeId,
      attempt: fence.attempt,
    });
  }

  evict(fence: JourneyAttemptFence): boolean {
    const key = processKey(fence);
    const entry = this.attempts.get(key);
    if (!entry?.terminal) return false;
    return this.attempts.delete(key);
  }

  cleanupTerminalAttempts(): number {
    let removed = 0;
    for (const [key, entry] of this.attempts) {
      if (!entry.terminal) continue;
      this.attempts.delete(key);
      removed += 1;
    }
    return removed;
  }

  interrupt(
    fence: JourneyAttemptFence,
    reason: string,
    notifyObserver = true,
  ): JourneyHarnessInspection | null {
    const entry = this.attempts.get(processKey(fence));
    if (!entry || entry.terminal) return entry ? this.snapshot(entry) : null;
    entry.terminal = true;
    entry.state = "interrupted";
    entry.failureReason = reason;
    entry.process?.kill("SIGTERM");
    if (notifyObserver) {
      entry.observer.onLifecycle?.({
        type: "interrupted",
        fence: cloneFence(entry.fence),
        reason,
      });
    }
    return this.snapshot(entry);
  }

  private onOutput(key: string, entry: AttemptEntry, data: string): void {
    if (this.attempts.get(key) !== entry || entry.terminal || entry.cancelRequested || !data)
      return;
    const firstCursor = entry.nextOutputCursor;
    entry.nextOutputCursor += Buffer.byteLength(data, "utf8");
    const discoveredIdentity = entry.resumableIdentity
      ? null
      : discoverIdentity(`${entry.output.join("")}${data}`, entry.harness);
    entry.output.push(data);
    entry.outputRetainedBytes += Buffer.byteLength(data, "utf8");
    this.trimCapturedOutput(entry);
    if (!entry.resumableIdentity && discoveredIdentity) {
      entry.resumableIdentity = discoveredIdentity;
      try {
        this.registerProcess(entry);
      } catch (cause) {
        entry.process?.kill("SIGTERM");
        this.onError(key, entry, cause instanceof Error ? cause : new Error(String(cause)));
        return;
      }
      entry.observer.onLifecycle?.({
        type: "identity",
        fence: cloneFence(entry.fence),
        resumableIdentity: discoveredIdentity,
      });
    }
    entry.observer.onOutput?.({
      fence: cloneFence(entry.fence),
      data,
      firstCursor,
      nextCursor: entry.nextOutputCursor,
    });
  }

  private onExit(key: string, entry: AttemptEntry, event: JourneyHarnessProcessExit): void {
    if (this.attempts.get(key) !== entry) return;
    if (entry.terminal) {
      if (entry.state === "interrupted") {
        entry.process = null;
        try {
          this.unregisterProcess(entry);
        } catch (cause) {
          console.error("Failed to remove Journey process registry evidence after exit.", cause);
        }
        entry.state = "exited";
        entry.observer.onLifecycle?.({
          type: "exitConfirmed",
          fence: cloneFence(entry.fence),
          exitCode: event.exitCode,
          signal: event.signal,
        });
      }
      return;
    }
    entry.terminal = true;
    entry.process = null;
    this.unregisterProcess(entry);
    const cancelled = entry.cancelRequested;
    const quiesced = entry.quiesceRequested;
    if (quiesced && !cancelled) {
      entry.state = "exited";
      entry.failureReason = null;
    } else if (!cancelled && event.exitCode === 0) {
      try {
        entry.result = decodeResult(entry.role, entry.output.join(""));
        entry.observer.onResult?.({ fence: cloneFence(entry.fence), result: entry.result });
        entry.state = "exited";
      } catch (cause) {
        entry.state = "failed";
        entry.failureReason = cause instanceof Error ? cause.message : String(cause);
        entry.observer.onLifecycle?.({
          type: "error",
          fence: cloneFence(entry.fence),
          message: entry.failureReason,
        });
      }
    } else {
      entry.state = cancelled ? "exited" : "failed";
      entry.failureReason = cancelled
        ? null
        : `Harness exited with ${event.signal ?? `code ${event.exitCode ?? "unknown"}`}.`;
    }
    entry.observer.onLifecycle?.({
      type: "exited",
      fence: cloneFence(entry.fence),
      exitCode: event.exitCode,
      signal: event.signal,
      cancelled,
      quiesced,
    });
  }

  private onError(key: string, entry: AttemptEntry, error: Error): void {
    if (this.attempts.get(key) !== entry || entry.terminal) return;
    entry.terminal = true;
    entry.process = null;
    const spawned = entry.pid !== null;
    entry.state = spawned ? "interrupted" : "failed";
    entry.failureReason = error.message;
    entry.observer.onLifecycle?.({
      type: "error",
      fence: cloneFence(entry.fence),
      message: error.message,
    });
    if (spawned) {
      entry.observer.onLifecycle?.({
        type: "interrupted",
        fence: cloneFence(entry.fence),
        reason: error.message,
      });
    }
  }

  private snapshot(entry: AttemptEntry): JourneyHarnessInspection {
    return {
      fence: cloneFence(entry.fence),
      harness: entry.harness,
      role: entry.role,
      state: entry.state,
      pid: entry.pid,
      nextOutputCursor: entry.nextOutputCursor,
      resumableIdentity: entry.resumableIdentity,
      result: entry.result,
      failureReason: entry.failureReason,
      retainedOutputBytes: entry.outputRetainedBytes,
    };
  }

  private trimCapturedOutput(entry: AttemptEntry): void {
    while (entry.outputRetainedBytes > this.maxCaptureBytes && entry.output.length > 1) {
      const removed = entry.output.shift()!;
      entry.outputRetainedBytes -= Buffer.byteLength(removed, "utf8");
    }
    if (entry.outputRetainedBytes <= this.maxCaptureBytes) return;
    const retained = Buffer.from(entry.output[0]!, "utf8").subarray(-this.maxCaptureBytes);
    entry.output[0] = retained.toString("utf8");
    entry.outputRetainedBytes = Buffer.byteLength(entry.output[0]!, "utf8");
    while (entry.outputRetainedBytes > this.maxCaptureBytes) {
      entry.output[0] = entry.output[0]!.slice(1);
      entry.outputRetainedBytes = Buffer.byteLength(entry.output[0]!, "utf8");
    }
  }

  private registerProcess(entry: AttemptEntry): void {
    if (!entry.processRegistryDir || entry.pid === null) return;
    writeSessionProcessRegistryEntry(entry.processRegistryDir, {
      harness: entry.harness,
      threadId: entry.fence.threadId,
      runId: entry.fence.runId,
      nodeId: entry.fence.nodeId,
      attempt: entry.fence.attempt,
      pid: entry.pid,
      ...(entry.resumableIdentity ? { resumableIdentity: entry.resumableIdentity } : {}),
    });
  }

  private unregisterProcess(entry: AttemptEntry): void {
    if (!entry.processRegistryDir) return;
    removeSessionProcessRegistryEntry(
      entry.processRegistryDir,
      entry.harness,
      entry.fence.threadId,
      {
        runId: entry.fence.runId,
        nodeId: entry.fence.nodeId,
        attempt: entry.fence.attempt,
      },
    );
  }
}

export const nodeProcessFactory: JourneyHarnessProcessFactory = {
  spawn: (launch, callbacks) =>
    new Promise((resolve, reject) => {
      const child = spawn(launch.command, [...launch.args], {
        cwd: launch.cwd,
        env: { ...process.env, ...launch.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let spawned = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", callbacks.onOutput);
      child.stderr.on("data", callbacks.onOutput);
      child.once("spawn", () => {
        spawned = true;
        resolve({
          pid: child.pid!,
          kill: (signal = "SIGTERM") => {
            child.kill(signal);
          },
        });
      });
      child.once("error", (error) => {
        if (spawned) callbacks.onError(error);
        else reject(error);
      });
      child.once("exit", (exitCode, signal) => callbacks.onExit({ exitCode, signal }));
    }),
};

const nodeSystemProcessControl: JourneySystemProcessControl = {
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  terminate: (pid) => {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  },
};
