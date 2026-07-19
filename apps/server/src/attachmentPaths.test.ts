import path from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeAttachmentRelativePath, resolveAttachmentRelativePath } from "./attachmentPaths";

describe("normalizeAttachmentRelativePath", () => {
  it("normalizes leading separators and backslashes", () => {
    expect(normalizeAttachmentRelativePath("/threads/thread-1/screenshot.png")).toBe(
      "threads/thread-1/screenshot.png",
    );
    expect(normalizeAttachmentRelativePath("\\threads\\thread-1\\screenshot.png")).toBe(
      "threads/thread-1/screenshot.png",
    );
  });

  it("rejects empty, traversal, and null-byte paths", () => {
    expect(normalizeAttachmentRelativePath("")).toBeNull();
    expect(normalizeAttachmentRelativePath("../secret.txt")).toBeNull();
    expect(normalizeAttachmentRelativePath("thread-1/\0secret.txt")).toBeNull();
  });
});

describe("resolveAttachmentRelativePath", () => {
  it("resolves normalized paths under the attachment root", () => {
    const stateDir = path.join(path.sep, "tmp", "clui-state");

    expect(
      resolveAttachmentRelativePath({ stateDir, relativePath: "thread-1/screenshot.png" }),
    ).toBe(path.resolve(path.join(stateDir, "attachments", "thread-1/screenshot.png")));
  });

  it("rejects traversal outside the attachment root", () => {
    const stateDir = path.join(path.sep, "tmp", "clui-state");

    expect(resolveAttachmentRelativePath({ stateDir, relativePath: "../secret.txt" })).toBeNull();
  });
});
