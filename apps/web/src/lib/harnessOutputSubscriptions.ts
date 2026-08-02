import { ThreadId, type NativeApi } from "@clui/contracts";

import { onServerWelcome } from "../wsNativeApi";

type HarnessKind = "claudeCode" | "pi" | "codexCli";

const claudeThreadSubscriptions = new Map<string, number>();
const piThreadSubscriptions = new Map<string, number>();

let apiRef: NativeApi | null = null;
let initialized = false;
let syncQueued = false;
let lastSentSignature: string | null = null;

function subscriptionPayload() {
  return {
    claudeThreadIds: [...claudeThreadSubscriptions.keys()].map((threadId) =>
      ThreadId.makeUnsafe(threadId),
    ),
    piThreadIds: [...piThreadSubscriptions.keys()].map((threadId) => ThreadId.makeUnsafe(threadId)),
  };
}

function addSubscription(subscriptions: Map<string, number>, threadId: string): void {
  subscriptions.set(threadId, (subscriptions.get(threadId) ?? 0) + 1);
}

function removeSubscription(subscriptions: Map<string, number>, threadId: string): void {
  const count = subscriptions.get(threadId) ?? 0;
  if (count <= 1) {
    subscriptions.delete(threadId);
    return;
  }
  subscriptions.set(threadId, count - 1);
}

function payloadSignature(payload: { claudeThreadIds: string[]; piThreadIds: string[] }): string {
  return `${payload.claudeThreadIds.toSorted().join(",")}\n${payload.piThreadIds.toSorted().join(",")}`;
}

function syncNow(): Promise<void> {
  syncQueued = false;
  if (!apiRef) return Promise.resolve();

  const payload = subscriptionPayload();
  const signature = payloadSignature(payload);
  if (signature === lastSentSignature) return Promise.resolve();
  lastSentSignature = signature;

  return apiRef.server.setHarnessOutputSubscriptions(payload).catch((error: unknown) => {
    lastSentSignature = null;
    throw error;
  });
}

function syncNowWithRetry(attemptsRemaining = 2): Promise<void> {
  return syncNow().catch((error: unknown) => {
    if (attemptsRemaining <= 0) throw error;
    return new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        syncNowWithRetry(attemptsRemaining - 1).then(resolve, reject);
      }, 150);
    });
  });
}

function scheduleSync(): void {
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(() => {
    void syncNow().catch(() => undefined);
  });
}

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;

  onServerWelcome(() => {
    lastSentSignature = null;
    scheduleSync();
  });
}

export interface HarnessOutputSubscriptionRegistration {
  /** Resolves after the server acknowledged the newly added subscription. */
  readonly ready: Promise<void>;
  readonly unsubscribe: () => void;
}

export function registerHarnessOutputSubscription(
  api: NativeApi,
  harness: HarnessKind,
  threadId: string,
): HarnessOutputSubscriptionRegistration {
  apiRef = api;
  ensureInitialized();

  const target = harness === "pi" ? piThreadSubscriptions : claudeThreadSubscriptions;
  addSubscription(target, threadId);
  // The terminal view must not ask for catch-up scrollback until the server has
  // acknowledged this subscription. Otherwise a status/hook event can prompt
  // navigation, getScrollback can snapshot just before the corresponding PTY
  // bytes, and those bytes can still be filtered because the subscription has
  // not reached the server yet. A later PTY resize then makes the missing TUI
  // frame appear, which looks like a render bug.
  const ready = syncNowWithRetry();
  let unsubscribed = false;

  return {
    ready,
    unsubscribe: () => {
      if (unsubscribed) return;
      unsubscribed = true;
      removeSubscription(target, threadId);
      scheduleSync();
    },
  };
}
