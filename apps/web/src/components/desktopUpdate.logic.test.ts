import { describe, expect, it } from "vitest";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@clui/contracts";

import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateBannerButtonLabel,
  getDesktopUpdateBannerTitle,
  getDesktopUpdateButtonTooltip,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldHighlightDesktopUpdateError,
  shouldOpenReleasesPage,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateBanner,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
  supportsInAppUpdate: true,
  releasesUrl: null,
};

describe("desktop update button state", () => {
  it("shows a download action when an update is available", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("keeps retry action available after a download error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("keeps install action available after an install error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      downloadedVersion: "1.1.0",
      availableVersion: "1.1.0",
      message: "shutdown timeout",
      errorContext: "install",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("hides the button for non-actionable check errors", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      message: "network unavailable",
      errorContext: "check",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(false);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
  });

  it("disables the button while downloading", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloading",
      availableVersion: "1.1.0",
      downloadPercent: 42.5,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(isDesktopUpdateButtonDisabled(state)).toBe(true);
    expect(getDesktopUpdateButtonTooltip(state)).toContain("42%");
  });
});

describe("getDesktopUpdateActionError", () => {
  it("returns user-visible message for accepted failed attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: false,
      state: {
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
        message: "checksum mismatch",
        errorContext: "download",
        canRetry: true,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBe("checksum mismatch");
  });

  it("ignores messages for non-accepted attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: false,
      completed: false,
      state: {
        ...baseState,
        status: "error",
        message: "background failure",
        errorContext: "check",
        canRetry: false,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBeNull();
  });

  it("ignores messages for successful attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: true,
      state: {
        ...baseState,
        status: "downloaded",
        downloadedVersion: "1.1.0",
        availableVersion: "1.1.0",
        message: null,
        errorContext: null,
        canRetry: true,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBeNull();
  });
});

describe("desktop update UI helpers", () => {
  it("toasts only for accepted incomplete actions", () => {
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: false,
        state: baseState,
      }),
    ).toBe(true);
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: true,
        state: baseState,
      }),
    ).toBe(false);
  });

  it("highlights only actionable updater errors", () => {
    expect(
      shouldHighlightDesktopUpdateError({
        ...baseState,
        status: "error",
        errorContext: "download",
        canRetry: true,
      }),
    ).toBe(true);
    expect(
      shouldHighlightDesktopUpdateError({
        ...baseState,
        status: "error",
        errorContext: "check",
        canRetry: true,
      }),
    ).toBe(false);
  });

  it("shows an Apple Silicon warning for Intel builds under Rosetta", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
    };

    expect(shouldShowArm64IntelBuildWarning(state)).toBe(true);
    expect(getArm64IntelBuildWarningDescription(state)).toContain("Apple Silicon");
    expect(getArm64IntelBuildWarningDescription(state)).toContain("Intel build");
  });

  it("changes the warning copy when a native build update is ready to download", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
      status: "available",
      availableVersion: "1.1.0",
    };

    expect(getArm64IntelBuildWarningDescription(state)).toContain("Download the available update");
  });
});

describe("desktop update banner", () => {
  it("shows the banner when an update is available", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "2.0.0",
    };
    expect(shouldShowDesktopUpdateBanner(state)).toBe(true);
    expect(getDesktopUpdateBannerTitle(state)).toBe("v2.0.0 available");
    expect(getDesktopUpdateBannerButtonLabel(state)).toBe("Download");
  });

  it("shows the banner with progress during download", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloading",
      availableVersion: "2.0.0",
      downloadPercent: 65.3,
    };
    expect(shouldShowDesktopUpdateBanner(state)).toBe(true);
    expect(getDesktopUpdateBannerTitle(state)).toBe("Downloading update 65%");
    expect(getDesktopUpdateBannerButtonLabel(state)).toBeNull();
  });

  it("shows install button when download is complete", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloaded",
      availableVersion: "2.0.0",
      downloadedVersion: "2.0.0",
      downloadPercent: 100,
    };
    expect(shouldShowDesktopUpdateBanner(state)).toBe(true);
    expect(getDesktopUpdateBannerTitle(state)).toBe("v2.0.0 ready to install");
    expect(getDesktopUpdateBannerButtonLabel(state)).toBe("Restart & Install");
  });

  it("shows error state for download failures", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "2.0.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateBanner(state)).toBe(true);
    expect(getDesktopUpdateBannerTitle(state)).toBe("Download failed");
    expect(getDesktopUpdateBannerButtonLabel(state)).toBe("Download");
  });

  it("shows error state for install failures", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "2.0.0",
      downloadedVersion: "2.0.0",
      message: "shutdown timeout",
      errorContext: "install",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateBanner(state)).toBe(true);
    expect(getDesktopUpdateBannerTitle(state)).toBe("Install failed");
    expect(getDesktopUpdateBannerButtonLabel(state)).toBe("Restart & Install");
  });

  it("hides the banner when disabled", () => {
    expect(shouldShowDesktopUpdateBanner({ ...baseState, enabled: false })).toBe(false);
  });

  it("hides the banner for check errors without actionable context", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      message: "network unavailable",
      errorContext: "check",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateBanner(state)).toBe(false);
  });

  it("hides the banner when up to date", () => {
    expect(shouldShowDesktopUpdateBanner({ ...baseState, status: "up-to-date" })).toBe(false);
  });
});

describe("macOS unsigned fallback (releases page)", () => {
  const unsignedMacBase: DesktopUpdateState = {
    ...baseState,
    supportsInAppUpdate: false,
    releasesUrl: "https://github.com/test/clui/releases/latest",
  };

  it("opens releases page when app is unsigned", () => {
    const state: DesktopUpdateState = {
      ...unsignedMacBase,
      status: "available",
      availableVersion: "2.0.0",
    };
    expect(shouldOpenReleasesPage(state)).toBe(true);
  });

  it("shows 'Download from GitHub' button label when unsigned", () => {
    const state: DesktopUpdateState = {
      ...unsignedMacBase,
      status: "available",
      availableVersion: "2.0.0",
    };
    expect(getDesktopUpdateBannerButtonLabel(state)).toBe("Download from GitHub");
  });

  it("does not open releases page when app is signed", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "2.0.0",
    };
    expect(shouldOpenReleasesPage(state)).toBe(false);
  });

  it("does not open releases page when releasesUrl is null", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      supportsInAppUpdate: false,
      releasesUrl: null,
      status: "available",
      availableVersion: "2.0.0",
    };
    expect(shouldOpenReleasesPage(state)).toBe(false);
  });
});
