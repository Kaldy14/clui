import { type ThreadId } from "@clui/contracts";
import type { ClaudeSessionEvent } from "@clui/contracts";
import { PlayIcon, TerminalIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { isTerminalClearShortcut, terminalNavigationShortcutData } from "../keybindings";
import * as claudeCache from "../lib/claudeTerminalCache";
import { isMacPlatform } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import type { Thread } from "../types";
import type { EnvMode } from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { useBranchToolbar } from "./useBranchToolbar";

// ── Worktree branch prefix (per-project, localStorage) ───────────────

const BRANCH_PREFIX_STORAGE_KEY = "clui:worktree-branch-prefix";
const DEFAULT_BRANCH_PREFIX = "feature/ITE-";

function getWorktreeBranchPrefix(projectCwd: string): string {
  try {
    const raw = localStorage.getItem(BRANCH_PREFIX_STORAGE_KEY);
    if (raw) {
      const prefixes = JSON.parse(raw) as Record<string, string>;
      if (typeof prefixes[projectCwd] === "string") return prefixes[projectCwd];
    }
  } catch { /* best-effort */ }
  return DEFAULT_BRANCH_PREFIX;
}

function setWorktreeBranchPrefix(projectCwd: string, prefix: string): void {
  try {
    const raw = localStorage.getItem(BRANCH_PREFIX_STORAGE_KEY);
    const prefixes: Record<string, string> = raw ? JSON.parse(raw) : {};
    prefixes[projectCwd] = prefix;
    localStorage.setItem(BRANCH_PREFIX_STORAGE_KEY, JSON.stringify(prefixes));
  } catch { /* best-effort */ }
}

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
  const [envMode, setEnvMode] = useState<EnvMode>("local");
  const [prDialogOpen, setPrDialogOpen] = useState(false);
  const [prInitialReference, setPrInitialReference] = useState<string | null>(null);
  const project = useStore((s) => s.projects.find((p) => p.id === thread.projectId));
  const branchToolbar = useBranchToolbar(threadId);
  const cwd = thread.worktreePath ?? project?.cwd ?? "";
  const projectCwd = project?.cwd ?? "";
  const [branchPrefix, setBranchPrefix] = useState(() => getWorktreeBranchPrefix(projectCwd));
  const [editingPrefix, setEditingPrefix] = useState(false);
  const [worktreeBranchName, setWorktreeBranchName] = useState(() => getWorktreeBranchPrefix(projectCwd));
  const effectiveEnvMode: EnvMode = thread.worktreePath ? "worktree" : envMode;
  const isWorktreePending = effectiveEnvMode === "worktree" && !thread.worktreePath;
  const trimmedWorktreeBranch = worktreeBranchName.trim();
  const isWorktreeBranchValid = !isWorktreePending || (trimmedWorktreeBranch.length > 0 && !trimmedWorktreeBranch.endsWith("/") && !trimmedWorktreeBranch.endsWith("-"));

  const handleStart = useCallback(async () => {
    const api = readNativeApi();
    if (!api) return;
    setStarting(true);
    setError(null);
    try {
      let startCwd = cwd;
      // Create worktree if in worktree mode without one yet
      if (isWorktreePending && thread.branch && project?.cwd) {
        const branchArg = trimmedWorktreeBranch || thread.branch;
        const result = await api.git.createWorktree({
          cwd: project.cwd,
          branch: thread.branch,
          newBranch: trimmedWorktreeBranch || undefined,
          path: null,
        });
        branchToolbar.setThreadBranch(branchArg, result.worktree.path);
        startCwd = result.worktree.path;
      }
      if (!startCwd) return;
      // cols/rows are initial defaults — ActiveTerminalView sends a corrective
      // resize with actual container dimensions immediately after mounting.
      await api.claude.start({
        threadId,
        cwd: startCwd,
        cols: 120,
        rows: 40,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start session");
      setStarting(false);
    }
  }, [threadId, cwd, isWorktreePending, thread.branch, project?.cwd, branchToolbar, trimmedWorktreeBranch]);

  const showBranchInput = isWorktreePending && !!thread.branch;

  return (
    <div className="flex h-full flex-col items-center justify-center p-8">
      <div className="flex w-72 flex-col items-center gap-5 animate-fade-in">
        {/* Icon with subtle glow */}
        <div className="relative animate-zoom-fade-in">
          <div className="absolute inset-0 rounded-full bg-primary/10 blur-xl" />
          <div className="relative flex size-12 items-center justify-center rounded-xl border border-border/50 bg-card/80 shadow-sm dark:border-border/30 dark:bg-card/60">
            <TerminalIcon className="size-5 text-muted-foreground/70" aria-hidden="true" />
          </div>
        </div>

        {/* Copy — fixed height to prevent shift */}
        <div className="flex h-10 flex-col items-center justify-center gap-1.5 text-center">
          <h2 className="text-sm font-medium text-foreground/90">New Claude Session</h2>
          <p
            className="max-w-xs truncate font-mono text-[11px] text-muted-foreground/60 transition-opacity duration-200"
            title={isWorktreePending && thread.branch ? `Worktree from ${thread.branch}` : cwd}
          >
            {isWorktreePending && thread.branch ? (
              <>Worktree from <span className="text-muted-foreground/80">{thread.branch}</span></>
            ) : cwd || "\u00A0"}
          </p>
        </div>

        {/* Branch/worktree picker */}
        {branchToolbar.isReady && branchToolbar.activeProjectCwd && (
          <div className="flex w-full flex-col items-center gap-3 animate-fade-in-up-delay">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setEnvMode(effectiveEnvMode === "local" ? "worktree" : "local")}
                disabled={!!thread.worktreePath}
                className="rounded-md border border-border/40 px-2 py-0.5 text-xs font-medium text-muted-foreground/70 transition-colors hover:bg-muted/50 hover:text-foreground/80 disabled:opacity-50 dark:border-border/20"
              >
                {effectiveEnvMode === "worktree" ? "Worktree" : "Local"}
              </button>
              <BranchToolbarBranchSelector
                activeProjectCwd={branchToolbar.activeProjectCwd}
                activeThreadBranch={branchToolbar.activeThreadBranch}
                activeWorktreePath={branchToolbar.activeWorktreePath}
                branchCwd={branchToolbar.branchCwd}
                effectiveEnvMode={effectiveEnvMode}
                envLocked={!!thread.worktreePath}
                onSetThreadBranch={branchToolbar.setThreadBranch}
                onCheckoutPullRequestRequest={(ref) => {
                  setPrInitialReference(ref);
                  setPrDialogOpen(true);
                }}
              />
            </div>
            {/* Animated expand/collapse via CSS grid trick */}
            <div
              className="grid w-full transition-[grid-template-rows,opacity] duration-200 ease-out"
              style={{ gridTemplateRows: showBranchInput ? "1fr" : "0fr", opacity: showBranchInput ? 1 : 0 }}
            >
              <div className="overflow-hidden">
                <label className="flex flex-col gap-1 pb-0.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-muted-foreground/60">Branch name</span>
                    <button
                      type="button"
                      onClick={() => setEditingPrefix(!editingPrefix)}
                      className="text-[10px] text-muted-foreground/50 transition-colors hover:text-primary/70"
                    >
                      {editingPrefix ? "done" : "prefix"}
                    </button>
                  </div>
                  <div
                    className="grid transition-[grid-template-rows] duration-200 ease-out"
                    style={{ gridTemplateRows: editingPrefix ? "1fr" : "0fr" }}
                  >
                    <div className="overflow-hidden">
                      <input
                        type="text"
                        value={branchPrefix}
                        onChange={(e) => {
                          const next = e.target.value;
                          setBranchPrefix(next);
                          setWorktreeBranchPrefix(projectCwd, next);
                          if (worktreeBranchName === branchPrefix || worktreeBranchName.length === 0) {
                            setWorktreeBranchName(next);
                          }
                        }}
                        placeholder="feature/ITE-"
                        spellCheck={false}
                        className="mb-1 w-full rounded-md border border-primary/30 bg-primary/5 px-2 py-1 font-mono text-[11px] text-foreground outline-none ring-1 ring-primary/10 transition-colors focus:border-primary/40 focus:ring-primary/20 dark:border-primary/20"
                      />
                    </div>
                  </div>
                  <input
                    type="text"
                    value={worktreeBranchName}
                    onChange={(e) => setWorktreeBranchName(e.target.value)}
                    placeholder={branchPrefix || "branch-name"}
                    spellCheck={false}
                    className="w-full rounded-md border border-border/40 bg-background/80 px-2 py-1 font-mono text-xs text-foreground outline-none ring-1 ring-transparent transition-colors focus:border-primary/40 focus:ring-primary/20 dark:border-border/20"
                  />
                </label>
              </div>
            </div>
          </div>
        )}

        {/* Launch button */}
        <button
          type="button"
          disabled={starting || (!cwd && !isWorktreePending) || !isWorktreeBranchValid}
          aria-busy={starting}
          onClick={handleStart}
          className="group relative inline-flex items-center gap-2 overflow-hidden rounded-lg border border-primary/80 bg-primary px-5 py-2 text-xs font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 hover:shadow-md disabled:opacity-50 dark:border-primary/60 animate-fade-in-up-delay-2"
        >
          {starting ? (
            <>
              <span className="size-3 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground" />
              {isWorktreePending ? "Creating worktree..." : "Starting..."}
            </>
          ) : (
            <>
              <TerminalIcon className="size-3.5 opacity-80" aria-hidden="true" />
              Start Claude
            </>
          )}
        </button>

        {error && (
          <p role="alert" className="text-center text-xs text-destructive animate-fade-in-up">
            {error}
          </p>
        )}
      </div>

      <PullRequestThreadDialog
        open={prDialogOpen}
        cwd={branchToolbar.activeProjectCwd}
        initialReference={prInitialReference}
        onOpenChange={setPrDialogOpen}
        onPrepared={(input) => {
          branchToolbar.setThreadBranch(input.branch, input.worktreePath);
          if (input.worktreePath) setEnvMode("worktree");
        }}
      />
    </div>
  );
}

// ── DormantTerminalView ───────────────────────────────────────────────

/** Cooldown guard for auto-resume to prevent infinite loops.
 *  When `--resume` fails (e.g. stale session ID), the CLI exits immediately →
 *  status goes "dormant" → briefly "active" (started event) → "dormant" again →
 *  component remounts. Without a cooldown, auto-resume would fire endlessly.
 *  A simple Set doesn't work because ActiveTerminalView mounts during the brief
 *  "active" window and would clear it. A timestamp-based cooldown is immune to that. */
const autoResumeLastAttempt = new Map<string, number>();
const AUTO_RESUME_COOLDOWN_MS = 10_000;

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

  // Auto-resume dormant sessions when the thread is opened.
  // Guard against infinite loops: if a resume fails (e.g. stale session ID),
  // the CLI exits immediately → status goes back to "dormant" → this component
  // remounts → without the guard, auto-resume would fire again endlessly.
  useEffect(() => {
    const lastAttempt = autoResumeLastAttempt.get(threadId) ?? 0;
    if (!resuming && cwd && Date.now() - lastAttempt > AUTO_RESUME_COOLDOWN_MS) {
      autoResumeLastAttempt.set(threadId, Date.now());
      handleResume();
    }
  }, [threadId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full flex-col">
      {/* Scrollback area — dimmed to signal read-only */}
      <div ref={containerRef} className="min-h-0 flex-1 opacity-50 saturate-50 transition-opacity hover:opacity-70 hover:saturate-75" />

      {/* Resume bar — compact, glass-like */}
      <div className="flex items-center justify-center gap-3 border-t border-border/40 bg-card/60 px-4 py-2 backdrop-blur-sm dark:border-border/20 dark:bg-card/40">
        <button
          type="button"
          disabled={resuming || !cwd}
          aria-busy={resuming}
          onClick={handleResume}
          className="inline-flex items-center gap-1.5 rounded-md border border-primary/60 bg-primary/10 px-3 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50 dark:border-primary/40 dark:bg-primary/8 dark:text-primary/90"
        >
          {resuming ? (
            <>
              <span className="size-2.5 animate-spin rounded-full border border-primary/30 border-t-primary" />
              Resuming...
            </>
          ) : (
            <>
              <PlayIcon className="size-3" aria-hidden="true" />
              Resume
            </>
          )}
        </button>
        {error && (
          <p role="alert" className="text-xs text-destructive">
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
  const [searchOpen, setSearchOpen] = useState(false);
  const searchAddonRef = useRef<claudeCache.CachedTerminal["searchAddon"] | null>(null);

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
    searchAddonRef.current = entry.searchAddon;
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
        case "hookStatus":
        case "hookNotification":
          // Handled by orchestration layer / EventRouter, not terminal view
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

    // Intercept macOS navigation shortcuts before the browser captures them
    terminal.attachCustomKeyEventHandler((event) => {
      // Cmd+F (Mac) / Ctrl+F (other) — open terminal search
      if (
        event.type === "keydown" &&
        event.key.toLowerCase() === "f" &&
        !event.altKey &&
        !event.shiftKey &&
        (isMacPlatform(navigator.platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
      ) {
        event.preventDefault();
        event.stopPropagation();
        setSearchOpen(true);
        return false;
      }

      const navigationData = terminalNavigationShortcutData(event);
      if (navigationData !== null) {
        event.preventDefault();
        event.stopPropagation();
        void api.claude.write({ threadId, data: navigationData }).catch(() => undefined);
        return false;
      }

      if (isTerminalClearShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        void api.claude.write({ threadId, data: "\u000c" }).catch(() => undefined);
        return false;
      }

      return true;
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
    // Throttled via rAF to avoid excessive reflows during sidebar drag
    let resizeRafId: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeRafId !== null) return;
      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = null;
        fitAddon.fit();
      });
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
      searchAddonRef.current = null;
      if (resizeRafId !== null) cancelAnimationFrame(resizeRafId);
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

  const handleSearchClose = useCallback(() => {
    setSearchOpen(false);
    // Re-focus the terminal after closing the search bar
    const cached = claudeCache.get(threadId);
    if (cached) cached.terminal.focus();
  }, [threadId]);

  return (
    <div className="relative h-full w-full">
      {searchOpen && searchAddonRef.current && (
        <TerminalSearchBar
          searchAddon={searchAddonRef.current}
          onClose={handleSearchClose}
        />
      )}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
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
