import type { NativeApi, ThreadId } from "@clui/contracts";

import { newCommandId } from "./utils";

export function dispatchThreadSettle(api: NativeApi, threadId: ThreadId) {
  return api.orchestration.dispatchCommand({
    type: "thread.settle",
    commandId: newCommandId(),
    threadId,
  });
}

export function dispatchThreadUnsettle(api: NativeApi, threadId: ThreadId) {
  return api.orchestration.dispatchCommand({
    type: "thread.unsettle",
    commandId: newCommandId(),
    threadId,
    reason: "user",
  });
}

export function dispatchThreadSnooze(api: NativeApi, threadId: ThreadId, snoozedUntil: string) {
  return api.orchestration.dispatchCommand({
    type: "thread.snooze",
    commandId: newCommandId(),
    threadId,
    snoozedUntil,
  });
}

export function dispatchThreadUnsnooze(api: NativeApi, threadId: ThreadId) {
  return api.orchestration.dispatchCommand({
    type: "thread.unsnooze",
    commandId: newCommandId(),
    threadId,
    reason: "user",
  });
}
