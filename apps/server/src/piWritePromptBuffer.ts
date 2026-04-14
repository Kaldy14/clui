/**
 * Accumulates pi PTY writes per thread until a newline, then exposes the first
 * logical line (ANSI stripped + trimmed) for auto-title and hook transitions.
 */

const esc = String.fromCharCode(0x1b);
const bel = String.fromCharCode(7);
const ctrl0to8 = Array.from({ length: 9 }, (_, c) => String.fromCharCode(c)).join("");
const ctrl0b0c = String.fromCharCode(0x0b, 0x0c);
const ctrl0eto1f = Array.from({ length: 18 }, (_, i) => String.fromCharCode(0x0e + i)).join("");
const ctrl7f = String.fromCharCode(0x7f);
const ctrlStripClass = `[${ctrl0to8}${ctrl0b0c}${ctrl0eto1f}${ctrl7f}]`;

// Match ANSI CSI/OSC/string-terminator sequences plus bare control chars so
// the accumulated pi keystroke buffer reduces to printable text.
export const PI_WRITE_CONTROL_SEQ_RE = new RegExp(
  `${esc}\\[[0-?]*[ -/]*[@-~]|${esc}\\][^${bel}${esc}]*(?:${bel}|${esc}\\\\)?|${esc}\\\\|${ctrlStripClass}`,
  "g",
);

export const MAX_PI_PROMPT_BUFFER_BYTES = 4_096;

export type PiWritePromptAdvance =
  | { kind: "buffering" }
  | { kind: "empty_submit" }
  | { kind: "submitted"; firstLineStripped: string };

/**
 * Append `data` to the per-thread buffer. On the first `\r` or `\n`, consume
 * the leading line and return `submitted` or `empty_submit`. Otherwise
 * `buffering`.
 */
export function advancePiWritePromptBuffer(
  pendingBuffers: Map<string, string>,
  threadId: string,
  data: string,
): PiWritePromptAdvance {
  const prior = pendingBuffers.get(threadId) ?? "";
  let buffer = prior + data;
  if (buffer.length > MAX_PI_PROMPT_BUFFER_BYTES) {
    buffer = buffer.slice(buffer.length - MAX_PI_PROMPT_BUFFER_BYTES);
  }
  const newlineIdx = buffer.search(/[\r\n]/);
  if (newlineIdx < 0) {
    pendingBuffers.set(threadId, buffer);
    return { kind: "buffering" };
  }
  const rest = buffer.slice(newlineIdx + 1);
  const firstLine = buffer.slice(0, newlineIdx);
  const stripped = firstLine.replace(PI_WRITE_CONTROL_SEQ_RE, "").trim();
  if (stripped.length === 0) {
    if (rest.length > 0) {
      pendingBuffers.set(threadId, rest);
    } else {
      pendingBuffers.delete(threadId);
    }
    return { kind: "empty_submit" };
  }
  if (rest.length > 0) {
    pendingBuffers.set(threadId, rest);
  } else {
    pendingBuffers.delete(threadId);
  }
  return { kind: "submitted", firstLineStripped: stripped };
}
