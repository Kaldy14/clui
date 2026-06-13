import { afterEach, describe, expect, it, vi } from "vitest";

import type { NativeApi } from "@clui/contracts";

function installDocumentStub(visibilityState: DocumentVisibilityState = "visible") {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      visibilityState,
      addEventListener: vi.fn(),
    },
  });
}

function removeDocumentStub() {
  Reflect.deleteProperty(globalThis, "document");
}

describe("harness output subscriptions", () => {
  afterEach(() => {
    removeDocumentStub();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("exposes a ready promise for ordering catch-up scrollback after server ack", async () => {
    installDocumentStub();
    const { registerHarnessOutputSubscription } = await import("./harnessOutputSubscriptions");
    const calls: unknown[] = [];
    let acknowledge!: () => void;
    const serverAck = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const api = {
      server: {
        setHarnessOutputSubscriptions: vi.fn((payload: unknown) => {
          calls.push(payload);
          return serverAck;
        }),
      },
    } as unknown as NativeApi;

    const registration = registerHarnessOutputSubscription(api, "pi", "thread-1");
    let ready = false;
    void registration.ready.then(() => {
      ready = true;
    });
    calls.push("after-register");
    await Promise.resolve();

    expect(calls).toEqual([
      { claudeThreadIds: [], piThreadIds: ["thread-1"] },
      "after-register",
    ]);
    expect(ready).toBe(false);

    acknowledge();
    await registration.ready;

    expect(ready).toBe(true);

    registration.unsubscribe();
    await Promise.resolve();

    expect(api.server.setHarnessOutputSubscriptions).toHaveBeenLastCalledWith({
      claudeThreadIds: [],
      piThreadIds: [],
    });
  });
});
