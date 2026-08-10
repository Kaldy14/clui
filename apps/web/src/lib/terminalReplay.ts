import type { CodingHarness } from "@clui/contracts";

import { isPiDerivedHarness } from "./harnessCapabilities";

export const TERMINAL_FULL_RESET_SEQUENCE = "\u001bc";
export const TERMINAL_ENABLE_BRACKETED_PASTE_SEQUENCE = "\x1b[?2004h";

export interface TerminalWriter {
  write(data: string): void;
}

/**
 * Restores xterm-local input modes that the running harness expects.
 *
 * Pi-derived TUIs enable bracketed paste when they start, but Clui can replay
 * truncated scrollback that no longer contains that startup DECSET. If we
 * reset xterm during replay and do not restore the local mode, multiline
 * browser paste is converted into raw Enter keypresses and the harness submits each row
 * as a separate queued message.
 */
export function restoreTerminalInputModesForHarness(
  terminal: TerminalWriter,
  harness: CodingHarness,
): void {
  if (!isPiDerivedHarness(harness)) return;
  terminal.write(TERMINAL_ENABLE_BRACKETED_PASTE_SEQUENCE);
}

/**
 * Full-reset xterm before replaying a fresh scrollback snapshot, then restore
 * harness-specific local input modes that are not guaranteed to be present in
 * the retained scrollback window.
 */
export function writeTerminalFullResetForReplay(
  terminal: TerminalWriter,
  harness: CodingHarness,
): void {
  terminal.write(TERMINAL_FULL_RESET_SEQUENCE);
  restoreTerminalInputModesForHarness(terminal, harness);
}
