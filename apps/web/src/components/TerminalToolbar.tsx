import {
  EDITORS,
  type EditorId,
  type KeybindingCommand,
  type ProjectId,
  type ProjectPrompt,
  type ProjectScript,
  type ThreadId,
} from "@clui/contracts";
import { isElectron } from "../env";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  DiffIcon,
  FolderClosedIcon,
  GitBranchIcon,
  PlayIcon,
  RotateCcwIcon,
  ShieldOffIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { stripDiffSearchParams } from "../diffRouteSearch";
import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "../keybindings";
import * as claudeCache from "../lib/claudeTerminalCache";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { submitThreadPrompt } from "../lib/threadInput";
import { claudeTerminalStatusPill } from "../lib/threadStatus";
import { isMacPlatform, isWindowsPlatform, newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import {
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptRuntimeEnv,
} from "../projectScripts";
import { useStore } from "../store";
import { LAST_EDITOR_KEY } from "../terminal-links";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { DEFAULT_THREAD_TERMINAL_ID, projectTerminalThreadId, type Thread } from "../types";
import GitActionsControl from "./GitActionsControl";
import { SpeechControl } from "./SpeechControl";
import type { Icon } from "./Icons";
import { CursorIcon, VisualStudioCode, Zed } from "./Icons";
import ProjectPromptsControl, { type NewProjectPromptInput } from "./ProjectPromptsControl";
import ProjectScriptsControl, { type NewProjectScriptInput } from "./ProjectScriptsControl";
import { Button } from "./ui/button";
import { Group, GroupSeparator } from "./ui/group";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "./ui/menu";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Toggle } from "./ui/toggle";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { toastManager } from "./ui/toast";

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
        className="h-5 w-full min-w-0 rounded-sm border border-primary/40 bg-background/80 px-1 text-xs font-medium text-foreground outline-none ring-1 ring-primary/20"
        spellCheck={false}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="min-w-0 w-full rounded-sm px-1 text-left text-xs font-medium text-foreground/90 transition-colors hover:bg-muted/50 hover:text-foreground"
      title="Click to rename"
    >
      <span className="thread-title-fade block min-w-0 overflow-hidden whitespace-nowrap">{title}</span>
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
  const availableEditors = useMemo(() => serverConfig?.availableEditors ?? [], [serverConfig?.availableEditors]);
  const keybindings = useMemo(() => serverConfig?.keybindings ?? [], [serverConfig?.keybindings]);

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
              variant="outline"
              disabled={!effectiveEditor || !openInCwd}
              onClick={() => openInEditor(effectiveEditor)}
            />
          }
        >
          {primaryOption?.Icon && <primaryOption.Icon aria-hidden="true" className="size-3.5" />}
          <span className="ml-0.5">Open</span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          Open in {primaryOption?.label ?? "editor"}
          {openFavoriteEditorShortcutLabel && ` (${openFavoriteEditorShortcutLabel})`}
        </TooltipPopup>
      </Tooltip>
      <GroupSeparator />
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label="Editor options"
              size="icon-xs"
              variant="outline"
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

// ── Run Script in Terminal ────────────────────────────────────────────

const SCRIPT_TERMINAL_ID = "script";

