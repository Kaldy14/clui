import { type ThreadId } from "@clui/contracts";
import type { ClaudeSessionEvent } from "@clui/contracts";
import { PlayIcon, PlusCircleIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import * as claudeCache from "../lib/claudeTerminalCache";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import type { Thread } from "../types";

// ── NewThreadView ─────────────────────────────────────────────────────

function NewThreadView({
  threadId,
  thread,
}: {
  threadId: ThreadId;
  thread: Thread;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = useStore((s) => s.projects.find((p) => p.id === thread.projectId));
  const cwd = thread.worktreePath ?? project?.cwd ?? "";

  const handleStart = useCallback(async () => {
    const api = readNativeApi();
    if (!api || !cwd) return;
    setStarting(true);
    setError(null);
    try {
      // cols/rows are initial defaults — ActiveTerminalView sends a corrective
      // resize with actual container dimensions immediately after mounting.
      await api.claude.start({
        threadId,
        cwd,
        cols: 120,
        rows: 40,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start session");
      setStarting(false);
    }
  }, [threadId, cwd]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
      <div className="flex flex-col items-center gap-2 text-center">
        <PlusCircleIcon className="size-10 text-muted-foreground/50" aria-hidden="true" />
        <h2 className="text-lg font-medium text-foreground">Start Conversation</h2>
        {cwd && (
          <p className="max-w-md truncate text-sm text-muted-foreground" title={cwd}>
            {cwd}
          </p>
        )}
      </div>
      <button
        type="button"
        disabled={starting || !cwd}
        aria-busy={starting}
        onClick={handleStart}
        className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
      >
        {starting ? "Starting..." : "Start Claude"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

// ── DormantTerminalView ───────────────────────────────────────────────

function DormantTerminalView({
  threadId,
  thread,
}: {
  threadId: ThreadId;
  thread: Thread;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = useStore((s) => s.projects.find((p) => p.id === thread.projectId));
  const cwd = thread.worktreePath ?? project?.cwd ?? "";

  // Render scrollback in a read-only xterm.js instance (or reuse cached)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // If there's a cached terminal from a previous active session, reuse it
    const cached = claudeCache.get(threadId);
    if (cached) {
      claudeCache.attach(threadId, el);
      cached.terminal.options.disableStdin = true;
      return () => {
        claudeCache.detach(threadId);
      };
    }

    // Otherwise, fetch scrollback and render in a new terminal
    let ownsCacheEntry = true;
    const entry = claudeCache.attach(threadId, el);
    entry.terminal.options.disableStdin = true;
    const api = readNativeApi();
    if (!api) return;

    let disposed = false;
    void api.claude.getScrollback({ threadId }).then((result) => {
      if (disposed) return;
      if (result.scrollback) {
        entry.terminal.write(result.scrollback);
      }
    });

    return () => {
      disposed = true;
      claudeCache.detach(threadId);
      // Dispose dormant terminals on unmount — they're cheap to recreate
      // and we don't want stale scrollback accumulating in memory.
      if (ownsCacheEntry) {
        claudeCache.dispose(threadId);
      }
    };
  }, [threadId]);

  const handleResume = useCallback(async () => {
    const api = readNativeApi();
    if (!api || !cwd) return;
    setResuming(true);
    setError(null);
    try {
      // Read actual terminal dimensions before disposing
      const cached = claudeCache.get(threadId);
      const cols = cached?.terminal.cols ?? 120;
      const rows = cached?.terminal.rows ?? 40;
      // Dispose the read-only terminal so ActiveTerminalView gets a fresh one
      claudeCache.dispose(threadId);
      await api.claude.start({
        threadId,
        cwd,
        cols,
        rows,
        resumeSessionId: thread.claudeSessionId ?? undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resume session");
      setResuming(false);
    }
  }, [threadId, cwd, thread.claudeSessionId]);

  return (
    <div className="flex h-full flex-col">
      <div ref={containerRef} className="min-h-0 flex-1 opacity-60" />
      <div className="flex items-center justify-center gap-3 border-t border-border/60 bg-muted/30 px-4 py-3">
        <button
          type="button"
          disabled={resuming || !cwd}
          aria-busy={resuming}
          onClick={handleResume}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          <PlayIcon className="size-3.5" aria-hidden="true" />
          {resuming ? "Resuming..." : "Resume Conversation"}
        </button>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

// ── ActiveTerminalView ────────────────────────────────────────────────

function ActiveTerminalView({ threadId }: { threadId: ThreadId }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const api = readNativeApi();
    if (!api) return;

    let disposed = false;

    // Subscribe to session events FIRST to avoid missing output
    const eventBuffer: ClaudeSessionEvent[] = [];
    let terminalReady = false;

    const entry = claudeCache.attach(threadId, el);
    const { terminal, fitAddon } = entry;
    terminal.options.disableStdin = false;

    const writeEvent = (event: ClaudeSessionEvent) => {
      if (event.threadId !== threadId) return;
      switch (event.type) {
        case "output":
          terminal.write(event.data);
          break;
        case "error":
          terminal.write(`\r\n[error] ${event.message}\r\n`);
          break;
        case "exited":
        case "started":
        case "hibernated":
        case "sessionId":
          // Handled by orchestration layer, not terminal view
          break;
      }
    };

    const unsubscribe = api.claude.onSessionEvent((event) => {
      if (event.threadId !== threadId) return;
      if (!terminalReady) {
        eventBuffer.push(event);
        return;
      }
      writeEvent(event);
    });

    // Get any scrollback we may have missed, then flush buffered events
    void api.claude
      .getScrollback({ threadId })
      .then((result) => {
        if (disposed) return;
        if (result.scrollback) {
          terminal.write("\u001bc"); // reset terminal first
          terminal.write(result.scrollback);
        }
        // Flush events that arrived during getScrollback
        terminalReady = true;
        for (const event of eventBuffer) {
          writeEvent(event);
        }
        eventBuffer.length = 0;
      })
      .catch(() => {
        if (disposed) return;
        // Even if scrollback fetch fails, start processing live events
        terminalReady = true;
        for (const event of eventBuffer) {
          writeEvent(event);
        }
        eventBuffer.length = 0;
      });

    // Forward keystrokes to the server
    const inputDisposable = terminal.onData((data) => {
      void api.claude.write({ threadId, data }).catch(() => undefined);
    });

    // Handle resize
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      void api.claude.resize({ threadId, cols, rows }).catch(() => undefined);
    });

    // Fit to container
    fitAddon.fit();

    // Send initial resize
    void api.claude
      .resize({ threadId, cols: terminal.cols, rows: terminal.rows })
      .catch(() => undefined);

    // Focus the terminal
    window.requestAnimationFrame(() => {
      if (!disposed) terminal.focus();
    });

    // Watch for window resize
    const onWindowResize = () => {
      fitAddon.fit();
    };
    window.addEventListener("resize", onWindowResize);

    // Watch for container resize (sidebar collapse/expand, split changes)
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(el);

    // Watch for theme changes
    const themeObserver = new MutationObserver(() => {
      claudeCache.refreshTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    return () => {
      disposed = true;
      window.removeEventListener("resize", onWindowResize);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      unsubscribe();
      inputDisposable.dispose();
      resizeDisposable.dispose();
      // Detach but keep in cache for instant reattachment
      claudeCache.detach(threadId);
    };
  }, [threadId]);

  return <div ref={containerRef} className="h-full w-full" />;
}

// ── ThreadTerminalView (three-state router) ───────────────────────────

export default function ThreadTerminalView({
  threadId,
}: {
  threadId: ThreadId;
}) {
  const thread = useStore((s) => s.threads.find((t) => t.id === threadId));

  if (!thread) return null;

  switch (thread.terminalStatus) {
    case "active":
      return <ActiveTerminalView threadId={threadId} />;
    case "dormant":
      return <DormantTerminalView threadId={threadId} thread={thread} />;
    case "new":
    default:
      return <NewThreadView threadId={threadId} thread={thread} />;
  }
}
