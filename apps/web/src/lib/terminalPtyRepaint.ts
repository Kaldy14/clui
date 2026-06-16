import type { CodingHarness, NativeApi, ThreadId } from "@clui/contracts";

export interface TerminalPtySize {
  cols: number;
  rows: number;
}

export interface RequestTerminalRepaintInput extends TerminalPtySize {
  api: NativeApi;
  harness: CodingHarness;
  threadId: ThreadId;
  /** Optional current-size reader used right before restoring on the next frame. */
  readRestoreSize?: () => TerminalPtySize;
}

export interface TerminalRepaintRequest {
  scheduled: boolean;
  cancel: () => void;
}

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
    return [
      { cols, rows: rows - 1 },
      normalized,
    ];
  }

  if (cols > 1) {
    return [
      { cols: cols - 1, rows },
      normalized,
    ];
  }

  return [];
}

/**
 * Request a real PTY repaint by momentarily changing terminal dimensions.
 *
 * TUI harnesses (Claude Code / pi) often buffer the current screen and only
 * repaint on SIGWINCH. A local xterm fit/refresh does not generate a new
 * SIGWINCH if the final dimensions match the PTY's current size, so sending a
 * one-row shrink followed by the actual size on the next frame forces the
 * harness to emit a fresh full-screen paint.
 */
export function requestTerminalRepaint(input: RequestTerminalRepaintInput): TerminalRepaintRequest {
  const sequence = resolveTerminalRepaintResizeSequence(input);
  if (sequence.length === 0) return NOT_SCHEDULED_REPAINT_REQUEST;

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

  if (typeof requestAnimationFrame === "function") {
    const rafId = requestAnimationFrame(runRestore);
    return {
      scheduled: true,
      cancel: () => {
        cancelAnimationFrame(rafId);
        runRestore();
      },
    };
  }

  // Tests run outside a browser environment, so fall back to setTimeout(0)
  // to keep the two resizes ordered and asynchronous.
  const timeoutId = setTimeout(runRestore, 0);
  return {
    scheduled: true,
    cancel: () => {
      clearTimeout(timeoutId);
      runRestore();
    },
  };
}
