import { accessSync, constants, realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

import {
  CommandId,
  type JourneyAttemptFence,
  type JourneyCoordinatorOutcome,
  type JourneyLogicalRun,
  type JourneyProjectionSnapshot,
  type JourneySteeringItem,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadId,
} from "@clui/contracts";
import { Effect, Layer, Stream } from "effect";

import { ServerConfig } from "../../config";
import {
  JourneyHarnessAdapter,
  JourneyHarnessOwnershipUncertainError,
  type JourneyHarnessInspection,
  type JourneyHarnessLifecycleEvent,
  type JourneyHarnessObserver,
  type JourneyHarnessProfile,
  type JourneyHarnessValidatedResult,
} from "../journeyHarnessAdapter";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine";
import { JourneyReactor, type JourneyReactorShape } from "../Services/JourneyReactor";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import {
  journeyAttemptAuthorizer,
  type JourneyAttemptGrant,
} from "../../terminal/journeyAttemptAuthorization";
import {
  CLUI_JOURNEY_TOOL_ENDPOINT_ENV,
  CLUI_JOURNEY_TOOL_THREAD_ID_ENV,
  CLUI_JOURNEY_TOOL_TOKEN_ENV,
} from "../../terminal/journeyMcpServer";
import {
  buildCodexJourneyMcpConfigArgs,
  ensureJourneyHarnessToolRuntime,
  journeyHarnessToolRuntimePaths,
  journeyToolNamesForCapabilities,
  type JourneyHarnessToolRuntimePaths,
} from "../../terminal/journeyHarnessToolRuntime";
import { getSessionProcessRegistryDir } from "../../terminal/sessionProcessRegistry";

const execFileAsync = promisify(execFile);
const DEFAULT_START_ACK_TIMEOUT_MS = 15_000;
const DEFAULT_TERMINATION_ACK_TIMEOUT_MS = 10_000;
const CALLBACK_RETRY_MS = 100;
const PRE_START_OUTPUT_LIMIT_BYTES = 64 * 1024;

export interface JourneyReactorClock {
  readonly now: () => string;
  readonly schedule: (delayMs: number, callback: () => void) => () => void;
}

export interface JourneyReactorAuthorizer {
  issue(input: {
    readonly fence: JourneyAttemptFence;
    readonly role: JourneyLogicalRun["role"];
    readonly capabilities: JourneyLogicalRun["capabilities"];
  }): JourneyAttemptGrant;
  revokeFence(fence: JourneyAttemptFence): void;
  revokeRun(fence: Pick<JourneyAttemptFence, "threadId" | "runId">): void;
}

export interface JourneyReactorAdapter {
  start(input: {
    readonly fence: JourneyAttemptFence;
    readonly profile: JourneyHarnessProfile;
    readonly prompt: string;
    readonly cwd: string;
    readonly observer?: JourneyHarnessObserver;
  }): Promise<JourneyHarnessInspection>;
  cancel(fence: JourneyAttemptFence): JourneyHarnessInspection | null;
  quiesce(fence: JourneyAttemptFence): JourneyHarnessInspection | null;
  inspect(fence: JourneyAttemptFence): JourneyHarnessInspection | null;
  interrupt(
    fence: JourneyAttemptFence,
    reason: string,
    notifyObserver?: boolean,
  ): JourneyHarnessInspection | null;
  inspectRegistered(
    fence: JourneyAttemptFence,
    registryDir: string,
  ): { readonly pid: number } | null;
  registeredProcessAlive(fence: JourneyAttemptFence, registryDir: string): boolean;
  terminateRegistered(
    fence: JourneyAttemptFence,
    registryDir: string,
  ): "absent" | "signalled" | "denied";
  forgetRegistered(
    fence: JourneyAttemptFence,
    registryDir: string,
    harness: "pi" | "codexCli",
  ): void;
}

export interface JourneyReactorEngine {
  readonly dispatch: (command: OrchestrationCommand) => Promise<{ sequence: number }>;
  readonly getJourneyProjection: (threadId: ThreadId) => Promise<JourneyProjectionSnapshot>;
  readonly getReadModel: () => Promise<OrchestrationReadModel>;
  readonly beginJourneyRunOutput: (fence: JourneyAttemptFence) => Promise<void>;
  readonly appendJourneyRunOutput: (fence: JourneyAttemptFence, data: string) => Promise<void>;
  readonly deactivateJourneyRunOutput: (fence: JourneyAttemptFence) => Promise<void>;
}

export interface JourneyReactorOptions {
  readonly engine: JourneyReactorEngine;
  readonly adapter: JourneyReactorAdapter;
  readonly authorizer: JourneyReactorAuthorizer;
  readonly stateDir: string;
  readonly toolEndpoint: string;
  readonly toolRuntimePaths?: JourneyHarnessToolRuntimePaths;
  readonly ensureToolRuntime?: () => Promise<void>;
  readonly clock?: JourneyReactorClock;
  readonly startAckTimeoutMs?: number;
  readonly terminationAckTimeoutMs?: number;
  readonly resolveExecutable?: (harness: "pi" | "codexCli") => string;
  readonly inspectWorkspaceClean?: (cwd: string) => Promise<boolean>;
}

interface AttemptRuntimeState {
  readonly fence: JourneyAttemptFence;
  startedDelivered: boolean;
  steeringDelivered: boolean;
  resultDelivered: boolean;
  terminalCallbackDelivered: boolean;
  startAccepted: boolean;
  preStartOutput: string[];
  preStartOutputBytes: number;
  outputOverflowed: boolean;
  overflowInterrupted: boolean;
  quiesceOutcome: JourneyCoordinatorOutcome | null;
  steering: JourneySteeringItem | null;
  outputTail: Promise<void>;
}

function fenceKey(fence: JourneyAttemptFence): string {
  return JSON.stringify([fence.threadId, fence.runId, fence.nodeId, fence.attempt]);
}

function eventId(kind: string, fence: JourneyAttemptFence, suffix = "event"): string {
  return `${kind}:${Buffer.from(fenceKey(fence)).toString("base64url")}:${suffix}`;
}

function commandId(kind: string, fence: JourneyAttemptFence, suffix = "event") {
  return CommandId.makeUnsafe(eventId(kind, fence, suffix));
}

function systemClock(): JourneyReactorClock {
  return {
    now: () => new Date().toISOString(),
    schedule: (delayMs, callback) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
  };
}

function resolvePathExecutable(harness: "pi" | "codexCli"): string {
  const executable = harness === "pi" ? "pi" : "codex";
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, executable);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync.native(candidate);
    } catch {
      // Continue through PATH.
    }
  }
  throw new Error(`Journey harness executable '${executable}' was not found on PATH.`);
}

