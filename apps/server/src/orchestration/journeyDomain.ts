import type {
  JourneyCoordinatorOutcome,
  JourneyDecisionSubmission,
  JourneyLogicalRun,
  JourneyPhysicalAttempt,
  JourneyProjectionSnapshot,
  JourneyRevisionBoundApproval,
  JourneySteeringItem,
  JourneyReconciliationObservation,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  ThreadId,
} from "@clui/contracts";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  DEFAULT_GLOBAL_RESEARCH_CONCURRENCY,
  DEFAULT_JOURNEY_RESEARCH_CONCURRENCY,
  canonicalJourneyWorkspaceIdentity,
  isJourneyNodeSuccessReady,
  journeyProposalRevisionHash,
  selectJourneyResearchStarts,
  validateJourneyResearchConcurrency,
} from "./journeySchedulerPolicy.ts";

export interface JourneyWaitProjection {
  readonly threadId: ThreadId;
  readonly runId: string;
  readonly nodeId: string;
  readonly waitGeneration: number;
  readonly outcome: JourneyCoordinatorOutcome;
  readonly acceptedWakeGeneration: number | null;
  readonly consumedWakeGeneration: number | null;
}

export interface JourneyPermitProjection {
  readonly permitId: string;
  readonly fence: JourneyPhysicalAttempt["fence"];
}

export interface JourneyWriterLeaseProjection {
  readonly leaseId: string;
  readonly canonicalWorkspaceId: string;
  readonly fence: JourneyPhysicalAttempt["fence"];
}

export interface JourneyDomainThreadProjection {
  readonly threadId: ThreadId;
  readonly journeyRevision: number;
  readonly globalEventWatermark: number;
  readonly runs: ReadonlyArray<JourneyLogicalRun>;
  readonly attempts: ReadonlyArray<JourneyPhysicalAttempt>;
  readonly approvals: ReadonlyArray<JourneyRevisionBoundApproval>;
  readonly decisions: ReadonlyArray<JourneyDecisionSubmission>;
  readonly waits: ReadonlyArray<JourneyWaitProjection>;
  readonly permits: ReadonlyArray<JourneyPermitProjection>;
  readonly writerLeases: ReadonlyArray<JourneyWriterLeaseProjection>;
  readonly steering?: ReadonlyArray<JourneySteeringItem>;
  readonly decidedInteractionIds: ReadonlyArray<string>;
  readonly recoveryAuthorizedRunIds: ReadonlyArray<string>;
  readonly reconciliations: ReadonlyArray<{
    readonly fence: JourneyPhysicalAttempt["fence"];
    readonly observation: JourneyReconciliationObservation;
    readonly detail: string;
    readonly observedAt: string;
  }>;
}

export interface JourneyDomainState {
  readonly threads: ReadonlyArray<JourneyDomainThreadProjection>;
  readonly scheduler?: {
    readonly globalResearchLimit: number;
    readonly journeyResearchLimits: ReadonlyArray<{
      readonly threadId: ThreadId;
      readonly limit: number;
    }>;
    readonly lastAdmittedJourneyId: ThreadId | null;
  };
}

export const createEmptyJourneyDomainState = (): JourneyDomainState => ({
  threads: [],
  scheduler: {
    globalResearchLimit: DEFAULT_GLOBAL_RESEARCH_CONCURRENCY,
    journeyResearchLimits: [],
    lastAdmittedJourneyId: null,
  },
});

export interface JourneyEventSpec {
  readonly type: OrchestrationEvent["type"];
  readonly payload: unknown;
}

const terminalRunStatuses = new Set(["completed", "failed", "cancelled"]);
const observedTerminalRunStatuses = new Set(["completed", "failed", "cancelled", "interrupted"]);
const activeAttemptStatuses = new Set(["starting", "running", "cancelling"]);

function invariant(command: OrchestrationCommand, detail: string) {
  return new OrchestrationCommandInvariantError({ commandType: command.type, detail });
}

function threadProjection(state: JourneyDomainState, threadId: ThreadId) {
  const found = state.threads.find((thread) => thread.threadId === threadId);
  return found ? { ...found, steering: found.steering ?? [] } : null;
}

function schedulerProjection(state: JourneyDomainState) {
  return (
    state.scheduler ?? {
      globalResearchLimit: DEFAULT_GLOBAL_RESEARCH_CONCURRENCY,
      journeyResearchLimits: [],
      lastAdmittedJourneyId: null,
    }
  );
}

function sameRunOwner(
  left: JourneyPhysicalAttempt["fence"],
  right: Pick<JourneyPhysicalAttempt["fence"], "threadId" | "runId">,
) {
  return left.threadId === right.threadId && left.runId === right.runId;
}

function sameFence(left: JourneyPhysicalAttempt["fence"], right: JourneyPhysicalAttempt["fence"]) {
  return (
    sameRunOwner(left, right) && left.nodeId === right.nodeId && left.attempt === right.attempt
  );
}

function descendantRunIds(
  runs: ReadonlyArray<JourneyLogicalRun>,
  rootRunIds: ReadonlySet<string>,
): Set<string> {
  const descendants = new Set(rootRunIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const run of runs) {
      if (descendants.has(run.runId)) continue;
      if (
        (run.parentRunId !== null && descendants.has(run.parentRunId)) ||
        (run.coordinatorRunId !== null && descendants.has(run.coordinatorRunId))
      ) {
        descendants.add(run.runId);
        changed = true;
      }
    }
  }
  return descendants;
}

function commandThreadId(command: OrchestrationCommand): ThreadId | null {
  if ("threadId" in command) return command.threadId;
  if ("parentFence" in command) return command.parentFence.threadId;
  if ("submission" in command && "threadId" in command.submission) {
    return command.submission.threadId;
  }
  if ("fence" in command) return command.fence.threadId;
  return null;
}

function requireJourneyThread(
  command: OrchestrationCommand,
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
) {
  const thread = readModel.threads.find((candidate) => candidate.id === threadId);
  if (thread?.surface !== "journey" || thread.journey === null) {
    throw invariant(command, `Journey thread '${threadId}' is not initialized.`);
  }
  return thread;
}

function requireRun(
  command: OrchestrationCommand,
  state: JourneyDomainState,
  threadId: ThreadId,
  runId: string,
) {
  const run = threadProjection(state, threadId)?.runs.find(
    (candidate) => candidate.runId === runId,
  );
  if (!run) throw invariant(command, `Journey run '${runId}' does not exist.`);
  return run;
}

function requireMatchingFence(command: OrchestrationCommand, state: JourneyDomainState) {
  if (!("fence" in command)) throw invariant(command, "A Journey attempt fence is required.");
  const run = requireRun(command, state, command.fence.threadId, command.fence.runId);
  if (
    run.nodeId !== command.fence.nodeId ||
    run.attempt !== command.fence.attempt ||
    command.fence.attempt <= 0
  ) {
    throw invariant(
      command,
      `Stale Journey attempt fence for run '${command.fence.runId}' (current attempt ${run.attempt}).`,
    );
  }
  const attempt = threadProjection(state, command.fence.threadId)?.attempts.find(
    (candidate) =>
      candidate.fence.runId === command.fence.runId &&
      candidate.fence.attempt === command.fence.attempt,
  );
  if (!attempt) throw invariant(command, "The fenced Journey attempt does not exist.");
  return { run, attempt };
}

function requireNonTerminalFence(command: OrchestrationCommand, state: JourneyDomainState) {
  const current = requireMatchingFence(command, state);
  if (terminalRunStatuses.has(current.run.status) || current.run.status === "interrupted") {
    throw invariant(command, "Normal Journey callbacks cannot target a terminal attempt.");
  }
  if (!activeAttemptStatuses.has(current.attempt.status)) {
    throw invariant(command, "Normal Journey callbacks require a non-terminal attempt.");
  }
  return current;
}

function requireInterruptedReconciliationFence(
  command: OrchestrationCommand,
  state: JourneyDomainState,
) {
  const current = requireMatchingFence(command, state);
  if (current.run.status !== "interrupted" || current.attempt.status !== "interrupted") {
    throw invariant(command, "Reconciliation is only valid for the current interrupted attempt.");
  }
  return current;
}

