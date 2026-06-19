import {
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetTurnDiffInput,
  ThreadId,
  type OrchestrationDiffReviewScope,
} from "@clui/contracts";
import { queryOptions } from "@tanstack/react-query";
import { Option, Schema } from "effect";
import { ensureNativeApi } from "../nativeApi";

interface CheckpointDiffQueryInput {
  threadId: ThreadId | null;
  fromTurnCount: number | null;
  toTurnCount: number | null;
  cacheScope?: string | null;
  enabled?: boolean;
}

export const providerQueryKeys = {
  all: ["providers"] as const,
  checkpointDiff: (input: CheckpointDiffQueryInput) =>
    [
      "providers",
      "checkpointDiff",
      input.threadId,
      input.fromTurnCount,
      input.toTurnCount,
      input.cacheScope ?? null,
    ] as const,
  workingTreeDiff: (threadId: ThreadId | null) =>
    ["providers", "workingTreeDiff", threadId] as const,
  diffReview: (threadId: ThreadId | null, scope: OrchestrationDiffReviewScope | null) =>
    ["providers", "diffReview", threadId, scope] as const,
};

function decodeCheckpointDiffRequest(input: CheckpointDiffQueryInput) {
  if (input.fromTurnCount === 0) {
    return Schema.decodeUnknownOption(OrchestrationGetFullThreadDiffInput)({
      threadId: input.threadId,
      toTurnCount: input.toTurnCount,
    }).pipe(Option.map((fields) => ({ kind: "fullThreadDiff" as const, input: fields })));
  }

  return Schema.decodeUnknownOption(OrchestrationGetTurnDiffInput)({
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
  }).pipe(Option.map((fields) => ({ kind: "turnDiff" as const, input: fields })));
}

function asCheckpointErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "";
}

function normalizeCheckpointErrorMessage(error: unknown): string {
  const message = asCheckpointErrorMessage(error).trim();
  if (message.length === 0) {
    return "Failed to load checkpoint diff.";
  }

  const lower = message.toLowerCase();
  if (lower.includes("not a git repository")) {
    return "Turn diffs are unavailable because this project is not a git repository.";
  }

  if (
    lower.includes("checkpoint unavailable for thread") ||
    lower.includes("checkpoint invariant violation")
  ) {
    const separatorIndex = message.indexOf(":");
    if (separatorIndex >= 0) {
      const detail = message.slice(separatorIndex + 1).trim();
      if (detail.length > 0) {
        return detail;
      }
    }
  }

  return message;
}

function isCheckpointTemporarilyUnavailable(error: unknown): boolean {
  const message = asCheckpointErrorMessage(error).toLowerCase();
  return (
    message.includes("exceeds current turn count") ||
    message.includes("checkpoint is unavailable for turn") ||
    message.includes("filesystem checkpoint is unavailable")
  );
}

export function checkpointDiffQueryOptions(input: CheckpointDiffQueryInput) {
  const decodedRequest = decodeCheckpointDiffRequest(input);

  return queryOptions({
    queryKey: providerQueryKeys.checkpointDiff(input),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.threadId || decodedRequest._tag === "None") {
        throw new Error("Checkpoint diff is unavailable.");
      }
      try {
        if (decodedRequest.value.kind === "fullThreadDiff") {
          return await api.orchestration.getFullThreadDiff(decodedRequest.value.input);
        }
        return await api.orchestration.getTurnDiff(decodedRequest.value.input);
      } catch (error) {
        throw new Error(normalizeCheckpointErrorMessage(error), { cause: error });
      }
    },
    enabled: (input.enabled ?? true) && !!input.threadId && decodedRequest._tag === "Some",
    staleTime: Infinity,
    gcTime: 30_000, // free diff data 30s after the component unmounts
    retry: (failureCount, error) => {
      if (isCheckpointTemporarilyUnavailable(error)) {
        return failureCount < 12;
      }
      return failureCount < 3;
    },
    retryDelay: (attempt, error) =>
      isCheckpointTemporarilyUnavailable(error)
        ? Math.min(5_000, 250 * 2 ** (attempt - 1))
        : Math.min(1_000, 100 * 2 ** (attempt - 1)),
  });
}

const DIFF_REVIEW_CLIENT_TIMEOUT_MS = 10 * 60_000 + 45_000;

function withClientTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        globalThis.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export async function generateDiffReview(input: {
  threadId: ThreadId | null;
  scope: OrchestrationDiffReviewScope | null;
}) {
  const api = ensureNativeApi();
  if (!input.threadId || !input.scope) {
    throw new Error("AI review requires a thread and review scope.");
  }
  return await withClientTimeout(
    api.orchestration.generateDiffReview({
      threadId: input.threadId,
      scope: input.scope,
    }),
    DIFF_REVIEW_CLIENT_TIMEOUT_MS,
    "AI review timed out while waiting for pi. You can retry from the AI Review workbench.",
  );
}

export function generateDiffReviewQueryOptions(input: {
  threadId: ThreadId | null;
  scope: OrchestrationDiffReviewScope | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: providerQueryKeys.diffReview(input.threadId, input.scope),
    queryFn: async () => generateDiffReview(input),
    enabled: (input.enabled ?? false) && !!input.threadId && !!input.scope,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: false,
  });
}

export function workingTreeDiffQueryOptions(input: {
  threadId: ThreadId | null;
  enabled?: boolean;
  refetchIntervalMs?: number | false;
}) {
  return queryOptions({
    queryKey: providerQueryKeys.workingTreeDiff(input.threadId),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.threadId) {
        throw new Error("Working tree diff requires a thread ID.");
      }
      return await api.orchestration.getWorkingTreeDiff({ threadId: input.threadId });
    },
    enabled: (input.enabled ?? true) && !!input.threadId,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: input.refetchIntervalMs ?? false,
    gcTime: 60_000, // free diff data 60s after the component unmounts
    retry: 2,
  });
}
