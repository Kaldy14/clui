import { describe, expect, it } from "vitest";

import { applyJourneyMutation } from "./journeyMutation";

const startedAt = "2026-08-02T10:00:00.000Z";
const updatedAt = "2026-08-02T10:01:00.000Z";

function initialJourney() {
  return {
    version: 1 as const,
    destination: "Ship live journeys",
    layoutDirection: "TB" as const,
    activeNodeId: "goal",
    nodes: [
      {
        id: "goal",
        type: "goal" as const,
        status: "running" as const,
        title: "Ship live journeys",
        summary: "Starting",
        detailMarkdown: "",
        todos: [],
        interaction: null,
        activity: [],
        createdAt: startedAt,
        updatedAt: startedAt,
      },
    ],
    edges: [],
    updatedAt: startedAt,
  };
}

describe("applyJourneyMutation", () => {
  it("upserts nodes and edges while preserving existing creation timestamps", () => {
    const snapshot = applyJourneyMutation(
      initialJourney(),
      {
        nodes: [
          {
            ...initialJourney().nodes[0]!,
            status: "completed",
            summary: "Mapped the work",
            createdAt: updatedAt,
            updatedAt,
          },
          {
            id: "research",
            type: "research",
            status: "running",
            title: "Inspect the repository",
            summary: "Reading the current implementation",
            detailMarkdown: "",
            todos: [],
            interaction: null,
            activity: [],
            createdAt: updatedAt,
            updatedAt,
          },
        ],
        edges: [
          {
            id: "goal-research",
            source: "goal",
            target: "research",
            relation: "spawns",
          },
        ],
        activeNodeId: "research",
      },
      updatedAt,
    );

    expect(snapshot.nodes).toHaveLength(2);
    expect(snapshot.nodes[0]).toMatchObject({
      id: "goal",
      status: "completed",
      createdAt: startedAt,
      updatedAt,
    });
    expect(snapshot.edges).toEqual([
      { id: "goal-research", source: "goal", target: "research", relation: "spawns" },
    ]);
    expect(snapshot.activeNodeId).toBe("research");
    expect(snapshot.updatedAt).toBe(updatedAt);
  });

  it("removes incident edges and clears a removed active node", () => {
    const withResearch = applyJourneyMutation(
      initialJourney(),
      {
        nodes: [
          {
            id: "research",
            type: "research",
            status: "ready",
            title: "Research",
            summary: "",
            detailMarkdown: "",
            todos: [],
            interaction: null,
            activity: [],
            createdAt: startedAt,
            updatedAt: startedAt,
          },
        ],
        edges: [{ id: "goal-research", source: "goal", target: "research", relation: "spawns" }],
        activeNodeId: "research",
      },
      updatedAt,
    );

    const removed = applyJourneyMutation(
      withResearch,
      { removeNodeIds: ["research"] },
      "2026-08-02T10:02:00.000Z",
    );

    expect(removed.nodes.map((node) => node.id)).toEqual(["goal"]);
    expect(removed.edges).toEqual([]);
    expect(removed.activeNodeId).toBeNull();
  });

  it("rejects edges that reference missing nodes", () => {
    expect(() =>
      applyJourneyMutation(
        initialJourney(),
        {
          edges: [{ id: "missing-edge", source: "goal", target: "missing", relation: "dependsOn" }],
        },
        updatedAt,
      ),
    ).toThrow("references missing node 'missing'");
  });
});
