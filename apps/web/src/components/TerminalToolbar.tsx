import type { ThreadId } from "@clui/contracts";
import {
  GitBranchIcon,
  PlayIcon,
  RotateCcwIcon,
  SquareIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import * as claudeCache from "../lib/claudeTerminalCache";
import { formatBranchForDisplay } from "../lib/threadStatus";
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import type { Thread } from "../types";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

// ── Status Badge ──────────────────────────────────────────────────────

function TerminalStatusBadge({ status }: { status: Thread["terminalStatus"] }) {
  switch (status) {
    case "active":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-1.5 py-px text-[10px] font-medium tracking-wide uppercase text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-400/90">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" />
            <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
          </span>
          Live
        </span>
      );
    case "dormant":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-md bg-zinc-500/8 px-1.5 py-px text-[10px] font-medium tracking-wide uppercase text-zinc-500 dark:bg-zinc-400/8 dark:text-zinc-500">
          <span className="size-1.5 rounded-full bg-zinc-400 dark:bg-zinc-600" />
          Paused
        </span>
      );
    default:
      return null;
  }
}

// ── Editable Title ────────────────────────────────────────────────────

function EditableTitle({
  threadId,
  title,
}: {
  threadId: ThreadId;
  title: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = useCallback(() => {
    const trimmed = draft.trim();
    setEditing(false);
    if (!trimmed || trimmed === title) return;
    const api = readNativeApi();
    if (!api) return;
    void api.orchestration.dispatchCommand({
      type: "thread.meta.update",
      commandId: newCommandId(),
      threadId,
      title: trimmed,
    });
  }, [draft, title, threadId]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="h-5 min-w-0 flex-1 rounded-sm border border-primary/40 bg-background/80 px-1 text-xs font-medium text-foreground outline-none ring-1 ring-primary/20"
        spellCheck={false}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="min-w-0 truncate rounded-sm px-1 text-xs font-medium text-foreground/90 transition-colors hover:bg-muted/50 hover:text-foreground"
      title="Click to rename"
    >
      {title}
    </button>
  );
}

// ── Toolbar ───────────────────────────────────────────────────────────

export default function TerminalToolbar({
  threadId,
}: {
  threadId: ThreadId;
}) {
  const thread = useStore((s) => s.threads.find((t) => t.id === threadId));
  const project = useStore((s) =>
    s.projects.find((p) => p.id === thread?.projectId),
  );

  const handleStop = useCallback(async () => {
    const api = readNativeApi();
    if (!api) return;
    try {
      await api.claude.hibernate({ threadId });
    } catch {
      // Stop failure — terminal may have already exited
    }
  }, [threadId]);

  const handleResume = useCallback(async () => {
    const api = readNativeApi();
    if (!api || !thread) return;
    const cwd = thread.worktreePath ?? project?.cwd ?? "";
    if (!cwd) return;
    claudeCache.dispose(threadId);
    try {
      await api.claude.start({
        threadId,
        cwd,
        cols: 120,
        rows: 40,
        resumeSessionId: thread.claudeSessionId ?? undefined,
      });
    } catch {
      // Start failure handled by ThreadTerminalView
    }
  }, [threadId, thread, project]);

  if (!thread) return null;

  const branch = thread.branch;
  const isActive = thread.terminalStatus === "active";
  const isDormant = thread.terminalStatus === "dormant";

  return (
    <TooltipProvider>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/40 bg-card/60 px-2 backdrop-blur-sm dark:border-border/25 dark:bg-card/40">
        {/* Title */}
        <div className="min-w-0 flex-1">
          <EditableTitle threadId={threadId} title={thread.title} />
        </div>

        {/* Branch */}
        {branch && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/40 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/80 dark:border-border/20 dark:bg-muted/20">
            <GitBranchIcon className="size-2.5 opacity-60" aria-hidden="true" />
            <span className="max-w-32 truncate">
              {formatBranchForDisplay(branch)}
            </span>
          </span>
        )}

        {/* Status badge */}
        <TerminalStatusBadge status={thread.terminalStatus} />

        {/* Separator before actions */}
        {(isActive || isDormant) && (
          <div className="h-3.5 w-px bg-border/50 dark:bg-border/30" />
        )}

        {/* Actions */}
        <div className="flex items-center gap-0.5">
          {isActive && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={handleStop}
                    className="size-6 rounded-md p-0 text-muted-foreground/70 hover:text-destructive"
                  />
                }
              >
                <SquareIcon className="size-3" aria-hidden="true" />
                <span className="sr-only">Stop</span>
              </TooltipTrigger>
              <TooltipPopup side="bottom">Stop session</TooltipPopup>
            </Tooltip>
          )}
          {isDormant && (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={handleResume}
                      className="size-6 rounded-md p-0 text-muted-foreground/70 hover:text-emerald-600 dark:hover:text-emerald-400"
                    />
                  }
                >
                  <PlayIcon className="size-3" aria-hidden="true" />
                  <span className="sr-only">Resume</span>
                </TooltipTrigger>
                <TooltipPopup side="bottom">Resume</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        const api = readNativeApi();
                        if (!api || !thread) return;
                        const cwd = thread.worktreePath ?? project?.cwd ?? "";
                        if (!cwd) return;
                        claudeCache.dispose(threadId);
                        void api.claude.start({ threadId, cwd, cols: 120, rows: 40 });
                      }}
                      className="size-6 rounded-md p-0 text-muted-foreground/70 hover:text-foreground"
                    />
                  }
                >
                  <RotateCcwIcon className="size-3" aria-hidden="true" />
                  <span className="sr-only">Restart fresh</span>
                </TooltipTrigger>
                <TooltipPopup side="bottom">New session</TooltipPopup>
              </Tooltip>
            </>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
