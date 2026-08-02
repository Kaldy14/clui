import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ThreadId, type JourneyLogicalRun, type JourneySnapshot } from "@clui/contracts";
import { describe, expect, it } from "vitest";

import {
  acknowledgeJourneySteering,
  canonicalJourneyWorkspaceIdentity,
  enqueueJourneySteering,
  isJourneyNodeSuccessReady,
  journeyProposalRevisionHash,
  nextJourneySteering,
  selectJourneyResearchStarts,
  validateJourneyResearchConcurrency,
} from "./journeySchedulerPolicy.ts";

const now = "2026-08-02T12:00:00.000Z";
const thread = (id: string) => ThreadId.makeUnsafe(id);

function researchRun(input: {
  threadId: ThreadId;
  runId: string;
  status?: JourneyLogicalRun["status"];
  createdAt?: string;
}): JourneyLogicalRun {
  return {
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.runId,
    role: "researchWorker",
    harness: "codexCli",
    status: input.status ?? "queued",
    attempt: input.status === undefined || input.status === "queued" ? 0 : 1,
    capabilities: ["graph.read", "research.read"],
    parentRunId: null,
    coordinatorRunId: null,
    canonicalWorkspaceLeaseId: null,
    outputStreamId: input.runId,
    failureReason: null,
    resumableHarnessIdentity: null,
    createdAt: input.createdAt ?? now,
    updatedAt: input.createdAt ?? now,
  };
}

function snapshot(): JourneySnapshot {
  const node = (id: string, status: JourneySnapshot["nodes"][number]["status"]) => ({
    id,
    type: id === "proposal" ? ("proposal" as const) : ("research" as const),
    status,
    title: id,
    summary: "summary",
    detailMarkdown: "detail",
    todos: [{ id: "todo", title: "Todo", completed: false, note: "note" }],
    interaction:
      id === "proposal"
        ? {
            id: "approval",
            title: "Approve",
            description: "Approve plan",
            steps: [],
            activeStepId: null,
            answers: {},
            submittedAt: null,
            submitLabel: "Approve",
          }
        : null,
    activity: [],
    createdAt: now,
    updatedAt: now,
  });
  return {
    version: 1,
    destination: "Ship",
    layoutDirection: "TB",
    activeNodeId: "proposal",
    nodes: [node("research", "completed"), node("proposal", "completed")],
    edges: [{ id: "dependency", source: "research", target: "proposal", relation: "dependsOn" }],
    updatedAt: now,
  };
}

describe("Journey scheduler safety policy", () => {
  it("validates per-Journey bounds and separates successful readiness from non-gating edges", () => {
    expect(validateJourneyResearchConcurrency(1)).toBe(1);
    expect(validateJourneyResearchConcurrency(4)).toBe(4);
    expect(() => validateJourneyResearchConcurrency(0)).toThrow("between 1 and 4");
    const readyTarget = snapshot();
    expect(
      isJourneyNodeSuccessReady(
        {
          ...readyTarget,
          nodes: readyTarget.nodes.map((node) =>
            node.id === "proposal" ? Object.assign({}, node, { status: "ready" as const }) : node,
          ),
        },
        "proposal",
      ),
    ).toBe(true);
    const original = snapshot();
    const failed: JourneySnapshot = {
      ...original,
      nodes: original.nodes.map((node, index) =>
        index === 0 ? { ...node, status: "failed" as const } : node,
      ),
      edges: [
        ...original.edges,
        {
          id: "presentation",
          source: "proposal",
          target: "research",
          relation: "relatesTo",
        },
      ],
    };
    expect(isJourneyNodeSuccessReady(failed, "proposal")).toBe(false);
  });

  it("selects round-robin across Journeys and FIFO within each while respecting both caps", () => {
    const a = thread("a");
    const b = thread("b");
    const result = selectJourneyResearchStarts({
      journeys: [
        {
          threadId: a,
          runs: [
            researchRun({ threadId: a, runId: "a-1", createdAt: "2026-08-02T10:00:00Z" }),
            researchRun({ threadId: a, runId: "a-2", createdAt: "2026-08-02T11:00:00Z" }),
          ],
        },
        {
          threadId: b,
          runs: [
            researchRun({ threadId: b, runId: "b-active", status: "running" }),
            researchRun({ threadId: b, runId: "b-1" }),
          ],
        },
      ],
      perJourneyLimit: 2,
      globalLimit: 4,
      afterJourneyId: a,
    });
    expect(result.selected.map((run) => run.runId)).toEqual(["b-1", "a-1", "a-2"]);
    expect(result.nextJourneyCursor).toBe(a);
  });

  it("canonicalizes symlink aliases while keeping separate worktree roots distinct", () => {
    const root = mkdtempSync(join(tmpdir(), "clui-journey-policy-"));
    try {
      const checkout = join(root, "checkout");
      const worktree = join(root, "worktree");
      const alias = join(root, "alias");
      mkdirSync(checkout);
      mkdirSync(worktree);
      symlinkSync(checkout, alias);
      expect(canonicalJourneyWorkspaceIdentity(alias)).toBe(
        canonicalJourneyWorkspaceIdentity(checkout),
      );
      expect(canonicalJourneyWorkspaceIdentity(worktree)).not.toBe(
        canonicalJourneyWorkspaceIdentity(checkout),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the workspace root cannot be canonicalized", () => {
    const root = mkdtempSync(join(tmpdir(), "clui-journey-policy-missing-"));
    try {
      expect(() => canonicalJourneyWorkspaceIdentity(join(root, "missing"))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hashes only material proposal content and scheduling dependencies", () => {
    const base = snapshot();
    const hash = journeyProposalRevisionHash(base, "proposal");
    const progressSource = snapshot();
    const progressOnly: JourneySnapshot = {
      ...progressSource,
      nodes: progressSource.nodes.map((node) =>
        node.id === "proposal"
          ? Object.assign({}, node, {
              status: "waitingForUser" as const,
              updatedAt: "2026-08-02T13:00:00Z",
              todos: node.todos.map((todo) => ({ ...todo, completed: true })),
              interaction: {
                ...node.interaction!,
                answers: { approved: true },
                submittedAt: now,
              },
            })
          : node,
      ),
    };
    expect(journeyProposalRevisionHash(progressOnly, "proposal")).toBe(hash);
    const materialSource = snapshot();
    const material: JourneySnapshot = {
      ...materialSource,
      nodes: materialSource.nodes.map((node) =>
        node.id === "proposal" ? Object.assign({}, node, { summary: "changed scope" }) : node,
      ),
    };
    expect(journeyProposalRevisionHash(material, "proposal")).not.toBe(hash);
  });

  it("retains steering in FIFO order and deduplicates retries", () => {
    let queue = enqueueJourneySteering([], {
      id: "one",
      threadId: thread("a"),
      runId: "run",
      prompt: "first",
    });
    queue = enqueueJourneySteering(queue, {
      id: "two",
      threadId: thread("a"),
      runId: "run",
      prompt: "second",
    });
    queue = enqueueJourneySteering(queue, {
      id: "one",
      threadId: thread("a"),
      runId: "run",
      prompt: "duplicate",
    });
    expect(queue).toHaveLength(2);
    expect(nextJourneySteering(queue, "run")?.id).toBe("one");
    expect(() => acknowledgeJourneySteering(queue, "two")).toThrow("FIFO order");
    queue = acknowledgeJourneySteering(queue, "one");
    expect(nextJourneySteering(queue, "run")?.id).toBe("two");
  });
});
