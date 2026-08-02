import {
  ThreadId,
  type JourneyAttemptFence,
  type JourneyOutputChunk,
  type NativeApi,
} from "@clui/contracts";
import { describe, expect, it, vi } from "vitest";

import { subscribeJourneyRunOutput } from "./journeyRunOutputSubscription";

const fence: JourneyAttemptFence = {
  threadId: ThreadId.makeUnsafe("journey-output-client"),
  runId: "selected-run",
  nodeId: "selected-node",
  attempt: 2,
};

describe("subscribeJourneyRunOutput", () => {
  it("hydrates once, consumes selected-fence pushes and unsubscribes", async () => {
    let listener: (chunk: JourneyOutputChunk) => void = vi.fn();
    const unsubscribePush = vi.fn();
    const subscribeRpc = vi.fn().mockResolvedValue({
      fence,
      reset: false,
      firstCursor: 0,
      nextCursor: 3,
      data: "one",
    });
    const onJourneyRunOutput = vi.fn((callback: (chunk: JourneyOutputChunk) => void) => {
      listener = callback;
      return unsubscribePush;
    });
    const unsubscribeJourneyRunOutput = vi.fn().mockResolvedValue(undefined);
    const api = {
      orchestration: {
        subscribeJourneyRunOutput: subscribeRpc,
        unsubscribeJourneyRunOutput,
        onJourneyRunOutput,
      },
    } as unknown as NativeApi;
    const onOutput = vi.fn();
    const subscription = subscribeJourneyRunOutput({ api, fence, onOutput });
    await subscription.ready;
    listener({ fence, startCursor: 3, endCursor: 6, data: "two" });

    expect(subscribeRpc).toHaveBeenCalledWith({ fence, afterCursor: 0 });
    expect(onJourneyRunOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenLastCalledWith({
      data: "onetwo",
      firstCursor: 0,
      nextCursor: 6,
      reset: false,
    });
    subscription.dispose();
    expect(unsubscribePush).toHaveBeenCalledTimes(1);
    expect(unsubscribeJourneyRunOutput).toHaveBeenCalledWith({ fence });
  });

  it("ignores other attempts and applies pushed resets", async () => {
    let listener: (
      chunk:
        | JourneyOutputChunk
        | {
            fence: JourneyAttemptFence;
            reset: boolean;
            firstCursor: number;
            nextCursor: number;
            data: string;
          },
    ) => void = vi.fn();
    const subscribeRpc = vi.fn().mockResolvedValue({
      fence,
      reset: false,
      firstCursor: 0,
      nextCursor: 3,
      data: "old",
    });
    const api = {
      orchestration: {
        subscribeJourneyRunOutput: subscribeRpc,
        unsubscribeJourneyRunOutput: vi.fn().mockResolvedValue(undefined),
        onJourneyRunOutput: (callback: typeof listener) => {
          listener = callback;
          return vi.fn();
        },
      },
    } as unknown as NativeApi;
    const onOutput = vi.fn();
    const subscription = subscribeJourneyRunOutput({ api, fence, onOutput });
    await subscription.ready;
    listener({
      fence: { ...fence, attempt: 1 },
      startCursor: 0,
      endCursor: 7,
      data: "ignored",
    });
    listener({
      fence,
      reset: true,
      firstCursor: 8,
      nextCursor: 12,
      data: "tail",
    });

    expect(onOutput).toHaveBeenLastCalledWith({
      data: "tail",
      firstCursor: 8,
      nextCursor: 12,
      reset: true,
    });
    subscription.dispose();
  });
});
