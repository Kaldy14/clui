import type {
  JourneyAttemptFence,
  NativeApi,
  OrchestrationJourneyRunOutputPush,
} from "@clui/contracts";

export interface JourneyRunOutputState {
  readonly data: string;
  readonly firstCursor: number;
  readonly nextCursor: number;
  readonly reset: boolean;
}

function sameFence(left: JourneyAttemptFence, right: JourneyAttemptFence): boolean {
  return (
    left.threadId === right.threadId &&
    left.runId === right.runId &&
    left.nodeId === right.nodeId &&
    left.attempt === right.attempt
  );
}

function pushRange(push: OrchestrationJourneyRunOutputPush): {
  readonly startCursor: number;
  readonly endCursor: number;
  readonly reset: boolean;
  readonly data: string;
} {
  if ("startCursor" in push) {
    return {
      startCursor: push.startCursor,
      endCursor: push.endCursor,
      reset: false,
      data: push.data,
    };
  }
  return {
    startCursor: push.firstCursor,
    endCursor: push.nextCursor,
    reset: push.reset,
    data: push.data,
  };
}

/**
 * Subscribes to output for one selected physical attempt. The initial RPC closes
 * the subscribe-before-hydrate race; all later updates arrive through push.
 */
export function subscribeJourneyRunOutput(input: {
  readonly api: NativeApi;
  readonly fence: JourneyAttemptFence;
  readonly onOutput: (state: JourneyRunOutputState) => void;
  readonly onError?: (error: Error) => void;
}) {
  let disposed = false;
  let hydrated = false;
  let cursor = 0;
  let firstCursor = 0;
  let output = "";
  let catchUpInFlight: Promise<void> | null = null;
  const pending: OrchestrationJourneyRunOutputPush[] = [];

  const emit = (reset: boolean) => {
    input.onOutput({
      data: output,
      firstCursor,
      nextCursor: cursor,
      reset,
    });
  };

  const applyPush = (push: OrchestrationJourneyRunOutputPush) => {
    if (disposed || !sameFence(push.fence, input.fence)) return;
    if (!hydrated) {
      pending.push(push);
      return;
    }
    const range = pushRange(push);
    if (range.endCursor <= cursor) return;
    if (range.reset) {
      output = range.data;
      firstCursor = range.startCursor;
      cursor = range.endCursor;
      emit(true);
      return;
    }
    if (range.startCursor !== cursor) {
      void catchUp();
      return;
    }
    output += range.data;
    cursor = range.endCursor;
    emit(false);
  };

  const unsubscribePush = input.api.orchestration.onJourneyRunOutput(applyPush);

  async function hydrate(): Promise<void> {
    try {
      const result = await input.api.orchestration.subscribeJourneyRunOutput({
        fence: input.fence,
        afterCursor: 0,
      });
      if (disposed) return;
      output = result.data;
      firstCursor = result.firstCursor;
      cursor = result.nextCursor;
      hydrated = true;
      emit(result.reset);
      const buffered = pending.splice(0);
      for (const push of buffered) applyPush(push);
    } catch (cause) {
      if (!disposed) {
        input.onError?.(cause instanceof Error ? cause : new Error(String(cause)));
      }
    }
  }

  function catchUp(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (catchUpInFlight) return catchUpInFlight;
    catchUpInFlight = input.api.orchestration
      .getJourneyRunOutput({ fence: input.fence, afterCursor: cursor })
      .then((result) => {
        if (disposed) return;
        if (result.reset) {
          output = result.data;
          firstCursor = result.firstCursor;
        } else {
          output += result.data;
        }
        cursor = result.nextCursor;
        emit(result.reset);
      })
      .catch((cause: unknown) => {
        if (!disposed) {
          input.onError?.(cause instanceof Error ? cause : new Error(String(cause)));
        }
      })
      .finally(() => {
        catchUpInFlight = null;
      });
    return catchUpInFlight;
  }

  const ready = hydrate();

  return {
    ready,
    dispose: () => {
      disposed = true;
      pending.length = 0;
      unsubscribePush();
      void input.api.orchestration
        .unsubscribeJourneyRunOutput({ fence: input.fence })
        .catch(() => undefined);
    },
  };
}
