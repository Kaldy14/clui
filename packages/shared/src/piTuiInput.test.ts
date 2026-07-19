import { describe, expect, it } from "vitest";

import { encodePiTuiPrompt, PI_TUI_NEWLINE_SEQUENCE, PI_TUI_SUBMIT_SEQUENCE } from "./piTuiInput";

describe("encodePiTuiPrompt", () => {
  it("exports the exact Pi CSI-u input bytes", () => {
    expect(PI_TUI_NEWLINE_SEQUENCE).toBe("\x1b[13;2u");
    expect(PI_TUI_SUBMIT_SEQUENCE).toBe("\x1b[13u");
  });

  it("appends exactly one CSI-u Enter to a single-line prompt", () => {
    expect(encodePiTuiPrompt("fix the startup prompt")).toBe("fix the startup prompt\x1b[13u");
  });

  it("encodes mixed CRLF, CR, and LF line breaks as CSI-u Shift+Enter", () => {
    expect(encodePiTuiPrompt("one\ntwo\r\nthree\rfour")).toBe(
      "one\x1b[13;2utwo\x1b[13;2uthree\x1b[13;2ufour\x1b[13u",
    );
  });

  it("strips trailing CR/LF before appending one CSI-u Enter", () => {
    expect(encodePiTuiPrompt("prompt\r\n\n")).toBe("prompt\x1b[13u");
  });

  it("preserves normal Unicode while encoding allowed newlines exactly", () => {
    expect(encodePiTuiPrompt("café π\n東京")).toBe(
      `café π${PI_TUI_NEWLINE_SEQUENCE}東京${PI_TUI_SUBMIT_SEQUENCE}`,
    );
  });

  it.each([
    ["tab", `before${String.fromCodePoint(0x09)}after`, "U+0009"],
    ["Ctrl-C", `before${String.fromCodePoint(0x03)}after`, "U+0003"],
    ["ESC", `before${String.fromCodePoint(0x1b)}after`, "U+001B"],
    ["embedded CSI-u", `before${String.fromCodePoint(0x1b)}[13uafter`, "U+001B"],
    ["C1 control", `before${String.fromCodePoint(0x9b)}after`, "U+009B"],
  ])("rejects %s with the offending code point", (_label, prompt, codePoint) => {
    expect(() => encodePiTuiPrompt(prompt)).toThrow(codePoint);
  });

  it("keeps blank-string behavior compatible with terminal submission", () => {
    expect(encodePiTuiPrompt("")).toBe("\x1b[13u");
  });
});
