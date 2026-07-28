export const USER_INPUT_TOOL_NAMES = [
  "ask",
  "askfollowupquestion",
  "askquestion",
  "askuser",
  "askuserquestion",
  "planreview",
  "question",
  "questionnaire",
] as const;

const USER_INPUT_TOOL_NAME_SET: ReadonlySet<string> = new Set(USER_INPUT_TOOL_NAMES);

export function normalizeToolName(toolName: unknown): string {
  return String(toolName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function isUserInputToolName(toolName: unknown): boolean {
  return USER_INPUT_TOOL_NAME_SET.has(normalizeToolName(toolName));
}
