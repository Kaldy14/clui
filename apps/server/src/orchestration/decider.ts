import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_CLAUDE_CODE_BACKEND,
  DEFAULT_THREAD_SURFACE,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@clui/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  listThreadsByProjectId,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadAbsent,
} from "./commandInvariants.ts";

const nowIso = () => new Date().toISOString();
const DEFAULT_ASSISTANT_DELIVERY_MODE = "buffered" as const;
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

const defaultMetadata: Omit<OrchestrationEvent, "sequence" | "type" | "payload"> = {
  eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
  aggregateKind: "thread",
  aggregateId: "" as OrchestrationEvent["aggregateId"],
  occurredAt: nowIso(),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
};

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Omit<OrchestrationEvent, "sequence" | "type" | "payload"> {
  return {
    ...defaultMetadata,
    eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    correlationId: input.commandId,
    metadata: input.metadata ?? {},
  };
}

function activityRequestId(
  activity: OrchestrationReadModel["threads"][number]["activities"][number],
) {
  if (
    typeof activity.payload !== "object" ||
    activity.payload === null ||
    !("requestId" in activity.payload) ||
    typeof activity.payload.requestId !== "string"
  ) {
    return null;
  }
  return activity.payload.requestId;
}

function hasOpenBlockingRequest(thread: OrchestrationReadModel["threads"][number]): boolean {
  const approvals = new Set<string>();
  const userInputs = new Set<string>();
  for (const activity of thread.activities) {
    const requestId = activityRequestId(activity);
    if (requestId === null) continue;
    if (activity.kind === "approval.requested") {
      approvals.add(requestId);
    } else if (
      activity.kind === "approval.resolved" ||
      (activity.kind === "provider.approval.respond.failed" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        "detail" in activity.payload &&
        typeof activity.payload.detail === "string" &&
        activity.payload.detail.includes("Unknown pending permission request"))
    ) {
      approvals.delete(requestId);
    } else if (activity.kind === "user-input.requested") {
      userInputs.add(requestId);
    } else if (activity.kind === "user-input.resolved") {
      userInputs.delete(requestId);
    }
  }
  return approvals.size > 0 || userInputs.size > 0;
}

function hasQueuedTurnStart(
  thread: OrchestrationReadModel["threads"][number],
  now: string,
): boolean {
  const latestUserMessage = thread.messages
    .filter((message) => message.role === "user")
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1);
  if (!latestUserMessage) return false;
  const messageAt = Date.parse(latestUserMessage.createdAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(messageAt) || !Number.isFinite(nowMs)) return false;
  if (Math.abs(nowMs - messageAt) > QUEUED_TURN_START_GRACE_MS) return false;
  if (thread.session?.status === "error") return false;
  if (thread.latestTurn === null) return true;
  return [
    thread.latestTurn.requestedAt,
    thread.latestTurn.startedAt,
    thread.latestTurn.completedAt,
  ].every((candidate) => candidate === null || Date.parse(candidate) < messageAt);
}

