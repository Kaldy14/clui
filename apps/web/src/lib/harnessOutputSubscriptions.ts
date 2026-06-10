import { ThreadId, type NativeApi } from "@clui/contracts";

import { onServerWelcome } from "../wsNativeApi";

type HarnessKind = "claudeCode" | "pi";

const claudeThreadIds = new Set<string>();
const piThreadIds = new Set<string>();

let apiRef: NativeApi | null = null;
let initialized = false;
let syncQueued = false;
let lastSentSignature: string | null = null;

function payloadForVisibility() {
  if (document.visibilityState !== "visible") {
    return { claudeThreadIds: [], piThreadIds: [] };
  }
  return {
    claudeThreadIds: [...claudeThreadIds].map((threadId) => ThreadId.makeUnsafe(threadId)),
    piThreadIds: [...piThreadIds].map((threadId) => ThreadId.makeUnsafe(threadId)),
  };
}

function payloadSignature(payload: { claudeThreadIds: string[]; piThreadIds: string[] }): string {
  return `${payload.claudeThreadIds.toSorted().join(",")}\n${payload.piThreadIds.toSorted().join(",")}`;
}

function syncNow(): void {
  syncQueued = false;
  if (!apiRef) return;

  const payload = payloadForVisibility();
  const signature = payloadSignature(payload);
  if (signature === lastSentSignature) return;
  lastSentSignature = signature;

  void apiRef.server.setHarnessOutputSubscriptions(payload).catch(() => {
    lastSentSignature = null;
  });
}

function scheduleSync(): void {
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(syncNow);
}

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;

  document.addEventListener("visibilitychange", () => {
    lastSentSignature = null;
    scheduleSync();
  });

  onServerWelcome(() => {
    lastSentSignature = null;
    scheduleSync();
  });
}

export function registerHarnessOutputSubscription(
  api: NativeApi,
  harness: HarnessKind,
  threadId: string,
): () => void {
  apiRef = api;
  ensureInitialized();

  const target = harness === "pi" ? piThreadIds : claudeThreadIds;
  target.add(threadId);
  scheduleSync();

  return () => {
    target.delete(threadId);
    scheduleSync();
  };
}