async function defaultWorkspaceClean(cwd: string): Promise<boolean> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
  return stdout.trim().length === 0;
}

function queuedSteeringHead(
  projection: JourneyProjectionSnapshot,
  runId: string,
): JourneySteeringItem | null {
  return (
    projection.steering
      .filter((item) => item.runId === runId && item.status === "queued")
      .toSorted((left, right) => left.sequence - right.sequence)[0] ?? null
  );
}

function isCoordinatorOutcome(
  result: JourneyHarnessValidatedResult,
): result is JourneyCoordinatorOutcome {
  return (
    result.kind === "complete" ||
    result.kind === "waitForDependencies" ||
    result.kind === "waitForUser"
  );
}

export class JourneyReactorRuntime {
  private readonly engine: JourneyReactorEngine;
  private readonly adapter: JourneyReactorAdapter;
  private readonly authorizer: JourneyReactorAuthorizer;
  private readonly stateDir: string;
  private readonly registryDir: string;
  private readonly toolEndpoint: string;
  private readonly toolRuntimePaths: JourneyHarnessToolRuntimePaths;
  private readonly ensureToolRuntime: () => Promise<void>;
  private readonly clock: JourneyReactorClock;
  private readonly startAckTimeoutMs: number;
  private readonly terminationAckTimeoutMs: number;
  private readonly resolveExecutable: (harness: "pi" | "codexCli") => string;
  private readonly inspectWorkspaceClean: (cwd: string) => Promise<boolean>;
  private readonly prompts = new Map<string, string>();
  private readonly processedSequences = new Set<number>();
  private readonly eventTasks = new Map<number, Promise<void>>();
  private readonly pendingCallbacks = new Set<Promise<void>>();
  private readonly startAckTimers = new Map<string, () => void>();
  private readonly terminationAckTimers = new Map<string, () => void>();
  private readonly attempts = new Map<string, AttemptRuntimeState>();
  private readonly pendingNodeDeletions = new Map<
    string,
    { readonly threadId: ThreadId; readonly nodeId: string }
  >();
  private readonly pendingThreadDeletions = new Set<ThreadId>();
  private admissionDrain: Promise<void> | null = null;

  constructor(options: JourneyReactorOptions) {
    this.engine = options.engine;
    this.adapter = options.adapter;
    this.authorizer = options.authorizer;
    this.stateDir = options.stateDir;
    this.registryDir = getSessionProcessRegistryDir(options.stateDir);
    this.toolEndpoint = options.toolEndpoint;
    this.toolRuntimePaths =
      options.toolRuntimePaths ?? journeyHarnessToolRuntimePaths(options.stateDir);
    this.ensureToolRuntime =
      options.ensureToolRuntime ??
      (async () => void (await ensureJourneyHarnessToolRuntime(options.stateDir)));
    this.clock = options.clock ?? systemClock();
    this.startAckTimeoutMs = options.startAckTimeoutMs ?? DEFAULT_START_ACK_TIMEOUT_MS;
    this.terminationAckTimeoutMs =
      options.terminationAckTimeoutMs ?? DEFAULT_TERMINATION_ACK_TIMEOUT_MS;
    this.resolveExecutable = options.resolveExecutable ?? resolvePathExecutable;
    this.inspectWorkspaceClean = options.inspectWorkspaceClean ?? defaultWorkspaceClean;
  }

  rememberHistoricalEvent(event: OrchestrationEvent): void {
    if (event.type === "journey.run-requested") {
      this.prompts.set(
        `${event.payload.run.threadId}\0${event.payload.run.runId}`,
        event.payload.prompt,
      );
    }
    if (event.type === "journey.node-deletion-requested") {
      this.pendingNodeDeletions.set(
        `${event.payload.threadId}\0${event.payload.nodeId}`,
        event.payload,
      );
    }
    if (event.type === "journey.thread-deletion-requested") {
      this.pendingThreadDeletions.add(event.payload.threadId);
    }
  }

  handleEvent(event: OrchestrationEvent): Promise<void> {
    this.rememberHistoricalEvent(event);
    if (this.processedSequences.has(event.sequence)) return Promise.resolve();
    const existing = this.eventTasks.get(event.sequence);
    if (existing) return existing;
    const task = this.processEvent(event)
      .then(() => {
        this.processedSequences.add(event.sequence);
      })
      .finally(() => this.eventTasks.delete(event.sequence));
    this.eventTasks.set(event.sequence, task);
    return task;
  }

  async flush(): Promise<void> {
    while (this.pendingCallbacks.size > 0) {
      await Promise.allSettled(this.pendingCallbacks);
    }
  }

