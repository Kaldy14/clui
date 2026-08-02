import {
  type CodingHarness,
  DEFAULT_CLAUDE_CODE_PROXY_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  type ClaudeCodeBackend,
  type ClaudeCodeProxyModel,
  type NativeApi,
  type PiRenderMode,
  type ThreadId,
} from "@clui/contracts";
import {
  CLAUDE_CODE_PROXY_MODEL_OPTIONS,
  isClaudeCodeProxyModel,
} from "@clui/shared/claudeCodeProxy";
import type { ClaudeSessionEvent, PiSessionEvent } from "@clui/contracts";
import {
  Code2Icon,
  FolderGit2Icon,
  FolderIcon,
  GaugeIcon,
  MonitorIcon,
  NetworkIcon,
  PlayIcon,
  ShieldAlertIcon,
  TerminalIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { CODING_HARNESS_LABELS, CODING_HARNESS_OPTIONS, useAppSettings } from "../appSettings";
import { isElectron } from "../env";
import { isTerminalClearShortcut, terminalNavigationShortcutData } from "../keybindings";
import {
  clipboardImageFiles,
  clipboardItemsContainImageFile,
  readFileAsDataUrl,
} from "../lib/clipboard";
import { registerHarnessOutputSubscription } from "../lib/harnessOutputSubscriptions";
import { stripTerminalResponses } from "../lib/terminalInputFilter";
import * as claudeCache from "../lib/claudeTerminalCache";
import {
  piStickyInputMirrorsEqual,
  readPiStickyInputMirror,
  type PiStickyInputMirror,
} from "../lib/piStickyInputMirror";
import { appendCompactedTerminalOutput } from "../lib/terminalOutputCompaction";
import {
  createMarkdownCodeFenceFilter,
  stripMarkdownCodeFences,
} from "../lib/terminalOutputMarkdown";
import { requestTerminalRepaint } from "../lib/terminalPtyRepaint";
import { resolveScrollbackReplay } from "../lib/terminalScrollbackReplay";
import { PI_TERMINAL_LINE_HEIGHT, terminalLineHeightForHarness } from "../lib/terminalSurfaceTheme";
import { terminalThemeFromApp } from "../lib/terminalTheme";
import { THREAD_SELECTED_EVENT, isThreadSelectedEventFor } from "../lib/threadSelectionEvent";
import { createTerminalWriteQueue } from "../lib/terminalWriteQueue";
import { shouldConvertWheelToArrowKeys } from "../lib/terminalWheelRouting";
import {
  restoreTerminalInputModesForHarness,
  writeTerminalFullResetForReplay,
} from "../lib/terminalReplay";
import { isMacPlatform, newCommandId } from "../lib/utils";
import { submitThreadPrompt } from "../lib/threadInput";
import { setupProjectScript } from "../projectScripts";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import type { Thread } from "../types";
import type { EnvMode } from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { HarnessIcon } from "./HarnessIcon";
import {
  NewThreadChoiceMenu,
  NewThreadToggleControl,
  type NewThreadChoice,
} from "./NewThreadComposerControls";
import { NewThreadProjectPicker } from "./NewThreadProjectPicker";
import PiHtmlThreadView from "./PiHtmlThreadView";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { runProjectScriptInTerminal } from "./TerminalToolbar";
import { useBranchToolbar } from "./useBranchToolbar";
import {
  readNewThreadPreference,
  readNewThreadFastModePreference,
  readNewThreadPiRenderModePreference,
  writeNewThreadPreference,
  writeNewThreadFastModePreference,
  writeNewThreadPiRenderModePreference,
} from "../lib/newThreadPreferences";

type HarnessSessionEvent = ClaudeSessionEvent | PiSessionEvent;
type HarnessKind = Thread["harness"];
type JourneyHarness = Extract<CodingHarness, "pi" | "codexCli">;

const IMAGE_PASTE_KEYSTROKE = "\x16";
const ALT_BUFFER_WHEEL_PIXELS_PER_LINE = 50;
const ALT_BUFFER_WHEEL_DELTA_LINE_PIXELS = 40;
const ALT_BUFFER_WHEEL_MAX_STEPS_PER_FRAME = 24;
const TERMINAL_RECOVERY_TIMEOUT_MS = [120, 350, 900] as const;

const NEW_THREAD_HARNESS_OPTIONS = CODING_HARNESS_OPTIONS.map((value) => ({
  value,
  label: CODING_HARNESS_LABELS[value],
}));
const NEW_THREAD_HARNESS_CHOICES: readonly NewThreadChoice<CodingHarness>[] =
  NEW_THREAD_HARNESS_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
    icon: <HarnessIcon harness={option.value} className="size-4 shrink-0" />,
  }));
const JOURNEY_HARNESS_CHOICES: readonly NewThreadChoice<JourneyHarness>[] = [
  {
    value: "pi",
    label: "Pi",
    icon: <HarnessIcon harness="pi" className="size-4 shrink-0" />,
  },
  {
    value: "codexCli",
    label: "Codex",
    icon: <HarnessIcon harness="codexCli" className="size-4 shrink-0" />,
  },
];
const NEW_THREAD_ENVIRONMENT_CHOICES: readonly NewThreadChoice<EnvMode>[] = [
  {
    value: "local",
    label: "Local",
    icon: <FolderIcon className="size-4 shrink-0 opacity-70" />,
  },
  {
    value: "worktree",
    label: "Worktree",
    icon: <FolderGit2Icon className="size-4 shrink-0 opacity-70" />,
  },
];
const PI_RENDER_MODE_CHOICES: readonly NewThreadChoice<PiRenderMode>[] = [
  {
    value: "terminal",
    label: "Terminal",
    icon: <TerminalIcon className="size-4 shrink-0 opacity-70" />,
  },
  {
    value: "html",
    label: "HTML",
    icon: <Code2Icon className="size-4 shrink-0 opacity-70" />,
  },
];
const CLAUDE_BACKEND_CHOICES: readonly NewThreadChoice<ClaudeCodeBackend>[] = [
  {
    value: "anthropic",
    label: "Anthropic",
    icon: <HarnessIcon harness="claudeCode" className="size-4 shrink-0" />,
  },
  {
    value: "codex",
    label: "Codex",
    icon: <HarnessIcon harness="codexCli" className="size-4 shrink-0" />,
  },
];
function scheduleTerminalRecoveryPasses(runPass: () => void): () => void {
  const rafIds = new Set<number>();
  const timeoutIds = new Set<number>();

  const scheduleRaf = (callback: () => void) => {
    const rafId = window.requestAnimationFrame(() => {
      rafIds.delete(rafId);
      callback();
    });
    rafIds.add(rafId);
  };

  scheduleRaf(() => {
    runPass();
    scheduleRaf(runPass);
  });

  for (const delayMs of TERMINAL_RECOVERY_TIMEOUT_MS) {
    const timeoutId = window.setTimeout(() => {
      timeoutIds.delete(timeoutId);
      runPass();
    }, delayMs);
    timeoutIds.add(timeoutId);
  }

  return () => {
    for (const rafId of rafIds) window.cancelAnimationFrame(rafId);
    for (const timeoutId of timeoutIds) window.clearTimeout(timeoutId);
    rafIds.clear();
    timeoutIds.clear();
  };
}

function refreshTerminal(entry: claudeCache.CachedTerminal): void {
  entry.fitAddon.fit();
  entry.terminal.refresh(0, Math.max(0, entry.terminal.rows - 1));
}

function configureTerminalLineHeight(
  entry: claudeCache.CachedTerminal,
  harness: HarnessKind,
): void {
  entry.terminal.options.lineHeight = terminalLineHeightForHarness(harness);
}

