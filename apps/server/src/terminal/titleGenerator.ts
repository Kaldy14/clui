/**
 * Title generator — extracts the user's prompt text from Claude Code hook payloads.
 *
 * @module titleGenerator
 */

const SIDE_EFFECT_ONLY_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  "changelog",
  "clone",
  "compact",
  "copy",
  "export",
  "fast",
  "fork",
  "hotkeys",
  "import",
  "login",
  "logout",
  "model",
  "name",
  "new",
  "quit",
  "reload",
  "resume",
  "scoped-models",
  "session",
  "settings",
  "share",
  "tree",
]);

const SLASH_COMMAND_PATTERN = /^\/([A-Za-z][\w.-]*(?::[A-Za-z][\w.-]*)?)(?:\s+([\s\S]*))?$/u;

/**
 * Returns true when a prompt has enough user intent to generate a useful title.
 *
 * Bare slash commands like `/fast` and side-effect-only commands like
 * `/model gpt-5` should leave the thread as "New thread" so the next real
 * message can title it. Slash commands with task text, such as
 * `/impeccable improve this ui`, are title-worthy.
 */
export function shouldGenerateTitleFromPrompt(promptText: string): boolean {
  const trimmed = promptText.trim();
  if (trimmed.length === 0) return false;

  const slashCommandMatch = SLASH_COMMAND_PATTERN.exec(trimmed);
  if (!slashCommandMatch) return true;

  const command = slashCommandMatch[1]?.toLowerCase() ?? "";
  const rest = slashCommandMatch[2]?.trim() ?? "";
  if (rest.length === 0) return false;
  return !SIDE_EFFECT_ONLY_SLASH_COMMANDS.has(command);
}

/**
 * Extract the user's prompt text from a UserPromptSubmit hook body.
 *
 * Claude Code sends JSON on stdin for hook events. The prompt text
 * may appear under various keys depending on the Claude Code version.
 */
export function extractPromptText(rawBody: string): string | null {
  const trimmed = rawBody.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;

    // Try direct string keys first (user_prompt is the canonical Claude Code field)
    for (const key of ["user_prompt", "prompt", "message", "text", "input"]) {
      const value = obj[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }

    // Check nested objects
    for (const nestedKey of ["data", "context", "event"]) {
      const nested = obj[nestedKey];
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        for (const key of ["user_prompt", "prompt", "message", "text", "input"]) {
          const value = (nested as Record<string, unknown>)[key];
          if (typeof value === "string" && value.trim().length > 0) {
            return value.trim();
          }
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}
