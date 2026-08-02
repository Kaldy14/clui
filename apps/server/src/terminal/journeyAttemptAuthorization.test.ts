import type { JourneyAttemptFence } from "@clui/contracts";
import { describe, expect, it } from "vitest";

import { JourneyAttemptAuthorizer } from "./journeyAttemptAuthorization";

const fence = (attempt = 1): JourneyAttemptFence => ({
  threadId: "thread-1" as JourneyAttemptFence["threadId"],
  runId: "run-1",
  nodeId: "node-1",
  attempt,
});

describe("JourneyAttemptAuthorizer", () => {
  it("stores only a hash and authorizes the exact fence and capability", () => {
    const authorizer = new JourneyAttemptAuthorizer();
    const grant = authorizer.issue({
      fence: fence(),
      role: "coordinator",
      capabilities: ["graph.read", "research.start"],
    });

    expect(
      authorizer.authorize({ token: grant.token, fence: fence(), capability: "graph.read" }),
    ).toEqual(fence());
    expect(JSON.stringify(authorizer.inspect())).not.toContain(grant.token);
    expect(authorizer.inspect()[0]?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["missing token", undefined, fence(), "graph.read" as const],
    ["unknown token", "wrong", fence(), "graph.read" as const],
    ["wrong node", null, { ...fence(), nodeId: "other" }, "graph.read" as const],
    ["wrong attempt", null, fence(2), "graph.read" as const],
    ["missing capability", null, fence(), "repository.write" as const],
  ])(
    "rejects %s without revealing credential details",
    (_name, supplied, expectedFence, capability) => {
      const authorizer = new JourneyAttemptAuthorizer();
      const grant = authorizer.issue({
        fence: fence(),
        role: "coordinator",
        capabilities: ["graph.read"],
      });
      expect(() =>
        authorizer.authorize({
          token: supplied === null ? grant.token : supplied,
          fence: expectedFence,
          capability,
        }),
      ).toThrow("Unauthorized Journey tool request.");
    },
  );

  it("rotates per run and rejects revoked and stale-attempt tokens", () => {
    const authorizer = new JourneyAttemptAuthorizer();
    const first = authorizer.issue({
      fence: fence(),
      role: "coordinator",
      capabilities: ["graph.read"],
    });
    const second = authorizer.issue({
      fence: fence(2),
      role: "coordinator",
      capabilities: ["graph.read"],
    });

    expect(() =>
      authorizer.authorize({ token: first.token, fence: fence(), capability: "graph.read" }),
    ).toThrow("Unauthorized Journey tool request.");
    expect(
      authorizer.authorize({ token: second.token, fence: fence(2), capability: "graph.read" }),
    ).toEqual(fence(2));

    authorizer.revokeFence(fence(2));
    expect(() =>
      authorizer.authorize({ token: second.token, fence: fence(2), capability: "graph.read" }),
    ).toThrow("Unauthorized Journey tool request.");
    expect(authorizer.inspect()).toEqual([]);
  });

  it("bounds credential retention to the current attempt and deletes revoked indexes", () => {
    const authorizer = new JourneyAttemptAuthorizer();
    for (let attempt = 1; attempt <= 100; attempt += 1) {
      authorizer.issue({
        fence: fence(attempt),
        role: "coordinator",
        capabilities: ["graph.read"],
      });
    }
    expect(authorizer.inspect()).toHaveLength(1);
    authorizer.revokeRun(fence(100));
    expect(authorizer.inspect()).toEqual([]);
  });

  it("never inherits parent capabilities into a separately issued child token", () => {
    const authorizer = new JourneyAttemptAuthorizer();
    authorizer.issue({
      fence: fence(),
      role: "coordinator",
      capabilities: ["graph.read", "research.start", "implementation.start"],
    });
    const childFence = { ...fence(), runId: "child", nodeId: "child-node" };
    const child = authorizer.issue({
      fence: childFence,
      role: "researchWorker",
      capabilities: ["graph.read", "research.read"],
    });

    expect(() =>
      authorizer.authorize({
        token: child.token,
        fence: childFence,
        capability: "research.start",
      }),
    ).toThrow("Unauthorized Journey tool request.");
  });

  it("rejects research-worker escalation before creating a credential", () => {
    const authorizer = new JourneyAttemptAuthorizer();
    expect(() =>
      authorizer.issue({
        fence: fence(),
        role: "researchWorker",
        capabilities: ["graph.read", "graph.mutate"],
      }),
    ).toThrow("Invalid Journey attempt capability grant.");
    expect(authorizer.inspect()).toEqual([]);
  });
});