  async reconcileStartup(): Promise<void> {
    const readModel = await this.engine.getReadModel();
    for (const thread of readModel.threads) {
      if (thread.surface !== "journey" || thread.journey === null) continue;
      const projection = await this.engine.getJourneyProjection(thread.id);
      for (const run of projection.runs) {
        if (!["starting", "running", "quiescing", "cancelling", "interrupted"].includes(run.status))
          continue;
        const attempt = projection.attempts.find(
          (candidate) =>
            candidate.fence.runId === run.runId && candidate.fence.attempt === run.attempt,
        );
        if (!attempt) continue;
        const fence = attempt.fence;
        const deletionPending = this.deletionPending(projection, run.runId);
        if (!deletionPending) this.authorizer.revokeFence(fence);
        if (run.status !== "interrupted") {
          await this.dispatch({
            type: "journey.run.interrupt",
            commandId: commandId("restart-interrupt", fence),
            fence,
            adapterEventId: eventId("restart-interrupt", fence),
            reason: "Server restarted while the Journey attempt could still own a process.",
            orphanProcessPossible: true,
            createdAt: this.clock.now(),
          });
        }
        const registered = this.adapter.inspectRegistered(fence, this.registryDir);
        if (!registered) {
          if (!deletionPending) continue;
          await this.dispatchReconciliation(
            fence,
            "processAbsent",
            "No process registry entry exists for the interrupted attempt.",
          );
          await this.dispatchCancelled(fence, "delete-after-process-absence-confirmed");
          await this.finalizePendingDeletions(fence.threadId, fence.nodeId);
          continue;
        }
        const termination = this.adapter.terminateRegistered(fence, this.registryDir);
        if (
          termination !== "absent" &&
          this.adapter.registeredProcessAlive(fence, this.registryDir)
        ) {
          continue;
        }
        this.adapter.forgetRegistered(fence, this.registryDir, run.harness);
        await this.dispatchReconciliation(fence, "orphanTerminated", "Orphan process is absent.");
        if (deletionPending) {
          await this.dispatchCancelled(fence, "delete-after-orphan-confirmed");
          await this.finalizePendingDeletions(fence.threadId, fence.nodeId);
          continue;
        }
        if (run.role === "implementationOwner") {
          const cwd = await this.resolveWorkspace(run.threadId);
          const clean = await this.inspectWorkspaceClean(cwd);
          await this.dispatchReconciliation(
            fence,
            clean ? "workspaceClean" : "workspaceDirty",
            clean
              ? "Workspace is clean after interruption."
              : "Workspace remains dirty after interruption.",
          );
          continue;
        }
        await this.requestRetry(run, projection, null);
      }
      for (const pending of this.pendingNodeDeletions.values()) {
        if (pending.threadId === thread.id) {
          await this.finalizePendingDeletions(pending.threadId, pending.nodeId);
        }
      }
      if (this.pendingThreadDeletions.has(thread.id)) {
        await this.finalizePendingDeletions(thread.id, thread.journey.nodes[0]?.id ?? "");
      }
    }
    await this.drainQueuedAdmissions();
  }

  private async processEvent(event: OrchestrationEvent): Promise<void> {
    switch (event.type) {
      case "journey.run-requested":
        if (event.payload.run.role === "researchWorker") {
          await this.drainQueuedAdmissions();
        } else {
          await this.startInitialQueuedRun(event.payload.run);
        }
        break;
      case "journey.attempt-start-requested":
        await this.launchAttempt(event.payload.fence);
        break;
      case "journey.run-cancellation-requested":
        await this.cancelRun(event.payload.threadId, event.payload.runId);
        break;
      case "journey.run-completed":
      case "journey.run-failed":
      case "journey.run-cancelled":
        await this.revokeTerminal(event.payload.fence);
        await this.finalizePendingDeletions(
          event.payload.fence.threadId,
          event.payload.fence.nodeId,
        );
        await this.drainQueuedAdmissions();
        break;
      case "journey.node-deletion-requested":
        this.pendingNodeDeletions.set(
          `${event.payload.threadId}\0${event.payload.nodeId}`,
          event.payload,
        );
        await this.reconcileInterruptedDeletionRuns(event.payload.threadId, event.payload.nodeId);
        await this.finalizePendingDeletions(event.payload.threadId, event.payload.nodeId);
        break;
      case "journey.thread-deletion-requested":
        this.pendingThreadDeletions.add(event.payload.threadId);
        await this.finalizePendingDeletions(event.payload.threadId, "");
        break;
      case "journey.steering-enqueued":
        await this.startQueuedSteering(event.payload);
        break;
      case "journey.scheduler-configured":
      case "journey.permit-released":
        await this.drainQueuedAdmissions();
        break;
    }
  }

  private drainQueuedAdmissions(): Promise<void> {
    if (this.admissionDrain) return this.admissionDrain;
    const drain = this.drainQueuedAdmissionsOnce().finally(() => {
      if (this.admissionDrain === drain) this.admissionDrain = null;
    });
    this.admissionDrain = drain;
    return drain;
  }

  private async drainQueuedAdmissionsOnce(): Promise<void> {
    while (true) {
      const readModel = await this.engine.getReadModel();
      const journeyThreads = readModel.threads
        .filter((thread) => thread.surface === "journey" && thread.journey !== null)
        .toSorted((left, right) => left.id.localeCompare(right.id));
      const projections = await Promise.all(
        journeyThreads.map((thread) => this.engine.getJourneyProjection(thread.id)),
      );
      const candidates = projections
        .flatMap((projection) =>
          projection.runs.filter(
            (run) => run.role === "researchWorker" && run.status === "queued" && run.attempt === 0,
          ),
        )
        .toSorted(
          (left, right) =>
            left.threadId.localeCompare(right.threadId) ||
            left.createdAt.localeCompare(right.createdAt) ||
            left.runId.localeCompare(right.runId),
        );
      let admitted = false;
      for (const run of candidates) {
        const projection = projections.find((candidate) => candidate.threadId === run.threadId);
        if (!projection) continue;
        try {
          await this.requestRetry(run, projection, null);
          admitted = true;
          break;
        } catch (cause) {
          if (
            cause instanceof OrchestrationCommandInvariantError &&
            (cause.detail === "Research start is not the next fair scheduler admission." ||
              cause.detail === "Journey node dependencies are not ready." ||
              cause.detail.includes("Cannot start Journey run from"))
          ) {
            continue;
          }
          throw cause;
        }
      }
      if (!admitted) return;
    }
  }

  private async startInitialQueuedRun(requestedRun: JourneyLogicalRun): Promise<void> {
    const projection = await this.engine.getJourneyProjection(requestedRun.threadId);
    const run = projection.runs.find((candidate) => candidate.runId === requestedRun.runId);
    if (!run || run.status !== "queued" || run.attempt !== 0) return;
    await this.requestRetry(run, projection, null);
  }