export function runProjectScriptInTerminal(
  script: ProjectScript,
  threadId: ThreadId,
  project: { id: ProjectId; cwd: string },
  worktreePath?: string | null,
) {
  const api = readNativeApi();
  if (!api) return;

  const cwd = worktreePath ?? project.cwd;
  const env = projectScriptRuntimeEnv({ project, worktreePath: worktreePath ?? null });

  if (script.terminalTarget === "project") {
    // Open / write to the currently active project terminal tab
    const syntheticId = projectTerminalThreadId(project.id);
    const terminalStore = useTerminalStateStore.getState();
    const terminalState = selectThreadTerminalState(
      terminalStore.terminalStateByThreadId,
      syntheticId,
    );
    const terminalId = terminalState.activeTerminalId ?? DEFAULT_THREAD_TERMINAL_ID;
    terminalStore.setProjectTerminalOpen(syntheticId, true);
    void api.terminal
      .open({ threadId: syntheticId, terminalId, cwd, env })
      .then(() => api.terminal.write({ threadId: syntheticId, terminalId, data: `${script.command}\r` }))
      .catch(() => {
        // Terminal may already be open — try writing directly
        void api.terminal.write({ threadId: syntheticId, terminalId, data: `${script.command}\r` });
      });
  } else {
    // Open / write to a thread terminal
    const terminalStore = useTerminalStateStore.getState();
    const terminalState = terminalStore.terminalStateByThreadId[threadId];
    if (!terminalState?.terminalOpen) {
      terminalStore.setTerminalOpen(threadId, true);
    }
    const terminalId = terminalState?.activeTerminalId ?? SCRIPT_TERMINAL_ID;
    void api.terminal
      .open({ threadId, terminalId, cwd, env })
      .then(() => api.terminal.write({ threadId, terminalId, data: `${script.command}\r` }))
      .catch(() => {
        void api.terminal.write({ threadId, terminalId, data: `${script.command}\r` });
      });
  }
}

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

  // ── Project prompts + scripts ──
  const { data: serverConfig } = useQuery(serverConfigQueryOptions());
  const keybindings = useMemo(() => serverConfig?.keybindings ?? [], [serverConfig?.keybindings]);
  const prompts = useMemo(() => project?.prompts ?? [], [project?.prompts]);
  const scripts = useMemo(() => project?.scripts ?? [], [project?.scripts]);
  const [lastInvokedPromptId, setLastInvokedPromptId] = useState<string | null>(null);
  const [lastInvokedScriptId, setLastInvokedScriptId] = useState<string | null>(null);
  const canSendPrompt = thread?.terminalStatus === "active";

  const persistProjectMetadata = useCallback(
    async (input: {
      prompts?: ProjectPrompt[];
      scripts?: ProjectScript[];
      keybindingUpdate?: { key: string; command: KeybindingCommand };
    }) => {
      const api = readNativeApi();
      if (!api || !project) return;
      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: project.id,
        ...(input.prompts !== undefined ? { prompts: input.prompts } : {}),
        ...(input.scripts !== undefined ? { scripts: input.scripts } : {}),
      });
      if (input.keybindingUpdate) {
        await api.server.upsertKeybinding({
          key: input.keybindingUpdate.key,
          command: input.keybindingUpdate.command,
        });
      }
    },
    [project],
  );

  const handleRunPrompt = useCallback(
    async (projectPrompt: ProjectPrompt) => {
      if (!thread) return;
      if (thread.terminalStatus !== "active") {
        toastManager.add({
          type: "info",
          title: "Resume the thread first",
          description: "Custom prompts can only be sent while the thread is active.",
        });
        return;
      }
      const api = readNativeApi();
      if (!api) return;
      setLastInvokedPromptId(projectPrompt.id);
      try {
        await submitThreadPrompt(api, thread.harness, threadId, projectPrompt.prompt);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to send prompt",
          description: error instanceof Error ? error.message : "The prompt could not be submitted.",
        });
      }
    },
    [thread, threadId],
  );

  const handleAddPrompt = useCallback(
    async (input: NewProjectPromptInput) => {
      const newPrompt: ProjectPrompt = {
        id: crypto.randomUUID().slice(0, 8),
        name: input.name,
        prompt: input.prompt,
      };
      await persistProjectMetadata({ prompts: [...prompts, newPrompt] });
    },
    [prompts, persistProjectMetadata],
  );

  const handleUpdatePrompt = useCallback(
    async (promptId: string, input: NewProjectPromptInput) => {
      await persistProjectMetadata({
        prompts: prompts.map((projectPrompt) =>
          projectPrompt.id === promptId
            ? { ...projectPrompt, name: input.name, prompt: input.prompt }
            : projectPrompt,
        ),
      });
    },
    [prompts, persistProjectMetadata],
  );

  const handleDeletePrompt = useCallback(
    async (promptId: string) => {
      await persistProjectMetadata({
        prompts: prompts.filter((projectPrompt) => projectPrompt.id !== promptId),
      });
    },
    [prompts, persistProjectMetadata],
  );

  const handleRunScript = useCallback(
    (script: ProjectScript) => {
      if (!project) return;
      setLastInvokedScriptId(script.id);
      runProjectScriptInTerminal(script, threadId, project, thread?.worktreePath);
    },
    [project, threadId, thread?.worktreePath],
  );

  const handleAddScript = useCallback(
    async (input: NewProjectScriptInput) => {
      const scriptId = nextProjectScriptId(
        input.name,
        scripts.map((s) => s.id),
      );
      const newScript: ProjectScript = {
        id: scriptId,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
        terminalTarget: input.terminalTarget,
      };
      // If this script has runOnWorktreeCreate, unset it from others
      const nextScripts = input.runOnWorktreeCreate
        ? [...scripts.map((s) => ({ ...s, runOnWorktreeCreate: false })), newScript]
        : [...scripts, newScript];
      const cmd = commandForProjectScript(scriptId);
      await persistProjectMetadata({
        scripts: nextScripts,
        ...(input.keybinding ? { keybindingUpdate: { key: input.keybinding, command: cmd } } : {}),
      });
    },
    [scripts, persistProjectMetadata],
  );

  const handleUpdateScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      const nextScripts = scripts.map((s) => {
        if (s.id === scriptId) {
          return {
            ...s,
            name: input.name,
            command: input.command,
            icon: input.icon,
            runOnWorktreeCreate: input.runOnWorktreeCreate,
            terminalTarget: input.terminalTarget,
          };
        }
        // Unset runOnWorktreeCreate on others if this one claims it
        if (input.runOnWorktreeCreate && s.runOnWorktreeCreate) {
          return { ...s, runOnWorktreeCreate: false };
        }
        return s;
      });
      const cmd = commandForProjectScript(scriptId);
      await persistProjectMetadata({
        scripts: nextScripts,
        ...(input.keybinding != null
          ? { keybindingUpdate: { key: input.keybinding, command: cmd } }
          : {}),
      });
    },
    [scripts, persistProjectMetadata],
  );

  const handleDeleteScript = useCallback(
    async (scriptId: string) => {
      const nextScripts = scripts.filter((s) => s.id !== scriptId);
      await persistProjectMetadata({ scripts: nextScripts });
    },
    [scripts, persistProjectMetadata],
  );

  const diffShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "diff.toggle"),
    [keybindings],
  );

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

  // ── YOLO mode ──
  const yoloMode = useTerminalStateStore((s) =>
    selectThreadTerminalState(s.terminalStateByThreadId, threadId).yoloMode,
  );
  const setYoloMode = useTerminalStateStore((s) => s.setYoloMode);

  const handleYoloToggle = useCallback(async (enable: boolean) => {
    const api = readNativeApi();
    if (!api || !thread || thread.harness !== "claudeCode") return;
    const cwd = thread.worktreePath ?? project?.cwd ?? "";
    if (!cwd) return;
    setYoloMode(threadId, enable);
    const cached = claudeCache.get(threadId);
    const cols = cached?.terminal.cols ?? 120;
    const rows = cached?.terminal.rows ?? 40;
    try {
      await api.claude.start({
        threadId,
        cwd,
        cols,
        rows,
        resumeSessionId: thread.claudeSessionId ?? undefined,
        ...(enable ? { dangerouslySkipPermissions: true } : {}),
      });
    } catch {
      setYoloMode(threadId, !enable);
    }
  }, [threadId, thread, project, setYoloMode]);

  const handleResume = useCallback(async () => {
    const api = readNativeApi();
    if (!api || !thread) return;
    const cwd = thread.worktreePath ?? project?.cwd ?? "";
    if (!cwd) return;
    const cached = claudeCache.get(threadId);
    const cols = cached?.terminal.cols ?? 120;
    const rows = cached?.terminal.rows ?? 40;
    try {
      if (thread.harness === "pi") {
        await api.pi.start({
          threadId,
          cwd,
          cols,
          rows,
          ...(thread.piSessionFile ? { resumeSessionFile: thread.piSessionFile } : {}),
        });
      } else {
        await api.claude.start({
          threadId,
          cwd,
          cols,
          rows,
          resumeSessionId: thread.claudeSessionId ?? undefined,
          ...(yoloMode ? { dangerouslySkipPermissions: true } : {}),
        });
      }
    } catch {
      // Start failure handled by ThreadTerminalView
    }
  }, [threadId, thread, project, yoloMode]);

  if (!thread) return null;

  const isDormant = thread.terminalStatus === "dormant";
  const branchName = thread.branch ?? null;

  return (
    <TooltipProvider>
      <div className={`flex h-9 shrink-0 items-center gap-2 border-b border-border/40 bg-card/60 px-2 backdrop-blur-sm dark:border-border/25 dark:bg-card/40${isElectron ? " drag-region" : ""}`}>
        {/* Title */}
        <div className="flex min-w-0 flex-1">
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

        {/* Voice input */}
        <SpeechControl threadId={threadId} harness={thread.harness} />

        {/* Project prompts */}
        {project && (
          <ProjectPromptsControl
            prompts={prompts}
            preferredPromptId={lastInvokedPromptId}
            disabled={!canSendPrompt}
            onRunPrompt={handleRunPrompt}
            onAddPrompt={handleAddPrompt}
            onUpdatePrompt={handleUpdatePrompt}
            onDeletePrompt={handleDeletePrompt}
          />
        )}

        {/* Project scripts / actions */}
        {project && (
          <ProjectScriptsControl
            scripts={scripts}
            keybindings={keybindings}
            preferredScriptId={lastInvokedScriptId}
            onRunScript={handleRunScript}
            onAddScript={handleAddScript}
            onUpdateScript={handleUpdateScript}
            onDeleteScript={handleDeleteScript}
          />
        )}

        {/* Open in editor */}
        <OpenInEditorPicker openInCwd={gitCwd} />

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
              <TooltipPopup side="bottom">
                Toggle diff panel{diffShortcutLabel ? ` (${diffShortcutLabel})` : ""}
              </TooltipPopup>
            </Tooltip>
          </>
        )}

        {/* YOLO mode toggle */}
        {thread.harness === "claudeCode" ? (
          <>
        <div className="h-3.5 w-px bg-border/50 dark:bg-border/30" />
        <Popover>
          <Tooltip>
            <PopoverTrigger
              render={
                <TooltipTrigger
                  render={
                    <Button
                      size="xs"
                      variant={yoloMode ? "default" : "ghost"}
                      aria-label="YOLO mode"
                      className={
                        yoloMode
                          ? "size-6 rounded-md p-0 bg-red-500/15 text-red-500 hover:bg-red-500/25 dark:bg-red-500/20 dark:text-red-400 dark:hover:bg-red-500/30"
                          : "size-6 rounded-md p-0 text-muted-foreground/70 hover:text-foreground"
                      }
                    />
                  }
                />
              }
            >
              <ShieldOffIcon className="size-3" aria-hidden="true" />
            </PopoverTrigger>
            <TooltipPopup side="bottom">
              {yoloMode ? "YOLO mode active" : "YOLO mode"}
            </TooltipPopup>
          </Tooltip>
          <PopoverPopup side="bottom" align="end" className="w-64">
            <div className="space-y-2">
              <p className="text-sm font-medium">
                {yoloMode ? "Disable YOLO mode?" : "Enable YOLO mode?"}
              </p>
              <p className="text-xs text-muted-foreground">
                YOLO mode auto-accepts all tool calls without asking for permission.
              </p>
              <p className="text-xs text-amber-600 dark:text-amber-400">
                This will restart the current session to apply the change. Your conversation
                context is preserved, but the terminal will briefly reset.
                Best used when Claude is idle.
              </p>
              <div className="flex justify-end gap-2 pt-1">
                <PopoverClose
                  render={
                    <Button size="xs" variant="outline">
                      Cancel
                    </Button>
                  }
                />
                <PopoverClose
                  render={
                    <Button
                      size="xs"
                      variant={yoloMode ? "outline" : "default"}
                      className={yoloMode ? "" : "bg-red-500 text-white hover:bg-red-600"}
                      onClick={() => void handleYoloToggle(!yoloMode)}
                    >
                      {yoloMode ? "Disable" : "Enable YOLO"}
                    </Button>
                  }
                />
              </div>
            </div>
          </PopoverPopup>
        </Popover>
          </>
        ) : null}

        {/* Separator before terminal actions */}
        {isDormant && (
          <div className="h-3.5 w-px bg-border/50 dark:bg-border/30" />
        )}

        {/* Terminal actions */}
        <div className="flex items-center gap-0.5">
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
                      if (thread.harness === "pi") {
                        void api.pi.start({
                          threadId,
                          cwd,
                          cols: 120,
                          rows: 40,
                          fresh: true,
                          ...(thread.piSessionFile ? { resumeSessionFile: thread.piSessionFile } : {}),
                        });
                      } else {
                        void api.claude.start({
                          threadId,
                          cwd,
                          cols: 120,
                          rows: 40,
                          ...(yoloMode ? { dangerouslySkipPermissions: true } : {}),
                        });
                      }
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
