import {
  CommandId,
  ThreadId,
  type JourneyLogicalRun,
  type JourneyPhysicalAttempt,
  type JourneyProjectionSnapshot,
} from "@clui/contracts";
import { describe, expect, it } from "vitest";

import {
  activeJourneyRuns,
  coordinatorPrompt,
  hasJourneyAgentOutput,
  journeyRootStartCommand,
  journeyInteractionSubmitCommand,
  journeySteeringRemoveCommand,
  latestAttemptFenceForRun,
  latestRunForNode,
  selectJourneySteeringRun,
} from "./journeyProjectionClient";

const threadId = ThreadId.makeUnsafe("journey-projection-ui");
const now = "2026-08-02T12:00:00.000Z";

function run(
  runId: string,
  nodeId: string,
  status: JourneyLogicalRun["status"],
  attempt = 1,
): JourneyLogicalRun {
  return {
    threadId,
    runId,
    nodeId,
    role: "researchWorker",
    harness: "codexCli",
    status,
    attempt,
    capabilities: ["graph.read"],
    parentRunId: "coordinator",
    coordinatorRunId: "coordinator",
    canonicalWorkspaceLeaseId: null,
    outputStreamId: "output-" + runId,
    failureReason: null,
    resumableHarnessIdentity: null,
    createdAt: now,
    updatedAt: now,
  };
}

function projection(runs: JourneyLogicalRun[]): JourneyProjectionSnapshot {
  return {
    threadId,
    journeyRevision: 4,
    globalEventWatermark: 20,
    journey: {
      version: 1,
      destination: "Improve adaptive Journey planning",
      layoutDirection: "TB",
      activeNodeId: "research-a",
      nodes: [],
      edges: [],
      updatedAt: now,
    },
    runs,
    attempts: [],
    approvals: [],
    steering: [],
  };
}

