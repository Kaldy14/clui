import { afterEach, describe, expect, it, vi } from "vitest";

import type { NativeApi } from "@clui/contracts";

function installDocumentStub(initialVisibilityState: DocumentVisibilityState = "visible") {
  let visibilityState = initialVisibilityState;
  const listeners = new Set<() => void>();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: vi.fn((event: string, listener: () => void) => {
        if (event === "visibilitychange") listeners.add(listener);
      }),
      removeEventListener: vi.fn((event: string, listener: () => void) => {
        if (event === "visibilitychange") listeners.delete(listener);
      }),
    },
  });

  return {
    setVisibilityState(nextVisibilityState: DocumentVisibilityState) {
      visibilityState = nextVisibilityState;
      for (const listener of [...listeners]) listener();
    },
  };
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

    expect(calls).toEqual([{ claudeThreadIds: [], piThreadIds: ["thread-1"] }, "after-register"]);
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

  it("keeps the active terminal subscribed while the document is hidden", async () => {
    const documentStub = installDocumentStub("hidden");
    const { registerHarnessOutputSubscription } = await import("./harnessOutputSubscriptions");
    const api = {
      server: {
        setHarnessOutputSubscriptions: vi.fn(() => Promise.resolve()),
      },
    } as unknown as NativeApi;

    const registration = registerHarnessOutputSubscription(api, "pi", "thread-1");
    let ready = false;
    void registration.ready.then(() => {
      ready = true;
    });
    await registration.ready;
    await Promise.resolve();

    expect(ready).toBe(true);
    expect(api.server.setHarnessOutputSubscriptions).toHaveBeenLastCalledWith({
      claudeThreadIds: [],
      piThreadIds: ["thread-1"],
    });

    documentStub.setVisibilityState("visible");
    await Promise.resolve();

    expect(ready).toBe(true);
    expect(api.server.setHarnessOutputSubscriptions).toHaveBeenCalledTimes(1);

    registration.unsubscribe();
  });

  it.each([
    ["codexCli", "thread-codex"],
    ["omp", "thread-omp"],
  ] as const)(
    "routes %s output through the shared non-pi terminal subscription",
    async (harness, threadId) => {
      installDocumentStub();
      const { registerHarnessOutputSubscription } = await import("./harnessOutputSubscriptions");
      const api = {
        server: {
          setHarnessOutputSubscriptions: vi.fn(() => Promise.resolve()),
        },
      } as unknown as NativeApi;

      const registration = registerHarnessOutputSubscription(api, harness, threadId);
      await registration.ready;

      expect(api.server.setHarnessOutputSubscriptions).toHaveBeenLastCalledWith({
        claudeThreadIds: [threadId],
        piThreadIds: [],
      });

      registration.unsubscribe();
    },
  );
});
