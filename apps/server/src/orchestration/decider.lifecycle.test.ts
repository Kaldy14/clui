import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@clui/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider";

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  const now = new Date().toISOString();
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Lifecycle",
    model: "gpt-5.4",
    harness: "codexCli",
    claudeCodeBackend: "anthropic",
    piRenderMode: "terminal",
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    surface: "terminal",
    journey: null,
    branch: null,
    worktreePath: null,
    claudeSessionId: null,
    piSessionFile: null,
    terminalStatus: "dormant",
    scrollbackSnapshot: null,
    titleSource: "auto",
    bookmarked: false,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    lastInteractedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function makeReadModel(thread: OrchestrationThread): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: thread.updatedAt,
    projects: [],
    threads: [thread],
  };
}

async function decide(command: OrchestrationCommand, thread: OrchestrationThread) {
  return Effect.runPromise(
    decideOrchestrationCommand({ command, readModel: makeReadModel(thread) }),
  );
}

function eventTypes(
  event: Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
): string[] {
  return "type" in event ? [event.type] : event.map((entry) => entry.type);
}

describe("lifecycle command decider", () => {
  it("changes the surface only while a thread is new", async () => {
    const draft = makeThread({ terminalStatus: "new" });
    const event = await decide(
      {
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-surface-journey"),
        threadId: draft.id,
        surface: "journey",
      },
      draft,
    );

    expect(eventTypes(event)).toEqual(["thread.meta-updated"]);
    expect("type" in event ? event.payload : null).toMatchObject({ surface: "journey" });

    await expect(
      decide(
        {
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-surface-too-late"),
          threadId: draft.id,
          surface: "journey",
        },
        makeThread({ terminalStatus: "active" }),
      ),
    ).rejects.toThrow("Surface can only be changed before the thread has started");
  });

  it("emits explicit settle and snooze events", async () => {
    const thread = makeThread();
    const settled = await decide(
      {
        type: "thread.settle",
        commandId: CommandId.makeUnsafe("cmd-settle"),
        threadId: thread.id,
      },
      thread,
    );
    expect(eventTypes(settled)).toEqual(["thread.settled"]);

    const snoozedUntil = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const snoozed = await decide(
      {
        type: "thread.snooze",
        commandId: CommandId.makeUnsafe("cmd-snooze"),
        threadId: thread.id,
        snoozedUntil,
      },
      thread,
    );
    expect(eventTypes(snoozed)).toEqual(["thread.snoozed"]);
    expect("type" in snoozed ? snoozed.payload : null).toMatchObject({ snoozedUntil });
  });

  it("rejects settlement while work is running", async () => {
    const thread = makeThread({
      session: {
        threadId: ThreadId.makeUnsafe("thread-1"),
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: new Date().toISOString(),
      },
    });

    await expect(
      decide(
        {
          type: "thread.settle",
          commandId: CommandId.makeUnsafe("cmd-running"),
          threadId: thread.id,
        },
        thread,
      ),
    ).rejects.toThrow("active work");
  });

  it("rejects queued turns and pending approvals", async () => {
    const now = new Date().toISOString();
    const queuedThread = makeThread({
      messages: [
        {
          id: MessageId.makeUnsafe("message-1"),
          role: "user",
          text: "queued",
          attachments: [],
          streaming: false,
          turnId: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    await expect(
      decide(
        {
          type: "thread.settle",
          commandId: CommandId.makeUnsafe("cmd-queued"),
          threadId: queuedThread.id,
        },
        queuedThread,
      ),
    ).rejects.toThrow("queued turn");

    const blockedThread = makeThread({
      activities: [
        {
          id: EventId.makeUnsafe("event-approval"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Approval needed",
          payload: { requestId: "approval-1" },
          turnId: null,
          createdAt: now,
        },
      ],
    });
    await expect(
      decide(
        {
          type: "thread.snooze",
          commandId: CommandId.makeUnsafe("cmd-blocked"),
          threadId: blockedThread.id,
          snoozedUntil: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
        },
        blockedThread,
      ),
    ).rejects.toThrow("waiting on approval or user input");
  });

  it("clears settle and snooze state when a new turn starts", async () => {
    const thread = makeThread({
      settledOverride: "settled",
      settledAt: new Date(Date.now() - 1_000).toISOString(),
      snoozedAt: new Date(Date.now() - 1_000).toISOString(),
      snoozedUntil: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    });
    const event = await decide(
      {
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn"),
        threadId: thread.id,
        message: {
          messageId: MessageId.makeUnsafe("message-turn"),
          role: "user",
          text: "Continue",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: new Date().toISOString(),
      },
      thread,
    );

    expect(eventTypes(event)).toEqual([
      "thread.unsettled",
      "thread.unsnoozed",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
  });
});
