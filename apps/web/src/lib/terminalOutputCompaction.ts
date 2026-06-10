const DEFAULT_MAX_CATCH_UP_REPLAY_CHARS = 128 * 1024;
const LEADING_ESCAPE_SCAN_CHARS = 512;

const REPAINT_BOUNDARIES = [
  "\x1bc",
  "\x1b[?1049h",
  "\x1b[2J",
  "\x1b[H",
  "\x1b[1;1H",
  "\x1b[0;0H",
] as const;

export interface TerminalOutputCompactionResult {
  data: string;
  compacted: boolean;
}

function latestRepaintBoundaryIndex(data: string): number {
  let latest = -1;
  for (const boundary of REPAINT_BOUNDARIES) {
    const index = data.lastIndexOf(boundary);
    if (index > latest) latest = index;
  }
  return latest;
}

function trimLeadingPartialEscape(data: string): string {
  if (data.length === 0 || data.charCodeAt(0) === 0x1b) return data;
  const escapeIndex = data.indexOf("\x1b");
  if (escapeIndex > 0 && escapeIndex <= LEADING_ESCAPE_SCAN_CHARS) {
    return data.slice(escapeIndex);
  }
  return data;
}

/**
 * Keep catch-up replay bounded so hidden/inactive terminal views do not replay
 * minutes of stale TUI frames into xterm when the user focuses them again.
 */
export function compactTerminalCatchUpReplay(
  data: string,
  maxChars = DEFAULT_MAX_CATCH_UP_REPLAY_CHARS,
): TerminalOutputCompactionResult {
  if (data.length <= maxChars) return { data, compacted: false };

  const tail = data.slice(-maxChars);
  const boundaryIndex = latestRepaintBoundaryIndex(tail);
  if (boundaryIndex >= 0) {
    return { data: tail.slice(boundaryIndex), compacted: true };
  }

  return { data: trimLeadingPartialEscape(tail), compacted: true };
}

export function appendCompactedTerminalOutput(
  current: string,
  chunk: string,
  maxChars = DEFAULT_MAX_CATCH_UP_REPLAY_CHARS,
): TerminalOutputCompactionResult {
  if (chunk.length === 0) return { data: current, compacted: false };
  return compactTerminalCatchUpReplay(current + chunk, maxChars);
}
