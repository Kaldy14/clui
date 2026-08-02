import { describe, expect, it } from "vitest";

import {
  buildJourneyAgentPrompt,
  JOURNEY_NODE_EXPANDED_WIDTH,
  JOURNEY_NODE_FOCUSED_WIDTH,
  JOURNEY_NODE_HEIGHT,
  JOURNEY_NODE_WIDTH,
  JOURNEY_LAYER_GAP,
  journeyNodeZIndex,
  layoutJourneyNodes,
  makeInitialJourney,
  nextAutomaticJourneyNodeId,
  parseJourneyAgentResponse,
  settleJourneyAgentSnapshot,
} from "./journeyGraph";

describe("journey graph", () => {
  it("lays dependencies from top to bottom and left to right", () => {
    const initial = makeInitialJourney("Ship journey graphs", "2026-08-02T10:00:00.000Z");
    const snapshot = {
      ...initial,
      nodes: [
        ...initial.nodes,
        {
          ...initial.nodes[0]!,
          id: "review",
          type: "review" as const,
          status: "blocked" as const,
          title: "Review",
        },
      ],
      edges: [
        {
          id: "destination-review",
          source: "destination",
          target: "review",
          relation: "dependsOn" as const,
        },
      ],
    };

    const vertical = layoutJourneyNodes(snapshot, null);
    expect(vertical.find((node) => node.id === "review")!.y).toBeGreaterThan(
      vertical.find((node) => node.id === "destination")!.y,
    );
    const expandedVertical = layoutJourneyNodes(snapshot, "destination");
    expect(expandedVertical.find((node) => node.id === "review")!.y).toBeGreaterThan(
      vertical.find((node) => node.id === "review")!.y,
    );

    const horizontal = layoutJourneyNodes({ ...snapshot, layoutDirection: "LR" }, null);
    expect(horizontal.find((node) => node.id === "review")!.x).toBeGreaterThan(
      horizontal.find((node) => node.id === "destination")!.x,
    );
  });

  it("places the next layer after the rendered node height", () => {
    const initial = makeInitialJourney("Measure expanded nodes", "2026-08-02T10:00:00.000Z");
    const snapshot = {
      ...initial,
      nodes: [...initial.nodes, { ...initial.nodes[0]!, id: "next", title: "Next" }],
      edges: [
        {
          id: "destination-next",
          source: "destination",
          target: "next",
          relation: "dependsOn" as const,
        },
      ],
    };

    const renderedHeight = 236;
    const measured = layoutJourneyNodes(snapshot, "destination", null, {
      destination: renderedHeight,
    });
    const destination = measured.find((node) => node.id === "destination")!;
    const next = measured.find((node) => node.id === "next")!;

    expect(next.y - destination.y).toBe(renderedHeight + JOURNEY_LAYER_GAP);
  });

  it("gives a focused node more space than an expanded node", () => {
    const snapshot = makeInitialJourney("Inspect one node", "2026-08-02T10:00:00.000Z");

    const expanded = layoutJourneyNodes(snapshot, "destination");
    const focused = layoutJourneyNodes(snapshot, "destination", "destination");

    expect(expanded[0]?.width).toBe(JOURNEY_NODE_EXPANDED_WIDTH);
    expect(focused[0]?.width).toBe(JOURNEY_NODE_FOCUSED_WIDTH);
    expect(focused[0]!.height).toBeGreaterThan(expanded[0]!.height);
  });

  it("keeps collapsed nodes compact for overview density", () => {
    const snapshot = makeInitialJourney("Inspect one node", "2026-08-02T10:00:00.000Z");
    const [node] = layoutJourneyNodes(snapshot, null);

    expect(node?.width).toBe(JOURNEY_NODE_WIDTH);
    expect(node?.height).toBe(JOURNEY_NODE_HEIGHT);
    expect(JOURNEY_NODE_WIDTH).toBeLessThan(JOURNEY_NODE_EXPANDED_WIDTH);
    expect(JOURNEY_NODE_HEIGHT).toBeLessThan(100);
  });

  it("keeps expanded and focused nodes above compact graph siblings", () => {
    expect(journeyNodeZIndex(false, false)).toBe(0);
    expect(journeyNodeZIndex(true, false)).toBeGreaterThan(journeyNodeZIndex(false, false));
    expect(journeyNodeZIndex(true, true)).toBeGreaterThan(journeyNodeZIndex(true, false));
  });

  it("parses the tagged agent snapshot", () => {
    const snapshot = makeInitialJourney("Test response", "2026-08-02T10:00:00.000Z");
    const parsed = parseJourneyAgentResponse(
      `<journey-update>${JSON.stringify(snapshot)}</journey-update>`,
    );
    expect(parsed.destination).toBe("Test response");
    expect(parsed.nodes[0]?.id).toBe("destination");
  });

  it("rejects speculative ready nodes from fallback agent responses", () => {
    const snapshot = makeInitialJourney("Test response", "2026-08-02T10:00:00.000Z");
    const placeholder = {
      ...snapshot,
      nodes: [
        ...snapshot.nodes,
        {
          ...snapshot.nodes[0]!,
          id: "future-proposal",
          type: "proposal" as const,
          status: "ready" as const,
          title: "Shape a plan later",
        },
      ],
    };

    expect(() =>
      parseJourneyAgentResponse(`<journey-update>${JSON.stringify(placeholder)}</journey-update>`),
    ).toThrow("speculative Journey nodes");
  });

  it("settles agent-owned running nodes after a response", () => {
    const snapshot = makeInitialJourney("Settle response", "2026-08-02T10:00:00.000Z");
    const settled = settleJourneyAgentSnapshot(snapshot, "2026-08-02T10:01:00.000Z");

    expect(settled.nodes[0]?.status).toBe("ready");
    expect(settled.updatedAt).toBe("2026-08-02T10:01:00.000Z");
    expect(snapshot.nodes[0]?.status).toBe("running");
  });

  it("directs agents to mutate the graph before and after concrete work", () => {
    const snapshot = makeInitialJourney("Show live progress", "2026-08-02T10:00:00.000Z");
    const prompt = buildJourneyAgentPrompt({
      snapshot,
      focusNodeId: "destination",
      userMessage: "Continue",
    });

    expect(prompt).toContain("Call journey_update immediately");
    expect(prompt).toContain("Create it as running first");
    expect(prompt).toContain("Never create roadmap or placeholder nodes");
    expect(prompt).toContain("Continue all non-HITL work autonomously");
    expect(prompt).toContain("must never use draft or ready");
    expect(prompt).toContain("Do not return a <journey-update> snapshot after using the tools");
  });

  it("automatically selects dependency-ready agent work and pauses for HITL", () => {
    const initial = makeInitialJourney("Continue automatically", "2026-08-02T10:00:00.000Z");
    const research = {
      ...initial.nodes[0]!,
      id: "research",
      type: "research" as const,
      status: "ready" as const,
      title: "Inspect the repo",
    };
    const proposal = {
      ...initial.nodes[0]!,
      id: "proposal",
      type: "proposal" as const,
      status: "ready" as const,
      title: "Create the plan",
    };
    const snapshot = {
      ...initial,
      activeNodeId: "proposal",
      nodes: [{ ...initial.nodes[0]!, status: "completed" as const }, research, proposal],
      edges: [
        {
          id: "goal-research",
          source: "destination",
          target: "research",
          relation: "spawns" as const,
        },
        {
          id: "research-proposal",
          source: "research",
          target: "proposal",
          relation: "dependsOn" as const,
        },
      ],
    };

    expect(nextAutomaticJourneyNodeId(snapshot)).toBe("research");
    expect(
      nextAutomaticJourneyNodeId({
        ...snapshot,
        nodes: snapshot.nodes.map((node) =>
          node.id === "research" ? { ...node, status: "completed" as const } : node,
        ),
      }),
    ).toBe("proposal");
    expect(
      nextAutomaticJourneyNodeId({
        ...snapshot,
        nodes: [
          ...snapshot.nodes,
          { ...initial.nodes[0]!, id: "question", status: "waitingForUser" as const },
        ],
      }),
    ).toBeNull();
  });
});
