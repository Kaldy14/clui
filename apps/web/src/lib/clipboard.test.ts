import { describe, expect, it } from "vitest";
import { clipboardItemsContainImageFile } from "./clipboard";

const item = (
  kind: DataTransferItem["kind"],
  type: string,
): Pick<DataTransferItem, "kind" | "type"> => ({
  kind,
  type,
});

describe("clipboardItemsContainImageFile", () => {
  it("detects image file clipboard items", () => {
    expect(clipboardItemsContainImageFile([item("file", "image/png")])).toBe(true);
    expect(
      clipboardItemsContainImageFile([item("string", "text/plain"), item("file", "image/jpeg")]),
    ).toBe(true);
  });

  it("ignores text and non-image file clipboard items", () => {
    expect(clipboardItemsContainImageFile([item("string", "text/plain")])).toBe(false);
    expect(clipboardItemsContainImageFile([item("file", "application/pdf")])).toBe(false);
    expect(clipboardItemsContainImageFile([item("file", "")])).toBe(false);
  });

  it("handles empty or unavailable clipboard item lists", () => {
    expect(clipboardItemsContainImageFile(null)).toBe(false);
    expect(clipboardItemsContainImageFile(undefined)).toBe(false);
    expect(clipboardItemsContainImageFile([])).toBe(false);
  });
});
