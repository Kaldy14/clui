export const PI_TUI_NEWLINE_SEQUENCE = "\x1b[13;2u";
export const PI_TUI_SUBMIT_SEQUENCE = "\x1b[13u";

function unsafeControlCodePoint(prompt: string): number | null {
  for (const character of prompt) {
    const codePoint = character.codePointAt(0)!;
    const isAllowedLineBreak = codePoint === 0x0a || codePoint === 0x0d;
    const isC0Control = codePoint <= 0x1f || codePoint === 0x7f;
    const isC1Control = codePoint >= 0x80 && codePoint <= 0x9f;
    if (!isAllowedLineBreak && (isC0Control || isC1Control)) return codePoint;
  }
  return null;
}

function formatCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Encode a complete prompt as pi TUI keystrokes, including the final submit. */
export function encodePiTuiPrompt(prompt: string): string {
  const unsafeControl = unsafeControlCodePoint(prompt);
  if (unsafeControl !== null) {
    throw new Error(
      `Pi TUI prompts cannot contain control character ${formatCodePoint(unsafeControl)}`,
    );
  }

  const withoutTrailingSubmitChars = prompt.replace(/[\r\n]+$/u, "");
  return `${withoutTrailingSubmitChars.replace(/\r\n|\r|\n/gu, PI_TUI_NEWLINE_SEQUENCE)}${PI_TUI_SUBMIT_SEQUENCE}`;
}