function lifecycleThreadError(
  command: OrchestrationCommand,
  detail: string,
): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType: command.type,
    detail,
  });
}

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  OrchestrationCommandInvariantError
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });

      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: expandTilde(command.workspaceRoot),
          defaultModel: command.defaultModel ?? null,
          scripts: [],
          prompts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined
            ? { workspaceRoot: expandTilde(command.workspaceRoot) }
            : {}),
          ...(command.defaultModel !== undefined ? { defaultModel: command.defaultModel } : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          ...(command.prompts !== undefined ? { prompts: command.prompts } : {}),
          ...(command.hiddenAt !== undefined ? { hiddenAt: command.hiddenAt } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      const hasKeptThreads = listThreadsByProjectId(readModel, command.projectId).some(
        (thread) => thread.deletedAt === null,
      );
      if (hasKeptThreads) {
        return {
          ...withEventBase({
            aggregateKind: "project",
            aggregateId: command.projectId,
            occurredAt,
            commandId: command.commandId,
          }),
          type: "project.meta-updated",
          payload: {
            projectId: command.projectId,
            hiddenAt: occurredAt,
            updatedAt: occurredAt,
          },
        };
      }
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.deleted",
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          model: command.model,
          surface: command.surface ?? DEFAULT_THREAD_SURFACE,
          harness: command.harness,
          claudeCodeBackend: command.claudeCodeBackend ?? DEFAULT_CLAUDE_CODE_BACKEND,
          piRenderMode: command.piRenderMode ?? "terminal",
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.settle": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.archivedAt !== null || thread.deletedAt !== null) {
        return yield* lifecycleThreadError(
          command,
          `Thread '${command.threadId}' is archived or deleted and cannot be settled.`,
        );
      }
      if (
        thread.session?.status === "starting" ||
        thread.session?.status === "running" ||
        thread.latestTurn?.state === "running" ||
        thread.hookStatus === "working" ||
        thread.hookStatus === "pendingApproval" ||
        thread.hookStatus === "needsInput"
      ) {
        return yield* lifecycleThreadError(
          command,
          `Thread '${command.threadId}' has active work and cannot be settled.`,
        );
      }
      if (hasOpenBlockingRequest(thread)) {
        return yield* lifecycleThreadError(
          command,
          `Thread '${command.threadId}' is waiting on approval or user input and cannot be settled.`,
        );
      }
      const occurredAt = nowIso();
      if (hasQueuedTurnStart(thread, occurredAt)) {
        return yield* lifecycleThreadError(
          command,
          `Thread '${command.threadId}' has a queued turn and cannot be settled.`,
        );
      }
      const alreadySettled = thread.settledOverride === "settled" && thread.settledAt !== null;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.settled",
        payload: {
          threadId: command.threadId,
          settledAt: alreadySettled ? thread.settledAt : occurredAt,
          updatedAt: alreadySettled ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.unsettle": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.archivedAt !== null || thread.deletedAt !== null) {
        return yield* lifecycleThreadError(
          command,
          `Thread '${command.threadId}' is archived or deleted and cannot be un-settled.`,
        );
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: thread.settledOverride === "active" ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.snooze": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.archivedAt !== null || thread.deletedAt !== null) {
        return yield* lifecycleThreadError(
          command,
          `Thread '${command.threadId}' is archived or deleted and cannot be snoozed.`,
        );
      }
      const occurredAt = nowIso();
      if (!(Date.parse(command.snoozedUntil) > Date.parse(occurredAt))) {
        return yield* lifecycleThreadError(
          command,
          `Thread '${command.threadId}' snooze time must be in the future.`,
        );
      }
      if (
        hasOpenBlockingRequest(thread) ||
        thread.hookStatus === "pendingApproval" ||
        thread.hookStatus === "needsInput"
      ) {
        return yield* lifecycleThreadError(
          command,
          `Thread '${command.threadId}' is waiting on approval or user input and cannot be snoozed.`,
        );
      }
      if (hasQueuedTurnStart(thread, occurredAt)) {
        return yield* lifecycleThreadError(
          command,
          `Thread '${command.threadId}' has a queued turn and cannot be snoozed.`,
        );
      }
      const existingSnoozedAt =
        thread.snoozedUntil === command.snoozedUntil && thread.snoozedAt !== null
          ? thread.snoozedAt
          : null;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.snoozed",
        payload: {
          threadId: command.threadId,
          snoozedUntil: command.snoozedUntil,
          snoozedAt: existingSnoozedAt ?? occurredAt,
          updatedAt: existingSnoozedAt === null ? occurredAt : thread.updatedAt,
        },
      };
    }

    case "thread.unsnooze": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.archivedAt !== null || thread.deletedAt !== null) {
        return yield* lifecycleThreadError(
          command,
          `Thread '${command.threadId}' is archived or deleted and cannot be woken.`,
        );
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.unsnoozed",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: thread.snoozedUntil === null ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.surface !== undefined && thread.terminalStatus !== "new") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Surface can only be changed before the thread has started.",
        });
      }
      if (command.harness !== undefined && thread.terminalStatus !== "new") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Harness can only be changed before the thread has started.",
        });
      }
      if (command.claudeCodeBackend !== undefined && thread.terminalStatus !== "new") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Claude Code backend can only be changed before the thread has started.",
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.surface !== undefined ? { surface: command.surface } : {}),
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.model !== undefined ? { model: command.model } : {}),
          ...(command.harness !== undefined ? { harness: command.harness } : {}),
          ...(command.claudeCodeBackend !== undefined
            ? { claudeCodeBackend: command.claudeCodeBackend }
            : {}),
          ...(command.piRenderMode !== undefined ? { piRenderMode: command.piRenderMode } : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          ...(command.titleSource !== undefined ? { titleSource: command.titleSource } : {}),
          ...(command.bookmarked !== undefined ? { bookmarked: command.bookmarked } : {}),
          ...(command.archivedAt !== undefined ? { archivedAt: command.archivedAt } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.journey.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.surface !== "journey") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Journey snapshots can only be updated on journey threads.",
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.journey-updated",
        payload: {
          threadId: command.threadId,
          journey: command.journey,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.turn.start": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.provider !== undefined ? { provider: command.provider } : {}),
          ...(command.model !== undefined ? { model: command.model } : {}),
          ...(command.modelOptions !== undefined ? { modelOptions: command.modelOptions } : {}),
          ...(command.providerOptions !== undefined
            ? { providerOptions: command.providerOptions }
            : {}),
          assistantDeliveryMode: command.assistantDeliveryMode ?? DEFAULT_ASSISTANT_DELIVERY_MODE,
          runtimeMode:
            readModel.threads.find((entry) => entry.id === command.threadId)?.runtimeMode ??
            command.runtimeMode,
          interactionMode:
            readModel.threads.find((entry) => entry.id === command.threadId)?.interactionMode ??
            command.interactionMode,
          createdAt: command.createdAt,
        },
      };
      const lifecycleResetEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (thread.settledOverride !== null) {
        lifecycleResetEvents.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      if (thread.snoozedUntil !== null) {
        lifecycleResetEvents.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      return [...lifecycleResetEvents, userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.turn.interrupt": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sessionSetEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
      const isSessionActivity =
        command.session.status === "starting" || command.session.status === "running";
      if (thread.settledOverride === null || !isSessionActivity) {
        return sessionSetEvent;
      }
      return [
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        },
        sessionSetEvent,
      ];
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      const activityAppendedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        }),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
      const wakesSettledThread =
        command.activity.kind === "approval.requested" ||
        command.activity.kind === "user-input.requested";
      if (thread.settledOverride === null || !wakesSettledThread) {
        return activityAppendedEvent;
      }
      return [
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        },
        activityAppendedEvent,
      ];
    }

    case "thread.turn.usage.update": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-usage-updated",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          inputTokens: command.inputTokens,
          outputTokens: command.outputTokens,
          cacheReadTokens: command.cacheReadTokens,
          cacheWriteTokens: command.cacheWriteTokens,
          totalCostUsd: command.totalCostUsd,
          model: command.model,
        },
      };
    }

    case "thread.terminal.statusChanged": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.updatedAt,
          commandId: command.commandId,
        }),
        type: "thread.terminal-status-changed",
        payload: {
          threadId: command.threadId,
          terminalStatus: command.terminalStatus,
          claudeSessionId: command.claudeSessionId,
          piSessionFile: command.piSessionFile,
          updatedAt: command.updatedAt,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});

function expandTilde(filePath: string): string {
  if (filePath.startsWith("~/") || filePath === "~") {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}
