import type { NativeApi, ThreadId } from "@clui/contracts";

import { newCommandId } from "./utils";

export function dispatchThreadArchiveUpdate(
  api: NativeApi,
  threadId: ThreadId,
  archivedAt: string | null,
): Promise<{ sequence: number }> {
  return api.orchestration.dispatchCommand({
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId,
    archivedAt,
  });
}
