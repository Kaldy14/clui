import { describe, expect, it } from "vitest";

import { createDesktopPackageIdentity, DESKTOP_EXECUTABLE_NAME } from "./desktop-build-config";

describe("desktop build configuration", () => {
  it("keeps the display name while using a path-safe executable name", () => {
    expect(createDesktopPackageIdentity("Clui (Alpha)")).toEqual({
      productName: "Clui (Alpha)",
      executableName: "Clui",
    });
    expect(DESKTOP_EXECUTABLE_NAME).toMatch(/^[A-Za-z0-9._ -]+$/);
  });
});