describe("Journey projection UI helpers", () => {
  it("keeps concurrent active runs independent instead of selecting one active node", () => {
    const snapshot = projection([
      run("run-a", "research-a", "running"),
      run("run-b", "research-b", "starting"),
      run("run-c", "research-c", "completed"),
    ]);

    expect(activeJourneyRuns(snapshot).map((item) => item.runId)).toEqual(["run-a", "run-b"]);
    expect(latestRunForNode(snapshot, "research-a")?.status).toBe("running");
    expect(latestRunForNode(snapshot, "research-b")?.status).toBe("starting");
  });

  it("selects the newest physical attempt fence for live output", () => {
    const attempts: JourneyPhysicalAttempt[] = [
      {
        fence: { threadId, runId: "run-a", nodeId: "research-a", attempt: 1 },
        status: "interrupted",
        capabilities: ["graph.read"],
        credentialId: null,
        startedAt: now,
        completedAt: now,
        failureReason: null,
      },
      {
        fence: { threadId, runId: "run-a", nodeId: "research-a", attempt: 2 },
        status: "running",
        capabilities: ["graph.read"],
        credentialId: null,
        startedAt: now,
        completedAt: null,
        failureReason: null,
      },
    ];

    expect(latestAttemptFenceForRun(attempts, "run-a")).toEqual(attempts[1]?.fence);
  });

  it("keeps agent output discoverable after the node run stops", () => {
    const snapshot = projection([run("run-failed", "research-a", "failed")]);
    const node = {
      id: "research-a",
      activity: [],
    } as Pick<JourneyProjectionSnapshot["journey"]["nodes"][number], "id" | "activity">;

    expect(hasJourneyAgentOutput(snapshot, node)).toBe(true);
    expect(hasJourneyAgentOutput(projection([]), node)).toBe(false);
    expect(
      hasJourneyAgentOutput(null, {
        ...node,
        activity: [
          {
            id: "activity-1",
            kind: "agent",
            summary: "Persisted result",
            detailMarkdown: "",
            createdAt: now,
          },
        ],
      }),
    ).toBe(true);
  });

  it("targets node-local steering first and falls back to the active coordinator", () => {
    const coordinator = {
      ...run("coordinator", "goal", "waitingForDependencies"),
      role: "coordinator" as const,
      parentRunId: null,
      coordinatorRunId: null,
      capabilities: ["graph.read", "graph.mutate"] as const,
    };
    const worker = run("worker", "research-a", "running");
    const snapshot = projection([coordinator, worker]);

    expect(selectJourneySteeringRun(snapshot, "research-a")?.runId).toBe("worker");
    expect(selectJourneySteeringRun(snapshot, "unknown-node")?.runId).toBe("coordinator");
  });

  it("encodes adaptive MVP semantics without placeholder roadmap nodes", () => {
    const prompt = coordinatorPrompt("Make onboarding better");
    expect(prompt).toContain("simple, concrete request");
    expect(prompt).toContain("concurrent branches");
    expect(prompt).toContain("wait for approval before repository writes");
    expect(prompt).toContain("never create placeholder");
  });

  it("builds the atomic root start with selected harness and adaptive prompt", () => {
    const command = journeyRootStartCommand({
      commandId: CommandId.makeUnsafe("root-start-command"),
      threadId,
      destination: "Make onboarding better",
      harness: "pi",
      createdAt: now,
    });

    expect(command).toMatchObject({
      type: "journey.root.start",
      threadId,
      destination: "Make onboarding better",
      harness: "pi",
    });
    expect(command.prompt).toBe(coordinatorPrompt("Make onboarding better"));
  });

  it("builds durable steering removal from the projected queue item", () => {
    const command = journeySteeringRemoveCommand({
      commandId: CommandId.makeUnsafe("remove-steering-command"),
      item: {
        id: "steering-1",
        threadId,
        runId: "coordinator",
        nodeId: "goal",
        prompt: "Refine the scope",
        sequence: 1,
        status: "queued",
        createdAt: now,
        deliveredAt: null,
      },
      createdAt: now,
    });

    expect(command).toEqual({
      type: "journey.steering.remove",
      commandId: "remove-steering-command",
      threadId,
      runId: "coordinator",
      itemId: "steering-1",
      createdAt: now,
    });
  });

  it("builds revision-bound approve and reject commands for material proposals", async () => {
    const baseProjection = projection([]);
    const proposalProjection: JourneyProjectionSnapshot = {
      ...baseProjection,
      journey: {
        ...baseProjection.journey,
        nodes: [
          {
            id: "proposal-1",
            type: "proposal",
            status: "waitingForUser",
            title: "Adopt server scheduling",
            summary: "One authority",
            detailMarkdown: "Use durable lifecycle events.",
            todos: [{ id: "todo-1", title: "Implement", completed: false, note: "One writer" }],
            interaction: {
              id: "approval-1",
              title: "Approve proposal",
              description: "Review the material plan.",
              steps: [
                {
                  id: "approval-step",
                  title: "Decision",
                  description: "Approve or reject.",
                  fields: [
                    {
                      id: "decision",
                      type: "singleChoice",
                      label: "Decision",
                      description: "Choose one.",
                      required: true,
                      options: [
                        { value: "approved", label: "Approve", description: "Proceed." },
                        { value: "rejected", label: "Reject", description: "Revise." },
                      ],
                    },
                  ],
                },
              ],
              activeStepId: "approval-step",
              answers: {},
              submitLabel: "Submit",
              submittedAt: null,
            },
            activity: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    };
    const build = (answer: "approved" | "rejected") =>
      journeyInteractionSubmitCommand({
        commandId: CommandId.makeUnsafe("approval-" + answer),
        projection: proposalProjection,
        nodeId: "proposal-1",
        answers: { decision: answer },
        actorId: "clui-user",
        timestamp: now,
      });

    const approved = await build("approved");
    const rejected = await build("rejected");
    expect(approved).toMatchObject({
      type: "journey.approval.submit",
      submission: {
        interactionId: "approval-1",
        proposalNodeId: "proposal-1",
        actor: { kind: "user", id: "clui-user" },
        answer: "approved",
        timestamp: now,
      },
    });
    expect(rejected).toMatchObject({
      type: "journey.approval.submit",
      submission: { answer: "rejected" },
    });
    if (approved.type !== "journey.approval.submit") throw new Error("Expected approval command");
    if (rejected.type !== "journey.approval.submit") throw new Error("Expected approval command");
    expect(approved.submission.proposalRevisionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(rejected.submission.proposalRevisionHash).toBe(approved.submission.proposalRevisionHash);
  });

  it("keeps ordinary questions on the decision path and blocks ambiguous approvals", async () => {
    const baseProjection = projection([]);
    const ordinaryProjection: JourneyProjectionSnapshot = {
      ...baseProjection,
      journey: {
        ...baseProjection.journey,
        nodes: [
          {
            id: "question-1",
            type: "question",
            status: "waitingForUser",
            title: "Choose scope",
            summary: "A real user decision",
            detailMarkdown: "",
            todos: [],
            interaction: {
              id: "decision-1",
              title: "Scope",
              description: "Choose scope.",
              steps: [],
              activeStepId: null,
              answers: {},
              submitLabel: "Submit",
              submittedAt: null,
            },
            activity: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    };
    const decision = await journeyInteractionSubmitCommand({
      commandId: CommandId.makeUnsafe("ordinary-decision"),
      projection: ordinaryProjection,
      nodeId: "question-1",
      answers: { scope: "small" },
      actorId: "clui-user",
      timestamp: now,
    });
    expect(decision).toMatchObject({
      type: "journey.decision.submit",
      submission: {
        interactionId: "decision-1",
        decisionNodeId: "question-1",
        answers: { scope: "small" },
      },
    });

    const ambiguousProjection: JourneyProjectionSnapshot = {
      ...ordinaryProjection,
      journey: {
        ...ordinaryProjection.journey,
        nodes: [{ ...ordinaryProjection.journey.nodes[0]!, type: "proposal" }],
      },
    };
    await expect(
      journeyInteractionSubmitCommand({
        commandId: CommandId.makeUnsafe("ambiguous-approval"),
        projection: ambiguousProjection,
        nodeId: "question-1",
        answers: { scope: "small" },
        actorId: "clui-user",
        timestamp: now,
      }),
    ).rejects.toThrow("Choose Approve or Reject");
  });
});
