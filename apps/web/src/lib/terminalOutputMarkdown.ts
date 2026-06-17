/**
 * Filters markdown code-fence markers out of terminal output before it reaches
 * xterm.js. The harness TUIs (Claude Code / pi) emit markdown code blocks as
 * plain text; the fence lines are visual noise in a terminal surface where the
 * surrounding chrome already implies a code block. This filter removes only
 * the fence lines and leaves the fenced content untouched.
 */

const SGR_SEQUENCE_RE = /\x1b\[[0-?]*[ -/]*m/gu;
const UNSUPPORTED_CONTROL_RE = /\x1b|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u;
const MAX_PENDING_FENCE_LINE_LENGTH = 256;

interface FenceMatch {
  char: "`" | "~";
  ticks: number;
  info: string;
}

function stripSupportedFenceStyling(line: string): string {
  return line.replace(SGR_SEQUENCE_RE, "");
}

function hasUnsupportedControls(line: string): boolean {
  return UNSUPPORTED_CONTROL_RE.test(line.replace(/\r/gu, ""));
}

function hasOnlyIncompleteSgrSuffixControl(line: string): boolean {
  const escapeIndex = line.lastIndexOf("\x1b");
  if (escapeIndex === -1) return false;

  const prefix = line.slice(0, escapeIndex);
  const suffix = line.slice(escapeIndex).replace(/\r/gu, "");
  return !hasUnsupportedControls(prefix) && /^\x1b(?:\[[0-?]*[ -/]*)?$/u.test(suffix);
}

function parseFenceLine(line: string): FenceMatch | null {
  if (line.length < 3) return null;
  if (!line.includes("```") && !line.includes("~~~")) return null;

  const stripped = stripSupportedFenceStyling(line);
  if (hasUnsupportedControls(stripped)) return null;

  const match = /^[ \t]*(`{3,}|~{3,})([^\r\n]*)\r?$/u.exec(stripped);
  if (!match) return null;

  const fence = match[1]!;
  const info = match[2]?.trim() ?? "";
  if (/[`~]/u.test(info)) return null;

  return { char: fence[0] as "`" | "~", ticks: fence.length, info };
}

function couldStillBeFenceLine(
  line: string,
  state: { inside: boolean; openChar: "`" | "~"; openTicks: number },
): boolean {
  if (line.length > MAX_PENDING_FENCE_LINE_LENGTH) return false;

  const stripped = stripSupportedFenceStyling(line);
  if (hasUnsupportedControls(stripped)) return hasOnlyIncompleteSgrSuffixControl(stripped);

  const withoutTrailingCr = stripped.endsWith("\r") ? stripped.slice(0, -1) : stripped;
  const candidate = withoutTrailingCr.replace(/^[ \t]*/u, "");
  if (candidate.length === 0) return true;

  const char = candidate[0];
  if (char !== "`" && char !== "~") return false;

  let tickCount = 0;
  while (candidate[tickCount] === char) tickCount++;

  const remainder = candidate.slice(tickCount);
  if (tickCount < 3) return remainder.length === 0;

  if (state.inside) {
    if (char !== state.openChar) return false;
    if (tickCount < state.openTicks) return remainder.length === 0;
    return /^[ \t]*$/u.test(remainder);
  }

  return !/[`~]/u.test(remainder);
}

export interface MarkdownCodeFenceFilter {
  /** Process a chunk of terminal output and return the filtered chunk. */
  process(chunk: string): string;
  /** Emit any buffered non-fence tail. */
  flush(): string;
}

/**
 * Create a streaming filter that tracks whether it is inside a markdown code
 * block and drops complete fence lines while preserving the fenced content.
 *
 * The filter only buffers short line prefixes that could still become a fence
 * line. Normal terminal output is emitted immediately, while fences split
 * across PTY chunks are still removed once their newline arrives.
 */
export function createMarkdownCodeFenceFilter(): MarkdownCodeFenceFilter {
  const state = {
    inside: false,
    openChar: "`" as "`" | "~",
    openTicks: 0,
  };
  let pendingLine = "";
  let passthroughLine = false;

  const processCompleteLine = (line: string): string | null => {
    const fence = parseFenceLine(line);
    if (fence) {
      if (
        state.inside &&
        fence.char === state.openChar &&
        fence.ticks >= state.openTicks &&
        fence.info.length === 0
      ) {
        state.inside = false;
        return null;
      }

      if (!state.inside) {
        state.inside = true;
        state.openChar = fence.char;
        state.openTicks = fence.ticks;
        return null;
      }
    }

    return line;
  };

  const processPotentialTail = (tail: string): string => {
    const candidate = pendingLine + tail;
    if (couldStillBeFenceLine(candidate, state)) {
      pendingLine = candidate;
      return "";
    }

    pendingLine = "";
    passthroughLine = true;
    return candidate;
  };

  return {
    process(chunk: string): string {
      if (chunk.length === 0) return "";

      let result = "";
      let cursor = 0;

      while (cursor < chunk.length) {
        if (passthroughLine) {
          const newlineIndex = chunk.indexOf("\n", cursor);
          if (newlineIndex === -1) {
            result += chunk.slice(cursor);
            cursor = chunk.length;
            continue;
          }

          result += chunk.slice(cursor, newlineIndex + 1);
          cursor = newlineIndex + 1;
          passthroughLine = false;
          continue;
        }

        const newlineIndex = chunk.indexOf("\n", cursor);
        if (newlineIndex === -1) {
          result += processPotentialTail(chunk.slice(cursor));
          cursor = chunk.length;
          continue;
        }

        const line = pendingLine + chunk.slice(cursor, newlineIndex);
        pendingLine = "";
        const processed = processCompleteLine(line);
        if (processed !== null) result += `${processed}\n`;
        cursor = newlineIndex + 1;
      }

      return result;
    },
    flush(): string {
      const line = pendingLine;
      pendingLine = "";
      passthroughLine = false;
      if (line.length === 0) return "";
      return processCompleteLine(line) ?? "";
    },
  };
}

/**
 * One-shot filter for complete terminal strings (e.g., dormant scrollback
 * snapshots). The final line is treated as complete, so an unmatched trailing
 * fence line is removed.
 */
export function stripMarkdownCodeFences(data: string): string {
  if (data.length === 0) return "";

  const filter = createMarkdownCodeFenceFilter();
  return filter.process(data) + filter.flush();
}