  private async launchAttempt(fence: JourneyAttemptFence): Promise<void> {
    const projection = await this.engine.getJourneyProjection(fence.threadId);
    const run = projection.runs.find((candidate) => candidate.runId === fence.runId);
    const attempt = projection.attempts.find(
      (candidate) =>
        candidate.fence.runId === fence.runId && candidate.fence.attempt === fence.attempt,
    );
    if (!run || !attempt || run.status !== "starting" || attempt.status !== "starting") return;
    if (this.adapter.inspect(fence)) return;

    const steering = queuedSteeringHead(projection, run.runId);
    const prompt =
      steering?.prompt ??
      this.prompts.get(`${run.threadId}\0${run.runId}`) ??
      projection.journey.nodes.find((node) => node.id === run.nodeId)?.title ??
      "Continue this Journey run.";
    const cwd = await this.resolveWorkspace(run.threadId);
    try {
      await this.ensureToolRuntime();
    } catch (cause) {
      await this.failAttempt(fence, "launchRejected", errorMessage(cause));
      return;
    }
    try {
      await this.engine.beginJourneyRunOutput(fence);
    } catch (cause) {
      await this.failAttempt(fence, "launchRejected", errorMessage(cause));
      return;
    }
    let grant: JourneyAttemptGrant;
    try {
      grant = this.authorizer.issue({
        fence,
        role: run.role,
        capabilities: run.capabilities,
      });
    } catch (cause) {
      await this.failAttempt(fence, "launchRejected", errorMessage(cause));
      return;
    }

    const state: AttemptRuntimeState = {
      fence,
      startedDelivered: false,
      steeringDelivered: false,
      resultDelivered: false,
      terminalCallbackDelivered: false,
      startAccepted: false,
      preStartOutput: [],
      preStartOutputBytes: 0,
      outputOverflowed: false,
      overflowInterrupted: false,
      quiesceOutcome: null,
      steering,
      outputTail: Promise.resolve(),
    };
    this.attempts.set(fenceKey(fence), state);
    const cancelTimer = this.clock.schedule(this.startAckTimeoutMs, () => {
      this.queueAttemptCallback(state, () => this.onStartAckTimeout(fence));
    });
    this.startAckTimers.set(fenceKey(fence), cancelTimer);
    const observer = this.observerFor(run, state);

    try {
      await this.adapter.start({
        fence,
        profile: this.profileFor(run, grant),
        prompt,
        cwd,
        observer,
      });
    } catch (cause) {
      this.clearStartTimer(fence);
      if (cause instanceof JourneyHarnessOwnershipUncertainError) {
        await this.interruptAttempt(
          fence,
          `${cause.message} Spawned pid ${cause.pid}; exit is not confirmed.`,
        );
      } else {
        await this.failAttempt(fence, "spawnFailed", errorMessage(cause));
        state.terminalCallbackDelivered = true;
      }
    }
  }

  private observerFor(run: JourneyLogicalRun, state: AttemptRuntimeState): JourneyHarnessObserver {
    return {
      onLifecycle: (event) =>
        this.queueAttemptCallback(state, () => this.onLifecycle(run, state, event)),
      onOutput: ({ data }) =>
        this.queueAttemptCallback(state, () => this.appendOutput(state, data)),
      onResult: ({ result }) =>
        this.queueAttemptCallback(state, () => this.onResult(run, state, result)),
    };
  }

  private async onLifecycle(
    run: JourneyLogicalRun,
    state: AttemptRuntimeState,
    event: JourneyHarnessLifecycleEvent,
  ): Promise<void> {
    const fence = state.fence;
    if (event.type === "started") {
      if (state.terminalCallbackDelivered) return;
      if (!(await this.isCurrentFence(fence))) return;
      if (!state.startedDelivered) {
        await this.dispatch({
          type: "journey.attempt.started",
          commandId: commandId("started", fence),
          fence,
          adapterEventId: eventId("started", fence),
          resumableHarnessIdentity: event.resumableIdentity,
          createdAt: this.clock.now(),
        });
        state.startedDelivered = true;
        state.startAccepted = true;
        this.clearStartTimer(fence);
      }
      await this.flushPreStartOutput(state);
      if (state.steering && !state.steeringDelivered) {
        await this.dispatch({
          type: "journey.steering.acknowledge",
          commandId: commandId("steering-ack", fence, state.steering.id),
          threadId: fence.threadId,
          runId: fence.runId,
          itemId: state.steering.id,
          sequence: state.steering.sequence,
          createdAt: this.clock.now(),
        });
        state.steeringDelivered = true;
      }
      return;
    }
    if (!(await this.isCurrentFence(fence))) return;
    if (event.type === "identity") return;
    if (event.type === "exitConfirmed") {
      if (state.terminalCallbackDelivered) return;
      const projection = await this.engine.getJourneyProjection(fence.threadId);
      const currentRun = projection.runs.find((candidate) => candidate.runId === fence.runId);
      if (currentRun?.status !== "interrupted") {
        throw new Error("Journey exit confirmation arrived before interruption was durable.");
      }
      this.authorizer.revokeFence(fence);
      await this.dispatchReconciliation(
        fence,
        "processExited",
        `Previously uncertain process exited with ${event.signal ?? `code ${event.exitCode ?? "unknown"}`}.`,
      );
      if (this.deletionPending(projection, fence.runId)) {
        await this.dispatchCancelled(fence, "delete-after-exit-confirmed");
        state.terminalCallbackDelivered = true;
        await this.finalizePendingDeletions(fence.threadId, fence.nodeId);
        return;
      }
      if (run.capabilities.includes("repository.write")) {
        const cwd = await this.resolveWorkspace(run.threadId);
        const clean = await this.inspectWorkspaceClean(cwd);
        await this.dispatchReconciliation(
          fence,
          clean ? "workspaceClean" : "workspaceDirty",
          clean
            ? "Workspace is clean after confirmed process exit."
            : "Workspace remains dirty after confirmed process exit.",
        );
      } else {
        await this.requestRetry(run, await this.engine.getJourneyProjection(fence.threadId), null);
      }
      state.terminalCallbackDelivered = true;
      await this.engine.deactivateJourneyRunOutput(fence);
      return;
    }
    if (event.type === "interrupted") {
      if (state.terminalCallbackDelivered) return;
      this.clearStartTimer(fence);
      this.authorizer.revokeFence(fence);
      await this.interruptAttempt(fence, event.reason, "adapter-interrupt");
      state.terminalCallbackDelivered = true;
      await this.engine.deactivateJourneyRunOutput(fence);
      return;
    }
    if (event.type === "error") {
      if (state.terminalCallbackDelivered) return;
      this.clearStartTimer(fence);
      this.authorizer.revokeFence(fence);
      const inspection = this.adapter.inspect(fence);
      if (inspection?.state === "interrupted") {
        await this.interruptAttempt(fence, event.message, "adapter-error-interrupt");
        state.terminalCallbackDelivered = true;
        await this.engine.deactivateJourneyRunOutput(fence);
      } else {
        await this.failAttempt(
          fence,
          run.role === "coordinator" ? "invalidOutcome" : "adapterError",
          event.message,
        );
        state.terminalCallbackDelivered = true;
      }
      return;
    }
    this.clearStartTimer(fence);
    this.authorizer.revokeFence(fence);
    if (state.terminalCallbackDelivered) return;
    this.clearTerminationTimer(fence);
    if (state.quiesceOutcome) {
      await this.dispatchQuiesced(fence, state.quiesceOutcome);
      state.terminalCallbackDelivered = true;
      await this.engine.deactivateJourneyRunOutput(fence);
      return;
    }
    if (event.cancelled) {
      await this.dispatch({
        type: "journey.run.cancelled",
        commandId: commandId("cancelled", fence),
        fence,
        adapterEventId: eventId("cancelled", fence),
        createdAt: this.clock.now(),
      });
      state.terminalCallbackDelivered = true;
      await this.engine.deactivateJourneyRunOutput(fence);
      return;
    }
    if (state.resultDelivered) return;
    const inspection = this.adapter.inspect(fence);
    const invalid = event.exitCode === 0 && inspection?.result === null;
    await this.failAttempt(
      fence,
      invalid ? (run.role === "coordinator" ? "invalidOutcome" : "invalidResult") : "processExited",
      inspection?.failureReason ?? `Harness exited before delivering a valid result.`,
    );
    state.terminalCallbackDelivered = true;
  }

