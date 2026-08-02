import { describe, expect, it } from "vitest";

import {
  JOURNEY_NODE_EXPANDED_WIDTH,
  JOURNEY_NODE_FOCUSED_WIDTH,
  layoutJourneyNodes,
  makeInitialJourney,
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

    const horizontal = layoutJourneyNodes({ ...snapshot, layoutDirection: "LR" }, null);
    expect(horizontal.find((node) => node.id === "review")!.x).toBeGreaterThan(
      horizontal.find((node) => node.id === "destination")!.x,
    );
  });

  it("gives a focused node more space than an expanded node", () => {
    const snapshot = makeInitialJourney("Inspect one node", "2026-08-02T10:00:00.000Z");

    const expanded = layoutJourneyNodes(snapshot, "destination");
    const focused = layoutJourneyNodes(snapshot, "destination", "destination");

    expect(expanded[0]?.width).toBe(JOURNEY_NODE_EXPANDED_WIDTH);
    expect(focused[0]?.width).toBe(JOURNEY_NODE_FOCUSED_WIDTH);
    expect(focused[0]!.height).toBeGreaterThan(expanded[0]!.height);
  });

  it("parses the tagged agent snapshot", () => {
    const snapshot = makeInitialJourney("Test response", "2026-08-02T10:00:00.000Z");
    const parsed = parseJourneyAgentResponse(
      `<journey-update>${JSON.stringify(snapshot)}</journey-update>`,
    );
    expect(parsed.destination).toBe("Test response");
    expect(parsed.nodes[0]?.id).toBe("destination");
  });

  it("settles agent-owned running nodes after a response", () => {
    const snapshot = makeInitialJourney("Settle response", "2026-08-02T10:00:00.000Z");
    const settled = settleJourneyAgentSnapshot(snapshot);

    expect(settled.nodes[0]?.status).toBe("ready");
    expect(snapshot.nodes[0]?.status).toBe("running");
  });
});
