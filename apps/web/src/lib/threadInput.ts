import type { CodingHarness, NativeApi, ThreadId } from "@clui/contracts";

export const PI_TUI_NEWLINE_SEQUENCE = "\x1b[13;2u";
export const PI_TUI_SUBMIT_SEQUENCE = "\x1b[13u";

function trimTrailingSubmitChars(prompt: string): string {
  return prompt.replace(/[\r\n]+$/u, "");
}

export function promptSubmitDataForHarness(harness: CodingHarness, prompt: string): string {
  const trimmedPrompt = trimTrailingSubmitChars(prompt);
  if (harness === "pi") {
    return `${trimmedPrompt.replace(/\r\n|\r|\n/gu, PI_TUI_NEWLINE_SEQUENCE)}${PI_TUI_SUBMIT_SEQUENCE}`;
  }
  return `${trimmedPrompt}\r`;
}

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
  return writeHarnessInput(api, harness, threadId, promptSubmitDataForHarness(harness, prompt));
}
