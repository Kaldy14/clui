import { describe, expect, it } from "vitest";

import { advancePiWritePromptBuffer, reconstructPiPromptLine } from "./piWritePromptBuffer";

describe("reconstructPiPromptLine", () => {
  it("preserves plain input", () => {
    expect(reconstructPiPromptLine("fix login bug")).toBe("fix login bug");
  });

  it("applies backspace edits", () => {
    expect(reconstructPiPromptLine("hellp\x7fo")).toBe("hello");
  });

  it("applies cursor-left insertions", () => {
    expect(reconstructPiPromptLine("heo\x1b[Dll")).toBe("hello");
  });

  it("applies delete-forward edits", () => {
    expect(reconstructPiPromptLine("helxo\x1b[D\x1b[D\x1b[3~l")).toBe("hello");
  });

  it("applies home/end readline controls", () => {
    expect(reconstructPiPromptLine("ello\x01h")).toBe("hello");
    expect(reconstructPiPromptLine("hell\x01\x05o")).toBe("hello");
  });

  it("ignores bracketed-paste wrappers while preserving pasted text", () => {
    expect(reconstructPiPromptLine("\x1b[200~fix login bug\x1b[201~")).toBe("fix login bug");
  });
});

describe("advancePiWritePromptBuffer", () => {
  it("buffers until newline", () => {
    const buffers = new Map<string, string>();
    expect(advancePiWritePromptBuffer(buffers, "t1", "fix ")).toEqual({ kind: "buffering" });
    expect(buffers.get("t1")).toBe("fix ");
  });

  it("returns reconstructed first line on submit across chunks", () => {
    const buffers = new Map<string, string>();
    expect(advancePiWritePromptBuffer(buffers, "t1", "hellp")).toEqual({ kind: "buffering" });
    expect(advancePiWritePromptBuffer(buffers, "t1", "\x7fo\r")).toEqual({
      kind: "submitted",
      firstLineStripped: "hello",
    });
    expect(buffers.has("t1")).toBe(false);
  });

  it("returns empty_submit when the edited line is blank", () => {
    const buffers = new Map<string, string>();
    expect(advancePiWritePromptBuffer(buffers, "t1", "a\x7f\r")).toEqual({ kind: "empty_submit" });
  });
});