export function isJourneyWaitReady(
  projection: JourneyDomainThreadProjection,
  readModel: OrchestrationReadModel,
  wait: JourneyWaitProjection,
) {
  if (wait.outcome.kind === "complete") return true;
  if (wait.outcome.kind === "waitForUser") {
    return projection.decidedInteractionIds.includes(wait.outcome.interactionId);
  }
  const journey = readModel.threads.find((thread) => thread.id === wait.threadId)?.journey;
  if (!journey) return false;
  const successfulNodes = wait.outcome.successDependencyNodeIds.every((nodeId) => {
    const status = journey.nodes.find((node) => node.id === nodeId)?.status;
    return status === "completed" || status === "superseded";
  });
  const observedRuns = wait.outcome.observeTerminalRunIds.map((runId) =>
    projection.runs.find((candidate) => candidate.runId === runId),
  );
  const hasNonSuccessObservation = observedRuns.some(
    (run) =>
      run?.status === "failed" || run?.status === "cancelled" || run?.status === "interrupted",
  );
  if (hasNonSuccessObservation) return true;
  const terminalRuns = observedRuns.every((run) => {
    return run !== undefined && observedTerminalRunStatuses.has(run.status);
  });
  if (wait.outcome.observeTerminalRunIds.length > 0 && terminalRuns) return true;
  return wait.outcome.successDependencyNodeIds.length > 0 && successfulNodes;
}

function nextStartEvent(run: JourneyLogicalRun): JourneyEventSpec {
  return {
    type: "journey.attempt-start-requested",
    payload: {
      fence: {
        threadId: run.threadId,
        runId: run.runId,
        nodeId: run.nodeId,
        attempt: run.attempt + 1,
      },
      capabilities: run.capabilities,
    },
  };
}

function interactionWakeEvents(
  projection: JourneyDomainThreadProjection,
  interactionId: string,
  triggerEventSequence: number,
): JourneyEventSpec[] {
  const wait = projection.waits.find(
    (candidate) =>
      candidate.outcome.kind === "waitForUser" &&
      candidate.outcome.interactionId === interactionId &&
      candidate.acceptedWakeGeneration === null,
  );
  if (!wait) return [];
  const run = projection.runs.find((candidate) => candidate.runId === wait.runId);
  if (!run || run.status !== "waitingForUser") return [];
  return [
    {
      type: "journey.wait-wake-accepted",
      payload: {
        fence: {
          threadId: run.threadId,
          runId: run.runId,
          nodeId: run.nodeId,
          attempt: run.attempt,
        },
        waitGeneration: wait.waitGeneration,
        acceptedWakeGeneration: wait.waitGeneration,
        triggerEventSequence,
      },
    },
    nextStartEvent(run),
  ];
}

function terminalReleaseEvents(
  projection: JourneyDomainThreadProjection,
  run: JourneyLogicalRun,
  fence: JourneyPhysicalAttempt["fence"],
): JourneyEventSpec[] {
  return [
    ...projection.permits
      .filter((permit) => sameRunOwner(permit.fence, run))
      .map(
        (permit): JourneyEventSpec => ({
          type: "journey.permit-released",
          payload: { fence, permitId: permit.permitId },
        }),
      ),
    ...projection.writerLeases
      .filter((lease) => sameRunOwner(lease.fence, run))
      .map(
        (lease): JourneyEventSpec => ({
          type: "journey.writer-lease-released",
          payload: {
            fence,
            leaseId: lease.leaseId,
            canonicalWorkspaceId: lease.canonicalWorkspaceId,
          },
        }),
      ),
  ];
}

function attemptPermitReleaseEvents(
  projection: JourneyDomainThreadProjection,
  run: JourneyLogicalRun,
  fence: JourneyPhysicalAttempt["fence"],
): JourneyEventSpec[] {
  return projection.permits
    .filter((permit) => sameRunOwner(permit.fence, run))
    .map((permit) => ({
      type: "journey.permit-released" as const,
      payload: { fence, permitId: permit.permitId },
    }));
}

/**
 * Decides Journey lifecycle and authoritative admission policy. Harness launching
 * remains an adapter concern; this function never performs side effects.
 */
