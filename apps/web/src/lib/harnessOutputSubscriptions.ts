import { ThreadId, type NativeApi } from "@clui/contracts";

import { onServerWelcome } from "../wsNativeApi";

type HarnessKind = "claudeCode" | "pi" | "codexCli" | "omp";

const claudeThreadIds = new Set<string>();
const piThreadIds = new Set<string>();

let apiRef: NativeApi | null = null;
let initialized = false;
let syncQueued = false;
let lastSentSignature: string | null = null;

function subscriptionPayload() {
  return {
    claudeThreadIds: [...claudeThreadIds].map((threadId) => ThreadId.makeUnsafe(threadId)),
    piThreadIds: [...piThreadIds].map((threadId) => ThreadId.makeUnsafe(threadId)),
  };
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

  const target = harness === "pi" ? piThreadIds : claudeThreadIds;
  target.add(threadId);
  // The terminal view must not ask for catch-up scrollback until the server has
  // acknowledged this subscription. Otherwise a status/hook event can prompt
  // navigation, getScrollback can snapshot just before the corresponding PTY
  // bytes, and those bytes can still be filtered because the subscription has
  // not reached the server yet. A later PTY resize then makes the missing TUI
  // frame appear, which looks like a render bug.
  const ready = syncNowWithRetry();

  return {
    ready,
    unsubscribe: () => {
      target.delete(threadId);
      scheduleSync();
    },
  };
}
