import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

import {
  restoreTerminalInputModesForHarness,
  TERMINAL_ENABLE_BRACKETED_PASTE_SEQUENCE,
  TERMINAL_FULL_RESET_SEQUENCE,
  writeTerminalActiveRepaintReset,
  writeTerminalFullResetForReplay,
} from "./terminalReplay";

function writeAsync(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

async function flushWrites(terminal: Terminal): Promise<void> {
  await writeAsync(terminal, "\x1b[0m");
}

describe("terminal replay input modes", () => {
  it("documents that RIS clears xterm bracketed paste mode", async () => {
    const terminal = new Terminal({ allowProposedApi: true });
    try {
      await writeAsync(terminal, TERMINAL_ENABLE_BRACKETED_PASTE_SEQUENCE);
      expect(terminal.modes.bracketedPasteMode).toBe(true);

      await writeAsync(terminal, TERMINAL_FULL_RESET_SEQUENCE);
      expect(terminal.modes.bracketedPasteMode).toBe(false);
    } finally {
      terminal.dispose();
    }
  });

  it("restores pi bracketed paste mode after a full replay reset", async () => {
    const terminal = new Terminal({ allowProposedApi: true });
    try {
      writeTerminalFullResetForReplay(terminal, "pi");
      await flushWrites(terminal);

      expect(terminal.modes.bracketedPasteMode).toBe(true);
    } finally {
      terminal.dispose();
    }
  });

  it("does not force bracketed paste mode for Claude Code terminals", async () => {
    const terminal = new Terminal({ allowProposedApi: true });
    try {
      writeTerminalFullResetForReplay(terminal, "claudeCode");
      await flushWrites(terminal);

      expect(terminal.modes.bracketedPasteMode).toBe(false);
    } finally {
      terminal.dispose();
    }
  });

  it("can restore pi bracketed paste mode after replayed scrollback lacks startup DECSET", async () => {
    const terminal = new Terminal({ allowProposedApi: true });
    try {
      writeTerminalFullResetForReplay(terminal, "pi");
      await writeAsync(terminal, "recent scrollback only\r\nwithout startup terminal modes");
      restoreTerminalInputModesForHarness(terminal, "pi");
      await flushWrites(terminal);

      expect(terminal.modes.bracketedPasteMode).toBe(true);
    } finally {
      terminal.dispose();
    }
  });

  it("prepares active repaint replay without synthesizing alternate screen", async () => {
    const terminal = new Terminal({ allowProposedApi: true });
    try {
      expect(terminal.buffer.active.type).toBe("normal");

      writeTerminalActiveRepaintReset(terminal, "pi");
      await flushWrites(terminal);

      expect(terminal.buffer.active.type).toBe("normal");
      expect(terminal.modes.bracketedPasteMode).toBe(true);
    } finally {
      terminal.dispose();
    }
  });
});
