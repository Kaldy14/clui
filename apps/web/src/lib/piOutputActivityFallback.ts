import type { ClaudeHookStatus, TerminalStatus } from "@clui/contracts";
import {
  hasPiWorkingStatusOutput,
  hasVisiblePiOutput,
  stripPiTerminalControls,
} from "@clui/shared/piTerminalStatus";

export { hasPiWorkingStatusOutput, hasVisiblePiOutput, stripPiTerminalControls };

export const PI_OUTPUT_ACTIVITY_IDLE_MS = 5_000;

export interface PiOutputActivityThreadState {
  readonly hookStatus: ClaudeHookStatus | null | undefined;
  readonly terminalStatus: TerminalStatus | undefined;
}

export interface PiOutputActivityFallbackDeps {
  readonly getThreadState: (rawThreadId: string) => PiOutputActivityThreadState;
  readonly setHookStatus: (rawThreadId: string, status: ClaudeHookStatus | null) => void;
  readonly onStatusChanged?: () => void;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

export interface PiOutputActivityFallback {
  readonly handleOutput: (rawThreadId: string, data: string) => boolean;
  readonly handleRealHookStatus: (rawThreadId: string) => void;
  readonly handleDormant: (rawThreadId: string) => void;
  readonly clearAll: () => void;
}

export function createPiOutputActivityFallback(
  deps: PiOutputActivityFallbackDeps,
): PiOutputActivityFallback {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const restoreStatusByThread = new Map<string, ClaudeHookStatus | null>();
  const setTimer = deps.setTimeout ?? setTimeout;
  const clearTimerFn = deps.clearTimeout ?? clearTimeout;

  const clearThread = (rawThreadId: string) => {
    const timer = timers.get(rawThreadId);
    if (timer) clearTimerFn(timer);
    timers.delete(rawThreadId);
    restoreStatusByThread.delete(rawThreadId);
  };

  const scheduleRestore = (rawThreadId: string) => {
    const existing = timers.get(rawThreadId);
    if (existing) clearTimerFn(existing);

    const timer = setTimer(() => {
      timers.delete(rawThreadId);
      if (!restoreStatusByThread.has(rawThreadId)) return;
      const restoreStatus = restoreStatusByThread.get(rawThreadId) ?? null;
      restoreStatusByThread.delete(rawThreadId);

      const current = deps.getThreadState(rawThreadId);
      if (current.terminalStatus !== "active" || current.hookStatus !== "working") return;
      deps.setHookStatus(rawThreadId, restoreStatus);
      deps.onStatusChanged?.();
    }, PI_OUTPUT_ACTIVITY_IDLE_MS);
    timers.set(rawThreadId, timer);
  };

  const handleOutput = (rawThreadId: string, data: string): boolean => {
    if (!hasPiWorkingStatusOutput(data)) return false;

    const current = deps.getThreadState(rawThreadId);
    if (current.terminalStatus !== "active") return false;
    if (
      current.hookStatus === "needsInput" ||
      current.hookStatus === "pendingApproval" ||
      current.hookStatus === "error"
    ) {
      return false;
    }

    const alreadyOutputDerived = restoreStatusByThread.has(rawThreadId);
    if (current.hookStatus === "working" && !alreadyOutputDerived) {
      return false;
    }

    if (!alreadyOutputDerived) {
      // "Completed" is an attention marker, not a durable live state. Restoring
      // it after a transient pi Working redraw can make a read completion look
      // unread again because setHookStatus("completed") records a fresh marker.
      restoreStatusByThread.set(
        rawThreadId,
        current.hookStatus === "completed" ? null : (current.hookStatus ?? null),
      );
    }

    let changed = false;
    if (current.hookStatus !== "working") {
      deps.setHookStatus(rawThreadId, "working");
      deps.onStatusChanged?.();
      changed = true;
    }

    scheduleRestore(rawThreadId);
    return changed;
  };

  return {
    handleOutput,
    handleRealHookStatus: clearThread,
    handleDormant: clearThread,
    clearAll() {
      for (const timer of timers.values()) clearTimerFn(timer);
      timers.clear();
      restoreStatusByThread.clear();
    },
  };
}
