import type { CodingHarness, NativeApi, ThreadId } from "@clui/contracts";

export function writeHarnessInput(
  api: NativeApi,
  harness: CodingHarness,
  threadId: ThreadId,
  data: string,
): Promise<void> {
  return harness === "pi"
    ? api.pi.write({ threadId, data })
    : api.claude.write({ threadId, data });
}

export function submitThreadPrompt(
  api: NativeApi,
  harness: CodingHarness,
  threadId: ThreadId,
  prompt: string,
): Promise<void> {
  const normalizedPrompt = prompt.endsWith("\n") ? prompt : `${prompt}\n`;
  return writeHarnessInput(api, harness, threadId, normalizedPrompt);
}
