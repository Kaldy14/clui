import { describe, expect, it } from "vitest";

import {
  JOURNEY_NODE_EXPANDED_WIDTH,
  JOURNEY_NODE_FOCUSED_WIDTH,
  JOURNEY_NODE_HEIGHT,
  JOURNEY_NODE_WIDTH,
  JOURNEY_LAYER_GAP,
  journeyNodeZIndex,
  layoutJourneyNodes,
  makeInitialJourney,
  toggleJourneyNodeFocusState,
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

  it("places the next layer after a wrapped collapsed node title", () => {
    const initial = makeInitialJourney(
      "A destination title long enough to wrap across several compact node lines",
      "2026-08-02T10:00:00.000Z",
    );
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

    const wrappedTitleHeight = 96;
    const measured = layoutJourneyNodes(snapshot, null, null, {
      destination: wrappedTitleHeight,
    });
    const destination = measured.find((node) => node.id === "destination")!;
    const next = measured.find((node) => node.id === "next")!;

    expect(next.y - destination.y).toBe(wrappedTitleHeight + JOURNEY_LAYER_GAP);
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

  it("collapses a node when its focused-state return action is used", () => {
    expect(toggleJourneyNodeFocusState("research", null)).toEqual({
      expandedNodeId: "research",
      focusedNodeId: "research",
    });
    expect(toggleJourneyNodeFocusState("research", "research")).toEqual({
      expandedNodeId: null,
      focusedNodeId: null,
    });
  });
});
