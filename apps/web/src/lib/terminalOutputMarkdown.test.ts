import { describe, expect, it } from "vitest";

import { createMarkdownCodeFenceFilter, stripMarkdownCodeFences } from "./terminalOutputMarkdown";

describe("stripMarkdownCodeFences", () => {
  it("removes a basic backtick code block", () => {
    const input = "Here is some code:\n```\nconst x = 1;\n```\nDone.";
    expect(stripMarkdownCodeFences(input)).toBe("Here is some code:\nconst x = 1;\nDone.");
  });

  it("removes fences with a language tag", () => {
    const input = "```typescript\nlet n: number = 1;\n```";
    expect(stripMarkdownCodeFences(input)).toBe("let n: number = 1;\n");
  });

  it("removes tilde fences", () => {
    const input = "~~~\nplain text\n~~~";
    expect(stripMarkdownCodeFences(input)).toBe("plain text\n");
  });

  it("keeps content lines that happen to contain backticks", () => {
    const input = "```\nconst s = `hello`;\nconst t = `${x}`;\n```";
    expect(stripMarkdownCodeFences(input)).toBe("const s = `hello`;\nconst t = `${x}`;\n");
  });

  it("handles Windows-style line endings", () => {
    const input = "```\r\nline one\r\n```\r\n";
    expect(stripMarkdownCodeFences(input)).toBe("line one\r\n");
  });

  it("treats an unmatched closing fence as an opening fence and removes it", () => {
    const input = "some text\n```\nmore text";
    expect(stripMarkdownCodeFences(input)).toBe("some text\nmore text");
  });

  it("handles ANSI SGR escape sequences on fence lines", () => {
    const input = "\x1b[90m```\x1b[0m\ncontent\n\x1b[90m```\x1b[0m";
    expect(stripMarkdownCodeFences(input)).toBe("content\n");
  });

  it("does not drop fence-looking lines with cursor control sequences", () => {
    const input = "\x1b[2K```\ncontent\n```";
    expect(stripMarkdownCodeFences(input)).toBe("\x1b[2K```\ncontent\n");
  });

  it("treats a higher backtick count as nested fence content", () => {
    const input = "````\nouter\n```\ninner\n```\n````";
    // The inner ``` line is content because it has fewer backticks than the opener.
    expect(stripMarkdownCodeFences(input)).toBe("outer\n```\ninner\n```\n");
  });

  it("returns an empty string when all input is fences", () => {
    expect(stripMarkdownCodeFences("```\n```")).toBe("");
  });
});

describe("createMarkdownCodeFenceFilter", () => {
  it("removes complete fence lines across output chunks", () => {
    const filter = createMarkdownCodeFenceFilter();
    const part1 = filter.process("Here is code:\n");
    const part2 = filter.process("```\nconst x = 1;\n```\nDone.");

    expect(part1).toBe("Here is code:\n");
    expect(part2).toBe("const x = 1;\nDone.");
  });

  it("emits normal incomplete tails immediately", () => {
    const filter = createMarkdownCodeFenceFilter();
    const output = filter.process("prompt > ");

    expect(output).toBe("prompt > ");
  });

  it("removes fence lines split across chunks", () => {
    const filter = createMarkdownCodeFenceFilter();

    expect(filter.process("`")).toBe("");
    expect(filter.process("``\nline\n`")).toBe("line\n");
    expect(filter.process("``\nafter")).toBe("after");
  });

  it("releases partial fence prefixes when they become normal output", () => {
    const filter = createMarkdownCodeFenceFilter();

    expect(filter.process("`")).toBe("");
    expect(filter.process("not a fence")).toBe("`not a fence");
    expect(filter.process(" still same line")).toBe(" still same line");
    expect(filter.process("\nnext")).toBe("\nnext");
  });

  it("removes styled fence lines split inside SGR sequences", () => {
    const filter = createMarkdownCodeFenceFilter();

    expect(filter.process("\x1b[")).toBe("");
    expect(filter.process("90m```\x1b[")).toBe("");
    expect(filter.process("0m\ncontent\n\x1b[90m```\x1b[0m\n")).toBe("content\n");
  });

  it("flushes buffered non-fence tails", () => {
    const filter = createMarkdownCodeFenceFilter();

    expect(filter.process("`")).toBe("");
    expect(filter.flush()).toBe("`");
  });

  it("tracks state across multiple chunks", () => {
    const filter = createMarkdownCodeFenceFilter();
    expect(filter.process("```\n")).toBe("");
    expect(filter.process("line one\n")).toBe("line one\n");
    expect(filter.process("```\n")).toBe("");
    expect(filter.process("after\n")).toBe("after\n");
  });

  it("flushes without emitting extra data", () => {
    const filter = createMarkdownCodeFenceFilter();
    filter.process("```\ncontent\n```");
    expect(filter.flush()).toBe("");
  });
});
