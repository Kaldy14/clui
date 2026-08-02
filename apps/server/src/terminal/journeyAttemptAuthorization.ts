import crypto from "node:crypto";

import type { JourneyAttemptFence, JourneyCapability, JourneyRunRole } from "@clui/contracts";

interface AttemptCredential {
  readonly tokenHash: string;
  readonly fence: JourneyAttemptFence;
  readonly role: JourneyRunRole;
  readonly capabilities: ReadonlySet<JourneyCapability>;
}

export interface JourneyAttemptGrant {
  readonly token: string;
  readonly fence: JourneyAttemptFence;
  readonly role: JourneyRunRole;
  readonly capabilities: ReadonlyArray<JourneyCapability>;
}

const unauthorized = (): Error => new Error("Unauthorized Journey tool request.");

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function runKey(fence: JourneyAttemptFence): string {
  return `${fence.threadId}\u0000${fence.runId}`;
}

function sameFence(left: JourneyAttemptFence, right: JourneyAttemptFence): boolean {
  return (
    left.threadId === right.threadId &&
    left.runId === right.runId &&
    left.nodeId === right.nodeId &&
    left.attempt === right.attempt
  );
}

const researchForbiddenCapabilities = new Set<JourneyCapability>([
  "graph.mutate",
  "research.start",
  "research.cancel",
  "implementation.start",
  "decision.request",
  "repository.write",
]);

function validateGrant(role: JourneyRunRole, capabilities: ReadonlyArray<JourneyCapability>): void {
  if (
    role === "researchWorker" &&
    capabilities.some((capability) => researchForbiddenCapabilities.has(capability))
  ) {
    throw new Error("Invalid Journey attempt capability grant.");
  }
  if (capabilities.includes("repository.write") && role !== "implementationOwner") {
    throw new Error("Invalid Journey attempt capability grant.");
  }
}

/** In-memory bearer credentials for one physical Journey attempt. Raw tokens are never retained. */
export class JourneyAttemptAuthorizer {
  readonly #credentials = new Map<string, AttemptCredential>();
  readonly #hashesByRun = new Map<string, Set<string>>();

  issue(input: {
    readonly fence: JourneyAttemptFence;
    readonly role: JourneyRunRole;
    readonly capabilities: ReadonlyArray<JourneyCapability>;
  }): JourneyAttemptGrant {
    validateGrant(input.role, input.capabilities);
    this.revokeRun(input.fence);

    const token = crypto.randomBytes(32).toString("base64url");
    const hash = tokenHash(token);
    const credential: AttemptCredential = {
      tokenHash: hash,
      fence: { ...input.fence },
      role: input.role,
      capabilities: new Set(input.capabilities),
    };
    this.#credentials.set(hash, credential);
    this.#hashesByRun.set(runKey(input.fence), new Set([hash]));
    return {
      token,
      fence: { ...input.fence },
      role: credential.role,
      capabilities: [...credential.capabilities],
    };
  }

  authorize(input: {
    readonly token: string | null | undefined;
    readonly fence: JourneyAttemptFence;
    readonly capability: JourneyCapability;
  }): JourneyAttemptFence {
    if (!input.token) throw unauthorized();
    const hash = tokenHash(input.token);
    const credential = this.#credentials.get(hash);
    if (
      !credential ||
      !sameFence(credential.fence, input.fence) ||
      !credential.capabilities.has(input.capability)
    ) {
      throw unauthorized();
    }
    return { ...credential.fence };
  }

  revokeFence(fence: JourneyAttemptFence): void {
    const hashes = this.#hashesByRun.get(runKey(fence));
    if (!hashes) return;
    for (const hash of hashes) {
      const credential = this.#credentials.get(hash);
      if (credential && sameFence(credential.fence, fence)) {
        this.#credentials.delete(hash);
        hashes.delete(hash);
      }
    }
    if (hashes.size === 0) this.#hashesByRun.delete(runKey(fence));
  }

  revokeRun(fence: Pick<JourneyAttemptFence, "threadId" | "runId">): void {
    const hashes = this.#hashesByRun.get(`${fence.threadId}\u0000${fence.runId}`);
    if (!hashes) return;
    for (const hash of hashes) this.#credentials.delete(hash);
    this.#hashesByRun.delete(`${fence.threadId}\u0000${fence.runId}`);
  }

  /** Test-only safe inspection: exposes hashes and grants, never bearer values. */
  inspect(): ReadonlyArray<{
    readonly tokenHash: string;
    readonly fence: JourneyAttemptFence;
    readonly role: JourneyRunRole;
    readonly capabilities: ReadonlyArray<JourneyCapability>;
  }> {
    return [...this.#credentials.values()].map((credential) => ({
      tokenHash: credential.tokenHash,
      fence: { ...credential.fence },
      role: credential.role,
      capabilities: [...credential.capabilities],
    }));
  }
}

export const journeyAttemptAuthorizer = new JourneyAttemptAuthorizer();
