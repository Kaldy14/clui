import type { IBuffer, IModes } from "@xterm/xterm";

/**
 * Use arrow keys only when xterm cannot report wheel events to the TUI.
 * VT200 and the motion-tracking modes all include native wheel reporting.
 */
export function shouldConvertWheelToArrowKeys(
  bufferType: IBuffer["type"],
  mouseTrackingMode: IModes["mouseTrackingMode"],
): boolean {
  return (
    bufferType === "alternate" && (mouseTrackingMode === "none" || mouseTrackingMode === "x10")
  );
}
