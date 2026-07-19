import type { CodingHarness, NativeApi, ThreadId } from "@clui/contracts";
import {
  encodePiTuiPrompt,
  PI_TUI_NEWLINE_SEQUENCE,
  PI_TUI_SUBMIT_SEQUENCE,
} from "@clui/shared/piTuiInput";

export { PI_TUI_NEWLINE_SEQUENCE, PI_TUI_SUBMIT_SEQUENCE };

function trimTrailingSubmitChars(prompt: string): string {
  return prompt.replace(/[\r\n]+$/u, "");
}

export function promptSubmitDataForHarness(harness: CodingHarness, prompt: string): string {
  return harness === "pi" ? encodePiTuiPrompt(prompt) : `${trimTrailingSubmitChars(prompt)}\r`;
}

export function writeHarnessInput(
  api: NativeApi,
  harness: CodingHarness,
  threadId: ThreadId,
  data: string,
): Promise<void> {
  return harness === "pi" ? api.pi.write({ threadId, data }) : api.claude.write({ threadId, data });
}

export function submitThreadPrompt(
  api: NativeApi,
  harness: CodingHarness,
  threadId: ThreadId,
  prompt: string,
): Promise<void> {
  return writeHarnessInput(api, harness, threadId, promptSubmitDataForHarness(harness, prompt));
}
