import type { CodingHarness, NativeApi, ThreadId } from "@clui/contracts";

export interface TerminalPtySize {
  cols: number;
  rows: number;
}

export interface RequestTerminalRepaintInput extends TerminalPtySize {
  api: NativeApi;
  harness: CodingHarness;
  threadId: ThreadId;
  /** Optional current-size reader used right before restoring. */
  readRestoreSize?: () => TerminalPtySize;
  /** How long to keep the PTY at the nudge size before restoring. */
  restoreDelayMs?: number;
}

export interface TerminalRepaintRequest {
  scheduled: boolean;
  cancel: () => void;
}

const DEFAULT_REPAINT_RESTORE_DELAY_MS = 90;

const NOT_SCHEDULED_REPAINT_REQUEST: TerminalRepaintRequest = Object.freeze({
  scheduled: false,
  cancel: () => undefined,
});

function normalizeTerminalPtySize(size: TerminalPtySize): TerminalPtySize | null {
  const cols = Math.trunc(size.cols);
  const rows = Math.trunc(size.rows);
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) {
    return null;
  }
  return { cols, rows };
}

/**
 * Build the resize sequence that forces a PTY SIGWINCH, then restores the real size.
 */
export function resolveTerminalRepaintResizeSequence(
  size: TerminalPtySize,
): readonly [TerminalPtySize, TerminalPtySize] | [] {
  const normalized = normalizeTerminalPtySize(size);
  if (!normalized) return [];

  const { cols, rows } = normalized;
  if (rows > 1) {
    return [{ cols, rows: rows - 1 }, normalized];
  }

  if (cols > 1) {
    return [{ cols: cols - 1, rows }, normalized];
  }

  return [];
}

/**
 * Request a real PTY repaint by briefly changing terminal dimensions.
 *
 * TUI harnesses (Claude Code / pi) often buffer the current screen and repaint
 * on SIGWINCH. Keep the nudge size alive briefly before restoring; restoring on
 * the next animation frame can be too fast and some TUIs coalesce it away.
 */
export function requestTerminalRepaint(input: RequestTerminalRepaintInput): TerminalRepaintRequest {
  const sequence = resolveTerminalRepaintResizeSequence(input);
  if (sequence.length === 0) return NOT_SCHEDULED_REPAINT_REQUEST;

  const restoreDelayMs = Math.max(
    0,
    Math.trunc(input.restoreDelayMs ?? DEFAULT_REPAINT_RESTORE_DELAY_MS),
  );

  const resize = (size: TerminalPtySize) => {
    if (input.harness === "pi") {
      void input.api.pi
        .resize({ threadId: input.threadId, cols: size.cols, rows: size.rows })
        .catch(() => undefined);
      return;
    }

    void input.api.claude
      .resize({ threadId: input.threadId, cols: size.cols, rows: size.rows })
      .catch(() => undefined);
  };

  resize(sequence[0]);

  let restored = false;
  const runRestore = () => {
    if (restored) return;
    restored = true;
    const latestRestoreSize = input.readRestoreSize?.() ?? sequence[1];
    resize(normalizeTerminalPtySize(latestRestoreSize) ?? sequence[1]);
  };

  const restoreTimeoutId = setTimeout(runRestore, restoreDelayMs);
  return {
    scheduled: true,
    cancel: () => {
      clearTimeout(restoreTimeoutId);
      runRestore();
    },
  };
}