  private async onResult(
    run: JourneyLogicalRun,
    state: AttemptRuntimeState,
    result: JourneyHarnessValidatedResult,
  ): Promise<void> {
    if (state.terminalCallbackDelivered) return;
    if (state.resultDelivered) {
      if (state.quiesceOutcome) {
        await this.beginQuiescenceTermination(state, state.quiesceOutcome);
      }
      return;
    }
    if (!(await this.isCurrentFence(state.fence))) return;
    const fence = state.fence;
    this.clearStartTimer(fence);
    if (run.role === "coordinator") {
      if (!isCoordinatorOutcome(result)) {
        await this.failAttempt(fence, "invalidOutcome", "Coordinator returned a worker result.");
        state.terminalCallbackDelivered = true;
        return;
      }
      this.authorizer.revokeFence(fence);
      await this.dispatch({
        type: "journey.attempt.quiesce.request",
        commandId: commandId("quiesce", fence),
        fence,
        adapterEventId: eventId("quiesce", fence),
        outcome: result,
        createdAt: this.clock.now(),
      });
      state.resultDelivered = true;
      state.quiesceOutcome = result;
      await this.beginQuiescenceTermination(state, result);
      return;
    }
    if (isCoordinatorOutcome(result)) {
      await this.failAttempt(fence, "invalidResult", "Worker returned a coordinator outcome.");
      state.terminalCallbackDelivered = true;
      return;
    }
    this.authorizer.revokeFence(fence);
    await this.dispatch({
      type: "journey.attempt.result.submit",
      commandId: commandId("result", fence),
      fence,
      adapterEventId: eventId("result", fence),
      resultSequence: 1,
      result,
      createdAt: this.clock.now(),
    });
    state.resultDelivered = true;
    await this.engine.deactivateJourneyRunOutput(fence);
  }

  private async beginQuiescenceTermination(
    state: AttemptRuntimeState,
    outcome: JourneyCoordinatorOutcome,
  ): Promise<void> {
    if (state.terminalCallbackDelivered || this.terminationAckTimers.has(fenceKey(state.fence))) {
      return;
    }
    const inspection = this.adapter.quiesce(state.fence);
    if (inspection?.state === "exited") {
      await this.dispatchQuiesced(state.fence, outcome);
      state.terminalCallbackDelivered = true;
      await this.engine.deactivateJourneyRunOutput(state.fence);
      return;
    }
    this.scheduleTerminationTimeout(state, "quiesce");
  }

  private async onStartAckTimeout(fence: JourneyAttemptFence): Promise<void> {
    if (!this.startAckTimers.has(fenceKey(fence))) return;
    this.clearStartTimer(fence);
    this.authorizer.revokeFence(fence);
    this.adapter.interrupt(fence, "Journey harness start acknowledgement timed out.", false);
    await this.failAttempt(
      fence,
      "startAckTimeout",
      "Journey harness start acknowledgement timed out.",
    );
  }

  private async flushPreStartOutput(state: AttemptRuntimeState): Promise<void> {
    if (state.outputOverflowed) return;
    while (state.preStartOutput.length > 0) {
      const data = state.preStartOutput[0]!;
      await this.engine.appendJourneyRunOutput(state.fence, data);
      state.preStartOutput.shift();
      state.preStartOutputBytes -= Buffer.byteLength(data, "utf8");
    }
  }

