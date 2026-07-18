import { createRequire } from "node:module";

import { assert, describe, it } from "@effect/vitest";

const require = createRequire(import.meta.url);
const { createAfterSign, resolveMacAppPath } = require("./after-sign-macos.cjs") as {
  readonly createAfterSign: (
    loadNotarizer?: () => Promise<{
      readonly notarizeMacosApp: (options: { readonly appPath: string }) => Promise<void>;
    }>,
  ) => (context: unknown) => Promise<void>;
  readonly resolveMacAppPath: (context: unknown) => string;
};

function macContext() {
  return {
    appOutDir: "/tmp/mac-arm64",
    electronPlatformName: "darwin",
    packager: {
      appInfo: {
        productFilename: "Clui (Alpha)",
      },
    },
  };
}

describe("after-sign-macos", () => {
  it("derives the application path from electron-builder context", () => {
    assert.equal(resolveMacAppPath(macContext()), "/tmp/mac-arm64/Clui (Alpha).app");
  });

  it("delegates macOS notarization with the resolved application path", async () => {
    const appPaths: string[] = [];
    const afterSign = createAfterSign(async () => ({
      notarizeMacosApp: async ({ appPath }) => {
        appPaths.push(appPath);
      },
    }));

    await afterSign(macContext());

    assert.deepStrictEqual(appPaths, ["/tmp/mac-arm64/Clui (Alpha).app"]);
  });

  it("ignores non-macOS hook invocations", async () => {
    let loaded = false;
    const afterSign = createAfterSign(async () => {
      loaded = true;
      return { notarizeMacosApp: async () => undefined };
    });

    await afterSign({ ...macContext(), electronPlatformName: "linux" });

    assert.equal(loaded, false);
  });

  it("rejects an incomplete hook context", () => {
    assert.throws(() => resolveMacAppPath({ electronPlatformName: "darwin" }), /missing/);
  });
});