export function decideJourneyCommand(input: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
  readonly state: JourneyDomainState;
}): ReadonlyArray<JourneyEventSpec> | null {
  const { command, readModel, state } = input;
  if (!command.type.startsWith("journey.")) return null;
  const threadId = commandThreadId(command);
  if (threadId === null) throw invariant(command, "Journey command has no thread identity.");
  const thread =
    command.type === "journey.root.start"
      ? readModel.threads.find((candidate) => candidate.id === threadId)
      : requireJourneyThread(command, readModel, threadId);
  if (!thread || thread.surface !== "journey") {
    throw invariant(command, `Journey thread '${threadId}' does not exist.`);
  }
  const projection = threadProjection(state, threadId) ?? {
    threadId,
    journeyRevision: 0,
    globalEventWatermark: 0,
    runs: [],
    attempts: [],
    approvals: [],
    decisions: [],
    waits: [],
    permits: [],
    writerLeases: [],
    steering: [],
    decidedInteractionIds: [],
    recoveryAuthorizedRunIds: [],
    reconciliations: [],
  };

  if (command.type === "journey.root.start") {
    if (thread.journey !== null || projection.runs.length > 0) {
      throw invariant(command, "Journey root can only start once on an empty Journey thread.");
    }
    const nodeId = `goal:${command.commandId}`;
    const runId = `coordinator:${command.commandId}`;
    const capabilities = [
      "graph.read",
      "graph.mutate",
      "research.start",
      "research.read",
      "research.cancel",
      "implementation.start",
      "decision.request",
    ] as const;
    const fence = { threadId, runId, nodeId, attempt: 1 };
    const run: JourneyLogicalRun = {
      threadId,
      runId,
      nodeId,
      role: "coordinator",
      harness: command.harness,
      status: "queued",
      attempt: 0,
      capabilities,
      parentRunId: null,
      coordinatorRunId: null,
      canonicalWorkspaceLeaseId: null,
      outputStreamId: `${threadId}:${runId}`,
      failureReason: null,
      resumableHarnessIdentity: null,
      createdAt: command.createdAt,
      updatedAt: command.createdAt,
    };
    return [
      {
        type: "thread.journey-updated",
        payload: {
          threadId,
          journey: {
            version: 1,
            destination: command.destination,
            layoutDirection: "TB",
            activeNodeId: nodeId,
            nodes: [
              {
                id: nodeId,
                type: "goal",
                status: "draft",
                title: command.destination,
                summary: command.prompt,
                detailMarkdown: "",
                todos: [],
                interaction: null,
                activity: [],
                createdAt: command.createdAt,
                updatedAt: command.createdAt,
              },
            ],
            edges: [],
            updatedAt: command.createdAt,
          },
          updatedAt: command.createdAt,
        },
      },
      { type: "journey.run-requested", payload: { run, prompt: command.prompt } },
      { type: "journey.attempt-start-requested", payload: { fence, capabilities } },
    ];
  }

  const journey = thread.journey!;

  switch (command.type) {
    case "journey.child.start": {
      const parentRun = projection.runs.find(
        (candidate) => candidate.runId === command.parentFence.runId,
      );
      const parentAttempt = projection.attempts.find((candidate) =>
        sameFence(candidate.fence, command.parentFence),
      );
      if (
        !parentRun ||
        parentRun.nodeId !== command.parentFence.nodeId ||
        parentRun.attempt !== command.parentFence.attempt ||
        parentRun.status !== "running" ||
        parentAttempt?.status !== "running"
      ) {
        throw invariant(command, "Child start requires the current running parent attempt.");
      }
      if (projection.runs.some((candidate) => candidate.runId === command.runId)) {
        throw invariant(command, `Journey run '${command.runId}' already exists.`);
      }
      if (journey.nodes.some((candidate) => candidate.id === command.nodeId)) {
        throw invariant(command, `Journey node '${command.nodeId}' already exists.`);
      }
      if (!journey.nodes.some((candidate) => candidate.id === command.parentFence.nodeId)) {
        throw invariant(command, "The parent Journey node no longer exists.");
      }

      const role = command.childKind === "research" ? "researchWorker" : "implementationOwner";
      const capabilities =
        command.childKind === "research"
          ? (["graph.read", "research.read"] as const)
          : (["graph.read", "graph.mutate", "repository.write"] as const);
      if (command.childKind === "research" && command.canonicalWorkspaceIdentity) {
        throw invariant(command, "Research starts cannot claim a writer workspace.");
      }
      if (command.childKind === "implementation" && !command.canonicalWorkspaceIdentity) {
        throw invariant(command, "Implementation starts require a trusted workspace identity.");
      }

      const node = {
        id: command.nodeId,
        type: command.childKind,
        status: "draft" as const,
        title: command.title,
        summary: command.instructions,
        detailMarkdown: "",
        todos: [],
        interaction: null,
        activity: [],
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      };
      const spawnEdge = {
        id: `spawn:${command.parentFence.nodeId}:${command.nodeId}`,
        source: command.parentFence.nodeId,
        target: command.nodeId,
        relation: "spawns" as const,
        label: command.childKind,
      };
      const nextJourney = {
        ...journey,
        nodes: [...journey.nodes, node],
        edges: [...journey.edges, spawnEdge],
        updatedAt: command.createdAt,
      };
      const fence = {
        threadId,
        runId: command.runId,
        nodeId: command.nodeId,
        attempt: 1,
      };
      const run: JourneyLogicalRun = {
        threadId,
        runId: command.runId,
        nodeId: command.nodeId,
        role,
        harness: command.harness,
        status: "queued",
        attempt: 0,
        capabilities,
        parentRunId: parentRun.runId,
        coordinatorRunId: parentRun.coordinatorRunId ?? parentRun.runId,
        canonicalWorkspaceLeaseId: null,
        outputStreamId: `${threadId}:${command.runId}`,
        failureReason: null,
        resumableHarnessIdentity: null,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      };
      const events: JourneyEventSpec[] = [
        {
          type: "thread.journey-updated",
          payload: { threadId, journey: nextJourney, updatedAt: command.createdAt },
        },
        { type: "journey.run-requested", payload: { run, prompt: command.instructions } },
      ];

      let startAttempt = true;
      if (command.childKind === "research") {
        const scheduler = schedulerProjection(state);
        const targetThreads = state.threads.some((candidate) => candidate.threadId === threadId)
          ? state.threads
          : [...state.threads, projection];
        const schedule = selectJourneyResearchStarts({
          journeys: targetThreads.map((candidate) => ({
            threadId: candidate.threadId,
            runs: candidate.threadId === threadId ? [...candidate.runs, run] : candidate.runs,
            researchLimit:
              scheduler.journeyResearchLimits.find(
                (configured) => configured.threadId === candidate.threadId,
              )?.limit ?? DEFAULT_JOURNEY_RESEARCH_CONCURRENCY,
          })),
          globalLimit: scheduler.globalResearchLimit,
          afterJourneyId: scheduler.lastAdmittedJourneyId,
        });
        const admitted = schedule.selected.at(0);
        if (!admitted || !sameRunOwner(fence, admitted)) {
          startAttempt = false;
        } else {
          events.push(
            {
              type: "journey.scheduler-admission-recorded",
              payload: { fence, nextJourneyCursor: threadId },
            },
            {
              type: "journey.permit-claimed",
              payload: { fence, permitId: `research:${threadId}:${command.runId}:1` },
            },
          );
        }
      } else {
        const canonicalWorkspaceIdentity = command.canonicalWorkspaceIdentity!;
        const approvalProposals = journey.nodes.filter(
          (candidate) => candidate.type === "proposal" && candidate.interaction !== null,
        );
        if (approvalProposals.length > 0 || command.proposalRevisionHash !== undefined) {
          if (command.proposalRevisionHash === undefined) {
            throw invariant(command, "Complex repository-write start requires plan approval.");
          }
          const currentProposal = approvalProposals.find(
            (candidate) =>
              journeyProposalRevisionHash(journey, candidate.id) === command.proposalRevisionHash,
          );
          if (!currentProposal) {
            throw invariant(
              command,
              "Repository-write start references a stale proposal revision.",
            );
          }
          const approved = projection.approvals.some(
            (approval) =>
              approval.answer === "approved" &&
              approval.proposalNodeId === currentProposal.id &&
              approval.proposalRevisionHash === command.proposalRevisionHash,
          );
          if (!approved) {
            throw invariant(command, "Repository-write start requires current revision approval.");
          }
        }
        const conflict = state.threads
          .flatMap((candidate) => candidate.writerLeases)
          .find((lease) => lease.canonicalWorkspaceId === canonicalWorkspaceIdentity);
        if (conflict) {
          throw invariant(
            command,
            `Canonical workspace '${canonicalWorkspaceIdentity}' is leased.`,
          );
        }
        events.push({
          type: "journey.writer-lease-claimed",
          payload: {
            fence,
            leaseId: `writer:${canonicalWorkspaceIdentity}:${command.runId}`,
            canonicalWorkspaceId: canonicalWorkspaceIdentity,
          },
        });
      }
      if (startAttempt) {
        events.push({
          type: "journey.attempt-start-requested",
          payload: {
            fence,
            capabilities,
            ...(command.canonicalWorkspaceIdentity
              ? { canonicalWorkspaceId: command.canonicalWorkspaceIdentity }
              : {}),
          },
        });
      }
      return events;
    }

    case "journey.run.request": {
      if (projection.runs.some((run) => run.runId === command.runId)) {
        throw invariant(command, `Journey run '${command.runId}' already exists.`);
      }
      if (!journey.nodes.some((node) => node.id === command.nodeId)) {
        throw invariant(command, `Journey node '${command.nodeId}' does not exist.`);
      }
      if (
        command.parentRunId !== null &&
        !projection.runs.some((run) => run.runId === command.parentRunId)
      ) {
        throw invariant(command, `Parent Journey run '${command.parentRunId}' does not exist.`);
      }
      return [
        {
          type: "journey.run-requested",
          payload: {
            run: {
              threadId,
              runId: command.runId,
              nodeId: command.nodeId,
              role: command.role,
              harness: command.harness,
              status: "queued",
              attempt: 0,
              capabilities: command.capabilities,
              parentRunId: command.parentRunId,
              coordinatorRunId: command.coordinatorRunId,
              canonicalWorkspaceLeaseId: null,
              outputStreamId: `${threadId}:${command.runId}`,
              failureReason: null,
              resumableHarnessIdentity: null,
              createdAt: command.createdAt,
              updatedAt: command.createdAt,
            },
            prompt: command.prompt,
          },
        },
      ];
    }

    case "journey.attempt.start.request": {
      const run = requireRun(command, state, threadId, command.fence.runId);
      if (run.nodeId !== command.fence.nodeId || command.fence.attempt !== run.attempt + 1) {
        throw invariant(command, `Attempt ${command.fence.attempt} is not the next attempt.`);
      }
      const allowed = ["queued", "waitingForDependencies", "waitingForUser"].includes(run.status);
      const recoveryAllowed =
        run.status === "interrupted" && projection.recoveryAuthorizedRunIds.includes(run.runId);
      if (!allowed && !recoveryAllowed) {
        throw invariant(command, `Cannot start Journey run from '${run.status}'.`);
      }
      if (run.status === "waitingForDependencies" || run.status === "waitingForUser") {
        const wait = projection.waits.find((candidate) => candidate.runId === run.runId);
        if (
          !wait ||
          wait.acceptedWakeGeneration !== wait.waitGeneration ||
          wait.consumedWakeGeneration !== null
        ) {
          throw invariant(
            command,
            "A waiting Journey run can start only from its accepted, unconsumed wake generation.",
          );
        }
      }
      if (run.status === "interrupted" && run.role === "implementationOwner") {
        throw invariant(
          command,
          "A write-capable interrupted run cannot be retried automatically.",
        );
      }
      if (
        command.capabilities.length !== run.capabilities.length ||
        command.capabilities.some((capability) => !run.capabilities.includes(capability))
      ) {
        throw invariant(command, "Attempt capabilities must match the logical run grant.");
      }
      if (!isJourneyNodeSuccessReady(journey, run.nodeId)) {
        throw invariant(command, "Journey node dependencies are not ready.");
      }
      const events: JourneyEventSpec[] = [];
      if (run.role === "researchWorker") {
        const scheduler = schedulerProjection(state);
        const schedule = selectJourneyResearchStarts({
          journeys: state.threads.map((candidate) => ({
            threadId: candidate.threadId,
            runs: candidate.runs.filter((candidateRun) => {
              if (candidateRun.status !== "queued") return true;
              const candidateJourney = readModel.threads.find(
                (candidateThread) => candidateThread.id === candidate.threadId,
              )?.journey;
              return (
                candidateJourney !== null &&
                candidateJourney !== undefined &&
                isJourneyNodeSuccessReady(candidateJourney, candidateRun.nodeId)
              );
            }),
            researchLimit:
              scheduler.journeyResearchLimits.find(
                (configured) => configured.threadId === candidate.threadId,
              )?.limit ?? DEFAULT_JOURNEY_RESEARCH_CONCURRENCY,
          })),
          globalLimit: scheduler.globalResearchLimit,
          afterJourneyId: scheduler.lastAdmittedJourneyId,
        });
        const admitted = schedule.selected.at(0);
        if (!admitted || !sameRunOwner(command.fence, admitted)) {
          throw invariant(command, "Research start is not the next fair scheduler admission.");
        }
        events.push({
          type: "journey.scheduler-admission-recorded",
          payload: {
            fence: command.fence,
            nextJourneyCursor: threadId,
          },
        });
        if (!projection.permits.some((permit) => sameRunOwner(permit.fence, run))) {
          events.push({
            type: "journey.permit-claimed",
            payload: {
              fence: command.fence,
              permitId: `research:${threadId}:${run.runId}:${command.fence.attempt}`,
            },
          });
        }
      }
      if (command.capabilities.includes("repository.write")) {
        if (!command.canonicalWorkspaceId) {
          throw invariant(command, "Repository-write attempts require a canonical workspace id.");
        }
        const canonicalWorkspaceId = canonicalJourneyWorkspaceIdentity(
          command.canonicalWorkspaceId,
        );
        const approvalProposals = journey.nodes.filter(
          (node) => node.type === "proposal" && node.interaction !== null,
        );
        if (approvalProposals.length > 0 || command.proposalRevisionHash !== undefined) {
          if (command.proposalRevisionHash === undefined) {
            throw invariant(command, "Complex repository-write start requires plan approval.");
          }
          const currentProposal = approvalProposals.find(
            (node) =>
              journeyProposalRevisionHash(journey, node.id) === command.proposalRevisionHash,
          );
          if (!currentProposal) {
            throw invariant(
              command,
              "Repository-write start references a stale proposal revision.",
            );
          }
          const approved = projection.approvals.some(
            (approval) =>
              approval.answer === "approved" &&
              approval.proposalNodeId === currentProposal.id &&
              approval.proposalRevisionHash === command.proposalRevisionHash,
          );
          if (!approved) {
            throw invariant(command, "Repository-write start requires current revision approval.");
          }
        }
        const conflicting = state.threads
          .flatMap((candidate) => candidate.writerLeases)
          .find(
            (lease) =>
              lease.canonicalWorkspaceId === canonicalWorkspaceId &&
              !sameRunOwner(lease.fence, run),
          );
        if (conflicting) {
          throw invariant(command, `Canonical workspace '${canonicalWorkspaceId}' is leased.`);
        }
        const ownedLease = projection.writerLeases.find((lease) => sameRunOwner(lease.fence, run));
        if (!ownedLease || !sameFence(ownedLease.fence, command.fence)) {
          events.push({
            type: "journey.writer-lease-claimed",
            payload: {
              fence: command.fence,
              leaseId: ownedLease?.leaseId ?? `writer:${canonicalWorkspaceId}:${run.runId}`,
              canonicalWorkspaceId,
            },
          });
        }
      }
      events.push({
        type: "journey.attempt-start-requested",
        payload: {
          fence: command.fence,
          capabilities: command.capabilities,
          ...(command.canonicalWorkspaceId
            ? { canonicalWorkspaceId: command.canonicalWorkspaceId }
            : {}),
        },
      });
      return events;
    }

    case "journey.attempt.started": {
      const { run, attempt } = requireNonTerminalFence(command, state);
      if (run.status !== "starting" || attempt.status !== "starting") {
        throw invariant(command, "Only a starting Journey attempt can acknowledge start.");
      }
      const node = journey.nodes.find((candidate) => candidate.id === run.nodeId);
      return [
        ...(node?.status === "draft"
          ? [
              {
                type: "thread.journey-updated" as const,
                payload: {
                  threadId,
                  journey: {
                    ...journey,
                    nodes: journey.nodes.map((candidate) =>
                      candidate.id === run.nodeId
                        ? { ...candidate, status: "running" as const, updatedAt: command.createdAt }
                        : candidate,
                    ),
                    updatedAt: command.createdAt,
                  },
                  updatedAt: command.createdAt,
                },
              },
            ]
          : []),
        {
          type: "journey.attempt-started",
          payload: {
            fence: command.fence,
            resumableHarnessIdentity: command.resumableHarnessIdentity,
          },
        },
      ];
    }

    case "journey.attempt.quiesce.request": {
      const { run, attempt } = requireNonTerminalFence(command, state);
      const outcome = command.outcome;
      if (run.status !== "running" || attempt.status !== "running") {
        throw invariant(command, "Only a running Journey attempt can quiesce.");
      }
      if (run.role === "researchWorker") {
        throw invariant(command, "Research workers cannot submit coordinator outcomes.");
      }
      const waitGeneration = (projection.waits.at(-1)?.waitGeneration ?? 0) + 1;
      if (outcome.kind === "waitForDependencies") {
        for (const nodeId of outcome.successDependencyNodeIds) {
          if (!journey.nodes.some((node) => node.id === nodeId)) {
            throw invariant(command, `Wait dependency node '${nodeId}' does not exist.`);
          }
        }
        for (const runId of outcome.observeTerminalRunIds) {
          if (!projection.runs.some((candidate) => candidate.runId === runId)) {
            throw invariant(command, `Observed Journey run '${runId}' does not exist.`);
          }
        }
      } else if (outcome.kind === "waitForUser") {
        const decisionNode = journey.nodes.find(
          (node) =>
            node.id === outcome.decisionNodeId && node.interaction?.id === outcome.interactionId,
        );
        if (!decisionNode) {
          throw invariant(command, "Wait-for-user references an unknown decision interaction.");
        }
      }
      return [
        {
          type: "journey.attempt-quiesce-requested",
          payload: {
            fence: command.fence,
            outcome,
            ...(outcome.kind === "complete" ? {} : { waitGeneration }),
          },
        },
      ];
    }

    case "journey.attempt.quiesced": {
      const { run, attempt } = requireNonTerminalFence(command, state);
      if (run.status !== "quiescing" || attempt.status !== "running") {
        throw invariant(command, "Only a quiescing Journey attempt can acknowledge process exit.");
      }
      const outcome = command.outcome;
      const pendingWait = projection.waits.find((wait) => wait.runId === run.runId);
      if (outcome.kind !== "complete" && !pendingWait) {
        throw invariant(command, "Quiescence acknowledgement is missing its durable wait intent.");
      }
      if (pendingWait && JSON.stringify(pendingWait.outcome) !== JSON.stringify(outcome)) {
        throw invariant(
          command,
          "Quiescence acknowledgement does not match the requested outcome.",
        );
      }
      const events: JourneyEventSpec[] = [
        {
          type: "journey.attempt-quiesced",
          payload: { fence: command.fence, outcome },
        },
      ];
      if (outcome.kind === "complete") {
        events.push({
          type: "journey.run-completed",
          payload: { fence: command.fence, status: "completed", reason: outcome.summary },
        });
        events.push(...terminalReleaseEvents(projection, run, command.fence));
        return events;
      }
      const waitGeneration = pendingWait!.waitGeneration;
      const waitStatus =
        outcome.kind === "waitForUser"
          ? "journey.run-waiting-for-user"
          : "journey.run-waiting-for-dependencies";
      events.push({
        type: waitStatus,
        payload: {
          fence: command.fence,
          status: outcome.kind === "waitForUser" ? "waitingForUser" : "waitingForDependencies",
          waitGeneration,
          acceptedWakeGeneration: null,
        },
      });
      if (isJourneyWaitReady(projection, readModel, pendingWait!)) {
        events.push({
          type: "journey.wait-wake-accepted",
          payload: {
            fence: command.fence,
            waitGeneration,
            acceptedWakeGeneration: waitGeneration,
            triggerEventSequence: readModel.snapshotSequence,
          },
        });
        events.push(nextStartEvent(run));
      }
      events.push(...attemptPermitReleaseEvents(projection, run, command.fence));
      return events;
    }

    case "journey.wait.evaluate":
    case "journey.wait.wake": {
      const run = requireRun(command, state, threadId, command.runId);
      const wait = projection.waits.find(
        (candidate) =>
          candidate.runId === command.runId && candidate.waitGeneration === command.waitGeneration,
      );
      if (!wait) throw invariant(command, "Journey wait generation does not exist.");
      const expectedStatus =
        wait.outcome.kind === "waitForUser" ? "waitingForUser" : "waitingForDependencies";
      if (run.status !== expectedStatus || wait.consumedWakeGeneration !== null) {
        throw invariant(command, "Journey run is no longer in the matching wait generation.");
      }
      if (wait.acceptedWakeGeneration !== null) {
        throw invariant(command, "Journey wait generation has already accepted a wake.");
      }
      if (!isJourneyWaitReady(projection, readModel, wait)) {
        throw invariant(command, "Journey wait is not ready.");
      }
      const fence = {
        threadId,
        runId: run.runId,
        nodeId: run.nodeId,
        attempt: run.attempt,
      };
      return [
        {
          type: "journey.wait-wake-accepted",
          payload: {
            fence,
            waitGeneration: command.waitGeneration,
            acceptedWakeGeneration: command.waitGeneration,
            triggerEventSequence: command.triggerEventSequence,
          },
        },
        nextStartEvent(run),
      ];
    }

    case "journey.attempt.result.submit": {
      const { run, attempt } = requireNonTerminalFence(command, state);
      if (run.status !== "running" || attempt.status !== "running") {
        throw invariant(command, "Only a running attempt can submit a result.");
      }
      if (
        (run.role === "researchWorker" && command.result.kind !== "research") ||
        (run.role === "implementationOwner" && command.result.kind !== "implementation") ||
        run.role === "coordinator"
      ) {
        throw invariant(command, `Result kind is invalid for Journey role '${run.role}'.`);
      }
      return [
        {
          type: "journey.attempt-result-accepted",
          payload: {
            fence: command.fence,
            resultSequence: command.resultSequence,
            result: command.result,
          },
        },
        {
          type: "journey.run-completed",
          payload: { fence: command.fence, status: "completed", reason: command.result.summary },
        },
        ...terminalReleaseEvents(projection, run, command.fence),
      ];
    }

    case "journey.attempt.fail": {
      const { run, attempt } = requireNonTerminalFence(command, state);
      if (!activeAttemptStatuses.has(attempt.status) || terminalRunStatuses.has(run.status)) {
        throw invariant(command, "A terminal Journey attempt cannot fail again.");
      }
      if (
        run.status === "cancelling" ||
        command.failureKind === "quiesceTimeout" ||
        command.failureKind === "startAckTimeout"
      ) {
        return [
          {
            type: "journey.run-interrupted",
            payload: {
              fence: command.fence,
              reason: command.reason,
              orphanProcessPossible: true,
            },
          },
        ];
      }
      return [
        {
          type: "journey.attempt-failed",
          payload: {
            fence: command.fence,
            status: "failed",
            failureKind: command.failureKind,
            reason: command.reason,
          },
        },
        {
          type: "journey.run-failed",
          payload: { fence: command.fence, status: "failed", reason: command.reason },
        },
        ...terminalReleaseEvents(projection, run, command.fence),
      ];
    }

    case "journey.run.cancel": {
      const run = requireRun(command, state, threadId, command.runId);
      if (
        run.nodeId !== command.nodeId ||
        terminalRunStatuses.has(run.status) ||
        run.status === "interrupted" ||
        run.status === "cancelling"
      ) {
        throw invariant(command, "Journey run cannot be cancelled from its current state.");
      }
      const targetRunIds = new Set([run.runId]);
      if (run.role === "coordinator") {
        let changed = true;
        while (changed) {
          changed = false;
          for (const candidate of projection.runs) {
            if (
              !targetRunIds.has(candidate.runId) &&
              ((candidate.parentRunId !== null && targetRunIds.has(candidate.parentRunId)) ||
                candidate.coordinatorRunId === run.runId)
            ) {
              targetRunIds.add(candidate.runId);
              changed = true;
            }
          }
        }
      }
      const events: JourneyEventSpec[] = [];
      for (const target of projection.runs
        .filter((candidate) => targetRunIds.has(candidate.runId))
        .toReversed()) {
        if (terminalRunStatuses.has(target.status) || target.status === "interrupted") continue;
        if (
          target.attempt > 0 &&
          (target.status === "waitingForDependencies" || target.status === "waitingForUser")
        ) {
          const targetFence = {
            threadId,
            runId: target.runId,
            nodeId: target.nodeId,
            attempt: target.attempt,
          };
          events.push({
            type: "journey.run-cancelled",
            payload: { fence: targetFence, status: "cancelled", reason: command.reason },
          });
          events.push(...terminalReleaseEvents(projection, target, targetFence));
          continue;
        }
        events.push({
          type: "journey.run-cancellation-requested",
          payload: {
            threadId,
            runId: target.runId,
            nodeId: target.nodeId,
            reason: command.reason,
          },
        });
      }
      return events;
    }

    case "journey.run.cancelled": {
      const { run } = requireMatchingFence(command, state);
      const reconciledAbsent =
        run.status === "interrupted" &&
        projection.reconciliations.some(
          (item) =>
            sameFence(item.fence, command.fence) &&
            ["processAbsent", "processExited", "orphanTerminated"].includes(item.observation),
        );
      if (run.status !== "cancelling" && !reconciledAbsent) {
        throw invariant(command, "Cancellation acknowledgement requires a cancelling run.");
      }
      return [
        {
          type: "journey.run-cancelled",
          payload: { fence: command.fence, status: "cancelled", reason: null },
        },
        ...terminalReleaseEvents(projection, run, command.fence),
      ];
    }

    case "journey.run.interrupt": {
      const { run, attempt } = requireNonTerminalFence(command, state);
      if (terminalRunStatuses.has(run.status) || !activeAttemptStatuses.has(attempt.status)) {
        throw invariant(command, "Only an active Journey attempt can be interrupted.");
      }
      return [
        {
          type: "journey.run-interrupted",
          payload: {
            fence: command.fence,
            reason: command.reason,
            orphanProcessPossible: command.orphanProcessPossible,
          },
        },
      ];
    }

    case "journey.permit.claim": {
      requireNonTerminalFence(command, state);
      if (
        state.threads.some((candidate) =>
          candidate.permits.some((p) => p.permitId === command.permitId),
        )
      ) {
        throw invariant(command, `Journey permit '${command.permitId}' is already claimed.`);
      }
      return [
        {
          type: "journey.permit-claimed",
          payload: { fence: command.fence, permitId: command.permitId },
        },
      ];
    }
    case "journey.permit.release": {
      requireNonTerminalFence(command, state);
      if (
        !projection.permits.some(
          (permit) =>
            permit.permitId === command.permitId && sameFence(permit.fence, command.fence),
        )
      ) {
        throw invariant(command, `Journey permit '${command.permitId}' is not claimed.`);
      }
      return [
        {
          type: "journey.permit-released",
          payload: { fence: command.fence, permitId: command.permitId },
        },
      ];
    }

    case "journey.writer-lease.claim": {
      const { run } = requireNonTerminalFence(command, state);
      if (!run.capabilities.includes("repository.write")) {
        throw invariant(command, "Only a repository-write run can claim a writer lease.");
      }
      const canonicalWorkspaceId = canonicalJourneyWorkspaceIdentity(command.canonicalWorkspaceId);
      const conflict = state.threads
        .flatMap((candidate) => candidate.writerLeases)
        .some(
          (lease) =>
            lease.canonicalWorkspaceId === canonicalWorkspaceId &&
            !sameRunOwner(lease.fence, command.fence),
        );
      if (conflict) throw invariant(command, "Canonical workspace already has a writer lease.");
      return [
        {
          type: "journey.writer-lease-claimed",
          payload: {
            fence: command.fence,
            leaseId: command.leaseId,
            canonicalWorkspaceId,
          },
        },
      ];
    }
    case "journey.writer-lease.release": {
      requireNonTerminalFence(command, state);
      const canonicalWorkspaceId = canonicalJourneyWorkspaceIdentity(command.canonicalWorkspaceId);
      const lease = projection.writerLeases.find(
        (candidate) => candidate.leaseId === command.leaseId,
      );
      if (
        !lease ||
        lease.canonicalWorkspaceId !== canonicalWorkspaceId ||
        !sameFence(lease.fence, command.fence)
      ) {
        throw invariant(command, "Journey writer lease is not held by this run.");
      }
      return [
        {
          type: "journey.writer-lease-released",
          payload: {
            fence: command.fence,
            leaseId: command.leaseId,
            canonicalWorkspaceId,
          },
        },
      ];
    }

    case "journey.scheduler.configure": {
      const scheduler = schedulerProjection(state);
      if (
        command.perJourneyResearchLimit === undefined &&
        command.globalResearchLimit === undefined
      ) {
        throw invariant(command, "Scheduler configuration must change at least one limit.");
      }
      let perJourneyResearchLimit =
        scheduler.journeyResearchLimits.find((entry) => entry.threadId === threadId)?.limit ??
        DEFAULT_JOURNEY_RESEARCH_CONCURRENCY;
      try {
        if (command.perJourneyResearchLimit !== undefined) {
          perJourneyResearchLimit = validateJourneyResearchConcurrency(
            command.perJourneyResearchLimit,
          );
        }
      } catch (error) {
        throw invariant(
          command,
          error instanceof Error ? error.message : "Invalid scheduler limit.",
        );
      }
      const globalResearchLimit = command.globalResearchLimit ?? scheduler.globalResearchLimit;
      if (!Number.isInteger(globalResearchLimit) || globalResearchLimit < 1) {
        throw invariant(command, "Global research concurrency must be a positive integer.");
      }
      return [
        {
          type: "journey.scheduler-configured",
          payload: { threadId, perJourneyResearchLimit, globalResearchLimit },
        },
      ];
    }

    case "journey.steering.enqueue": {
      const run = requireRun(command, state, threadId, command.runId);
      if (run.nodeId !== command.nodeId) {
        throw invariant(command, "Steering target does not match the Journey run node.");
      }
      if (terminalRunStatuses.has(run.status) || run.status === "interrupted") {
        throw invariant(command, "Steering cannot target a terminal Journey run.");
      }
      if (projection.steering.some((item) => item.id === command.itemId)) {
        throw invariant(command, `Journey steering item '${command.itemId}' already exists.`);
      }
      const sequence = Math.max(0, ...projection.steering.map((item) => item.sequence)) + 1;
      return [
        {
          type: "journey.steering-enqueued",
          payload: {
            id: command.itemId,
            threadId,
            runId: run.runId,
            nodeId: run.nodeId,
            prompt: command.prompt,
            sequence,
            status: "queued",
            createdAt: command.createdAt,
            deliveredAt: null,
          },
        },
      ];
    }

    case "journey.steering.acknowledge": {
      requireRun(command, state, threadId, command.runId);
      const next = projection.steering
        .filter((item) => item.runId === command.runId && item.status === "queued")
        .toSorted((left, right) => left.sequence - right.sequence)
        .at(0);
      if (!next || next.id !== command.itemId || next.sequence !== command.sequence) {
        throw invariant(command, "Journey steering delivery must acknowledge the FIFO head.");
      }
      return [
        {
          type: "journey.steering-delivered",
          payload: {
            threadId,
            runId: command.runId,
            itemId: command.itemId,
            sequence: command.sequence,
            deliveredAt: command.createdAt,
          },
        },
      ];
    }

    case "journey.steering.remove": {
      requireRun(command, state, threadId, command.runId);
      const item = projection.steering.find(
        (candidate) =>
          candidate.runId === command.runId &&
          candidate.id === command.itemId &&
          candidate.status === "queued",
      );
      if (!item) throw invariant(command, "Only queued Journey steering can be removed.");
      return [
        {
          type: "journey.steering-removed",
          payload: {
            threadId,
            runId: command.runId,
            itemId: item.id,
            sequence: item.sequence,
            removedAt: command.createdAt,
          },
        },
      ];
    }

    case "journey.node.delete": {
      if (!journey.nodes.some((node) => node.id === command.nodeId)) {
        throw invariant(command, "Journey node does not exist.");
      }
      const rootRunIds = new Set(
        projection.runs.filter((run) => run.nodeId === command.nodeId).map((run) => run.runId),
      );
      const deletionRunIds = descendantRunIds(projection.runs, rootRunIds);
      const deletionRuns = projection.runs.filter(
        (run) => deletionRunIds.has(run.runId) && !terminalRunStatuses.has(run.status),
      );
      if (deletionRuns.length > 0) {
        return [
          {
            type: "journey.node-deletion-requested",
            payload: { threadId, nodeId: command.nodeId, requestedAt: command.createdAt },
          },
          ...deletionRuns
            .toReversed()
            .filter((run) => run.status !== "interrupted" && run.status !== "cancelling")
            .map(
              (run): JourneyEventSpec => ({
                type: "journey.run-cancellation-requested",
                payload: {
                  threadId,
                  runId: run.runId,
                  nodeId: run.nodeId,
                  reason: "Journey node deletion requested.",
                },
              }),
            ),
        ];
      }
      return [
        {
          type: "thread.journey-updated",
          payload: {
            threadId,
            journey: {
              ...journey,
              nodes: journey.nodes.filter((node) => node.id !== command.nodeId),
              edges: journey.edges.filter(
                (edge) => edge.source !== command.nodeId && edge.target !== command.nodeId,
              ),
              activeNodeId: journey.activeNodeId === command.nodeId ? null : journey.activeNodeId,
              updatedAt: command.createdAt,
            },
            updatedAt: command.createdAt,
          },
        },
      ];
    }

    case "journey.decision.submit": {
      const submission = command.submission;
      if (projection.decidedInteractionIds.includes(submission.interactionId)) {
        throw invariant(command, "Journey interaction has already been answered.");
      }
      const decisionNode = journey.nodes.find(
        (node) =>
          node.id === submission.decisionNodeId &&
          node.interaction?.id === submission.interactionId,
      );
      if (!decisionNode) throw invariant(command, "Decision references an unknown interaction.");
      return [
        { type: "journey.decision-recorded", payload: submission },
        ...interactionWakeEvents(projection, submission.interactionId, readModel.snapshotSequence),
      ];
    }

    case "journey.approval.submit": {
      const submission = command.submission;
      if (projection.decidedInteractionIds.includes(submission.interactionId)) {
        throw invariant(command, "Journey interaction has already been answered.");
      }
      const proposalNode = journey.nodes.find((node) => node.id === submission.proposalNodeId);
      if (!proposalNode || proposalNode.interaction?.id !== submission.interactionId) {
        throw invariant(command, "Approval references an unknown proposal interaction.");
      }
      const currentRevisionHash = journeyProposalRevisionHash(journey, submission.proposalNodeId);
      if (currentRevisionHash !== submission.proposalRevisionHash) {
        throw invariant(
          command,
          "Approval does not match the proposal's current material revision.",
        );
      }
      return [
        { type: "journey.approval-recorded", payload: submission },
        ...interactionWakeEvents(projection, submission.interactionId, readModel.snapshotSequence),
      ];
    }

    case "journey.approval.invalidate": {
      const existing = projection.approvals.find(
        (approval) =>
          approval.interactionId === command.interactionId &&
          approval.proposalNodeId === command.proposalNodeId &&
          approval.proposalRevisionHash === command.previousRevisionHash,
      );
      if (!existing)
        throw invariant(command, "The approval revision to invalidate does not exist.");
      return [
        {
          type: "journey.approval-invalidated",
          payload: {
            threadId,
            interactionId: command.interactionId,
            proposalNodeId: command.proposalNodeId,
            previousRevisionHash: command.previousRevisionHash,
            nextRevisionHash: command.nextRevisionHash,
            reason: command.reason,
          },
        },
      ];
    }

    case "journey.reconcile.observe": {
      const { run } = requireInterruptedReconciliationFence(command, state);
      const events: JourneyEventSpec[] = [
        {
          type: "journey.reconciled",
          payload: {
            fence: command.fence,
            observation: command.observation,
            detail: command.detail,
          },
        },
      ];
      if (
        run.role === "researchWorker" &&
        ["processAbsent", "processExited", "orphanTerminated"].includes(command.observation)
      ) {
        events.push(
          ...projection.permits
            .filter((permit) => permit.fence.runId === run.runId)
            .map((permit) => ({
              type: "journey.permit-released" as const,
              payload: { fence: command.fence, permitId: permit.permitId },
            })),
        );
      }
      return events;
    }
  }
  throw invariant(command, `Unsupported Journey command '${command.type}'.`);
}