function startHarnessSession(
  api: NativeApi,
  thread: Thread,
  input: {
    cwd: string;
    cols: number;
    rows: number;
    fresh?: boolean;
    yoloMode?: boolean;
    piFastMode?: boolean;
    piHtmlMode?: boolean;
    initialPrompt?: string;
  },
): Promise<void> {
  if (thread.harness === "pi") {
    const shouldStartFresh = input.fresh || thread.terminalStatus === "new";
    return api.pi.start({
      threadId: thread.id,
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      ...(shouldStartFresh ? { fresh: true } : {}),
      ...(thread.piSessionFile ? { resumeSessionFile: thread.piSessionFile } : {}),
      ...(input.initialPrompt !== undefined ? { initialPrompt: input.initialPrompt } : {}),
      ...(input.piFastMode ? { fastMode: true } : {}),
      ...(input.piHtmlMode ? { htmlMode: true } : {}),
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
  harness: HarnessKind,
  input: { threadId: ThreadId; sinceOffset?: number },
): Promise<{ threadId: string; scrollback: string | null; offset: number; reset?: boolean }> {
  if (harness === "pi") {
    return api.pi.getScrollback(input);
  }
  return api.claude.getScrollback(input);
}

function subscribeHarnessSessionEvents(
  api: NativeApi,
  harness: HarnessKind,
  callback: (event: HarnessSessionEvent) => void,
): () => void {
  if (harness === "pi") {
    return api.pi.onSessionEvent(callback);
  }
  return api.claude.onSessionEvent(callback);
}

function writeHarnessData(
  api: NativeApi,
  harness: HarnessKind,
  threadId: ThreadId,
  data: string,
): Promise<void> {
  if (harness === "pi") {
    return api.pi.write({ threadId, data });
  }
  return api.claude.write({ threadId, data });
}

function resizeHarnessSession(
  api: NativeApi,
  harness: HarnessKind,
  threadId: ThreadId,
  cols: number,
  rows: number,
): Promise<void> {
  if (harness === "pi") {
    return api.pi.resize({ threadId, cols, rows });
  }
  return api.claude.resize({ threadId, cols, rows });
}

function modelForHarnessSelection(
  harness: HarnessKind,
  claudeCodeBackend: ClaudeCodeBackend,
): string | undefined {
  if (harness === "pi") return undefined;
  if (harness === "codexCli") return DEFAULT_MODEL_BY_PROVIDER.codex;
  return claudeCodeBackend === "codex"
    ? DEFAULT_CLAUDE_CODE_PROXY_MODEL
    : DEFAULT_MODEL_BY_PROVIDER.claudeCode;
}

// ── NewThreadView ─────────────────────────────────────────────────────

function NewThreadView({ threadId, thread }: { threadId: ThreadId; thread: Thread }) {
  const { updateSettings } = useAppSettings();
  const [starting, setStarting] = useState(false);
  const [journeyMode, setJourneyMode] = useState(false);
  const [journeyHarness, setJourneyHarness] = useState<JourneyHarness>(() =>
    thread.harness === "codexCli" ? "codexCli" : "pi",
  );
  const [error, setError] = useState<string | null>(null);
  const dangerouslySkipPermissions = useTerminalStateStore(
    (s) => selectThreadTerminalState(s.terminalStateByThreadId, threadId).yoloMode,
  );
  const setDangerouslySkipPermissions = useTerminalStateStore((s) => s.setYoloMode);
  const setYolo = useCallback(
    (v: boolean) => setDangerouslySkipPermissions(threadId, v),
    [threadId, setDangerouslySkipPermissions],
  );
  const piFastMode = useTerminalStateStore(
    (s) => selectThreadTerminalState(s.terminalStateByThreadId, threadId).piFastMode,
  );
  const draftPiRenderMode = useTerminalStateStore(
    (s) =>
      selectThreadTerminalState(s.terminalStateByThreadId, threadId).piRenderMode ?? "terminal",
  );
  const piRenderMode =
    thread.piRenderMode === "html" || draftPiRenderMode === "html" ? "html" : "terminal";
  const setPiFastMode = useTerminalStateStore((s) => s.setPiFastMode);
  const setDraftPiRenderMode = useTerminalStateStore((s) => s.setPiRenderMode);
  const setThreadPiRenderMode = useStore((s) => s.setThreadPiRenderMode);
  const [envMode, setEnvModeState] = useState<EnvMode>("local");
  const [localFastMode, setLocalFastMode] = useState<boolean>(piFastMode);
  const [prDialogOpen, setPrDialogOpen] = useState(false);
  const [prInitialReference, setPrInitialReference] = useState<string | null>(null);
  const project = useStore((s) => s.projects.find((p) => p.id === thread.projectId));
  const branchToolbar = useBranchToolbar(threadId);
  const activeProjectCwd = branchToolbar.activeProjectCwd ?? project?.cwd ?? null;
  const setThreadBranchMetadata = branchToolbar.setThreadBranch;
  const setThreadHarness = useStore((s) => s.setThreadHarness);
  const setThreadClaudeCodeBackend = useStore((s) => s.setThreadClaudeCodeBackend);
  const cwd = thread.worktreePath ?? project?.cwd ?? "";
  const initialPrompt = useTerminalStateStore(
    (s) => selectThreadTerminalState(s.terminalStateByThreadId, threadId).newThreadPromptDraft,
  );
  const setNewThreadPromptDraft = useTerminalStateStore((s) => s.setNewThreadPromptDraft);
  const clearNewThreadPromptDraft = useTerminalStateStore((s) => s.clearNewThreadPromptDraft);
  const initialPromptRef = useRef<HTMLTextAreaElement>(null);
  const effectiveEnvMode: EnvMode = thread.worktreePath ? "worktree" : envMode;
  const isWorktreePending = effectiveEnvMode === "worktree" && !thread.worktreePath;
  const isWorktreeBaseSelected = !isWorktreePending || !!thread.branch;
  const hasInitialPrompt = initialPrompt.trim().length > 0;

  const persistNewThreadPreference = useCallback(
    (nextEnvMode: EnvMode, nextBranch: string | null) => {
      const cwd = activeProjectCwd;
      const branch = nextBranch ?? thread.branch;
      if (!cwd || !branch) return;
      writeNewThreadPreference(cwd, {
        envMode: nextEnvMode,
        branch,
        fastMode: localFastMode,
        piRenderMode,
      });
    },
    [activeProjectCwd, thread.branch, localFastMode, piRenderMode],
  );

  const setEnvMode = useCallback(
    (nextEnvMode: EnvMode) => {
      setEnvModeState(nextEnvMode);
      persistNewThreadPreference(nextEnvMode, thread.branch);
    },
    [persistNewThreadPreference, thread.branch],
  );

  const setThreadBranch = useCallback(
    (branch: string | null, worktreePath: string | null) => {
      setThreadBranchMetadata(branch, worktreePath);
      persistNewThreadPreference(worktreePath ? "worktree" : effectiveEnvMode, branch);
    },
    [effectiveEnvMode, persistNewThreadPreference, setThreadBranchMetadata],
  );

  // Load saved new-thread preference for this project once the project cwd is known.
  const preferenceLoadedProjectCwdRef = useRef<string | null>(null);
  useEffect(() => {
    if (thread.terminalStatus !== "new") return;
    const cwd = activeProjectCwd;
    if (!cwd || preferenceLoadedProjectCwdRef.current === cwd) return;
    preferenceLoadedProjectCwdRef.current = cwd;

    const fastDefault = readNewThreadFastModePreference(cwd) ?? false;
    const renderModeDefault = readNewThreadPiRenderModePreference(cwd) ?? "terminal";
    setLocalFastMode(fastDefault);
    setPiFastMode(threadId, fastDefault);
    setDraftPiRenderMode(threadId, renderModeDefault);
    setThreadPiRenderMode(threadId, renderModeDefault);

    if (thread.branch || thread.worktreePath) return;
    const saved = readNewThreadPreference(cwd);
    if (!saved) return;
    setEnvModeState(saved.envMode);
    setThreadBranchMetadata(saved.branch, null);
  }, [
    activeProjectCwd,
    setDraftPiRenderMode,
    setPiFastMode,
    setThreadBranchMetadata,
    setThreadPiRenderMode,
    thread.branch,
    thread.worktreePath,
    threadId,
    thread.terminalStatus,
  ]);

  const handleStart = useCallback(async () => {
    if (journeyMode && !hasInitialPrompt) return;
    const api = readNativeApi();
    if (!api) return;
    setStarting(true);
    setError(null);
    try {
      let startCwd = cwd;
      // Create a detached worktree if in worktree mode without one yet.  The
      // user/AI can create the feature branch later from inside that worktree.
      if (isWorktreePending) {
        if (!thread.branch || !project?.cwd) {
          throw new Error("Select a base branch before creating a worktree.");
        }

        const result = await api.git.createWorktree({
          cwd: project.cwd,
          branch: thread.branch,
          detach: true,
          path: null,
        });
        setThreadBranchMetadata(null, result.worktree.path);
        startCwd = result.worktree.path;

        // Run the setup script (runOnWorktreeCreate) if one is configured.
        // This intentionally keeps today's fire-and-forget behavior.
        const setupScript = setupProjectScript(project.scripts ?? []);
        if (setupScript) {
          runProjectScriptInTerminal(setupScript, threadId, project, result.worktree.path, {
            openTerminal: setupScript.openTerminalOnWorktreeCreate,
          });
        }
      } else if (effectiveEnvMode === "local" && thread.branch && project?.cwd) {
        await api.git.checkout({ cwd: project.cwd, branch: thread.branch });
        const status = await api.git.status({ cwd: project.cwd }).catch(() => null);
        if (status?.branch && status.branch !== thread.branch) {
          setThreadBranchMetadata(status.branch, null);
        }
        startCwd = project.cwd;
      }
      if (!startCwd) return;
      if (journeyMode) {
        const journeyModel =
          journeyHarness === "codexCli" && thread.harness !== "codexCli"
            ? DEFAULT_MODEL_BY_PROVIDER.codex
            : undefined;
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId,
          surface: "journey",
          harness: journeyHarness,
          ...(journeyHarness === "pi" ? { piRenderMode: "html" as const } : {}),
          ...(journeyModel ? { model: journeyModel } : {}),
        });
        return;
      }
      // cols/rows are initial defaults — ActiveTerminalView sends a corrective
      // resize with actual container dimensions immediately after mounting.
      const initialPromptSentByStart = thread.harness === "pi" && hasInitialPrompt;
      await startHarnessSession(api, thread, {
        cwd: startCwd,
        cols: 120,
        rows: 40,
        yoloMode: dangerouslySkipPermissions,
        piFastMode: thread.harness === "pi" ? localFastMode : false,
        piHtmlMode: thread.harness === "pi" && piRenderMode === "html",
        ...(initialPromptSentByStart ? { initialPrompt } : {}),
      });
      if (hasInitialPrompt && !initialPromptSentByStart) {
        await submitThreadPrompt(api, thread.harness, threadId, initialPrompt);
      }
      clearNewThreadPromptDraft(threadId);
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
    setThreadBranchMetadata,
    dangerouslySkipPermissions,
    effectiveEnvMode,
    hasInitialPrompt,
    initialPrompt,
    journeyMode,
    journeyHarness,
    localFastMode,
    piRenderMode,
    clearNewThreadPromptDraft,
  ]);

  const containerRef = useRef<HTMLDivElement>(null);

  const setInitialPrompt = useCallback(
    (value: string) => setNewThreadPromptDraft(threadId, value),
    [setNewThreadPromptDraft, threadId],
  );

  const insertInitialPromptText = useCallback(
    (text: string, start: number, end: number) => {
      const current = selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadId,
        threadId,
      ).newThreadPromptDraft;
      const safeStart = Math.max(0, Math.min(start, current.length));
      const safeEnd = Math.max(safeStart, Math.min(end, current.length));
      const next = `${current.slice(0, safeStart)}${text}${current.slice(safeEnd)}`;
      setNewThreadPromptDraft(threadId, next);
      const cursor = safeStart + text.length;
      requestAnimationFrame(() => {
        const textarea = initialPromptRef.current;
        if (!textarea) return;
        textarea.focus({ preventScroll: true });
        textarea.setSelectionRange(cursor, cursor);
      });
    },
    [setNewThreadPromptDraft, threadId],
  );

  const handleInitialPromptPaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const imageFiles = clipboardImageFiles(event.clipboardData?.items);
      if (imageFiles.length === 0) return;

      event.preventDefault();
      const api = readNativeApi();
      if (!api) {
        setError("Image paste unavailable.");
        return;
      }

      const selectionStart = event.currentTarget.selectionStart;
      const selectionEnd = event.currentTarget.selectionEnd;
      setError(null);
      void (async () => {
        try {
          const filePaths: string[] = [];
          for (const file of imageFiles) {
            const dataUrl = await readFileAsDataUrl(file);
            const result = await api.server.writeTempImage({
              threadId,
              name: file.name.trim() || "clipboard-image.png",
              mimeType: file.type || "image/png",
              sizeBytes: file.size,
              dataUrl,
            });
            filePaths.push(result.filePath);
          }
          insertInitialPromptText(filePaths.join("\n"), selectionStart, selectionEnd);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to paste image.");
        }
      })();
    },
    [insertInitialPromptText, threadId],
  );

  const handleHarnessChange = useCallback(
    (harness: Thread["harness"]) => {
      if (thread.terminalStatus !== "new") return;
      updateSettings({ defaultCodingHarness: harness });
      const api = readNativeApi();
      const model = modelForHarnessSelection(harness, thread.claudeCodeBackend);
      setThreadHarness(threadId, harness);
      if (model) setThreadClaudeCodeBackend(threadId, thread.claudeCodeBackend, model);
      requestAnimationFrame(() => initialPromptRef.current?.focus({ preventScroll: true }));
      if (!api) return;
      void api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId,
        harness,
        ...(model ? { model } : {}),
      });
    },
    [
      setThreadClaudeCodeBackend,
      setThreadHarness,
      thread.claudeCodeBackend,
      thread.terminalStatus,
      threadId,
      updateSettings,
    ],
  );

  const handlePiRenderModeChange = useCallback(
    (renderMode: PiRenderMode) => {
      if (thread.terminalStatus !== "new") return;
      const api = readNativeApi();
      setDraftPiRenderMode(threadId, renderMode);
      setThreadPiRenderMode(threadId, renderMode);
      if (activeProjectCwd) writeNewThreadPiRenderModePreference(activeProjectCwd, renderMode);
      requestAnimationFrame(() => initialPromptRef.current?.focus({ preventScroll: true }));
      if (!api) return;
      void api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId,
        piRenderMode: renderMode,
      });
    },
    [
      activeProjectCwd,
      setDraftPiRenderMode,
      setThreadPiRenderMode,
      thread.terminalStatus,
      threadId,
    ],
  );

  const handleJourneyModeChange = useCallback(
    (next: boolean) => {
      setJourneyMode(next);
      if (next) {
        setJourneyHarness(thread.harness === "codexCli" ? "codexCli" : "pi");
      }
      requestAnimationFrame(() => initialPromptRef.current?.focus({ preventScroll: true }));
    },
    [thread.harness],
  );

  const handleClaudeCodeBackendChange = useCallback(
    (claudeCodeBackend: ClaudeCodeBackend) => {
      if (thread.terminalStatus !== "new") return;
      const api = readNativeApi();
      const model =
        claudeCodeBackend === "codex"
          ? isClaudeCodeProxyModel(thread.model)
            ? thread.model
            : DEFAULT_CLAUDE_CODE_PROXY_MODEL
          : isClaudeCodeProxyModel(thread.model)
            ? DEFAULT_MODEL_BY_PROVIDER.claudeCode
            : thread.model;
      setThreadClaudeCodeBackend(threadId, claudeCodeBackend, model);
      requestAnimationFrame(() => initialPromptRef.current?.focus({ preventScroll: true }));
      if (!api) return;
      void api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId,
        claudeCodeBackend,
        model,
      });
    },
    [setThreadClaudeCodeBackend, thread.model, thread.terminalStatus, threadId],
  );

  const handleClaudeCodeProxyModelChange = useCallback(
    (model: ClaudeCodeProxyModel) => {
      if (thread.terminalStatus !== "new" || thread.claudeCodeBackend !== "codex") return;
      const api = readNativeApi();
      setThreadClaudeCodeBackend(threadId, "codex", model);
      if (!api) return;
      void api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId,
        model,
      });
    },
    [setThreadClaudeCodeBackend, thread.claudeCodeBackend, thread.terminalStatus, threadId],
  );

  // Auto-focus the first-prompt textarea so new threads are keyboard-first.
  useEffect(() => {
    initialPromptRef.current?.focus({ preventScroll: true });
  }, [threadId]);

  // Enter starts the session: plain Enter from the empty state, or from the
  // first-prompt textarea via handlePromptKeyDown (Shift+Enter inserts a
  // newline there). Cmd/Ctrl+Enter starts from anywhere.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const isTextEntry =
        e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      const isInteractiveControl =
        e.target instanceof HTMLElement &&
        e.target.closest("button,a,input,select,textarea,[role='button'],[role='switch']") !== null;
      const isPlainEnter =
        e.key === "Enter" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        !isTextEntry &&
        !isInteractiveControl;
      const isSubmitShortcut =
        e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;

      if (
        (isPlainEnter || isSubmitShortcut) &&
        !starting &&
        (cwd || isWorktreePending) &&
        isWorktreeBaseSelected
      ) {
        e.preventDefault();
        handleStart();
      }
    },
    [handleStart, starting, cwd, isWorktreePending, isWorktreeBaseSelected],
  );

  // Enter submits from the textarea; Shift+Enter falls through as a newline.
  const handlePromptKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.nativeEvent.isComposing) return;
      e.preventDefault();
      if (!starting && (cwd || isWorktreePending) && isWorktreeBaseSelected) {
        handleStart();
      }
    },
    [handleStart, starting, cwd, isWorktreePending, isWorktreeBaseSelected],
  );

  const selectedProxyModel = isClaudeCodeProxyModel(thread.model)
    ? thread.model
    : DEFAULT_CLAUDE_CODE_PROXY_MODEL;
  const selectedProxyModelLabel =
    CLAUDE_CODE_PROXY_MODEL_OPTIONS.find((option) => option.value === selectedProxyModel)?.label ??
    selectedProxyModel;
  const environmentLabel =
    effectiveEnvMode === "local"
      ? "Current checkout"
      : thread.worktreePath
        ? "Worktree"
        : "New worktree";
  const startDisabled =
    starting ||
    (!cwd && !isWorktreePending) ||
    !isWorktreeBaseSelected ||
    (journeyMode && !hasInitialPrompt);
  const startLabel = starting
    ? isWorktreePending
      ? "Creating worktree"
      : journeyMode
        ? "Starting journey"
        : "Starting"
    : journeyMode
      ? "Start journey"
      : `Start ${CODING_HARNESS_LABELS[thread.harness]}`;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="relative flex h-full min-h-0 items-center justify-center overflow-y-auto px-3 py-28 outline-none sm:px-6"
    >
      <div className="w-full">
        <div
          className={`new-thread-composer-glass-shell relative mx-auto w-full max-w-3xl animate-fade-in ${
            branchToolbar.isReady && branchToolbar.activeProjectCwd
              ? "new-thread-composer-glass-shell-with-context"
              : ""
          }`}
        >
          <div className="absolute inset-x-0 bottom-full z-0 pb-8">
            <NewThreadProjectPicker activeProject={project ?? null} />
          </div>

          <div className="new-thread-composer-glass-host relative z-10 w-full rounded-[22px]">
            <div className="group rounded-[22px] p-px">
              <div className="rounded-[20px] transition-colors duration-200">
                <div className="relative px-3 pb-2 pt-3.5 sm:px-4 sm:pt-4">
                  <textarea
                    ref={initialPromptRef}
                    value={initialPrompt}
                    onChange={(event) => setInitialPrompt(event.target.value)}
                    onPaste={handleInitialPromptPaste}
                    onKeyDown={handlePromptKeyDown}
                    placeholder={
                      journeyMode
                        ? "What do you want to figure out, decide, or build?"
                        : `Ask ${CODING_HARNESS_LABELS[thread.harness]} what to do first...`
                    }
                    aria-label="First prompt"
                    rows={3}
                    spellCheck
                    className="block max-h-50 min-h-[4.375rem] w-full resize-none overflow-y-auto whitespace-pre-wrap bg-transparent text-[16px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/35 sm:text-[14px]"
                  />
                </div>

                <div className="flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-2.5 pb-2.5 sm:px-3 sm:pb-3">
                  <div className="-m-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {journeyMode ? (
                      <>
                        <NewThreadChoiceMenu
                          ariaLabel="Choose journey agent"
                          value={journeyHarness}
                          label={journeyHarness === "pi" ? "Pi" : "Codex"}
                          icon={
                            <HarnessIcon harness={journeyHarness} className="size-4 shrink-0" />
                          }
                          options={JOURNEY_HARNESS_CHOICES}
                          onValueChange={setJourneyHarness}
                        />

                        <span
                          aria-hidden="true"
                          className="mx-0.5 h-4 w-px shrink-0 bg-border/70"
                        />
                      </>
                    ) : (
                      <>
                        <NewThreadChoiceMenu
                          ariaLabel="Choose coding harness"
                          value={thread.harness}
                          label={CODING_HARNESS_LABELS[thread.harness]}
                          icon={
                            <HarnessIcon harness={thread.harness} className="size-4 shrink-0" />
                          }
                          options={NEW_THREAD_HARNESS_CHOICES}
                          onValueChange={handleHarnessChange}
                        />

                        <span
                          aria-hidden="true"
                          className="mx-0.5 h-4 w-px shrink-0 bg-border/70"
                        />
                      </>
                    )}

                    {!journeyMode && thread.harness === "pi" && (
                      <>
                        <NewThreadChoiceMenu
                          ariaLabel="Choose pi render mode"
                          value={piRenderMode}
                          label={piRenderMode === "html" ? "HTML" : "Terminal"}
                          icon={
                            piRenderMode === "html" ? (
                              <Code2Icon className="size-4 shrink-0 opacity-70" />
                            ) : (
                              <TerminalIcon className="size-4 shrink-0 opacity-70" />
                            )
                          }
                          options={PI_RENDER_MODE_CHOICES}
                          onValueChange={handlePiRenderModeChange}
                        />
                        {activeProjectCwd && (
                          <NewThreadToggleControl
                            checked={localFastMode}
                            label="Fast"
                            ariaLabel="Use OpenAI Fast mode for this pi thread"
                            icon={<GaugeIcon className="size-4" />}
                            onCheckedChange={(next) => {
                              setLocalFastMode(next);
                              setPiFastMode(threadId, next);
                              writeNewThreadFastModePreference(activeProjectCwd, next);
                            }}
                          />
                        )}
                      </>
                    )}

                    {!journeyMode && thread.harness === "claudeCode" && (
                      <>
                        <NewThreadChoiceMenu
                          ariaLabel="Choose Claude Code backend"
                          value={thread.claudeCodeBackend}
                          label={thread.claudeCodeBackend === "codex" ? "Codex" : "Anthropic"}
                          icon={
                            <HarnessIcon
                              harness={
                                thread.claudeCodeBackend === "codex" ? "codexCli" : "claudeCode"
                              }
                              className="size-4 shrink-0"
                            />
                          }
                          options={CLAUDE_BACKEND_CHOICES}
                          onValueChange={handleClaudeCodeBackendChange}
                        />
                        {thread.claudeCodeBackend === "codex" && (
                          <NewThreadChoiceMenu
                            ariaLabel="Choose Codex model"
                            value={selectedProxyModel}
                            label={selectedProxyModelLabel}
                            icon={<MonitorIcon className="size-4 shrink-0 opacity-70" />}
                            options={CLAUDE_CODE_PROXY_MODEL_OPTIONS}
                            onValueChange={handleClaudeCodeProxyModelChange}
                          />
                        )}
                      </>
                    )}

                    {!journeyMode && thread.harness !== "pi" && (
                      <NewThreadToggleControl
                        checked={dangerouslySkipPermissions}
                        label="YOLO"
                        ariaLabel="Skip all permission prompts"
                        icon={<ShieldAlertIcon className="size-4" />}
                        tone="danger"
                        onCheckedChange={setYolo}
                      />
                    )}

                    <NewThreadToggleControl
                      checked={journeyMode}
                      label="Journey"
                      ariaLabel="Start this thread as a journey"
                      icon={<NetworkIcon className="size-4" />}
                      onCheckedChange={handleJourneyModeChange}
                    />
                  </div>

                  <button
                    type="button"
                    disabled={startDisabled}
                    aria-busy={starting}
                    aria-label={startLabel}
                    title={startLabel}
                    onClick={handleStart}
                    className="relative isolate flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/90 text-primary-foreground shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-[0_1px_--theme(--color-white/16%)] enabled:hover:scale-105 enabled:hover:bg-primary active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none disabled:pointer-events-none disabled:opacity-30 disabled:shadow-none sm:size-8"
                  >
                    {starting ? (
                      <span
                        className="size-3.5 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
                        aria-hidden="true"
                      />
                    ) : (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {branchToolbar.isReady && branchToolbar.activeProjectCwd && (
            <div className="new-thread-composer-context-strip relative z-0 -mt-4 mx-auto flex w-[calc(100%-2.75rem)] max-w-[calc(48rem-2.75rem)] items-center gap-2 px-1 pb-1 pt-5">
              <div className="flex min-w-0 flex-1 items-center gap-1">
                <NewThreadChoiceMenu
                  ariaLabel="Choose local checkout or worktree"
                  value={effectiveEnvMode}
                  label={environmentLabel}
                  icon={
                    effectiveEnvMode === "worktree" ? (
                      <FolderGit2Icon className="size-4 shrink-0 opacity-70" />
                    ) : (
                      <FolderIcon className="size-4 shrink-0 opacity-70" />
                    )
                  }
                  options={NEW_THREAD_ENVIRONMENT_CHOICES}
                  onValueChange={setEnvMode}
                  className="min-w-0 max-w-full"
                  disabled={!!thread.worktreePath}
                  compact
                />
              </div>
              <div className="flex min-w-0 flex-1 justify-end">
                <BranchToolbarBranchSelector
                  activeProjectCwd={branchToolbar.activeProjectCwd}
                  activeThreadBranch={branchToolbar.activeThreadBranch}
                  activeWorktreePath={branchToolbar.activeWorktreePath}
                  branchCwd={branchToolbar.branchCwd}
                  dedupeRemotes={false}
                  deferCheckout
                  effectiveEnvMode={effectiveEnvMode}
                  envLocked={!!thread.worktreePath}
                  onSetThreadBranch={setThreadBranch}
                  onCheckoutPullRequestRequest={(ref) => {
                    setPrInitialReference(ref);
                    setPrDialogOpen(true);
                  }}
                />
              </div>
            </div>
          )}

          {error && (
            <p
              role="alert"
              className="absolute inset-x-0 top-full mt-3 text-center text-xs text-destructive animate-fade-in-up"
            >
              {error}
            </p>
          )}
        </div>
      </div>

      <PullRequestThreadDialog
        open={prDialogOpen}
        cwd={branchToolbar.activeProjectCwd}
        initialReference={prInitialReference}
        onOpenChange={setPrDialogOpen}
        onPrepared={(input) => {
          setThreadBranch(input.branch, input.worktreePath);
          if (input.worktreePath) {
            setEnvModeState("worktree");
            persistNewThreadPreference("worktree", input.branch);
          } else {
            persistNewThreadPreference("local", input.branch);
          }
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

function DormantTerminalView({ threadId, thread }: { threadId: ThreadId; thread: Thread }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const resumeButtonRef = useRef<HTMLButtonElement>(null);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = useStore((s) => s.projects.find((p) => p.id === thread.projectId));
  const cwd = thread.worktreePath ?? project?.cwd ?? "";
  const yoloMode = useTerminalStateStore(
    (s) => selectThreadTerminalState(s.terminalStateByThreadId, threadId).yoloMode,
  );
  const piFastMode = useTerminalStateStore(
    (s) => selectThreadTerminalState(s.terminalStateByThreadId, threadId).piFastMode,
  );

  // Render scrollback in a read-only xterm.js instance (or reuse cached)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onThreadSelected = (event: Event) => {
      if (!isThreadSelectedEventFor(event, threadId)) return;
      const target = claudeCache.get(threadId);
      if (!target?.container?.isConnected) return;
      refreshTerminal(target);
    };
    window.addEventListener(THREAD_SELECTED_EVENT, onThreadSelected);

    // If there's a cached terminal from a previous active session, reuse it
    const cached = claudeCache.get(threadId);
    if (cached) {
      claudeCache.attach(threadId, el);
      configureTerminalLineHeight(cached, thread.harness);
      cached.terminal.options.disableStdin = true;
      // Fit after layout has settled so read-only scrollback renders at correct dimensions.
      const cancelRecovery = scheduleTerminalRecoveryPasses(() => refreshTerminal(cached));
      return () => {
        window.removeEventListener(THREAD_SELECTED_EVENT, onThreadSelected);
        cancelRecovery();
        claudeCache.detach(threadId);
      };
    }

    // Otherwise, fetch scrollback and render in a new terminal
    const entry = claudeCache.attach(threadId, el);
    configureTerminalLineHeight(entry, thread.harness);
    entry.terminal.options.disableStdin = true;
    const api = readNativeApi();
    if (!api) {
      return () => {
        window.removeEventListener(THREAD_SELECTED_EVENT, onThreadSelected);
      };
    }

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
      if (scrollback) entry.terminal.write(stripMarkdownCodeFences(scrollback));
      if (offset != null) entry.lastServerOffset = offset;
    };

    const cancelRecovery = scheduleTerminalRecoveryPasses(() => {
      if (disposed) return;
      refreshTerminal(entry);
      if (!fitDone) {
        fitDone = true;
        writePendingIfReady();
      }
    });

    void getHarnessScrollback(api, thread.harness, { threadId }).then((result) => {
      if (disposed) return;
      pendingData = { scrollback: result.scrollback, offset: result.offset ?? null };
      writePendingIfReady();
    });

    return () => {
      disposed = true;
      window.removeEventListener(THREAD_SELECTED_EVENT, onThreadSelected);
      cancelRecovery();
      claudeCache.detach(threadId);
      // Dispose dormant terminals on unmount — they're cheap to recreate
      // and we don't want stale scrollback accumulating in memory.
      claudeCache.dispose(threadId);
    };
  }, [thread.harness, threadId]);

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
        piFastMode,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resume session");
      setResuming(false);
    }
  }, [thread, threadId, cwd, yoloMode, piFastMode]);

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
      <div
        ref={containerRef}
        className="min-h-0 flex-1 opacity-70 saturate-75 transition-opacity hover:opacity-85 hover:saturate-100"
      />

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

