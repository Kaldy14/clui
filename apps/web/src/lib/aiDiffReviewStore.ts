import type {
  OrchestrationDiffReviewScope,
  OrchestrationGenerateDiffReviewResult,
  ThreadId,
} from "@clui/contracts";
import { create } from "zustand";

import { generateDiffReview } from "./providerReactQuery";

export type AiDiffReviewRunStatus = "running" | "done" | "error";

export interface AiDiffReviewRun {
  readonly key: string;
  readonly threadId: ThreadId;
  readonly scope: OrchestrationDiffReviewScope;
  readonly status: AiDiffReviewRunStatus;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
  readonly result: OrchestrationGenerateDiffReviewResult | null;
  readonly error: string | null;
  readonly unread: boolean;
  readonly requestId: number;
}

export interface AiDiffReviewStoreState {
  readonly runsByKey: Record<string, AiDiffReviewRun>;
  readonly latestRunKeyByThreadId: Record<string, string | undefined>;
  readonly startRun: (input: {
    readonly threadId: ThreadId | null;
    readonly scope: OrchestrationDiffReviewScope | null;
  }) => Promise<OrchestrationGenerateDiffReviewResult>;
  readonly markRunSeen: (key: string) => void;
}

const pendingRuns = new Map<string, Promise<OrchestrationGenerateDiffReviewResult>>();
let nextRequestId = 1;

function scopeKey(scope: OrchestrationDiffReviewScope): string {
  switch (scope.type) {
    case "branch":
      return "branch";
    case "workingTree":
      return "workingTree";
    case "turn":
      return `turn:${scope.fromTurnCount}:${scope.toTurnCount}`;
    case "fullThread":
      return `fullThread:${scope.toTurnCount}`;
  }
}

export function diffReviewRunKey(input: {
  readonly threadId: ThreadId | null;
  readonly scope: OrchestrationDiffReviewScope | null;
}): string | null {
  if (!input.threadId || !input.scope) return null;
  return `${input.threadId}:${scopeKey(input.scope)}`;
}

export function selectLatestDiffReviewRunForThread(
  state: Pick<AiDiffReviewStoreState, "runsByKey" | "latestRunKeyByThreadId">,
  threadId: ThreadId | null,
): AiDiffReviewRun | null {
  if (!threadId) return null;
  const key = state.latestRunKeyByThreadId[String(threadId)];
  return key ? (state.runsByKey[key] ?? null) : null;
}

export function formatDiffReviewElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export function diffReviewProgressStage(elapsedMs: number): string {
  if (elapsedMs < 2_000) return "Starting";
  if (elapsedMs < 10_000) return "Collecting diff";
  if (elapsedMs < 30_000) return "Preparing context";
  if (elapsedMs < 90_000) return "Running AI review";
  return "Still running";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "AI review failed.";
}

export const useAiDiffReviewStore = create<AiDiffReviewStoreState>((set) => ({
  runsByKey: {},
  latestRunKeyByThreadId: {},
  startRun: (input) => {
    const key = diffReviewRunKey(input);
    if (!key || !input.threadId || !input.scope) {
      return Promise.reject(new Error("AI review requires a thread and review scope."));
    }

    const pending = pendingRuns.get(key);
    if (pending) return pending;

    const threadKey = String(input.threadId);
    const requestId = nextRequestId++;
    const startedAt = Date.now();
    const run: AiDiffReviewRun = {
      key,
      threadId: input.threadId,
      scope: input.scope,
      status: "running",
      startedAt,
      updatedAt: startedAt,
      completedAt: null,
      result: null,
      error: null,
      unread: false,
      requestId,
    };

    set((state) => ({
      runsByKey: {
        ...state.runsByKey,
        [key]: run,
      },
      latestRunKeyByThreadId: {
        ...state.latestRunKeyByThreadId,
        [threadKey]: key,
      },
    }));

    const promise = generateDiffReview({ threadId: input.threadId, scope: input.scope }).then(
      (result) => {
        pendingRuns.delete(key);
        const completedAt = Date.now();
        set((state) => {
          const current = state.runsByKey[key];
          if (!current || current.requestId !== requestId) return {};
          return {
            runsByKey: {
              ...state.runsByKey,
              [key]: {
                ...current,
                status: "done",
                updatedAt: completedAt,
                completedAt,
                result,
                error: null,
                unread: true,
              },
            },
          };
        });
        return result;
      },
      (error) => {
        pendingRuns.delete(key);
        const completedAt = Date.now();
        set((state) => {
          const current = state.runsByKey[key];
          if (!current || current.requestId !== requestId) return {};
          return {
            runsByKey: {
              ...state.runsByKey,
              [key]: {
                ...current,
                status: "error",
                updatedAt: completedAt,
                completedAt,
                result: null,
                error: errorMessage(error),
                unread: true,
              },
            },
          };
        });
        throw error;
      },
    );

    pendingRuns.set(key, promise);
    void promise.catch(() => undefined);
    return promise;
  },
  markRunSeen: (key) => {
    set((state) => {
      const run = state.runsByKey[key];
      if (!run || !run.unread) return {};
      return {
        runsByKey: {
          ...state.runsByKey,
          [key]: {
            ...run,
            unread: false,
          },
        },
      };
    });
  },
}));
