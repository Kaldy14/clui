import { describe, expect, it } from "vitest";
import { stripTerminalResponses } from "./terminalInputFilter";

describe("stripTerminalResponses", () => {
  it("strips OSC 11 background color response (ST = ESC backslash)", () => {
    const input = "\x1b]11;rgb:0c0c/0c0c/0c0c\x1b\\";
    expect(stripTerminalResponses(input)).toBe("");
  });

  it("strips OSC 11 background color response (ST = BEL)", () => {
    const input = "\x1b]11;rgb:0c0c/0c0c/0c0c\x07";
    expect(stripTerminalResponses(input)).toBe("");
  });

  it("strips CPR (cursor position report)", () => {
    expect(stripTerminalResponses("\x1b[16;1R")).toBe("");
    expect(stripTerminalResponses("\x1b[1;1R")).toBe("");
    expect(stripTerminalResponses("\x1b[999;999R")).toBe("");
  });

  it("strips multiple responses concatenated", () => {
    const input = "\x1b]11;rgb:0c0c/0c0c/0c0c\x1b\\\x1b[16;1R\x1b]11;rgb:0c0c/0c0c/0c0c\x1b\\\x1b[16;1R";
    expect(stripTerminalResponses(input)).toBe("");
  });

  it("preserves normal user input", () => {
    expect(stripTerminalResponses("hello")).toBe("hello");
    expect(stripTerminalResponses("\r")).toBe("\r");
    expect(stripTerminalResponses("\x1b[A")).toBe("\x1b[A"); // arrow up
  });

  it("preserves user input mixed with responses", () => {
    const input = "abc\x1b]11;rgb:0c0c/0c0c/0c0c\x1b\\def";
    expect(stripTerminalResponses(input)).toBe("abcdef");
  });

  it("returns empty string when input is only responses", () => {
    const input = "\x1b]11;rgb:ffff/ffff/ffff\x07\x1b[24;80R";
    expect(stripTerminalResponses(input)).toBe("");
  });

  it("handles OSC 10 foreground color response", () => {
    const input = "\x1b]10;rgb:ffff/ffff/ffff\x1b\\";
    expect(stripTerminalResponses(input)).toBe("");
  });
});
