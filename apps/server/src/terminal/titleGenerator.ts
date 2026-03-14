/**
 * Title generator — extracts the user's prompt text from Claude Code hook payloads.
 *
 * @module titleGenerator
 */

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