  private async cancelRun(threadId: ThreadId, runId: string): Promise<void> {
    const projection = await this.engine.getJourneyProjection(threadId);
    const run = projection.runs.find((candidate) => candidate.runId === runId);
    if (!run || run.attempt < 1) return;
    const fence: JourneyAttemptFence = {
      threadId,
      runId: run.runId,
      nodeId: run.nodeId,
      attempt: run.attempt,
    };
    this.authorizer.revokeFence(fence);
    const attempt = projection.attempts.find(
      (candidate) => candidate.fence.runId === run.runId && candidate.fence.attempt === run.attempt,
    );
    if (attempt && ["completed", "failed", "cancelled"].includes(attempt.status)) {
      await this.dispatchCancelled(fence, "cancelled-no-live-process");
      return;
    }
    const inspection = this.adapter.cancel(fence);
    if (inspection?.state === "exited") {
      await this.dispatchCancelled(fence, "cancelled-confirmed");
      return;
    }
    const state = this.attempts.get(fenceKey(fence));
    if (inspection && state) {
      this.scheduleTerminationTimeout(state, "cancel");
      return;
    }
    const registered = this.adapter.inspectRegistered(fence, this.registryDir);
    if (registered) this.adapter.terminateRegistered(fence, this.registryDir);
    await this.interruptAttempt(
      fence,
      "Cancellation could not confirm physical process exit.",
      "cancel-uncertain",
    );
    await this.engine.deactivateJourneyRunOutput(fence);
  }

  private async startQueuedSteering(item: JourneySteeringItem): Promise<void> {
    const projection = await this.engine.getJourneyProjection(item.threadId);
    const run = projection.runs.find((candidate) => candidate.runId === item.runId);
    if (!run || run.status !== "queued") return;
    await this.requestRetry(run, projection, item);
  }

