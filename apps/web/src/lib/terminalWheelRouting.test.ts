import { describe, expect, it } from "vitest";

import { shouldConvertWheelToArrowKeys } from "./terminalWheelRouting";

describe("shouldConvertWheelToArrowKeys", () => {
  it("keeps the alternate-buffer fallback when the TUI cannot receive wheel events", () => {
    expect(shouldConvertWheelToArrowKeys("alternate", "none")).toBe(true);
    expect(shouldConvertWheelToArrowKeys("alternate", "x10")).toBe(true);
  });

  it.each(["vt200", "drag", "any"] as const)(
    "lets xterm report wheel events in %s mouse tracking mode",
    (mouseTrackingMode) => {
      expect(shouldConvertWheelToArrowKeys("alternate", mouseTrackingMode)).toBe(false);
    },
  );

  it("does not convert wheel events in the normal buffer", () => {
    expect(shouldConvertWheelToArrowKeys("normal", "none")).toBe(false);
  });
});
