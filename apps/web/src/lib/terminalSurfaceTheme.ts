import type { CodingHarness } from "@clui/contracts";
import type { Terminal } from "@xterm/xterm";
import { terminalThemeFromApp } from "./terminalTheme";

export const TERMINAL_LINE_HEIGHT = 1.2;
export const PI_TERMINAL_LINE_HEIGHT = 1.1;

export function terminalLineHeightForHarness(harness: CodingHarness): number {
  return harness === "pi" ? PI_TERMINAL_LINE_HEIGHT : TERMINAL_LINE_HEIGHT;
}

/**
 * Keep the host DOM surface in sync with the terminal theme.
 *
 * xterm's fit addon rounds rows down to whole cells, which can leave a few
 * remainder pixels at the bottom of the container. If the host surface keeps
 * the app background instead of the terminal background, that remainder shows
 * up as a visible stripe.
 */
export function syncTerminalSurfaceTheme(
  container: HTMLElement | null | undefined,
  terminal?: Terminal | null,
): void {
  const theme = terminalThemeFromApp();

  if (container) {
    container.style.backgroundColor = theme.background ?? "";
    container.style.color = theme.foreground ?? "";
  }

  if (terminal) {
    terminal.options.theme = theme;
    if (terminal.rows > 0) {
      terminal.refresh(0, terminal.rows - 1);
    }
  }
}