function DormantPiHtmlView({ threadId, thread }: { threadId: ThreadId; thread: Thread }) {
  const resumeButtonRef = useRef<HTMLButtonElement>(null);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = useStore((s) => s.projects.find((p) => p.id === thread.projectId));
  const cwd = thread.worktreePath ?? project?.cwd ?? "";
  const yoloMode = useTerminalStateStore(
    (s) => selectThreadTerminalState(s.terminalStateByThreadId, threadId).yoloMode,
  );
  const piFastMode = useTerminalStateStore(
    (s) => selectThreadTerminalState(s.terminalStateByThreadId, threadId).piFastMode,
  );

  useEffect(() => {
    resumeButtonRef.current?.focus();
  }, []);

  const handleResume = useCallback(async () => {
    const api = readNativeApi();
    if (!api || !cwd) return;
    setResuming(true);
    setError(null);
    try {
      await startHarnessSession(api, thread, {
        cwd,
        cols: 120,
        rows: 40,
        yoloMode,
        piFastMode,
        piHtmlMode: true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resume session");
      setResuming(false);
    }
  }, [thread, cwd, yoloMode, piFastMode]);

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
    <PiHtmlThreadView
      threadId={threadId}
      footer={
        <div className="flex shrink-0 items-center justify-center gap-3 border-t border-border/40 bg-card/60 px-4 py-2 backdrop-blur-sm dark:border-border/20 dark:bg-card/40">
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
      }
    />
  );
}

// ── ActiveTerminalView ────────────────────────────────────────────────

function ActiveTerminalView({ threadId, thread }: { threadId: ThreadId; thread: Thread }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const harness = thread.harness;
  const [showNewOutput, setShowNewOutput] = useState(false);
  const [stickyPiInputMirror, setStickyPiInputMirror] = useState<PiStickyInputMirror | null>(null);
  const { settings } = useAppSettings();
  const searchAddonRef = useRef<claudeCache.CachedTerminal["searchAddon"] | null>(null);
  const stickyPiInputMirrorRef = useRef<PiStickyInputMirror | null>(null);
  const stickyPiInputMirrorWheelRemainderRef = useRef(0);
  const fenceFilterRef = useRef(createMarkdownCodeFenceFilter());

  // Reset the markdown fence filter whenever the thread/harness changes so we
  // do not carry a stale "inside code block" state across sessions.
  useEffect(() => {
    fenceFilterRef.current = createMarkdownCodeFenceFilter();
  }, [threadId, harness]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const api = readNativeApi();
    if (!api) return;
    const activeApi = api;
    const outputSubscription = registerHarnessOutputSubscription(api, harness, threadId);

    let disposed = false;

    // ── Gate: buffer ALL writes until fit(), catch-up, and PTY repaint ──
    // The subscription is acknowledged before requesting the missing offset
    // range, so live output cannot fall into the gap between those operations.
    // A repaint still follows catch-up to make the current TUI frame authoritative.
    const eventBuffer: HarnessSessionEvent[] = [];
    let preReadyOutputData = "";
    let preReadyOutputMaxOffset: number | null = null;
    let preReadyOutputCompacted = false;
    let terminalReady = false;
    let fitComplete = false;
    let catchUpReady = false;
    let pendingCatchUp: {
      scrollback: string | null;
      offset: number;
      reset: boolean;
      sinceOffset: number;
    } | null = null;
    let gateSyncedOffset: number | null = null;
    let gateOpened = false;
    const REPAINT_SETTLE_MS = 120;
    const MAX_REPAINT_GATE_RETRIES = 12;
    let repaintGateRetryCount = 0;
    let repaintGateRetryRafId: number | null = null;
    let repaintSettleTimeoutId: number | null = null;
    let cancelInitialPtyRepaint: (() => void) | null = null;
    let cancelThreadSelectionPtyRepaint: (() => void) | null = null;
    let repaintOffsetBaselineInvalid = false;

    const entry = claudeCache.attach(threadId, el);
    configureTerminalLineHeight(entry, harness);
    const { terminal, fitAddon } = entry;
    const terminalWriteQueue = createTerminalWriteQueue(terminal);
    const queuedTerminalWriter = {
      write: (data: string) => terminalWriteQueue.enqueue(data),
    };
    searchAddonRef.current = entry.searchAddon;
    terminal.options.disableStdin = false;
    // Reattached pi terminals can have lost local bracketed-paste mode before
    // scrollback replay completes; restore it immediately, then again after
    // any replay reset below.
    restoreTerminalInputModesForHarness(queuedTerminalWriter, harness);

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
    const stickyMirrorScrollThresholdReached = (): boolean => {
      return terminal.buffer.active.baseY - terminal.buffer.active.viewportY >= 3;
    };
    const isAltBuffer = () => terminal.buffer.active.type === "alternate";

    let stickyMirrorRafId: number | null = null;
    const commitStickyPiInputMirror = (nextMirror: PiStickyInputMirror | null) => {
      if (piStickyInputMirrorsEqual(stickyPiInputMirrorRef.current, nextMirror)) return;
      stickyPiInputMirrorRef.current = nextMirror;
      setStickyPiInputMirror(nextMirror);
    };
    const refreshStickyPiInputMirror = () => {
      if (disposed) return;
      if (
        harness !== "pi" ||
        !settings.stickyPiInputMirror ||
        !stickyMirrorScrollThresholdReached()
      ) {
        commitStickyPiInputMirror(null);
        return;
      }
      commitStickyPiInputMirror(readPiStickyInputMirror(terminal));
    };
    const scheduleStickyPiInputMirrorRefresh = () => {
      if (harness !== "pi") return;
      if (stickyMirrorRafId !== null) return;
      stickyMirrorRafId = requestAnimationFrame(() => {
        stickyMirrorRafId = null;
        refreshStickyPiInputMirror();
      });
    };

    let catchUpRedrawRafId: number | null = null;
    const scheduleCatchUpRedraw = () => {
      if (catchUpRedrawRafId !== null) return;
      catchUpRedrawRafId = requestAnimationFrame(() => {
        catchUpRedrawRafId = null;
        if (disposed) return;
        void resizeHarnessSession(activeApi, harness, threadId, terminal.cols, terminal.rows).catch(
          () => undefined,
        );
      });
    };

    let visualSettleRafIds: number[] = [];
    let visualSettleTimeoutId: ReturnType<typeof setTimeout> | null = null;
    const runTerminalVisualSettle = (stickToBottom: boolean) => {
      if (disposed || !entry.container?.isConnected) return;
      fitAddon.fit();
      if (stickToBottom && !isAltBuffer() && isViewportAtBottom()) {
        terminal.scrollToBottom();
      }
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
      scheduleStickyPiInputMirrorRefresh();
    };
    const finishTerminalVisualSettle = (stickToBottom: boolean) => {
      for (const rafId of visualSettleRafIds) cancelAnimationFrame(rafId);
      visualSettleRafIds = [];
      if (visualSettleTimeoutId !== null) {
        clearTimeout(visualSettleTimeoutId);
        visualSettleTimeoutId = null;
      }
      runTerminalVisualSettle(stickToBottom);
    };
    const scheduleTerminalVisualSettle = () => {
      if (visualSettleRafIds.length > 0 || visualSettleTimeoutId !== null) return;
      const stickToBottom = isViewportAtBottom();
      const firstRafId = requestAnimationFrame(() => {
        visualSettleRafIds = visualSettleRafIds.filter((id) => id !== firstRafId);
        const secondRafId = requestAnimationFrame(() => {
          finishTerminalVisualSettle(stickToBottom);
        });
        visualSettleRafIds.push(secondRafId);
      });
      visualSettleRafIds.push(firstRafId);
      visualSettleTimeoutId = setTimeout(() => {
        finishTerminalVisualSettle(stickToBottom);
      }, 120);
    };
    let initialVisualSettlePending = true;
    const scheduleInitialTerminalVisualSettle = (force = false) => {
      if (!force && !initialVisualSettlePending) return;
      initialVisualSettlePending = false;
      scheduleTerminalVisualSettle();
    };

    const readFittedTerminalSize = () => {
      if (!disposed && entry.container?.isConnected) {
        fitAddon.fit();
      }
      return { cols: terminal.cols, rows: terminal.rows };
    };

    let initialPtyRepaintRequested = false;
    const requestInitialTerminalPtyRepaint = (): boolean => {
      if (initialPtyRepaintRequested) return true;
      if (disposed || !entry.container?.isConnected) return false;
      fitAddon.fit();
      const repaint = requestTerminalRepaint({
        api: activeApi,
        harness,
        threadId,
        cols: terminal.cols,
        rows: terminal.rows,
        readRestoreSize: readFittedTerminalSize,
      });
      if (!repaint.scheduled) return false;
      cancelInitialPtyRepaint = repaint.cancel;
      initialPtyRepaintRequested = true;
      return true;
    };

    const requestThreadSelectionPtyRepaint = (): boolean => {
      if (!terminalReady || disposed || !entry.container?.isConnected) return false;
      cancelThreadSelectionPtyRepaint?.();
      const repaint = requestTerminalRepaint({
        api: activeApi,
        harness,
        threadId,
        cols: terminal.cols,
        rows: terminal.rows,
        readRestoreSize: readFittedTerminalSize,
      });
      cancelThreadSelectionPtyRepaint = repaint.scheduled ? repaint.cancel : null;
      return repaint.scheduled;
    };

    let terminalPaintRefreshRafId: number | null = null;
    const scheduleTerminalPaintRefresh = () => {
      if (terminalPaintRefreshRafId !== null) return;
      terminalPaintRefreshRafId = requestAnimationFrame(() => {
        terminalPaintRefreshRafId = null;
        if (disposed || !entry.container?.isConnected) return;
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
        scheduleStickyPiInputMirrorRefresh();
      });
    };

    const scrollGuardedWrite = (data: string, onWriteComplete?: () => void) => {
      if (isAltBuffer()) {
        terminalWriteQueue.enqueue(data, () => {
          scheduleStickyPiInputMirrorRefresh();
          onWriteComplete?.();
        });
        return;
      }
      if (isViewportAtBottom()) {
        terminalWriteQueue.enqueue(data, () => {
          scheduleStickyPiInputMirrorRefresh();
          onWriteComplete?.();
        });
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
      terminalWriteQueue.enqueue(data, () => {
        if (!disposed && !isAltBuffer()) {
          const drift = Math.abs(terminal.buffer.active.viewportY - savedLine);
          if (drift > terminal.rows) {
            terminal.scrollToLine(savedLine);
          }
          scheduleStickyPiInputMirrorRefresh();
        }
        onWriteComplete?.();
      });
      if (!hasNewOutputFlag) {
        hasNewOutputFlag = true;
        setShowNewOutput(true);
      }
    };

    let queuedOutputData = "";
    let queuedOutputMaxOffset: number | null = null;
    let queuedOutputCompacted = false;
    let outputWriteRafId: number | null = null;
    let outputWriteTimeoutId: number | null = null;

    const recordOutputOffset = (offset: number | null) => {
      if (offset != null && (repaintOffsetBaselineInvalid || offset > entry.lastServerOffset)) {
        entry.lastServerOffset = offset;
        repaintOffsetBaselineInvalid = false;
      }
    };

    const flushQueuedOutputWrite = () => {
      if (outputWriteRafId !== null) {
        cancelAnimationFrame(outputWriteRafId);
        outputWriteRafId = null;
      }
      if (outputWriteTimeoutId !== null) {
        window.clearTimeout(outputWriteTimeoutId);
        outputWriteTimeoutId = null;
      }
      if (!queuedOutputData || disposed) return;

      const data = queuedOutputData;
      const offset = queuedOutputMaxOffset;
      const wasCompacted = queuedOutputCompacted;
      queuedOutputData = "";
      queuedOutputMaxOffset = null;
      queuedOutputCompacted = false;

      scrollGuardedWrite(data, () => {
        scheduleInitialTerminalVisualSettle(wasCompacted);
        scheduleTerminalPaintRefresh();
        if (wasCompacted) scheduleCatchUpRedraw();
        recordOutputOffset(offset);
      });
    };

    const scheduleOutputWriteFlush = () => {
      if (outputWriteRafId !== null || outputWriteTimeoutId !== null) return;
      if (document.visibilityState === "visible") {
        outputWriteRafId = requestAnimationFrame(() => {
          outputWriteRafId = null;
          flushQueuedOutputWrite();
        });
        return;
      }
      // Background tabs pause requestAnimationFrame. Keep parsing subscribed
      // output into the cached xterm at a low cadence so history and offsets
      // remain complete while the app is out of focus.
      outputWriteTimeoutId = window.setTimeout(() => {
        outputWriteTimeoutId = null;
        flushQueuedOutputWrite();
      }, 100);
    };

    const enqueueOutputWrite = (data: string, offset: number) => {
      if (!data) {
        recordOutputOffset(offset);
        return;
      }
      const next = appendCompactedTerminalOutput(queuedOutputData, data);
      queuedOutputData = next.data;
      queuedOutputCompacted = queuedOutputCompacted || next.compacted;
      queuedOutputMaxOffset = Math.max(queuedOutputMaxOffset ?? offset, offset);
      scheduleOutputWriteFlush();
    };

    const writeEvent = (event: HarnessSessionEvent) => {
      if (event.threadId !== threadId) return;
      switch (event.type) {
        case "output":
          enqueueOutputWrite(fenceFilterRef.current.process(event.data), event.offset);
          break;
        case "error":
          flushQueuedOutputWrite();
          scrollGuardedWrite(`\r\n[error] ${event.message}\r\n`);
          break;
        case "exited":
        case "started":
        case "hibernated":
        case "sessionId":
        case "hookStatus":
        case "activityStatus":
        case "hookNotification":
          // Handled by orchestration layer / EventRouter, not terminal view
          break;
      }
    };

    const bufferPreReadyEvent = (event: HarnessSessionEvent) => {
      if (event.type !== "output") {
        eventBuffer.push(event);
        return;
      }
      const next = appendCompactedTerminalOutput(preReadyOutputData, event.data);
      preReadyOutputData = next.data;
      preReadyOutputCompacted = preReadyOutputCompacted || next.compacted;
      preReadyOutputMaxOffset = Math.max(preReadyOutputMaxOffset ?? event.offset, event.offset);
    };

    const scheduleOpenTerminalGateRetry = () => {
      if (repaintGateRetryRafId !== null || repaintGateRetryCount >= MAX_REPAINT_GATE_RETRIES) {
        return;
      }
      repaintGateRetryCount += 1;
      repaintGateRetryRafId = requestAnimationFrame(() => {
        repaintGateRetryRafId = null;
        if (disposed || terminalReady || gateOpened) return;
        fitAddon.fit();
        openTerminalGate();
      });
    };

    /** Open the terminal gate once fit and offset catch-up are both ready. */
    const openTerminalGate = () => {
      if (!fitComplete || !catchUpReady || disposed || terminalReady || gateOpened) return;

      let syncedOffset = gateSyncedOffset ?? entry.lastServerOffset;
      const catchUp = pendingCatchUp;
      pendingCatchUp = null;
      if (catchUp) {
        // A reset response is authoritative for a restarted/trimmed server
        // buffer, even when its new offset is lower than the cached one.
        const replay = resolveScrollbackReplay({
          scrollback: catchUp.scrollback,
          resultOffset: catchUp.offset,
          reset: catchUp.reset,
          sinceOffset: catchUp.sinceOffset,
          lastServerOffset: catchUp.reset ? 0 : entry.lastServerOffset,
        });
        syncedOffset = replay.nextLastServerOffset;
        gateSyncedOffset = syncedOffset;
        if (catchUp.reset) {
          repaintOffsetBaselineInvalid = true;
          writeTerminalFullResetForReplay(queuedTerminalWriter, harness);
        } else {
          restoreTerminalInputModesForHarness(queuedTerminalWriter, harness);
        }

        const catchUpData = replay.scrollback
          ? fenceFilterRef.current.process(replay.scrollback)
          : "";
        if (catchUpData) {
          const offset = syncedOffset;
          scrollGuardedWrite(catchUpData, () => {
            recordOutputOffset(offset);
            restoreTerminalInputModesForHarness(queuedTerminalWriter, harness);
            scheduleInitialTerminalVisualSettle();
            scheduleTerminalPaintRefresh();
          });
        } else {
          recordOutputOffset(syncedOffset);
        }
      }

      // Force the harness TUI to repaint with a real SIGWINCH. A same-size
      // resize can be ignored by the PTY/TUI; a one-row nudge followed by the
      // fitted size mirrors the manual window resize that repairs stale screens.
      if (!requestInitialTerminalPtyRepaint()) {
        scheduleOpenTerminalGateRetry();
        return;
      }
      gateOpened = true;

      // Preserve the caught-up xterm buffer/scrollback on reattach. The PTY
      // repaint refreshes the live screen without throwing away history.
      restoreTerminalInputModesForHarness(queuedTerminalWriter, harness);
      // The cached offset may belong to an older server-side session. We keep
      // the stored value until fresh output arrives, then accept that first
      // repaint/live offset even if it is lower than the cached baseline.
      repaintOffsetBaselineInvalid = true;

      // Give the repaint command one animation frame + network round-trip to
      // start producing output before releasing buffered/live events. If no
      // output arrives in time, we still open so the terminal is interactive.
      repaintSettleTimeoutId = window.setTimeout(() => {
        repaintSettleTimeoutId = null;
        if (disposed || terminalReady) return;
        terminalReady = true;

        if (preReadyOutputData && preReadyOutputMaxOffset != null) {
          const bufferedEndOffset = preReadyOutputMaxOffset;
          const bufferedStartOffset = Math.max(0, bufferedEndOffset - preReadyOutputData.length);
          const replay = resolveScrollbackReplay({
            scrollback: preReadyOutputData,
            resultOffset: bufferedEndOffset,
            reset: false,
            sinceOffset: bufferedStartOffset,
            lastServerOffset: syncedOffset,
          });
          const data = replay.scrollback ? fenceFilterRef.current.process(replay.scrollback) : "";
          const offset = replay.nextLastServerOffset;
          const wasCompacted = preReadyOutputCompacted;
          preReadyOutputData = "";
          preReadyOutputMaxOffset = null;
          preReadyOutputCompacted = false;
          if (data) {
            scrollGuardedWrite(data, () => {
              recordOutputOffset(offset);
              scheduleInitialTerminalVisualSettle(wasCompacted);
              scheduleTerminalPaintRefresh();
              if (wasCompacted) scheduleCatchUpRedraw();
            });
          } else {
            recordOutputOffset(offset);
          }
        } else {
          preReadyOutputData = "";
          preReadyOutputMaxOffset = null;
          preReadyOutputCompacted = false;
        }

        for (const event of eventBuffer) {
          writeEvent(event);
        }
        eventBuffer.length = 0;

        scheduleInitialTerminalVisualSettle();
        scheduleStickyPiInputMirrorRefresh();
      }, REPAINT_SETTLE_MS);
    };

    const unsubscribe = subscribeHarnessSessionEvents(api, harness, (event) => {
      if (event.threadId !== threadId) return;
      if (!terminalReady) {
        bufferPreReadyEvent(event);
        return;
      }
      writeEvent(event);
    });

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        flushQueuedOutputWrite();
        return;
      }
      if (outputWriteRafId !== null) {
        cancelAnimationFrame(outputWriteRafId);
        outputWriteRafId = null;
      }
      scheduleOutputWriteFlush();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    // Subscribe first, then fetch exactly the server range missing from the
    // cached xterm. Live output received during the request stays behind the
    // gate and is de-duplicated against the returned offset.
    const sinceOffset = entry.lastServerOffset;
    void outputSubscription.ready.then(
      () => {
        if (disposed) return;
        void getHarnessScrollback(api, harness, { threadId, sinceOffset }).then(
          (result) => {
            if (disposed) return;
            pendingCatchUp = {
              scrollback: result.scrollback,
              offset: result.offset,
              reset: result.reset ?? false,
              sinceOffset,
            };
            catchUpReady = true;
            openTerminalGate();
          },
          () => {
            if (disposed) return;
            // Subscription is active, so current/future output is still safe.
            // Let the repaint recover the live frame if the catch-up RPC failed.
            catchUpReady = true;
            openTerminalGate();
          },
        );
      },
      () => {
        // Do not catch up/repaint unless the server acknowledged the output
        // subscription; fresh repaint bytes could otherwise be filtered out.
      },
    );

    // PTY bytes are stateful terminal commands, so live output must not overtake
    // either the catch-up response or the authoritative repaint.

    // Intercept macOS navigation shortcuts before the browser captures them
    terminal.attachCustomKeyEventHandler((event) => {
      // Cmd+F (Mac) / Ctrl+F (other) — open terminal search
      if (
        event.type === "keydown" &&
        event.key.toLowerCase() === "f" &&
        !event.altKey &&
        !event.shiftKey &&
        (isMacPlatform(navigator.platform)
          ? event.metaKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey)
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
        void writeHarnessData(api, harness, threadId, navigationData).catch(() => undefined);
        return false;
      }

      if (isTerminalClearShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        void writeHarnessData(api, harness, threadId, "\u000c").catch(() => undefined);
        return false;
      }

      // Shift+Enter / Option+Enter — send CSI 13;2u so harness TUIs
      // insert a newline instead of submitting. xterm.js onData sends \r
      // for all Enter variants, losing the modifier, so we intercept here.
      if (
        event.type === "keydown" &&
        event.key === "Enter" &&
        (event.shiftKey || event.altKey) &&
        !event.metaKey &&
        !event.ctrlKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        void writeHarnessData(api, harness, threadId, "\x1b[13;2u").catch(() => undefined);
        return false;
      }

      // Ctrl+Z — prevent browser "undo" so SIGTSTP (suspend) reaches the PTY.
      // On Mac Cmd+Z is the undo shortcut so Ctrl+Z is free; on other platforms
      // we still want it to go to the terminal when focused.
      if (
        event.type === "keydown" &&
        event.key === "z" &&
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        void writeHarnessData(api, harness, threadId, "\x1a").catch(() => undefined);
        return false;
      }

      // Ctrl+F on Mac — let it pass through to the PTY (Claude Code uses it
      // to kill background agents). Cmd+F already opens terminal search above.
      if (
        event.type === "keydown" &&
        event.key.toLowerCase() === "f" &&
        isMacPlatform(navigator.platform) &&
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        void writeHarnessData(api, harness, threadId, "\x06").catch(() => undefined);
        return false;
      }

      return true;
    });

    const onPaste = (event: ClipboardEvent) => {
      if (disposed) return;
      if (!clipboardItemsContainImageFile(event.clipboardData?.items)) return;
      if (harness === "claudeCode" && !(isElectron && isMacPlatform(navigator.platform))) return;

      event.preventDefault();
      event.stopPropagation();
      void writeHarnessData(api, harness, threadId, IMAGE_PASTE_KEYSTROKE).catch(() => undefined);
    };
    el.addEventListener("paste", onPaste, { capture: true });

    // Forward keystrokes to the server, filtering out terminal query
    // responses (OSC 11 background color, CPR cursor position) that
    // xterm.js generates internally — these would echo as garbage text.
    const inputDisposable = terminal.onData((data) => {
      const filtered = stripTerminalResponses(data);
      if (filtered) {
        void writeHarnessData(api, harness, threadId, filtered).catch(() => undefined);
      }
    });

    // Handle resize
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      void resizeHarnessSession(api, harness, threadId, cols, rows).catch(() => undefined);
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
      void resizeHarnessSession(api, harness, threadId, terminal.cols, terminal.rows).catch(
        () => undefined,
      );
      terminal.focus();
      // Signal that dimensions are now correct — safe to write content
      fitComplete = true;
      openTerminalGate();
      scheduleStickyPiInputMirrorRefresh();
    });

    // Watch for window resize — re-fit and repaint locally; xterm.js preserves
    // scroll position natively via isUserScrolling during dimension changes.
    const refitTerminal = () => {
      fitAddon.fit();
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
      openTerminalGate();
      scheduleStickyPiInputMirrorRefresh();
    };
    const onWindowResize = refitTerminal;
    window.addEventListener("resize", onWindowResize);

    // Re-fit, repaint locally, and nudge the PTY whenever the user explicitly
    // selects this thread from the sidebar. This mirrors the manual
    // window-resize recovery path for stale or stuck terminal frames.
    const onThreadSelected = (event: Event) => {
      if (!isThreadSelectedEventFor(event, threadId)) return;
      refitTerminal();
      requestThreadSelectionPtyRepaint();
    };
    window.addEventListener(THREAD_SELECTED_EVENT, onThreadSelected);

    let activationRecoveryPtyRepaintRequested = false;
    const cancelActivationRecovery = scheduleTerminalRecoveryPasses(() => {
      refitTerminal();
      if (!activationRecoveryPtyRepaintRequested && requestThreadSelectionPtyRepaint()) {
        activationRecoveryPtyRepaintRequested = true;
      }
    });

    // Keep the visible terminal fresh in the server-side LRU. Looking at a
    // quiet thread is still active use, even if it is not producing output.
    const activeViewTouchIntervalId = window.setInterval(() => {
      if (disposed || document.visibilityState !== "visible") return;
      void resizeHarnessSession(api, harness, threadId, terminal.cols, terminal.rows).catch(
        () => undefined,
      );
    }, 30_000);

    // ── Alternate-buffer scroll fallback: convert wheel → arrow keys ────
    // xterm has no scrollback in the alternate buffer, so when the TUI has not
    // enabled a wheel-capable mouse protocol we provide a reliable key fallback.
    // When mouse reporting is active, xterm must receive the wheel event so it
    // can encode the pointer coordinates for the TUI instead of editing input.
    let wheelPartialScroll = 0;
    let queuedWheelUpLines = 0;
    let queuedWheelDownLines = 0;
    let wheelFlushRafId: number | null = null;

    const resetQueuedAltBufferWheel = () => {
      wheelPartialScroll = 0;
      queuedWheelUpLines = 0;
      queuedWheelDownLines = 0;
      if (wheelFlushRafId !== null) {
        cancelAnimationFrame(wheelFlushRafId);
        wheelFlushRafId = null;
      }
    };

    const scheduleAltBufferWheelFlush = () => {
      if (wheelFlushRafId !== null) return;
      wheelFlushRafId = requestAnimationFrame(() => {
        wheelFlushRafId = null;
        flushAltBufferWheel();
      });
    };

    const enqueueAltBufferWheelSteps = (direction: "up" | "down", steps: number) => {
      if (steps <= 0) return;
      if (direction === "up") {
        const canceled = Math.min(queuedWheelDownLines, steps);
        queuedWheelDownLines -= canceled;
        queuedWheelUpLines += steps - canceled;
      } else {
        const canceled = Math.min(queuedWheelUpLines, steps);
        queuedWheelUpLines -= canceled;
        queuedWheelDownLines += steps - canceled;
      }
      if (queuedWheelUpLines > 0 || queuedWheelDownLines > 0) {
        scheduleAltBufferWheelFlush();
      }
    };

    function flushAltBufferWheel() {
      if (disposed) {
        resetQueuedAltBufferWheel();
        return;
      }
      if (
        !shouldConvertWheelToArrowKeys(
          terminal.buffer.active.type,
          terminal.modes.mouseTrackingMode,
        )
      ) {
        resetQueuedAltBufferWheel();
        return;
      }

      // Use SS3 prefix (ESC O) when application cursor keys is active,
      // otherwise CSI prefix (ESC [) — matches xterm.js's own fallback.
      const prefix = terminal.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[";
      let data = "";
      if (queuedWheelUpLines > 0) {
        const steps = Math.min(queuedWheelUpLines, ALT_BUFFER_WHEEL_MAX_STEPS_PER_FRAME);
        queuedWheelUpLines -= steps;
        data = (prefix + "A").repeat(steps); // A = up
      } else if (queuedWheelDownLines > 0) {
        const steps = Math.min(queuedWheelDownLines, ALT_BUFFER_WHEEL_MAX_STEPS_PER_FRAME);
        queuedWheelDownLines -= steps;
        data = (prefix + "B").repeat(steps); // B = down
      }

      if (data) {
        void writeHarnessData(activeApi, harness, threadId, data).catch(() => undefined);
      }
      if (queuedWheelUpLines > 0 || queuedWheelDownLines > 0) {
        scheduleAltBufferWheelFlush();
      }
    }

    const onAltBufferWheel = (ev: WheelEvent) => {
      if (disposed) return;
      if (
        !shouldConvertWheelToArrowKeys(
          terminal.buffer.active.type,
          terminal.modes.mouseTrackingMode,
        )
      ) {
        return;
      }
      // Shift+scroll = horizontal intent — don't convert to vertical arrows
      if (ev.shiftKey) return;
      let deltaY = ev.deltaY;
      if (deltaY === 0) return;

      ev.preventDefault();
      ev.stopPropagation();

      // Accumulate signed partial scrolls for trackpad precision (mirrors
      // xterm.js consumeWheelEvent scaling). Mouse wheel events have larger
      // deltaY (~100) while trackpad gestures send many small values (1-20).
      if (ev.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        // Firefox on some systems: deltaY is already in line units
        deltaY *= ALT_BUFFER_WHEEL_DELTA_LINE_PIXELS;
      } else if (ev.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        deltaY *= terminal.rows * ALT_BUFFER_WHEEL_DELTA_LINE_PIXELS;
      }
      const accumulated = wheelPartialScroll + deltaY / ALT_BUFFER_WHEEL_PIXELS_PER_LINE;
      const wholeLines = accumulated > 0 ? Math.floor(accumulated) : Math.ceil(accumulated);
      wheelPartialScroll = accumulated - wholeLines;
      if (wholeLines === 0) return;

      enqueueAltBufferWheelSteps(wholeLines < 0 ? "up" : "down", Math.abs(wholeLines));
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
        openTerminalGate();
        scheduleStickyPiInputMirrorRefresh();
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
      scheduleStickyPiInputMirrorRefresh();
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
      const pendingMarkdownOutput = fenceFilterRef.current.flush();
      if (pendingMarkdownOutput) terminalWriteQueue.enqueue(pendingMarkdownOutput);
      disposed = true;
      searchAddonRef.current = null;
      cancelAnimationFrame(initialFitRafId);
      if (outputWriteRafId !== null) cancelAnimationFrame(outputWriteRafId);
      if (outputWriteTimeoutId !== null) window.clearTimeout(outputWriteTimeoutId);
      if (catchUpRedrawRafId !== null) cancelAnimationFrame(catchUpRedrawRafId);
      if (terminalPaintRefreshRafId !== null) cancelAnimationFrame(terminalPaintRefreshRafId);
      if (repaintGateRetryRafId !== null) cancelAnimationFrame(repaintGateRetryRafId);
      for (const rafId of visualSettleRafIds) cancelAnimationFrame(rafId);
      visualSettleRafIds = [];
      if (visualSettleTimeoutId !== null) clearTimeout(visualSettleTimeoutId);
      if (repaintSettleTimeoutId !== null) clearTimeout(repaintSettleTimeoutId);
      cancelInitialPtyRepaint?.();
      cancelThreadSelectionPtyRepaint?.();
      cancelActivationRecovery();
      terminalWriteQueue.dispose();
      queuedOutputData = "";
      queuedOutputMaxOffset = null;
      queuedOutputCompacted = false;
      preReadyOutputData = "";
      preReadyOutputMaxOffset = null;
      preReadyOutputCompacted = false;
      if (resizeRafId !== null) cancelAnimationFrame(resizeRafId);
      if (stickyMirrorRafId !== null) cancelAnimationFrame(stickyMirrorRafId);
      resetQueuedAltBufferWheel();
      window.clearInterval(activeViewTouchIntervalId);
      el.removeEventListener("paste", onPaste, { capture: true });
      el.removeEventListener("wheel", onAltBufferWheel, { capture: true });
      el.removeEventListener("wheel", onWheelClearIndicator);
      window.removeEventListener("resize", onWindowResize);
      window.removeEventListener(THREAD_SELECTED_EVENT, onThreadSelected);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      unsubscribe();
      inputDisposable.dispose();
      resizeDisposable.dispose();
      scrollDisposable.dispose();
      outputSubscription.unsubscribe();
      // Detach but keep in cache for instant reattachment
      claudeCache.detach(threadId);
    };
    // Keep the active xterm mounted across hook/status/sidebar updates.
    // Re-running this effect detaches the focused terminal DOM and can hand
    // focus back to the sidebar row while the user is typing.
  }, [harness, settings.stickyPiInputMirror, threadId]);

  const handleSearchClose = useCallback(() => {
    setSearchOpen(false);
    // Re-focus the terminal after closing the search bar
    const cached = claudeCache.get(threadId);
    if (cached) cached.terminal.focus();
  }, [threadId]);

  useEffect(() => {
    if (harness === "pi" && settings.stickyPiInputMirror) return;
    stickyPiInputMirrorRef.current = null;
    setStickyPiInputMirror(null);
  }, [harness, settings.stickyPiInputMirror]);

  const handleScrollToBottom = useCallback(() => {
    setShowNewOutput(false);
    const cached = claudeCache.get(threadId);
    if (cached) {
      cached.terminal.scrollToBottom();
      cached.terminal.focus();
    }
  }, [threadId]);

  const handleStickyPiInputMirrorClick = useCallback(() => {
    const cached = claudeCache.get(threadId);
    if (cached) {
      cached.terminal.focus();
    }
  }, [threadId]);

  const handleStickyPiInputMirrorWheel = useCallback(
    (event: React.WheelEvent<HTMLButtonElement>) => {
      const cached = claudeCache.get(threadId);
      if (!cached) return;

      event.preventDefault();

      let lineDelta = event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
        lineDelta /= 40;
      } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        lineDelta *= cached.terminal.rows;
      }

      const accumulatedDelta = stickyPiInputMirrorWheelRemainderRef.current + lineDelta;
      const wholeLines =
        accumulatedDelta > 0 ? Math.floor(accumulatedDelta) : Math.ceil(accumulatedDelta);
      stickyPiInputMirrorWheelRemainderRef.current = accumulatedDelta - wholeLines;

      if (wholeLines !== 0) {
        cached.terminal.scrollLines(wholeLines);
      }
    },
    [threadId],
  );

  const terminalTheme = terminalThemeFromApp();

  return (
    <div className="relative h-full w-full">
      {searchOpen && searchAddonRef.current && (
        <TerminalSearchBar searchAddon={searchAddonRef.current} onClose={handleSearchClose} />
      )}
      <div ref={containerRef} className="h-full w-full" />
      {stickyPiInputMirror && harness === "pi" && settings.stickyPiInputMirror && (
        <button
          type="button"
          onClick={handleStickyPiInputMirrorClick}
          onWheel={handleStickyPiInputMirrorWheel}
          className="absolute inset-x-0 bottom-0 z-20 block overflow-hidden border-0 bg-background p-0 text-left text-foreground shadow-none outline-none"
          aria-label="Jump to live pi input"
          title="Jump to live pi input"
          style={{
            backgroundColor: terminalTheme.background,
            color: terminalTheme.foreground,
            fontFamily: settings.terminalFontFamily,
            fontSize: `${settings.terminalFontSize}px`,
            lineHeight: PI_TERMINAL_LINE_HEIGHT,
          }}
        >
          <div className="m-0 overflow-hidden whitespace-pre px-0 py-0">
            {stickyPiInputMirror.lines.map((line, lineIndex) => (
              <div key={`sticky-pi-input-line-${lineIndex}`}>
                {line.segments.map((segment, segmentIndex) => (
                  <span
                    key={`sticky-pi-input-line-${lineIndex}-segment-${segmentIndex}`}
                    style={segment.style}
                  >
                    {segment.text}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </button>
      )}
      {showNewOutput && !stickyPiInputMirror && (
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

export default function ThreadTerminalView({ threadId }: { threadId: ThreadId }) {
  const thread = useStore((s) => s.threads.find((t) => t.id === threadId));
  const setThreadPiRenderMode = useStore((s) => s.setThreadPiRenderMode);
  const localPiRenderMode = useTerminalStateStore(
    (s) =>
      selectThreadTerminalState(s.terminalStateByThreadId, threadId).piRenderMode ?? "terminal",
  );

  useEffect(() => {
    if (!thread || thread.harness !== "pi") return;
    if (thread.piRenderMode === "html" || localPiRenderMode !== "html") return;
    const api = readNativeApi();
    setThreadPiRenderMode(threadId, "html");
    if (!api) return;
    void api.orchestration.dispatchCommand({
      type: "thread.meta.update",
      commandId: newCommandId(),
      threadId,
      piRenderMode: "html",
    });
  }, [localPiRenderMode, setThreadPiRenderMode, thread, threadId]);

  if (!thread) return null;

  const piRenderMode =
    thread.piRenderMode === "html" || localPiRenderMode === "html" ? "html" : "terminal";
  const usePiHtml = thread.harness === "pi" && piRenderMode === "html";

  switch (thread.terminalStatus) {
    case "active":
      return usePiHtml ? (
        <PiHtmlThreadView threadId={threadId} showComposer />
      ) : (
        <ActiveTerminalView threadId={threadId} thread={thread} />
      );
    case "dormant":
      return usePiHtml ? (
        <DormantPiHtmlView threadId={threadId} thread={thread} />
      ) : (
        <DormantTerminalView threadId={threadId} thread={thread} />
      );
    case "new":
    default:
      return <NewThreadView threadId={threadId} thread={thread} />;
  }
}
