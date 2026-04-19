import { type NativeApi, type ThreadId } from "@clui/contracts";
import type { ClaudeSessionEvent, PiSessionEvent } from "@clui/contracts";
import { PlayIcon, TerminalIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { isTerminalClearShortcut, terminalNavigationShortcutData } from "../keybindings";
import { stripTerminalResponses } from "../lib/terminalInputFilter";
import * as claudeCache from "../lib/claudeTerminalCache";
import { isMacPlatform, newCommandId } from "../lib/utils";
import { setupProjectScript } from "../projectScripts";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import type { Thread } from "../types";
import type { EnvMode } from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { runProjectScriptInTerminal } from "./TerminalToolbar";
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

type HarnessSessionEvent = ClaudeSessionEvent | PiSessionEvent;

function startHarnessSession(
  api: NativeApi,
  thread: Thread,
  input: { cwd: string; cols: number; rows: number; fresh?: boolean; yoloMode?: boolean },
): Promise<void> {
  if (thread.harness === "pi") {
    return api.pi.start({
      threadId: thread.id,
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      ...(input.fresh ? { fresh: true } : {}),
    });
  }

  return api.claude.start({
    threadId: thread.id,
    cwd: input.cwd,
    cols: input.cols,
    rows: input.rows,
    resumeSessionId: thread.claudeSessionId ?? undefined,
    ...(input.yoloMode ? { dangerouslySkipPermissions: true } : {}),
  });
}

function getHarnessScrollback(
  api: NativeApi,
  thread: Thread,
  input: { threadId: ThreadId; sinceOffset?: number },
): Promise<{ threadId: string; scrollback: string | null; offset: number; reset?: boolean }> {
  return thread.harness === "pi"
    ? api.pi.getScrollback(input)
    : api.claude.getScrollback(input);
}

function subscribeHarnessSessionEvents(
  api: NativeApi,
  thread: Thread,
  callback: (event: HarnessSessionEvent) => void,
): () => void {
  return thread.harness === "pi" ? api.pi.onSessionEvent(callback) : api.claude.onSessionEvent(callback);
}

function writeHarnessData(api: NativeApi, thread: Thread, data: string): Promise<void> {
  return thread.harness === "pi"
    ? api.pi.write({ threadId: thread.id, data })
    : api.claude.write({ threadId: thread.id, data });
}

function resizeHarnessSession(api: NativeApi, thread: Thread, cols: number, rows: number): Promise<void> {
  return thread.harness === "pi"
    ? api.pi.resize({ threadId: thread.id, cols, rows })
    : api.claude.resize({ threadId: thread.id, cols, rows });
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
  const dangerouslySkipPermissions = useTerminalStateStore((s) =>
    selectThreadTerminalState(s.terminalStateByThreadId, threadId).yoloMode,
  );
  const setDangerouslySkipPermissions = useTerminalStateStore((s) => s.setYoloMode);
  const setYolo = useCallback((v: boolean) => setDangerouslySkipPermissions(threadId, v), [threadId, setDangerouslySkipPermissions]);
  const [envMode, setEnvMode] = useState<EnvMode>("local");
  const [prDialogOpen, setPrDialogOpen] = useState(false);
  const [prInitialReference, setPrInitialReference] = useState<string | null>(null);
  const project = useStore((s) => s.projects.find((p) => p.id === thread.projectId));
  const branchToolbar = useBranchToolbar(threadId);
  const setThreadHarness = useStore((s) => s.setThreadHarness);
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

        // Run the setup script (runOnWorktreeCreate) if one is configured
        const setupScript = setupProjectScript(project.scripts ?? []);
        if (setupScript) {
          runProjectScriptInTerminal(setupScript, threadId, project, result.worktree.path);
        }
      }
      if (!startCwd) return;
      // cols/rows are initial defaults — ActiveTerminalView sends a corrective
      // resize with actual container dimensions immediately after mounting.
      await startHarnessSession(api, thread, {
        cwd: startCwd,
        cols: 120,
        rows: 40,
        yoloMode: dangerouslySkipPermissions,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start session");
      setStarting(false);
    }
  }, [
    thread,
    threadId,
    cwd,
    isWorktreePending,
    project,
    branchToolbar,
    trimmedWorktreeBranch,
    dangerouslySkipPermissions,
  ]);

  const showBranchInput = isWorktreePending && !!thread.branch;
  const containerRef = useRef<HTMLDivElement>(null);

  const handleHarnessChange = useCallback(
    (harness: Thread["harness"]) => {
      if (thread.terminalStatus !== "new") return;
      const api = readNativeApi();
      setThreadHarness(threadId, harness);
      if (!api) return;
      void api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId,
        harness,
      });
    },
    [setThreadHarness, thread.terminalStatus, threadId],
  );

  // Auto-focus container so Enter works immediately
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  // Enter key triggers start (unless an input is focused)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (
        e.key === "Enter" &&
        !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement) &&
        !starting && (cwd || isWorktreePending) && isWorktreeBranchValid
      ) {
        e.preventDefault();
        handleStart();
      }
    },
    [handleStart, starting, cwd, isWorktreePending, isWorktreeBranchValid],
  );

  return (
    <div ref={containerRef} tabIndex={-1} onKeyDown={handleKeyDown} className="flex h-full flex-col items-center justify-center p-8 outline-none">
      <div className="flex w-72 flex-col items-center gap-5 animate-fade-in">
        {/* App logo with subtle glow */}
        <div className="relative animate-zoom-fade-in">
          <div className="absolute inset-0 rounded-full bg-primary/10 blur-xl" />
          <img src="/favicon.svg" alt="" aria-hidden="true" className="relative size-12" />
        </div>

        {/* Copy — fixed height to prevent shift */}
        <div className="flex h-10 flex-col items-center justify-center gap-1.5 text-center">
          <h2 className="text-sm font-medium text-foreground/90">
            {thread.harness === "pi" ? "New pi Session" : "New Claude Code Session"}
          </h2>
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
                branchPrefix={branchPrefix}
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

        <div className="flex w-full flex-col gap-2 animate-fade-in-up-delay">
          <span className="text-center text-[11px] uppercase tracking-wide text-muted-foreground/60">
            Coding harness
          </span>
          <div className="grid grid-cols-2 gap-2">
            {[
              { value: "claudeCode" as const, label: "Claude Code" },
              { value: "pi" as const, label: "pi" },
            ].map((option) => {
              const selected = thread.harness === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleHarnessChange(option.value)}
                  className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                    selected
                      ? "border-primary/60 bg-primary/8 text-foreground"
                      : "border-border/40 bg-background/80 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Auto-accept toggle */}
        {thread.harness === "claudeCode" ? (
          <label className={`flex items-center gap-2 text-xs animate-fade-in-up-delay ${dangerouslySkipPermissions ? "text-red-500" : "text-muted-foreground/70"}`}>
            <input
              type="checkbox"
              checked={dangerouslySkipPermissions}
              onChange={(e) => setYolo(e.target.checked)}
              className="size-3.5 rounded border-border/40 accent-red-500"
            />
            <span>YOLO mode</span>
          </label>
        ) : null}

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
              {thread.harness === "pi" ? "Start pi" : "Start Claude Code"}
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

/** Prune stale entries from autoResumeLastAttempt to prevent unbounded growth.
 *  Note: Map deletion during for...of iteration is safe per ES2015 spec. */
function pruneAutoResumeMap() {
  const now = Date.now();
  for (const [id, ts] of autoResumeLastAttempt) {
    if (now - ts > AUTO_RESUME_COOLDOWN_MS * 2) {
      autoResumeLastAttempt.delete(id);
    }
  }
}

function DormantTerminalView({
  threadId,
  thread,
}: {
  threadId: ThreadId;
  thread: Thread;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const resumeButtonRef = useRef<HTMLButtonElement>(null);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = useStore((s) => s.projects.find((p) => p.id === thread.projectId));
  const cwd = thread.worktreePath ?? project?.cwd ?? "";
  const yoloMode = useTerminalStateStore((s) =>
    selectThreadTerminalState(s.terminalStateByThreadId, threadId).yoloMode,
  );

  // Render scrollback in a read-only xterm.js instance (or reuse cached)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // If there's a cached terminal from a previous active session, reuse it
    const cached = claudeCache.get(threadId);
    if (cached) {
      claudeCache.attach(threadId, el);
      cached.terminal.options.disableStdin = true;
      // Fit after layout so the read-only scrollback renders at correct dimensions
      const rafId = requestAnimationFrame(() => cached.fitAddon.fit());
      return () => {
        cancelAnimationFrame(rafId);
        claudeCache.detach(threadId);
      };
    }

    // Otherwise, fetch scrollback and render in a new terminal
    const entry = claudeCache.attach(threadId, el);
    entry.terminal.options.disableStdin = true;
    const api = readNativeApi();
    if (!api) return;

    let disposed = false;
    // Gate scrollback write on fit — same race as ActiveTerminalView:
    // scrollback (microtask) can resolve before rAF fit, writing content
    // at stale dimensions.
    let fitDone = false;
    let pendingData: { scrollback: string | null; offset: number | null } | null = null;

    const writePendingIfReady = () => {
      if (!fitDone || !pendingData || disposed) return;
      const { scrollback, offset } = pendingData;
      pendingData = null;
      if (scrollback) entry.terminal.write(scrollback);
      if (offset != null) entry.lastServerOffset = offset;
    };

    const rafId = requestAnimationFrame(() => {
      if (disposed) return;
      entry.fitAddon.fit();
      fitDone = true;
      writePendingIfReady();
    });

    void getHarnessScrollback(api, thread, { threadId }).then((result) => {
      if (disposed) return;
      pendingData = { scrollback: result.scrollback, offset: result.offset ?? null };
      writePendingIfReady();
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      claudeCache.detach(threadId);
      // Dispose dormant terminals on unmount — they're cheap to recreate
      // and we don't want stale scrollback accumulating in memory.
      claudeCache.dispose(threadId);
    };
  }, [thread, threadId]);

  // Focus the Resume button on mount so keyboard users have an obvious target.
  useEffect(() => {
    resumeButtonRef.current?.focus();
  }, []);

  const handleResume = useCallback(async () => {
    const api = readNativeApi();
    if (!api || !cwd) return;
    setResuming(true);
    setError(null);
    try {
      // Read terminal dimensions from the cached instance. Do NOT dispose the
      // cached terminal here — ActiveTerminalView will reuse it, preserving
      // full client-side scrollback. Disposing destroys all scrollback history,
      // forcing a server fetch that returns only a truncated snapshot.
      const cached = claudeCache.get(threadId);
      const cols = cached?.terminal.cols ?? 120;
      const rows = cached?.terminal.rows ?? 40;
      await startHarnessSession(api, thread, {
        cwd,
        cols,
        rows,
        yoloMode,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resume session");
      setResuming(false);
    }
  }, [thread, threadId, cwd, yoloMode]);

  // Auto-resume on mount for normal dormant threads. Archived threads must
  // stay paused when opened so the user sees the dormant snapshot + Resume
  // action instead of immediately restarting the harness.
  useEffect(() => {
    if (thread.archivedAt !== null) return;
    const lastAttempt = autoResumeLastAttempt.get(threadId) ?? 0;
    if (!resuming && cwd && Date.now() - lastAttempt > AUTO_RESUME_COOLDOWN_MS) {
      pruneAutoResumeMap();
      autoResumeLastAttempt.set(threadId, Date.now());
      handleResume();
    }
  }, [threadId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full flex-col">
      {/* Scrollback area — dimmed to signal read-only */}
      <div ref={containerRef} className="min-h-0 flex-1 opacity-70 saturate-75 transition-opacity hover:opacity-85 hover:saturate-100" />

      {/* Resume bar — compact, glass-like */}
      <div className="flex items-center justify-center gap-3 border-t border-border/40 bg-card/60 px-4 py-2 backdrop-blur-sm dark:border-border/20 dark:bg-card/40">
        <button
          ref={resumeButtonRef}
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

function ActiveTerminalView({ threadId, thread }: { threadId: ThreadId; thread: Thread }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [showNewOutput, setShowNewOutput] = useState(false);
  const searchAddonRef = useRef<claudeCache.CachedTerminal["searchAddon"] | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const api = readNativeApi();
    if (!api) return;

    let disposed = false;

    // ── Gate: buffer ALL writes until both fit() and scrollback are ready ──
    // fitAddon.fit() runs in rAF (needs layout) and getScrollback() is async.
    // Writing before fit produces content at stale dimensions — TUI escape
    // sequences with hardcoded cursor positions can't be reflowed by xterm.js,
    // causing permanent overlapping/garbled lines when switching threads.
    const eventBuffer: HarnessSessionEvent[] = [];
    let terminalReady = false;
    let fitComplete = false;
    let pendingScrollback: { scrollback: string | null; offset: number | null; reset: boolean } | null = null;

    const entry = claudeCache.attach(threadId, el);
    const { terminal, fitAddon } = entry;
    searchAddonRef.current = entry.searchAddon;
    terminal.options.disableStdin = false;

    // ── Scroll preservation ──────────────────────────────────────────────
    // xterm.js v6 natively preserves scroll position via the internal
    // `BufferService.isUserScrolling` flag, but Viewport._sync() can lose
    // the position: setScrollDimensions clamps scrollTop internally while
    // _suppressOnScrollHandler prevents _latestYDisp from updating, so
    // subsequent syncs never correct it. We add a targeted write callback
    // that detects and corrects large jumps (> 1 screenful) — this catches
    // "jump to top/bottom" bugs without causing the old "jump back N lines"
    // glitch (user scrolling between save and callback is always < 1
    // screenful in the few ms of write processing).
    //
    // Key invariant: scrollOnUserInput: false (set in claudeTerminalCache)
    // prevents xterm from auto-scrolling on keypress, which is correct
    // because the PTY echoes input back as output.
    setShowNewOutput(false);
    let hasNewOutputFlag = false;

    const isViewportAtBottom = (): boolean => {
      return terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    };
    const isAltBuffer = () => terminal.buffer.active.type === "alternate";

    const scrollGuardedWrite = (data: string) => {
      if (isAltBuffer()) {
        terminal.write(data);
        return;
      }
      if (isViewportAtBottom()) {
        terminal.write(data);
        if (hasNewOutputFlag) {
          hasNewOutputFlag = false;
          setShowNewOutput(false);
        }
        return;
      }
      // User is scrolled up — write normally but verify position afterward.
      // xterm.js's isUserScrolling handles most cases; the callback is a
      // safety net for Viewport._sync edge cases (dimension clamping).
      const savedLine = terminal.buffer.active.viewportY;
      terminal.write(data, () => {
        if (disposed || isAltBuffer()) return;
        const drift = Math.abs(terminal.buffer.active.viewportY - savedLine);
        if (drift > terminal.rows) {
          terminal.scrollToLine(savedLine);
        }
      });
      if (!hasNewOutputFlag) {
        hasNewOutputFlag = true;
        setShowNewOutput(true);
      }
    };

    const writeEvent = (event: HarnessSessionEvent) => {
      if (event.threadId !== threadId) return;
      switch (event.type) {
        case "output":
          scrollGuardedWrite(event.data);
          // Track the server offset so that on detach→reattach the scrollback
          // delta fetch only returns truly new content. Without this,
          // lastServerOffset stays at the initial-fetch value and every
          // reattach re-writes all output that arrived via live events.
          if (event.offset > entry.lastServerOffset) {
            entry.lastServerOffset = event.offset;
          }
          break;
        case "error":
          scrollGuardedWrite(`\r\n[error] ${event.message}\r\n`);
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

    /** Flush scrollback + buffered events once both fit and scrollback are ready. */
    const flushIfReady = () => {
      if (!fitComplete || !pendingScrollback || disposed) return;
      const { scrollback, offset, reset } = pendingScrollback;
      pendingScrollback = null;

      // The server sets `reset: true` when it couldn't provide a delta
      // (scrollback buffer was cleared after session restart, or old data was
      // trimmed by the ring buffer). In that case the returned content is a
      // full materialization — clear the terminal first to avoid stale content
      // (e.g. duplicate Claude Code banners).
      const needsReset = sinceOffset == null || reset;

      if (scrollback) {
        if (needsReset) {
          terminal.write("\u001bc");
        }
        terminal.write(scrollback);
      } else if (reset) {
        // Buffer was reset but no content yet — just clear stale content
        terminal.write("\u001bc");
      }
      if (offset != null) {
        entry.lastServerOffset = offset;
      }
      // Now safe to process live events — dimensions are correct.
      // Skip any buffered output events whose data was already included in the
      // scrollback delta (their offset <= the offset we just synced to).
      terminalReady = true;
      const syncedOffset = entry.lastServerOffset;
      for (const event of eventBuffer) {
        if (event.type === "output" && event.offset <= syncedOffset) continue;
        writeEvent(event);
      }
      eventBuffer.length = 0;
    };

    const unsubscribe = subscribeHarnessSessionEvents(api, thread, (event) => {
      if (event.threadId !== threadId) return;
      if (!terminalReady) {
        eventBuffer.push(event);
        return;
      }
      writeEvent(event);
    });

    // Fetch scrollback from the server to catch output that arrived while the
    // terminal was detached (user switched to another thread). If the cached
    // terminal already has scrollback (lastServerOffset > 0), request only the
    // delta to avoid resetting the terminal and losing old scrollback history.
    const sinceOffset = entry.lastServerOffset > 0 ? entry.lastServerOffset : undefined;
    const scrollbackRequest =
      sinceOffset != null ? { threadId, sinceOffset } : { threadId };
    void getHarnessScrollback(api, thread, scrollbackRequest)
      .then((result) => {
        if (disposed) return;
        pendingScrollback = { scrollback: result.scrollback, offset: result.offset ?? null, reset: result.reset ?? false };
        flushIfReady();
      })
      .catch(() => {
        if (disposed) return;
        // Even if scrollback fetch fails, allow live events after fit
        pendingScrollback = { scrollback: "", offset: null, reset: false };
        flushIfReady();
      });

    // Safety: for reattach (terminal already has content), don't block the
    // terminal for more than 200ms if the scrollback fetch is slow.  The cached
    // terminal already displays previous output, so live events can flow while
    // the delta fills in later (or is skipped entirely).
    let scrollbackTimeoutId: ReturnType<typeof setTimeout> | undefined;
    if (sinceOffset != null) {
      scrollbackTimeoutId = setTimeout(() => {
        if (disposed || terminalReady) return;
        pendingScrollback = pendingScrollback ?? { scrollback: null, offset: null, reset: false };
        flushIfReady();
      }, 200);
    }

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
        void writeHarnessData(api, thread, navigationData).catch(() => undefined);
        return false;
      }

      if (isTerminalClearShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        void writeHarnessData(api, thread, "\u000c").catch(() => undefined);
        return false;
      }

      // Shift+Enter / Option+Enter — send CSI 13;2u so Claude Code CLI
      // inserts a newline instead of submitting. xterm.js onData sends \r
      // for all Enter variants, losing the modifier, so we intercept here.
      if (event.type === "keydown" && event.key === "Enter" && (event.shiftKey || event.altKey) && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        void writeHarnessData(api, thread, "\x1b[13;2u").catch(() => undefined);
        return false;
      }

      // Ctrl+Z — prevent browser "undo" so SIGTSTP (suspend) reaches the PTY.
      // On Mac Cmd+Z is the undo shortcut so Ctrl+Z is free; on other platforms
      // we still want it to go to the terminal when focused.
      if (event.type === "keydown" && event.key === "z" && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        void writeHarnessData(api, thread, "\x1a").catch(() => undefined);
        return false;
      }

      // Ctrl+F on Mac — let it pass through to the PTY (Claude Code uses it
      // to kill background agents). Cmd+F already opens terminal search above.
      if (
        event.type === "keydown" &&
        event.key.toLowerCase() === "f" &&
        isMacPlatform(navigator.platform) &&
        event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        void writeHarnessData(api, thread, "\x06").catch(() => undefined);
        return false;
      }

      return true;
    });

    // Forward keystrokes to the server, filtering out terminal query
    // responses (OSC 11 background color, CPR cursor position) that
    // xterm.js generates internally — these would echo as garbage text.
    const inputDisposable = terminal.onData((data) => {
      const filtered = stripTerminalResponses(data);
      if (filtered) {
        void writeHarnessData(api, thread, filtered).catch(() => undefined);
      }
    });

    // Handle resize
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      void resizeHarnessSession(api, thread, cols, rows).catch(() => undefined);
    });

    // Defer fit + resize to after the browser has laid out the container.
    // Calling fitAddon.fit() synchronously during mount often reads stale
    // container dimensions (especially when reparenting a cached terminal),
    // which sends wrong cols/rows to the PTY and causes Claude Code's TUI
    // to render overlapping lines.
    const initialFitRafId = requestAnimationFrame(() => {
      if (disposed) return;
      fitAddon.fit();
      // Always send resize after reattach — even if cols/rows look unchanged,
      // the PTY may have been started with default dimensions or the previous
      // attach may have sent wrong values.
      void resizeHarnessSession(api, thread, terminal.cols, terminal.rows).catch(() => undefined);
      terminal.focus();
      // Signal that dimensions are now correct — safe to write content
      fitComplete = true;
      flushIfReady();
    });

    // Watch for window resize — just re-fit, xterm.js preserves scroll
    // position natively via isUserScrolling during dimension changes.
    const onWindowResize = () => {
      fitAddon.fit();
    };
    window.addEventListener("resize", onWindowResize);

    // ── Alternate-buffer scroll: convert wheel → arrow keys ──────────
    // Claude Code runs in alternate screen buffer (TUI mode). xterm.js has
    // no scrollback in alt-buffer and its internal wheel→arrow fallback
    // (CoreBrowserTerminal.ts:806-842) silently eats events when render
    // dimensions are unavailable — consumeWheelEvent returns 0 → event
    // canceled with no input sent. We intercept wheel in capture phase
    // and reliably forward arrow keys to the PTY so the user can scroll
    // within Claude Code's conversation view.
    //
    // We always intercept wheel in alternate buffer and send arrow keys,
    // even when mouse tracking is active — see note inside the handler.
    let wheelPartialScroll = 0;
    const onAltBufferWheel = (ev: WheelEvent) => {
      if (disposed) return;
      if (terminal.buffer.active.type !== "alternate") return;
      // Shift+scroll = horizontal intent — don't convert to vertical arrows
      if (ev.shiftKey) return;
      const deltaY = ev.deltaY;
      if (deltaY === 0) return;
      // NOTE: We intentionally do NOT bail out when xterm.js has mouse tracking
      // active (enable-mouse-events class). xterm.js's internal wheel→mouse
      // handler silently eats events when render dimensions are unavailable,
      // leaving scroll completely dead. Arrow keys are universally understood
      // by terminal TUIs for vertical navigation, so we always intercept.

      ev.preventDefault();
      ev.stopPropagation();

      // Accumulate partial scrolls for trackpad precision (mirrors xterm.js
      // consumeWheelEvent logic). Mouse wheel events have larger deltaY (~100)
      // while trackpad gestures send many small values (1-20).
      let amount = Math.abs(deltaY);
      if (ev.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        // Firefox on some systems: deltaY is already in line units
        amount *= 40;
      } else if (ev.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        amount *= terminal.rows * 40;
      }
      wheelPartialScroll += amount / 50;
      const lines = Math.floor(wheelPartialScroll);
      wheelPartialScroll -= lines;
      if (lines === 0) return;

      // Use SS3 prefix (ESC O) when application cursor keys is active,
      // otherwise CSI prefix (ESC [) — matches xterm.js's own fallback
      const prefix = terminal.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[";
      const key = deltaY < 0 ? "A" : "B"; // A = up, B = down
      const data = (prefix + key).repeat(Math.min(lines, 15));

      void writeHarnessData(api, thread, data).catch(() => undefined);
    };
    el.addEventListener("wheel", onAltBufferWheel, { capture: true, passive: false });

    // ── "New output" indicator management via wheel events ──
    // When user scrolls down to the bottom, clear the indicator.
    const onWheelClearIndicator = (e: WheelEvent) => {
      if (disposed) return;
      if (e.deltaY > 0 && hasNewOutputFlag && isViewportAtBottom()) {
        hasNewOutputFlag = false;
        setShowNewOutput(false);
      }
    };
    el.addEventListener("wheel", onWheelClearIndicator, { passive: true });

    // Watch for container resize (sidebar collapse/expand, split changes)
    // Throttled via rAF to avoid excessive reflows during sidebar drag.
    // Just re-fit — xterm.js preserves scroll position natively.
    let resizeRafId: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeRafId !== null) return;
      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = null;
        fitAddon.fit();
      });
    });
    resizeObserver.observe(el);

    // ── Clear "New output" when viewport reaches the bottom ──────────
    // This covers scrollbar drags, programmatic scrolls, and any path
    // that wasn't a wheel event (which has its own clearing above).
    const scrollDisposable = terminal.onScroll(() => {
      if (disposed) return;
      if (hasNewOutputFlag && isViewportAtBottom()) {
        hasNewOutputFlag = false;
        setShowNewOutput(false);
      }
    });

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
      cancelAnimationFrame(initialFitRafId);
      if (resizeRafId !== null) cancelAnimationFrame(resizeRafId);
      if (scrollbackTimeoutId != null) clearTimeout(scrollbackTimeoutId);
      el.removeEventListener("wheel", onAltBufferWheel, { capture: true });
      el.removeEventListener("wheel", onWheelClearIndicator);
      window.removeEventListener("resize", onWindowResize);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      unsubscribe();
      inputDisposable.dispose();
      resizeDisposable.dispose();
      scrollDisposable.dispose();
      // Detach but keep in cache for instant reattachment
      claudeCache.detach(threadId);
    };
  }, [thread, threadId]);

  const handleSearchClose = useCallback(() => {
    setSearchOpen(false);
    // Re-focus the terminal after closing the search bar
    const cached = claudeCache.get(threadId);
    if (cached) cached.terminal.focus();
  }, [threadId]);

  const handleScrollToBottom = useCallback(() => {
    setShowNewOutput(false);
    const cached = claudeCache.get(threadId);
    if (cached) {
      cached.terminal.scrollToBottom();
      cached.terminal.focus();
    }
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
      {showNewOutput && (
        <button
          type="button"
          onClick={handleScrollToBottom}
          className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border/40 bg-card/90 px-3 py-1 text-xs font-medium text-foreground/80 shadow-lg backdrop-blur-sm transition-all hover:bg-card hover:text-foreground dark:border-border/20 dark:bg-card/80"
        >
          <span className="text-[10px]">↓</span>
          New output
        </button>
      )}
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
      return <ActiveTerminalView threadId={threadId} thread={thread} />;
    case "dormant":
      return <DormantTerminalView threadId={threadId} thread={thread} />;
    case "new":
    default:
      return <NewThreadView threadId={threadId} thread={thread} />;
  }
}
