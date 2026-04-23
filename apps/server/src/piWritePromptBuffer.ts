/**
 * Accumulates pi PTY writes per thread until a newline, then reconstructs the
 * edited first logical line for auto-title and hook transitions.
 *
 * pi titles are inferred from terminal keystrokes, so we need to replay common
 * line-editing controls (backspace, arrows, home/end, delete, word motions)
 * instead of just stripping escape sequences. Otherwise edited prompts like
 * `hellp<backspace>o` or cursor-left insertions become scrambled titles.
 */

const ESC = "\x1b";
const BACKSPACE = "\x08";
const DELETE = "\x7f";

export const MAX_PI_PROMPT_BUFFER_BYTES = 4_096;

export type PiWritePromptAdvance =
  | { kind: "buffering" }
  | { kind: "empty_submit" }
  | { kind: "submitted"; firstLineStripped: string };

interface EditableLineState {
  chars: string[];
  cursor: number;
}

function clampCursor(state: EditableLineState): void {
  state.cursor = Math.max(0, Math.min(state.cursor, state.chars.length));
}

function insertText(state: EditableLineState, text: string): void {
  for (const char of text) {
    state.chars.splice(state.cursor, 0, char);
    state.cursor += 1;
  }
}

function moveCursor(state: EditableLineState, delta: number): void {
  state.cursor += delta;
  clampCursor(state);
}

function deleteBackward(state: EditableLineState): void {
  if (state.cursor <= 0) return;
  state.chars.splice(state.cursor - 1, 1);
  state.cursor -= 1;
}

function deleteForward(state: EditableLineState): void {
  if (state.cursor >= state.chars.length) return;
  state.chars.splice(state.cursor, 1);
}

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/u.test(char);
}

function moveWordLeft(state: EditableLineState): void {
  while (state.cursor > 0 && isWhitespace(state.chars[state.cursor - 1])) {
    state.cursor -= 1;
  }
  while (state.cursor > 0 && !isWhitespace(state.chars[state.cursor - 1])) {
    state.cursor -= 1;
  }
}

function moveWordRight(state: EditableLineState): void {
  while (state.cursor < state.chars.length && isWhitespace(state.chars[state.cursor])) {
    state.cursor += 1;
  }
  while (state.cursor < state.chars.length && !isWhitespace(state.chars[state.cursor])) {
    state.cursor += 1;
  }
}

function deleteWordLeft(state: EditableLineState): void {
  const end = state.cursor;
  moveWordLeft(state);
  state.chars.splice(state.cursor, end - state.cursor);
}

function deleteWordRight(state: EditableLineState): void {
  const start = state.cursor;
  moveWordRight(state);
  state.chars.splice(start, state.cursor - start);
  state.cursor = start;
}

function applySs3Sequence(state: EditableLineState, code: string): void {
  switch (code) {
    case "D":
      moveCursor(state, -1);
      break;
    case "C":
      moveCursor(state, 1);
      break;
    case "H":
      state.cursor = 0;
      break;
    case "F":
      state.cursor = state.chars.length;
      break;
    default:
      break;
  }
}

function applyCsiSequence(state: EditableLineState, sequence: string): void {
  const final = sequence.at(-1);
  if (!final) return;

  const body = sequence.slice(2, -1);
  const params = body.length > 0
    ? body.split(";").map((part) => {
        const parsed = Number.parseInt(part, 10);
        return Number.isFinite(parsed) ? parsed : null;
      })
    : [];
  const first = params[0] ?? 1;
  const modifier = params[1] ?? null;
  const wantsWordMotion = modifier === 3 || modifier === 5;

  switch (final) {
    case "D":
      if (wantsWordMotion) {
        moveWordLeft(state);
      } else {
        moveCursor(state, -first);
      }
      break;
    case "C":
      if (wantsWordMotion) {
        moveWordRight(state);
      } else {
        moveCursor(state, first);
      }
      break;
    case "H":
      state.cursor = 0;
      break;
    case "F":
      state.cursor = state.chars.length;
      break;
    case "~":
      switch (first) {
        case 1:
        case 7:
        case 200: // bracketed-paste start
        case 201: // bracketed-paste end
          if (first === 1 || first === 7) state.cursor = 0;
          break;
        case 4:
        case 8:
          state.cursor = state.chars.length;
          break;
        case 3:
          deleteForward(state);
          break;
        default:
          break;
      }
      break;
    default:
      break;
  }
}

/**
 * Replays common terminal line-editing input and returns the final visible
 * prompt line. Unknown escape sequences are ignored instead of leaking into the
 * title text.
 */
export function reconstructPiPromptLine(rawLine: string): string {
  const state: EditableLineState = { chars: [], cursor: 0 };

  for (let index = 0; index < rawLine.length;) {
    const current = rawLine[index];
    if (!current) break;

    if (current === ESC) {
      const next = rawLine[index + 1];
      if (next === "[") {
        let end = index + 2;
        while (end < rawLine.length) {
          const code = rawLine.charCodeAt(end);
          if (code >= 0x40 && code <= 0x7e) break;
          end += 1;
        }
        if (end >= rawLine.length) break;
        applyCsiSequence(state, rawLine.slice(index, end + 1));
        index = end + 1;
        continue;
      }
      if (next === "]") {
        let end = index + 2;
        while (end < rawLine.length) {
          const char = rawLine[end];
          if (char === "\x07") {
            end += 1;
            break;
          }
          if (char === ESC && rawLine[end + 1] === "\\") {
            end += 2;
            break;
          }
          end += 1;
        }
        index = Math.min(end, rawLine.length);
        continue;
      }
      if (next === "O") {
        const code = rawLine[index + 2];
        if (code) {
          applySs3Sequence(state, code);
          index += 3;
          continue;
        }
        break;
      }
      if (next === "b" || next === "B") {
        moveWordLeft(state);
        index += 2;
        continue;
      }
      if (next === "f" || next === "F") {
        moveWordRight(state);
        index += 2;
        continue;
      }
      if (next === "d" || next === "D") {
        deleteWordRight(state);
        index += 2;
        continue;
      }
      if (next === DELETE) {
        deleteWordLeft(state);
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (current === BACKSPACE || current === DELETE) {
      deleteBackward(state);
      index += 1;
      continue;
    }

    switch (current) {
      case "\x01": // Ctrl+A
        state.cursor = 0;
        index += 1;
        continue;
      case "\x02": // Ctrl+B
        moveCursor(state, -1);
        index += 1;
        continue;
      case "\x04": // Ctrl+D
        deleteForward(state);
        index += 1;
        continue;
      case "\x05": // Ctrl+E
        state.cursor = state.chars.length;
        index += 1;
        continue;
      case "\x06": // Ctrl+F
        moveCursor(state, 1);
        index += 1;
        continue;
      case "\x0b": // Ctrl+K
        state.chars.splice(state.cursor);
        index += 1;
        continue;
      case "\x15": // Ctrl+U
        state.chars.splice(0, state.cursor);
        state.cursor = 0;
        index += 1;
        continue;
      case "\x17": // Ctrl+W
        deleteWordLeft(state);
        index += 1;
        continue;
      default:
        break;
    }

    const codePoint = rawLine.codePointAt(index);
    if (codePoint == null) break;
    const char = String.fromCodePoint(codePoint);
    if (codePoint >= 0x20 || char === "\t") {
      insertText(state, char);
    }
    index += char.length;
  }

  return state.chars.join("");
}

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
  const stripped = reconstructPiPromptLine(firstLine).trim();
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
