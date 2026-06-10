import { describe, expect, it } from "vitest";

import {
  appendCompactedTerminalOutput,
  compactTerminalCatchUpReplay,
} from "./terminalOutputCompaction";

describe("compactTerminalCatchUpReplay", () => {
  it("keeps small output unchanged", () => {
    expect(compactTerminalCatchUpReplay("hello", 10)).toEqual({
      data: "hello",
      compacted: false,
    });
  });

  it("keeps output from the latest repaint boundary", () => {
    const output = `old frame${"x".repeat(20)}\x1b[Hcurrent frame`;

    expect(compactTerminalCatchUpReplay(output, 32)).toEqual({
      data: "\x1b[Hcurrent frame",
      compacted: true,
    });
  });

  it("falls back to a bounded tail when no repaint boundary exists", () => {
    expect(compactTerminalCatchUpReplay("abcdefghijklmnopqrstuvwxyz", 8)).toEqual({
      data: "stuvwxyz",
      compacted: true,
    });
  });

  it("avoids starting bounded output in the middle of nearby escape text", () => {
    const output = `${"x".repeat(20)}\x1b[31mred text`;

    expect(compactTerminalCatchUpReplay(output, 16)).toEqual({
      data: "\x1b[31mred text",
      compacted: true,
    });
  });
});

describe("appendCompactedTerminalOutput", () => {
  it("compacts appended output over the limit", () => {
    expect(appendCompactedTerminalOutput("old", "\x1b[Hnew screen", 15)).toEqual({
      data: "\x1b[Hnew screen",
      compacted: true,
    });
  });
});
