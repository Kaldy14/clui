import { MemoryStickIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { clearIdleTerminals, getCacheStats, type CacheStats } from "../lib/claudeTerminalCache";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

const POLL_INTERVAL_MS = 30_000;
const DISMISS_COOLDOWN_MS = 10 * 60_000; // 10 minutes
/** Show banner when clearable memory exceeds this threshold. */
const MEMORY_THRESHOLD_BYTES = 300 * 1024 * 1024; // 300 MB

function formatMB(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${Math.round(mb)}MB`;
}

export default function MemoryPressureBanner() {
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const dismissedAt = useRef(0);

  useEffect(() => {
    function poll() {
      const next = getCacheStats();
      setStats(next);

      // Auto-resurface if dismissed and memory grew significantly
      if (dismissed && Date.now() - dismissedAt.current > DISMISS_COOLDOWN_MS) {
        setDismissed(false);
      }
    }

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [dismissed]);

  const handleClear = useCallback(() => {
    const cleared = clearIdleTerminals();
    if (cleared > 0) {
      setStats(getCacheStats());
    }
    setDismissed(true);
    dismissedAt.current = Date.now();
  }, []);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    dismissedAt.current = Date.now();
  }, []);

  if (
    dismissed ||
    !stats ||
    stats.clearableCount < 2 ||
    stats.clearableEstimatedBytes < MEMORY_THRESHOLD_BYTES
  ) {
    return null;
  }

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-xs text-amber-700 dark:border-amber-400/15 dark:bg-amber-400/5 dark:text-amber-400">
      <MemoryStickIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        {stats.clearableCount} idle terminal{stats.clearableCount !== 1 ? "s" : ""} using
        ~{formatMB(stats.clearableEstimatedBytes)} of memory
      </span>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button size="xs" variant="outline" onClick={handleClear} className="h-5 border-amber-500/30 text-[10px] text-amber-700 hover:bg-amber-500/10 dark:border-amber-400/20 dark:text-amber-400 dark:hover:bg-amber-400/10" />
            }
          >
            Clear idle
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            Free memory by disposing cached terminal buffers for inactive threads.
            Active, working, and recently used terminals are kept safe.
          </TooltipPopup>
        </Tooltip>
      </TooltipProvider>
      <button
        type="button"
        onClick={handleDismiss}
        className="rounded p-0.5 text-amber-600/60 transition-colors hover:text-amber-700 dark:text-amber-400/50 dark:hover:text-amber-400"
        aria-label="Dismiss"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}
