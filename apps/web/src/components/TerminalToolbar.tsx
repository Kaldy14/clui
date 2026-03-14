import { EDITORS, type EditorId, type ThreadId } from "@clui/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  DiffIcon,
  FolderClosedIcon,
  GitBranchIcon,
  PlayIcon,
  RotateCcwIcon,
  SquareIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { stripDiffSearchParams } from "../diffRouteSearch";
import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "../keybindings";
import * as claudeCache from "../lib/claudeTerminalCache";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { claudeTerminalStatusPill } from "../lib/threadStatus";
import { isMacPlatform, isWindowsPlatform, newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { LAST_EDITOR_KEY } from "../terminal-links";
import type { Thread } from "../types";
import GitActionsControl from "./GitActionsControl";
import type { Icon } from "./Icons";
import { CursorIcon, VisualStudioCode, Zed } from "./Icons";
import { Button } from "./ui/button";
import { Group, GroupSeparator } from "./ui/group";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "./ui/menu";
import { Toggle } from "./ui/toggle";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

// ── Status Badge ──────────────────────────────────────────────────────

function TerminalStatusBadge({ thread }: { thread: Thread }) {
  const pill = claudeTerminalStatusPill(thread.terminalStatus, thread.hookStatus);
  if (!pill) return null;

  // Pick background tint based on color class
  const bgClass = pill.colorClass.includes("sky")
    ? "bg-sky-500/10 dark:bg-sky-400/10"
    : pill.colorClass.includes("amber")
      ? "bg-amber-500/10 dark:bg-amber-400/10"
      : pill.colorClass.includes("red")
        ? "bg-red-500/10 dark:bg-red-400/10"
        : pill.colorClass.includes("emerald")
          ? "bg-emerald-500/10 dark:bg-emerald-400/10"
          : "bg-zinc-500/8 dark:bg-zinc-400/8";

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-px text-[10px] font-medium tracking-wide uppercase ${pill.colorClass} ${bgClass}`}>
      <span className={pill.pulse ? "relative flex size-1.5" : undefined}>
        {pill.pulse && (
          <span className={`absolute inline-flex size-full animate-ping rounded-full ${pill.dotClass} opacity-50`} />
        )}
        <span className={`${pill.pulse ? "relative inline-flex" : ""} size-1.5 rounded-full ${pill.dotClass}`} />
      </span>
      {pill.label}
    </span>
  );
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
      titleSource: "manual",
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

// ── Open In Editor ───────────────────────────────────────────────────

const ALL_EDITOR_OPTIONS: ReadonlyArray<{ label: string; Icon: Icon; value: EditorId }> = [
  { label: "Cursor", Icon: CursorIcon, value: "cursor" },
  { label: "VS Code", Icon: VisualStudioCode, value: "vscode" },
  { label: "Zed", Icon: Zed, value: "zed" },
  {
    label: isMacPlatform(navigator.platform)
      ? "Finder"
      : isWindowsPlatform(navigator.platform)
        ? "Explorer"
        : "Files",
    Icon: FolderClosedIcon,
    value: "file-manager",
  },
];

const OpenInEditorPicker = memo(function OpenInEditorPicker({
  openInCwd,
}: {
  openInCwd: string | null;
}) {
  const { data: serverConfig } = useQuery(serverConfigQueryOptions());
  const availableEditors = serverConfig?.availableEditors ?? [];
  const keybindings = serverConfig?.keybindings ?? [];

  const [lastEditor, setLastEditor] = useState<EditorId>(() => {
    const stored = localStorage.getItem(LAST_EDITOR_KEY);
    return EDITORS.some((e) => e.id === stored) ? (stored as EditorId) : EDITORS[0].id;
  });

  const options = useMemo(
    () => ALL_EDITOR_OPTIONS.filter((option) => availableEditors.includes(option.value)),
    [availableEditors],
  );

  const effectiveEditor = options.some((option) => option.value === lastEditor)
    ? lastEditor
    : (options[0]?.value ?? null);
  const primaryOption = options.find(({ value }) => value === effectiveEditor) ?? null;

  const openInEditor = useCallback(
    (editorId: EditorId | null) => {
      const api = readNativeApi();
      if (!api || !openInCwd) return;
      const editor = editorId ?? effectiveEditor;
      if (!editor) return;
      void api.shell.openInEditor(openInCwd, editor);
      localStorage.setItem(LAST_EDITOR_KEY, editor);
      setLastEditor(editor);
    },
    [effectiveEditor, openInCwd],
  );

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;
      const api = readNativeApi();
      if (!api || !openInCwd || !effectiveEditor) return;
      e.preventDefault();
      void api.shell.openInEditor(openInCwd, effectiveEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [effectiveEditor, keybindings, openInCwd]);

  if (options.length === 0) return null;

  return (
    <Group aria-label="Open in editor">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="ghost"
              disabled={!effectiveEditor || !openInCwd}
              onClick={() => openInEditor(effectiveEditor)}
              className="h-6 gap-1 rounded-md px-1.5 text-muted-foreground/70 hover:text-foreground"
            />
          }
        >
          {primaryOption?.Icon && <primaryOption.Icon aria-hidden="true" className="size-3.5" />}
          <span className="sr-only">Open</span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          Open in {primaryOption?.label ?? "editor"}
          {openFavoriteEditorShortcutLabel && ` (${openFavoriteEditorShortcutLabel})`}
        </TooltipPopup>
      </Tooltip>
      <GroupSeparator className="hidden @sm:block" />
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label="Editor options"
              size="xs"
              variant="ghost"
              className="size-6 rounded-md p-0 text-muted-foreground/70 hover:text-foreground"
            />
          }
        >
          <ChevronDownIcon aria-hidden="true" className="size-3" />
        </MenuTrigger>
        <MenuPopup align="end">
          {options.map(({ label, Icon, value }) => (
            <MenuItem key={value} onClick={() => openInEditor(value)}>
              <Icon aria-hidden="true" className="text-muted-foreground" />
              {label}
              {value === effectiveEditor && openFavoriteEditorShortcutLabel && (
                <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
              )}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </Group>
  );
});

// ── Toolbar ───────────────────────────────────────────────────────────

export default function TerminalToolbar({
  threadId,
  diffOpen,
}: {
  threadId: ThreadId;
  diffOpen: boolean;
}) {
  const thread = useStore((s) => s.threads.find((t) => t.id === threadId));
  const project = useStore((s) =>
    s.projects.find((p) => p.id === thread?.projectId),
  );
  const gitCwd = thread?.worktreePath ?? project?.cwd ?? null;
  const navigate = useNavigate();
  const isGitRepo = gitCwd !== null;

  const onToggleDiff = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous: Record<string, unknown>) => {
        const rest = stripDiffSearchParams(previous);
        return diffOpen ? rest : { ...rest, diff: "1" };
      },
    });
  }, [navigate, threadId, diffOpen]);

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

  const isActive = thread.terminalStatus === "active";
  const isDormant = thread.terminalStatus === "dormant";
  const branchName = thread.branch ?? null;

  return (
    <TooltipProvider>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/40 bg-card/60 px-2 backdrop-blur-sm dark:border-border/25 dark:bg-card/40">
        {/* Title */}
        <div className="min-w-0 flex-1">
          <EditableTitle threadId={threadId} title={thread.title} />
        </div>

        {/* Read-only branch badge */}
        {branchName && (
          <span className="inline-flex max-w-[180px] items-center gap-1 rounded-md bg-muted/50 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground/70 dark:bg-muted/30">
            <GitBranchIcon className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{branchName}</span>
          </span>
        )}

        {/* Status badge */}
        <TerminalStatusBadge thread={thread} />

        {/* Open in editor */}
        <OpenInEditorPicker openInCwd={gitCwd} />

        {/* Separator */}
        {gitCwd && <div className="h-3.5 w-px bg-border/50 dark:bg-border/30" />}

        {/* Git actions */}
        <GitActionsControl gitCwd={gitCwd} activeThreadId={threadId} />

        {/* Diff toggle */}
        {isGitRepo && (
          <>
            <div className="h-3.5 w-px bg-border/50 dark:bg-border/30" />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    className="shrink-0"
                    pressed={diffOpen}
                    onPressedChange={onToggleDiff}
                    aria-label="Toggle diff panel"
                    variant="outline"
                    size="xs"
                  >
                    <DiffIcon className="size-3" />
                  </Toggle>
                }
              />
              <TooltipPopup side="bottom">Toggle diff panel</TooltipPopup>
            </Tooltip>
          </>
        )}

        {/* Separator before terminal actions */}
        {(isActive || isDormant) && (
          <div className="h-3.5 w-px bg-border/50 dark:bg-border/30" />
        )}

        {/* Terminal actions */}
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