function replaceRun(
  projection: JourneyDomainThreadProjection,
  runId: string,
  update: (run: JourneyLogicalRun) => JourneyLogicalRun,
) {
  return projection.runs.map((run) => (run.runId === runId ? update(run) : run));
}

function replaceAttempt(
  projection: JourneyDomainThreadProjection,
  runId: string,
  attemptNumber: number,
  update: (attempt: JourneyPhysicalAttempt) => JourneyPhysicalAttempt,
) {
  return projection.attempts.map((attempt) =>
    attempt.fence.runId === runId && attempt.fence.attempt === attemptNumber
      ? update(attempt)
      : attempt,
  );
}

export function projectJourneyEvent(
  state: JourneyDomainState,
  event: OrchestrationEvent,
): JourneyDomainState {
  const threadId = event.aggregateKind === "thread" ? (event.aggregateId as ThreadId) : null;
  if (threadId === null) return state;
  const isJourneyEvent = event.type.startsWith("journey.");
  if (!isJourneyEvent && event.type !== "thread.journey-updated") return state;
  const current = threadProjection(state, threadId) ?? {
    threadId,
    journeyRevision: 0,
    globalEventWatermark: 0,
    runs: [],
    attempts: [],
    approvals: [],
    decisions: [],
    waits: [],
    permits: [],
    writerLeases: [],
    steering: [],
    decidedInteractionIds: [],
    recoveryAuthorizedRunIds: [],
    reconciliations: [],
  };
  let next: JourneyDomainThreadProjection = {
    ...current,
    journeyRevision: current.journeyRevision + 1,
    globalEventWatermark: event.sequence,
  };
  const payload = event.payload as any;
  switch (event.type) {
    case "journey.run-requested":
      next = { ...next, runs: [...next.runs, payload.run] };
      break;
    case "journey.attempt-start-requested": {
      const fence = payload.fence;
      next = {
        ...next,
        runs: replaceRun(next, fence.runId, (run) => ({
          ...run,
          status: "starting",
          attempt: fence.attempt,
          capabilities: payload.capabilities,
          updatedAt: event.occurredAt,
        })),
        attempts: [
          ...next.attempts,
          {
            fence,
            status: "starting",
            capabilities: payload.capabilities,
            credentialId: null,
            startedAt: null,
            completedAt: null,
            failureReason: null,
          },
        ],
        recoveryAuthorizedRunIds: next.recoveryAuthorizedRunIds.filter(
          (runId) => runId !== fence.runId,
        ),
        waits: next.waits.map((wait) =>
          wait.runId === fence.runId &&
          wait.acceptedWakeGeneration === wait.waitGeneration &&
          wait.consumedWakeGeneration === null
            ? { ...wait, consumedWakeGeneration: wait.waitGeneration }
            : wait,
        ),
      };
      break;
    }
    case "journey.attempt-started": {
      const fence = payload.fence;
      next = {
        ...next,
        runs: replaceRun(next, fence.runId, (run) => ({
          ...run,
          status: "running",
          resumableHarnessIdentity: payload.resumableHarnessIdentity,
          updatedAt: event.occurredAt,
        })),
        attempts: replaceAttempt(next, fence.runId, fence.attempt, (attempt) => ({
          ...attempt,
          status: "running",
          startedAt: event.occurredAt,
        })),
      };
      break;
    }
    case "journey.attempt-quiesce-requested": {
      const fence = payload.fence;
      next = {
        ...next,
        runs: replaceRun(next, fence.runId, (run) => ({
          ...run,
          status: "quiescing",
          updatedAt: event.occurredAt,
        })),
        ...(payload.waitGeneration
          ? {
              waits: [
                ...next.waits.filter((wait) => wait.runId !== fence.runId),
                {
                  threadId,
                  runId: fence.runId,
                  nodeId: fence.nodeId,
                  waitGeneration: payload.waitGeneration,
                  outcome: payload.outcome,
                  acceptedWakeGeneration: null,
                  consumedWakeGeneration: null,
                },
              ],
            }
          : {}),
      };
      break;
    }
    case "journey.attempt-quiesced":
      break;
    case "journey.run-waiting-for-dependencies":
    case "journey.run-waiting-for-user": {
      const fence = payload.fence;
      next = {
        ...next,
        runs: replaceRun(next, fence.runId, (run) => ({
          ...run,
          status: payload.status,
          updatedAt: event.occurredAt,
        })),
        attempts: replaceAttempt(next, fence.runId, fence.attempt, (attempt) => ({
          ...attempt,
          status: "completed",
          completedAt: event.occurredAt,
        })),
      };
      break;
    }
    case "journey.wait-wake-accepted":
      next = {
        ...next,
        waits: next.waits.map((wait) =>
          wait.runId === payload.fence.runId && wait.waitGeneration === payload.waitGeneration
            ? { ...wait, acceptedWakeGeneration: payload.acceptedWakeGeneration }
            : wait,
        ),
      };
      break;
    case "journey.attempt-result-accepted":
      break;
    case "journey.attempt-failed": {
      const fence = payload.fence;
      next = {
        ...next,
        attempts: replaceAttempt(next, fence.runId, fence.attempt, (attempt) => ({
          ...attempt,
          status: "failed",
          completedAt: event.occurredAt,
          failureReason: payload.reason,
        })),
      };
      break;
    }
    case "journey.run-completed":
    case "journey.run-failed":
    case "journey.run-cancelled": {
      const fence = payload.fence;
      const status =
        event.type === "journey.run-completed"
          ? "completed"
          : event.type === "journey.run-failed"
            ? "failed"
            : "cancelled";
      next = {
        ...next,
        runs: replaceRun(next, fence.runId, (run) => ({
          ...run,
          status,
          failureReason: status === "failed" ? payload.reason : null,
          updatedAt: event.occurredAt,
        })),
        attempts: replaceAttempt(next, fence.runId, fence.attempt, (attempt) => ({
          ...attempt,
          ...(attempt.status === "completed"
            ? {}
            : {
                status,
                completedAt: event.occurredAt,
                failureReason: status === "failed" ? payload.reason : null,
              }),
        })),
      };
      break;
    }
    case "journey.run-cancellation-requested": {
      const cancellingRun = current.runs.find((run) => run.runId === payload.runId);
      const needsProcessAcknowledgement =
        cancellingRun !== undefined &&
        ["starting", "running", "quiescing"].includes(cancellingRun.status);
      next = {
        ...next,
        runs: replaceRun(next, payload.runId, (run) => ({
          ...run,
          status: needsProcessAcknowledgement ? "cancelling" : "cancelled",
          updatedAt: event.occurredAt,
        })),
        attempts: needsProcessAcknowledgement
          ? replaceAttempt(next, payload.runId, cancellingRun?.attempt ?? 0, (attempt) => ({
              ...attempt,
              status: "cancelling",
            }))
          : next.attempts,
      };
      break;
    }
    case "journey.run-interrupted": {
      const fence = payload.fence;
      next = {
        ...next,
        runs: replaceRun(next, fence.runId, (run) => ({
          ...run,
          status: "interrupted",
          failureReason: payload.reason,
          updatedAt: event.occurredAt,
        })),
        attempts: replaceAttempt(next, fence.runId, fence.attempt, (attempt) => ({
          ...attempt,
          status: "interrupted",
          completedAt: event.occurredAt,
          failureReason: payload.reason,
        })),
      };
      break;
    }
    case "journey.decision-recorded":
      next = {
        ...next,
        decisions: [
          ...next.decisions.filter((decision) => decision.interactionId !== payload.interactionId),
          payload,
        ],
        decidedInteractionIds: [...new Set([...next.decidedInteractionIds, payload.interactionId])],
      };
      break;
    case "journey.approval-recorded":
      next = {
        ...next,
        approvals: [
          ...next.approvals.filter(
            (approval) =>
              approval.interactionId !== payload.interactionId ||
              approval.proposalNodeId !== payload.proposalNodeId,
          ),
          {
            interactionId: payload.interactionId,
            proposalNodeId: payload.proposalNodeId,
            proposalRevisionHash: payload.proposalRevisionHash,
            actor: payload.actor,
            answer: payload.answer,
            timestamp: payload.timestamp,
          },
        ],
        decidedInteractionIds: [...new Set([...next.decidedInteractionIds, payload.interactionId])],
      };
      break;
    case "journey.approval-invalidated":
      next = {
        ...next,
        approvals: next.approvals.filter(
          (approval) =>
            approval.interactionId !== payload.interactionId ||
            approval.proposalNodeId !== payload.proposalNodeId ||
            approval.proposalRevisionHash !== payload.previousRevisionHash,
        ),
      };
      break;
    case "journey.permit-claimed":
      next = {
        ...next,
        permits: [...next.permits, { permitId: payload.permitId, fence: payload.fence }],
      };
      break;
    case "journey.permit-released":
      next = {
        ...next,
        permits: next.permits.filter((permit) => permit.permitId !== payload.permitId),
      };
      break;
    case "journey.writer-lease-claimed":
      next = {
        ...next,
        writerLeases: [
          ...next.writerLeases.filter((lease) => lease.leaseId !== payload.leaseId),
          {
            leaseId: payload.leaseId,
            canonicalWorkspaceId: payload.canonicalWorkspaceId,
            fence: payload.fence,
          },
        ],
        runs: replaceRun(next, payload.fence.runId, (run) => ({
          ...run,
          canonicalWorkspaceLeaseId: payload.leaseId,
        })),
      };
      break;
    case "journey.writer-lease-released":
      next = {
        ...next,
        writerLeases: next.writerLeases.filter((lease) => lease.leaseId !== payload.leaseId),
        runs: replaceRun(next, payload.fence.runId, (run) => ({
          ...run,
          canonicalWorkspaceLeaseId: null,
        })),
      };
      break;
    case "journey.reconciled": {
      const run = next.runs.find((candidate) => candidate.runId === payload.fence.runId);
      next = {
        ...next,
        reconciliations: [
          ...next.reconciliations,
          {
            fence: payload.fence,
            observation: payload.observation,
            detail: payload.detail,
            observedAt: event.occurredAt,
          },
        ],
      };
      if (payload.observation === "reattached") {
        next = {
          ...next,
          runs: replaceRun(next, payload.fence.runId, (candidate) => ({
            ...candidate,
            status: "running",
            failureReason: null,
            updatedAt: event.occurredAt,
          })),
          attempts: replaceAttempt(next, payload.fence.runId, payload.fence.attempt, (attempt) => ({
            ...attempt,
            status: "running",
            completedAt: null,
            failureReason: null,
          })),
        };
      }
      if (
        run &&
        !run.capabilities.includes("repository.write") &&
        ["processAbsent", "processExited", "orphanTerminated"].includes(payload.observation)
      ) {
        next = {
          ...next,
          recoveryAuthorizedRunIds: [
            ...new Set([...next.recoveryAuthorizedRunIds, payload.fence.runId]),
          ],
        };
      }
      break;
    }
    case "journey.scheduler-configured":
      break;
    case "journey.scheduler-admission-recorded":
      break;
    case "journey.steering-enqueued":
      next = { ...next, steering: [...(next.steering ?? []), payload] };
      break;
    case "journey.steering-delivered":
      next = {
        ...next,
        steering: (next.steering ?? []).map((item) =>
          item.id === payload.itemId &&
          item.runId === payload.runId &&
          item.sequence === payload.sequence
            ? Object.assign({}, item, {
                status: "delivered" as const,
                deliveredAt: payload.deliveredAt,
              })
            : item,
        ),
      };
      break;
    case "journey.steering-removed":
      next = {
        ...next,
        steering: (next.steering ?? []).filter(
          (item) =>
            item.id !== payload.itemId ||
            item.runId !== payload.runId ||
            item.sequence !== payload.sequence,
        ),
      };
      break;
    case "journey.node-deletion-requested":
    case "journey.thread-deletion-requested":
      break;
  }
  const scheduler = schedulerProjection(state);
  const nextScheduler =
    event.type === "journey.scheduler-configured"
      ? {
          globalResearchLimit: payload.globalResearchLimit,
          journeyResearchLimits: [
            ...scheduler.journeyResearchLimits.filter(
              (entry) => entry.threadId !== payload.threadId,
            ),
            { threadId: payload.threadId, limit: payload.perJourneyResearchLimit },
          ],
          lastAdmittedJourneyId: scheduler.lastAdmittedJourneyId,
        }
      : event.type === "journey.scheduler-admission-recorded"
        ? { ...scheduler, lastAdmittedJourneyId: payload.nextJourneyCursor }
        : scheduler;
  return {
    ...state,
    scheduler: nextScheduler,
    threads: state.threads.some((candidate) => candidate.threadId === threadId)
      ? state.threads.map((candidate) => (candidate.threadId === threadId ? next : candidate))
      : [...state.threads, next],
  };
}

export function getJourneyProjectionSnapshot(input: {
  readonly state: JourneyDomainState;
  readonly readModel: OrchestrationReadModel;
  readonly threadId: ThreadId;
}): JourneyProjectionSnapshot {
  const thread = input.readModel.threads.find((candidate) => candidate.id === input.threadId);
  if (thread?.surface !== "journey" || thread.journey === null) {
    throw new Error(`Journey thread '${input.threadId}' is not initialized.`);
  }
  const projection = threadProjection(input.state, input.threadId);
  return {
    threadId: input.threadId,
    journeyRevision: projection?.journeyRevision ?? 0,
    globalEventWatermark: input.readModel.snapshotSequence,
    journey: thread.journey,
    runs: projection?.runs ?? [],
    attempts: projection?.attempts ?? [],
    approvals: projection?.approvals ?? [],
    steering: projection?.steering ?? [],
  };
}