  private async finalizePendingDeletions(threadId: ThreadId, _nodeId: string): Promise<void> {
    const projection = await this.engine.getJourneyProjection(threadId);
    const pendingNodes = [...this.pendingNodeDeletions.entries()].filter(
      ([, pending]) => pending.threadId === threadId,
    );
    for (const [nodeKey, pending] of pendingNodes) {
      const deletionRunIds = this.nodeDeletionRunIds(projection, pending.nodeId);
      if (
        !projection.runs
          .filter((run) => deletionRunIds.has(run.runId))
          .every((run) => ["completed", "failed", "cancelled"].includes(run.status))
      ) {
        continue;
      }
      await this.dispatch({
        type: "journey.node.delete",
        commandId: CommandId.makeUnsafe(`journey-node-delete-finalize:${nodeKey}`),
        threadId,
        nodeId: pending.nodeId,
        createdAt: this.clock.now(),
      });
      this.pendingNodeDeletions.delete(nodeKey);
    }
    if (
      this.pendingThreadDeletions.has(threadId) &&
      projection.runs.every((run) => ["completed", "failed", "cancelled"].includes(run.status))
    ) {
      await this.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe(`journey-thread-delete-finalize:${threadId}`),
        threadId,
      });
      this.pendingThreadDeletions.delete(threadId);
    }
  }

  private async reconcileInterruptedDeletionRuns(
    threadId: ThreadId,
    nodeId: string,
  ): Promise<void> {
    const projection = await this.engine.getJourneyProjection(threadId);
    const deletionRunIds = this.nodeDeletionRunIds(projection, nodeId);
    for (const run of projection.runs.filter(
      (candidate) => deletionRunIds.has(candidate.runId) && candidate.status === "interrupted",
    )) {
      if (run.attempt < 1) continue;
      const fence: JourneyAttemptFence = {
        threadId,
        runId: run.runId,
        nodeId: run.nodeId,
        attempt: run.attempt,
      };
      this.authorizer.revokeFence(fence);
      const registered = this.adapter.inspectRegistered(fence, this.registryDir);
      if (!registered) {
        await this.dispatchReconciliation(
          fence,
          "processAbsent",
          "No process registry entry exists for the interrupted deletion descendant.",
        );
        await this.dispatchCancelled(fence, "delete-after-process-absence-confirmed");
        continue;
      }
      const termination = this.adapter.terminateRegistered(fence, this.registryDir);
      if (
        termination !== "absent" &&
        this.adapter.registeredProcessAlive(fence, this.registryDir)
      ) {
        continue;
      }
      this.adapter.forgetRegistered(fence, this.registryDir, run.harness);
      await this.dispatchReconciliation(
        fence,
        "orphanTerminated",
        "Interrupted deletion descendant process is absent.",
      );
      await this.dispatchCancelled(fence, "delete-after-orphan-confirmed");
    }
  }

  private nodeDeletionRunIds(projection: JourneyProjectionSnapshot, nodeId: string): Set<string> {
    const runIds = new Set(
      projection.runs.filter((run) => run.nodeId === nodeId).map((run) => run.runId),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const run of projection.runs) {
        if (runIds.has(run.runId)) continue;
        if (
          (run.parentRunId !== null && runIds.has(run.parentRunId)) ||
          (run.coordinatorRunId !== null && runIds.has(run.coordinatorRunId))
        ) {
          runIds.add(run.runId);
          changed = true;
        }
      }
    }
    return runIds;
  }

  private deletionPending(projection: JourneyProjectionSnapshot, runId: string): boolean {
    if (this.pendingThreadDeletions.has(projection.threadId)) return true;
    return [...this.pendingNodeDeletions.values()].some(
      (pending) =>
        pending.threadId === projection.threadId &&
        this.nodeDeletionRunIds(projection, pending.nodeId).has(runId),
    );
  }

  private async requestRetry(
    run: JourneyLogicalRun,
    projection: JourneyProjectionSnapshot,
    steering: JourneySteeringItem | null,
  ): Promise<void> {
    const fence: JourneyAttemptFence = {
      threadId: run.threadId,
      runId: run.runId,
      nodeId: run.nodeId,
      attempt: run.attempt + 1,
    };
    const cwd = await this.resolveWorkspace(run.threadId);
    const approval = projection.approvals.at(-1);
    await this.dispatch({
      type: "journey.attempt.start.request",
      commandId: commandId("continuation-start", fence, steering?.id ?? "recovery"),
      fence,
      capabilities: run.capabilities,
      ...(run.capabilities.includes("repository.write")
        ? { canonicalWorkspaceId: realpathSync.native(cwd) }
        : {}),
      ...(approval ? { proposalRevisionHash: approval.proposalRevisionHash } : {}),
      createdAt: this.clock.now(),
    });
  }

  private profileFor(run: JourneyLogicalRun, grant: JourneyAttemptGrant): JourneyHarnessProfile {
    return {
      harness: run.harness,
      role: run.role,
      capabilities: run.capabilities,
      executable: this.resolveExecutable(run.harness),
      runtimeRoot: path.join(
        this.stateDir,
        "journey-harness",
        Buffer.from(fenceKey(grant.fence)).toString("base64url"),
      ),
      processRegistryDir: this.registryDir,
      ...(run.resumableHarnessIdentity ? { resumeIdentity: run.resumableHarnessIdentity } : {}),
      ...(run.harness === "codexCli"
        ? {
            codexConfigArgs: buildCodexJourneyMcpConfigArgs(this.toolRuntimePaths.mcpServerPath, {
              attemptScoped: true,
            }),
          }
        : {
            trustedPiExtensionPaths: [this.toolRuntimePaths.piExtensionPath],
            trustedPiToolNames: journeyToolNamesForCapabilities(run.capabilities),
          }),
      baseEnv: {
        [CLUI_JOURNEY_TOOL_ENDPOINT_ENV]: this.toolEndpoint,
        [CLUI_JOURNEY_TOOL_THREAD_ID_ENV]: run.threadId,
        [CLUI_JOURNEY_TOOL_TOKEN_ENV]: grant.token,
      },
    };
  }

  private async resolveWorkspace(threadId: ThreadId): Promise<string> {
    const readModel = await this.engine.getReadModel();
    const thread = readModel.threads.find((candidate) => candidate.id === threadId);
    if (!thread) throw new Error(`Journey thread '${threadId}' no longer exists.`);
    if (thread.worktreePath) return realpathSync.native(thread.worktreePath);
    const project = readModel.projects.find((candidate) => candidate.id === thread.projectId);
    if (!project) throw new Error(`Journey project '${thread.projectId}' no longer exists.`);
    return realpathSync.native(project.workspaceRoot);
  }

  private async isCurrentFence(fence: JourneyAttemptFence): Promise<boolean> {
    const projection = await this.engine.getJourneyProjection(fence.threadId);
    const run = projection.runs.find((candidate) => candidate.runId === fence.runId);
    return run?.nodeId === fence.nodeId && run.attempt === fence.attempt;
  }

  private async dispatchReconciliation(
    fence: JourneyAttemptFence,
    observation:
      | "reattached"
      | "processAbsent"
      | "processExited"
      | "orphanTerminated"
      | "workspaceClean"
      | "workspaceDirty",
    detail: string,
  ): Promise<void> {
    await this.dispatch({
      type: "journey.reconcile.observe",
      commandId: commandId("reconcile", fence, observation),
      fence,
      adapterEventId: eventId("reconcile", fence, observation),
      observation,
      detail,
      createdAt: this.clock.now(),
    });
  }

  private async failAttempt(
    fence: JourneyAttemptFence,
    failureKind:
      | "launchRejected"
      | "spawnFailed"
      | "startAckTimeout"
      | "processExited"
      | "invalidOutcome"
      | "invalidResult"
      | "outputOverflow"
      | "quiesceTimeout"
      | "adapterError",
    reason: string,
  ): Promise<void> {
    this.authorizer.revokeFence(fence);
    await this.dispatch({
      type: "journey.attempt.fail",
      commandId: commandId("fail", fence, failureKind),
      fence,
      adapterEventId: eventId("fail", fence, failureKind),
      failureKind,
      reason,
      createdAt: this.clock.now(),
    });
    await this.engine.deactivateJourneyRunOutput(fence);
  }

  private async interruptAttempt(
    fence: JourneyAttemptFence,
    reason: string,
    kind = "ownership-uncertain",
  ): Promise<void> {
    this.authorizer.revokeFence(fence);
    await this.dispatch({
      type: "journey.run.interrupt",
      commandId: commandId(kind, fence),
      fence,
      adapterEventId: eventId(kind, fence),
      reason,
      orphanProcessPossible: true,
      createdAt: this.clock.now(),
    });
  }

  private async dispatchQuiesced(
    fence: JourneyAttemptFence,
    outcome: JourneyCoordinatorOutcome,
  ): Promise<void> {
    this.authorizer.revokeFence(fence);
    await this.dispatch({
      type: "journey.attempt.quiesced",
      commandId: commandId("quiesced", fence),
      fence,
      adapterEventId: eventId("quiesced", fence),
      outcome,
      createdAt: this.clock.now(),
    });
  }

  private async dispatchCancelled(fence: JourneyAttemptFence, kind: string): Promise<void> {
    this.authorizer.revokeFence(fence);
    await this.dispatch({
      type: "journey.run.cancelled",
      commandId: commandId(kind, fence),
      fence,
      adapterEventId: eventId(kind, fence),
      createdAt: this.clock.now(),
    });
    await this.engine.deactivateJourneyRunOutput(fence);
  }

  private scheduleTerminationTimeout(state: AttemptRuntimeState, kind: "quiesce" | "cancel"): void {
    const key = fenceKey(state.fence);
    if (this.terminationAckTimers.has(key)) return;
    const cancel = this.clock.schedule(this.terminationAckTimeoutMs, () => {
      this.terminationAckTimers.delete(key);
      this.queueAttemptCallback(state, () => this.onTerminationTimeout(state, kind));
    });
    this.terminationAckTimers.set(key, cancel);
  }

  private async onTerminationTimeout(
    state: AttemptRuntimeState,
    kind: "quiesce" | "cancel",
  ): Promise<void> {
    if (state.terminalCallbackDelivered) return;
    const inspection = this.adapter.inspect(state.fence);
    if (inspection?.state === "exited") {
      if (kind === "quiesce" && state.quiesceOutcome) {
        await this.dispatchQuiesced(state.fence, state.quiesceOutcome);
      } else {
        await this.dispatchCancelled(state.fence, "cancelled-timeout-inspection");
      }
      state.terminalCallbackDelivered = true;
      return;
    }
    this.authorizer.revokeFence(state.fence);
    this.adapter.interrupt(
      state.fence,
      `${kind === "quiesce" ? "Quiescence" : "Cancellation"} exit acknowledgement timed out.`,
      false,
    );
    await this.interruptAttempt(
      state.fence,
      `${kind === "quiesce" ? "Quiescence" : "Cancellation"} exit acknowledgement timed out; process ownership is uncertain.`,
      `${kind}-timeout-interrupt`,
    );
    state.terminalCallbackDelivered = true;
    await this.engine.deactivateJourneyRunOutput(state.fence);
  }

  private async revokeTerminal(fence: JourneyAttemptFence): Promise<void> {
    this.clearStartTimer(fence);
    this.authorizer.revokeFence(fence);
    await this.engine.deactivateJourneyRunOutput(fence);
  }

  private appendOutput(state: AttemptRuntimeState, data: string): Promise<void> {
    if (state.startAccepted) return this.engine.appendJourneyRunOutput(state.fence, data);
    if (!state.outputOverflowed) {
      state.preStartOutput.push(data);
      state.preStartOutputBytes += Buffer.byteLength(data, "utf8");
      if (state.preStartOutputBytes <= PRE_START_OUTPUT_LIMIT_BYTES) return Promise.resolve();
      state.outputOverflowed = true;
      state.preStartOutput = [];
      state.preStartOutputBytes = 0;
    }
    return this.handlePreStartOutputOverflow(state);
  }

  private async handlePreStartOutputOverflow(state: AttemptRuntimeState): Promise<void> {
    if (state.terminalCallbackDelivered) return;
    this.authorizer.revokeFence(state.fence);
    if (!state.overflowInterrupted) {
      this.adapter.interrupt(
        state.fence,
        "Journey harness exceeded the pre-start output limit.",
        false,
      );
      state.overflowInterrupted = true;
    }
    await this.failAttempt(
      state.fence,
      "outputOverflow",
      "Journey harness produced more than 64 KiB before start acknowledgement.",
    );
    state.terminalCallbackDelivered = true;
  }

  private queueAttemptCallback(state: AttemptRuntimeState, operation: () => Promise<void>): void {
    const task = state.outputTail.then(operation);
    state.outputTail = task.catch(() => undefined);
    const retrying = task.catch((cause) => {
      if (state.terminalCallbackDelivered) return;
      console.error("Journey reactor callback failed; scheduling deterministic retry.", cause);
      this.clock.schedule(CALLBACK_RETRY_MS, () => this.queueAttemptCallback(state, operation));
    });
    this.enqueueCallback(retrying);
  }

  private clearStartTimer(fence: JourneyAttemptFence): void {
    const key = fenceKey(fence);
    this.startAckTimers.get(key)?.();
    this.startAckTimers.delete(key);
  }

  private clearTerminationTimer(fence: JourneyAttemptFence): void {
    const key = fenceKey(fence);
    this.terminationAckTimers.get(key)?.();
    this.terminationAckTimers.delete(key);
  }

  private enqueueCallback(task: Promise<void>): void {
    const guarded = task
      .catch((cause) => {
        console.error("Journey reactor callback bookkeeping failed.", cause);
      })
      .finally(() => this.pendingCallbacks.delete(guarded));
    this.pendingCallbacks.add(guarded);
  }

  private dispatch(command: OrchestrationCommand): Promise<{ sequence: number }> {
    return this.engine.dispatch(command);
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : String(cause);
}

function retryReactorEffect<A, E, R>(
  label: string,
  make: () => Effect.Effect<A, E, R>,
): Effect.Effect<A, never, R> {
  return make().pipe(
    Effect.catch((cause) =>
      Effect.logError(`Journey reactor ${label} failed; retrying.`, cause).pipe(
        Effect.andThen(Effect.sleep("100 millis")),
        Effect.andThen(Effect.suspend(() => retryReactorEffect(label, make))),
      ),
    ),
  );
}

export const makeJourneyReactor = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const config = yield* ServerConfig;
  const runtime = new JourneyReactorRuntime({
    engine: {
      dispatch: (command) => Effect.runPromise(engine.dispatch(command)),
      getJourneyProjection: (threadId) => Effect.runPromise(engine.getJourneyProjection(threadId)),
      getReadModel: () => Effect.runPromise(engine.getReadModel()),
      beginJourneyRunOutput: (fence) => Effect.runPromise(engine.beginJourneyRunOutput(fence)),
      appendJourneyRunOutput: (fence, data) =>
        Effect.runPromise(engine.appendJourneyRunOutput(fence, data)).then(() => undefined),
      deactivateJourneyRunOutput: (fence) =>
        Effect.runPromise(engine.deactivateJourneyRunOutput(fence)),
    },
    adapter: new JourneyHarnessAdapter(),
    authorizer: journeyAttemptAuthorizer,
    stateDir: config.stateDir,
    toolEndpoint: `http://127.0.0.1:${config.port}/journey-tools`,
  });

  const start: JourneyReactorShape["start"] = Effect.gen(function* () {
    let lastSequence = 0;
    yield* retryReactorEffect("historical replay", () =>
      Stream.runForEach(engine.readEvents(0), (event) =>
        Effect.sync(() => {
          runtime.rememberHistoricalEvent(event);
          lastSequence = Math.max(lastSequence, event.sequence);
        }),
      ),
    );
    yield* retryReactorEffect("startup reconciliation", () =>
      Effect.promise(() => runtime.reconcileStartup()),
    );
    yield* Effect.forkScoped(
      retryReactorEffect("domain event stream", () =>
        Stream.runForEach(engine.streamDomainEvents, (event) =>
          retryReactorEffect(`event ${event.sequence}`, () =>
            Effect.promise(() => runtime.handleEvent(event)),
          ),
        ),
      ),
    );
    yield* retryReactorEffect("catch-up replay", () =>
      Stream.runForEach(engine.readEvents(lastSequence), (event) =>
        retryReactorEffect(`catch-up event ${event.sequence}`, () =>
          Effect.promise(() => runtime.handleEvent(event)),
        ),
      ),
    );
  });

  return { start } satisfies JourneyReactorShape;
});

export const JourneyReactorLive = Layer.effect(JourneyReactor, makeJourneyReactor);
