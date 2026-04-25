import {
  ArchiveIcon,
  ArrowLeftIcon,
  BookmarkIcon,
  ChevronRightIcon,
  DownloadIcon,
  XIcon,
  FolderIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  GripVerticalIcon,
  PlusIcon,
  RocketIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import * as claudeCache from "../lib/claudeTerminalCache";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  type DragCancelEvent,
  type CollisionDetection,
  PointerSensor,
  type DragStartEvent,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type DesktopUpdateState,
  ProjectId,
  ThreadId,
  type GitStatusResult,
  type ResolvedKeybindingsConfig,
} from "@clui/contracts";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useAppSettings } from "../appSettings";
import { isElectron } from "../env";
import { APP_STAGE_LABEL } from "../branding";
import { cn, isMacPlatform, newCommandId, newProjectId, newThreadId } from "../lib/utils";
import { useStore } from "../store";
import { isChatNewLocalShortcut, isChatNewShortcut, shortcutLabelForCommand } from "../keybindings";
import { projectTerminalThreadId, type Project, type Thread } from "../types";
import { derivePendingApprovals, derivePendingUserInputs } from "../session-logic";
import { getGlobalSessionEventState } from "../lib/sessionEventState";
import { gitRemoveWorktreeMutationOptions, gitStatusQueryOptions } from "../lib/gitReactQuery";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { toastManager } from "./ui/toast";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldOpenReleasesPage,
  shouldShowDesktopUpdateBanner,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent } from "./ui/collapsible";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenuAction,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
  SidebarTrigger,
} from "./ui/sidebar";
import { PurgeSessionsButton } from "./PurgeSessionsButton";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import {
  type ThreadPr,
  formatBranchForDisplay,
  formatRelativeTime,
  terminalStatusFromRunningIds,
  prStatusIndicator,
} from "../lib/threadStatus";
import { isNonEmpty as isNonEmptyString } from "effect/String";
import { getTopThreadForProject, orderThreadsForProject } from "../lib/threadOrdering";
import {
  createThreadAndNavigate,
  resolveThreadStatusPill,
  shouldClearThreadSelectionOnMouseDown,
} from "./Sidebar.logic";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const THREAD_PREVIEW_LIMIT = 6;

async function copyTextToClipboard(text: string): Promise<void> {
  // Try modern Clipboard API first, fall back to execCommand for cases where
  // the browser's transient user activation has expired (e.g. after native
  // context menu interactions in Electron).
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Permission denied — fall through to legacy fallback.
    }
  }
  if (typeof document === "undefined") {
    throw new Error("Clipboard API unavailable.");
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("execCommand('copy') returned false.");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}

function CluiWordmark() {
  return (
    <span
      aria-label="Clui"
      className="shrink-0 text-sm font-semibold tracking-tight text-foreground"
    >
      Clui
    </span>
  );
}

/**
 * Derives the server's HTTP origin (scheme + host + port) from the same
 * sources WsTransport uses, converting ws(s) to http(s).
 */
function getServerHttpOrigin(): string {
  const bridgeUrl = window.desktopBridge?.getWsUrl();
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsUrl =
    bridgeUrl && bridgeUrl.length > 0
      ? bridgeUrl
      : envUrl && envUrl.length > 0
        ? envUrl
        : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:${window.location.port}`;
  // Parse to extract just the origin, dropping path/query (e.g. ?token=…)
  const httpUrl = wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  try {
    return new URL(httpUrl).origin;
  } catch {
    return httpUrl;
  }
}

const serverHttpOrigin = getServerHttpOrigin();

function ProjectFavicon({ cwd }: { cwd: string }) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");

  const src = `${serverHttpOrigin}/api/project-favicon?cwd=${encodeURIComponent(cwd)}`;

  if (status === "error") {
    return <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/50" />;
  }

  return (
    <img
      src={src}
      alt=""
      className={`size-3.5 shrink-0 rounded-sm object-contain ${status === "loading" ? "hidden" : ""}`}
      onLoad={() => setStatus("loaded")}
      onError={() => setStatus("error")}
    />
  );
}

const PROJECT_SORTABLE_ID_PREFIX = "project:";
const THREAD_SORTABLE_ID_PREFIX = "thread:";

function projectSortableId(projectId: ProjectId): string {
  return `${PROJECT_SORTABLE_ID_PREFIX}${projectId}`;
}

function threadSortableId(threadId: ThreadId): string {
  return `${THREAD_SORTABLE_ID_PREFIX}${threadId}`;
}

type SidebarDragData =
  | {
      kind: "project";
      projectId: ProjectId;
      label: string;
    }
  | {
      kind: "thread";
      projectId: ProjectId;
      threadId: ThreadId;
      label: string;
      harness: string;
    };

type SidebarDragOverlaySize = {
  width: number;
  height: number;
};

type SortableProjectHandleProps = Pick<ReturnType<typeof useSortable>, "attributes" | "listeners">;
type SortableThreadHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

function SortableProjectItem({
  project,
  children,
}: {
  project: Project;
  children: (handleProps: SortableProjectHandleProps) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: projectSortableId(project.id),
    data: {
      kind: "project",
      projectId: project.id,
      label: project.name,
    } satisfies SidebarDragData,
  });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={`group/menu-item relative rounded-md ${isDragging ? "z-20 opacity-65" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners })}
    </li>
  );
}

function SortableThreadItem({
  thread,
  children,
}: {
  thread: Thread;
  children: (handleProps: SortableThreadHandleProps) => React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: threadSortableId(thread.id),
    data: {
      kind: "thread",
      projectId: thread.projectId,
      threadId: thread.id,
      label: thread.title,
      harness: thread.harness,
    } satisfies SidebarDragData,
  });

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={`group/menu-sub-item relative -ml-4 w-[calc(100%+1rem)] rounded-lg ${
        isDragging ? "z-30 invisible" : ""
      }`}
      data-sidebar="menu-sub-item"
      data-slot="sidebar-menu-sub-item"
      data-thread-item
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}

function getSidebarThreadRowClassName({
  isActive,
  isSelected,
  isArchived,
  interactive,
}: {
  isActive: boolean;
  isSelected: boolean;
  isArchived: boolean;
  interactive: boolean;
}) {
  return cn(
    "group/thread h-7 w-full translate-x-0 cursor-default justify-start px-2 text-left select-none focus-visible:ring-0",
    interactive && "hover:bg-accent hover:text-foreground",
    isSelected
      ? "bg-primary/15 text-foreground dark:bg-primary/10"
      : isActive
        ? "bg-accent/85 text-foreground font-medium dark:bg-accent/55"
        : isArchived
          ? "text-muted-foreground/70 opacity-80"
          : "text-muted-foreground",
  );
}

function SidebarThreadDragHandle({
  ariaLabel,
  handleProps,
  disabled = false,
}: {
  ariaLabel?: string;
  handleProps?: SortableThreadHandleProps;
  disabled?: boolean;
}) {
  if (!handleProps) {
    return (
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-0 z-10 inline-flex size-4 -translate-y-1/2 items-center justify-center text-muted-foreground/60"
      >
        <GripVerticalIcon className="size-3" />
      </div>
    );
  }

  return (
    <button
      ref={handleProps.setActivatorNodeRef}
      type="button"
      aria-label={ariaLabel}
      className={cn(
        "absolute top-1/2 left-0 z-10 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/40 transition-[opacity,color] hover:text-foreground/80 focus-visible:text-foreground/80 focus-visible:outline-none cursor-grab active:cursor-grabbing",
        disabled
          ? "pointer-events-none opacity-0"
          : "opacity-0 group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:opacity-100",
      )}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      {...handleProps.attributes}
      {...handleProps.listeners}
    >
      <GripVerticalIcon className="size-3" />
    </button>
  );
}

function SidebarThreadRowBody({
  thread,
  isHighlighted,
  threadStatus,
  prStatus,
  terminalStatus,
}: {
  thread: Thread;
  isHighlighted: boolean;
  threadStatus: ReturnType<typeof resolveThreadStatusPill> | null;
  prStatus: ReturnType<typeof prStatusIndicator>;
  terminalStatus: ReturnType<typeof terminalStatusFromRunningIds> | null;
}) {
  return (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        {prStatus && (
          <span
            aria-hidden="true"
            className={`inline-flex items-center justify-center ${prStatus.colorClass}`}
          >
            <GitPullRequestIcon className="size-3" />
          </span>
        )}
        {threadStatus && (
          <span
            role="status"
            aria-label={threadStatus.label}
            className={`inline-flex items-center gap-1 text-[10px] ${threadStatus.colorClass}`}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${threadStatus.dotClass} ${threadStatus.pulse ? "animate-pulse" : ""}`}
            />
            <span className="hidden md:inline">{threadStatus.label}</span>
          </span>
        )}
        {thread.archivedAt && (
          <ArchiveIcon className="size-3 shrink-0 text-muted-foreground/55" />
        )}
        {thread.bookmarked && (
          <BookmarkIcon className="size-3 shrink-0 fill-amber-400 text-amber-500 dark:fill-amber-300/80 dark:text-amber-400/80" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs">{thread.title}</span>
      </div>
      <div className="relative ml-auto flex shrink-0 items-center gap-1.5">
        {terminalStatus && (
          <span
            role="img"
            aria-label={terminalStatus.label}
            title={terminalStatus.label}
            className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
          >
            <TerminalIcon className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`} />
          </span>
        )}
        <span
          className={`text-[10px] ${
            isHighlighted ? "text-foreground/65" : "text-muted-foreground/40"
          }`}
        >
          {formatRelativeTime(thread.updatedAt)}
        </span>
      </div>
    </>
  );
}

function SidebarDragOverlayPreview({
  item,
  size,
  thread,
  isActive = false,
  isSelected = false,
  threadStatus = null,
  pr = null,
  terminalStatus = null,
}: {
  item: SidebarDragData;
  size: SidebarDragOverlaySize | null;
  thread?: Thread | null;
  isActive?: boolean;
  isSelected?: boolean;
  threadStatus?: ReturnType<typeof resolveThreadStatusPill> | null;
  pr?: ThreadPr | null;
  terminalStatus?: ReturnType<typeof terminalStatusFromRunningIds> | null;
}) {
  if (item.kind === "project") {
    return (
      <div className="flex min-w-[220px] items-center gap-2 rounded-lg border border-border/70 bg-popover/95 px-3 py-2 text-xs font-medium text-popover-foreground shadow-2xl backdrop-blur-md">
        <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{item.label}</span>
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="flex min-w-[240px] items-center gap-2 rounded-lg border border-border/70 bg-popover/95 px-3 py-2 text-xs text-popover-foreground shadow-2xl backdrop-blur-md">
        <GripVerticalIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{item.label}</div>
          <div className="truncate text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
            {item.harness === "claudeCode" ? "Claude Code" : "Pi"}
          </div>
        </div>
      </div>
    );
  }

  const isHighlighted = isActive || isSelected;
  const prStatus = prStatusIndicator(pr);

  return (
    <div
      className={cn("relative box-border pl-4", size ? undefined : "w-[240px]")}
      style={size ? { width: size.width } : undefined}
    >
      <SidebarThreadDragHandle />
      <SidebarMenuSubButton
        render={<div role="presentation" />}
        size="sm"
        isActive={isActive}
        className={cn(
          getSidebarThreadRowClassName({
            isActive,
            isSelected,
            isArchived: thread.archivedAt !== null,
            interactive: false,
          }),
          "pointer-events-none shadow-2xl",
        )}
        style={size ? { height: size.height } : undefined}
      >
        <SidebarThreadRowBody
          thread={thread}
          isHighlighted={isHighlighted}
          threadStatus={threadStatus}
          prStatus={prStatus}
          terminalStatus={terminalStatus}
        />
      </SidebarMenuSubButton>
    </div>
  );
}

export default function Sidebar({ onSearchClick }: { onSearchClick?: () => void }) {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const markThreadUnread = useStore((store) => store.markThreadUnread);
  const toggleProject = useStore((store) => store.toggleProject);
  const reorderProjects = useStore((store) => store.reorderProjects);
  const reorderThreadsInProject = useStore((store) => store.reorderThreadsInProject);
  const threadOrderByProject = useStore((store) => store.threadOrderByProject);
  const getDraftThread = useCallback(
    (
      _threadId: ThreadId,
    ): {
      projectId: ProjectId;
      branch: string | null;
      worktreePath: string | null;
      envMode: string;
    } | null => null,
    [],
  );
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const storeSetTerminalOpen = useTerminalStateStore((state) => state.setProjectTerminalOpen);
  const clearProjectDraftThreadId = useCallback((_projectId: ProjectId) => {}, []);
  const clearProjectDraftThreadById = useCallback(
    (_projectId: ProjectId, _threadId: ThreadId) => {},
    [],
  );
  const setThreadArchived = useStore((store) => store.setThreadArchived);
  const navigate = useNavigate();
  const isOnSettings = useLocation({ select: (loc) => loc.pathname === "/settings" });
  const { settings: appSettings } = useAppSettings();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const { data: keybindings = EMPTY_KEYBINDINGS } = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.keybindings,
  });
  const queryClient = useQueryClient();
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const addProjectInputRef = useRef<HTMLInputElement | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<ProjectId>
  >(() => new Set());
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const startRenameThread = useCallback((thread: Thread) => {
    setRenamingThreadId(thread.id);
    setRenamingTitle(thread.title);
    renamingCommittedRef.current = false;
  }, []);
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const suppressThreadClickAfterDragRef = useRef(false);
  const [activeDragItem, setActiveDragItem] = useState<SidebarDragData | null>(null);
  const [activeDragOverlaySize, setActiveDragOverlaySize] = useState<SidebarDragOverlaySize | null>(null);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false);
  const [showArchivedThreads, setShowArchivedThreads] = useState(false);
  const selectedThreadIds = useThreadSelectionStore((s) => s.selectedThreadIds);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const shouldBrowseForProjectImmediately = isElectron;
  const shouldShowProjectPathEntry = addingProject && !shouldBrowseForProjectImmediately;
  const pendingApprovalByThreadId = useMemo(() => {
    const map = new Map<ThreadId, boolean>();
    for (const thread of threads) {
      map.set(thread.id, derivePendingApprovals(thread.activities).length > 0);
    }
    return map;
  }, [threads]);
  const pendingUserInputByThreadId = useMemo(() => {
    const map = new Map<ThreadId, boolean>();
    for (const thread of threads) {
      map.set(thread.id, derivePendingUserInputs(thread.activities).length > 0);
    }
    return map;
  }, [threads]);
  const visibleSidebarThreads = useMemo(
    () =>
      showArchivedThreads
        ? threads
        : threads.filter((thread) => thread.archivedAt === null),
    [showArchivedThreads, threads],
  );
  const projectCwdById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.cwd] as const)),
    [projects],
  );
  const threadGitTargets = useMemo(
    () =>
      threads.map((thread) => ({
        threadId: thread.id,
        branch: thread.branch,
        cwd: thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null,
      })),
    [projectCwdById, threads],
  );
  const threadGitStatusCwds = useMemo(
    () => [
      ...new Set(
        threadGitTargets
          .filter((target) => target.branch !== null)
          .map((target) => target.cwd)
          .filter((cwd): cwd is string => cwd !== null),
      ),
    ],
    [threadGitTargets],
  );
  const threadGitStatusQueries = useQueries({
    queries: threadGitStatusCwds.map((cwd) => ({
      ...gitStatusQueryOptions(cwd),
      staleTime: 30_000,
      refetchInterval: 60_000,
    })),
  });
  const prByThreadId = useMemo(() => {
    const statusByCwd = new Map<string, GitStatusResult>();
    for (let index = 0; index < threadGitStatusCwds.length; index += 1) {
      const cwd = threadGitStatusCwds[index];
      if (!cwd) continue;
      const status = threadGitStatusQueries[index]?.data;
      if (status) {
        statusByCwd.set(cwd, status);
      }
    }

    const map = new Map<ThreadId, ThreadPr>();
    for (const target of threadGitTargets) {
      const status = target.cwd ? statusByCwd.get(target.cwd) : undefined;
      const branchMatches =
        target.branch !== null && status?.branch !== null && status?.branch === target.branch;
      map.set(target.threadId, branchMatches ? (status?.pr ?? null) : null);
    }
    return map;
  }, [threadGitStatusCwds, threadGitStatusQueries, threadGitTargets]);

  const activeDragThread = useMemo(() => {
    if (activeDragItem?.kind !== "thread") {
      return null;
    }
    return threads.find((thread) => thread.id === activeDragItem.threadId) ?? null;
  }, [activeDragItem, threads]);
  const activeDragThreadStatus = useMemo(() => {
    if (!activeDragThread) {
      return null;
    }
    return resolveThreadStatusPill({
      thread: activeDragThread,
      hasPendingApprovals: pendingApprovalByThreadId.get(activeDragThread.id) === true,
      hasPendingUserInput: pendingUserInputByThreadId.get(activeDragThread.id) === true,
    });
  }, [activeDragThread, pendingApprovalByThreadId, pendingUserInputByThreadId]);
  const activeDragThreadTerminalStatus = useMemo(() => {
    if (!activeDragThread) {
      return null;
    }
    return terminalStatusFromRunningIds(
      selectThreadTerminalState(terminalStateByThreadId, activeDragThread.id).runningTerminalIds,
    );
  }, [activeDragThread, terminalStateByThreadId]);

  const openPrLink = useCallback((event: React.MouseEvent<HTMLElement>, prUrl: string) => {
    event.preventDefault();
    event.stopPropagation();

    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
      });
      return;
    }

    void api.shell.openExternal(prUrl).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to open PR link",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, []);

  const addOptimisticThread = useStore((store) => store.addOptimisticThread);
  const handleNewThread = useCallback(
    async (
      projectId: ProjectId,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
      },
    ): Promise<void> => {
      const api = readNativeApi();
      if (!api) return;

      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const branch = options?.branch ?? null;
      const worktreePath = options?.worktreePath ?? null;
      const harness = appSettings.defaultCodingHarness;
      const project = useStore.getState().projects.find((entry) => entry.id === projectId);
      const model =
        project?.model ??
        (harness === "claudeCode"
          ? DEFAULT_MODEL_BY_PROVIDER.claudeCode
          : DEFAULT_MODEL_BY_PROVIDER.codex);

      await createThreadAndNavigate({
        api,
        navigate,
        addOptimisticThread,
        commandId: newCommandId(),
        threadId,
        projectId,
        model,
        harness,
        createdAt,
        branch,
        worktreePath,
      });
    },
    [appSettings.defaultCodingHarness, navigate, addOptimisticThread],
  );

  const getTopUnarchivedThreadForProject = useCallback(
    (projectId: ProjectId, excludedThreadId?: ThreadId) =>
      getTopThreadForProject(
        threads.filter(
          (thread) =>
            thread.projectId === projectId &&
            thread.archivedAt === null &&
            thread.id !== excludedThreadId,
        ),
        threadOrderByProject[projectId],
      ),
    [threadOrderByProject, threads],
  );

  const focusMostRecentThreadForProject = useCallback(
    (projectId: ProjectId) => {
      const { threads: currentThreads, threadOrderByProject: currentThreadOrderByProject } =
        useStore.getState();
      const latestThread = getTopThreadForProject(
        currentThreads.filter((thread) => thread.projectId === projectId),
        currentThreadOrderByProject[projectId],
      );
      if (!latestThread) return;

      void navigate({
        to: "/$threadId",
        params: { threadId: latestThread.id },
      });
    },
    [navigate],
  );

  const addProjectFromPath = useCallback(
    async (rawCwd: string) => {
      const cwd = rawCwd.trim();
      if (!cwd || isAddingProject) return;
      const api = readNativeApi();
      if (!api) return;

      const refreshSnapshot = async () => {
        const snapshot = await api.orchestration.getSnapshot();
        useStore.getState().syncServerReadModel(snapshot);
        return snapshot;
      };

      setIsAddingProject(true);
      const finishAddingProject = () => {
        setIsAddingProject(false);
        setNewCwd("");
        setAddProjectError(null);
        setAddingProject(false);
      };

      const existing = projects.find((project) => project.cwd === cwd);
      if (existing) {
        focusMostRecentThreadForProject(existing.id);
        finishAddingProject();
        return;
      }

      try {
        const snapshot = await api.orchestration.getSnapshot();
        const matchingProject = snapshot.projects.find(
          (project) => project.workspaceRoot === cwd && project.deletedAt === null,
        );

        if (matchingProject) {
          if ((matchingProject.hiddenAt ?? null) !== null) {
            await api.orchestration.dispatchCommand({
              type: "project.meta.update",
              commandId: newCommandId(),
              projectId: matchingProject.id,
              hiddenAt: null,
            });

            const refreshedSnapshot = await refreshSnapshot().catch(() => null);
            const existingThreads = (refreshedSnapshot ?? snapshot).threads.filter(
              (thread) => thread.projectId === matchingProject.id && thread.deletedAt === null,
            );
            if (existingThreads.length > 0) {
              focusMostRecentThreadForProject(matchingProject.id);
              finishAddingProject();
              return;
            }

            await handleNewThread(matchingProject.id);
            finishAddingProject();
            return;
          }

          focusMostRecentThreadForProject(matchingProject.id);
          finishAddingProject();
          return;
        }
      } catch {
        // Fall through to create mode. The project.create dispatch below remains authoritative.
      }

      const projectId = newProjectId();
      const createdAt = new Date().toISOString();
      const title = cwd.split(/[/\\]/).findLast(isNonEmptyString) ?? cwd;
      try {
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title,
          workspaceRoot: cwd,
          defaultModel: DEFAULT_MODEL_BY_PROVIDER.codex,
          createdAt,
        });
        await refreshSnapshot().catch(() => null);
      } catch (error) {
        const description =
          error instanceof Error ? error.message : "An error occurred while adding the project.";
        setIsAddingProject(false);
        if (shouldBrowseForProjectImmediately) {
          toastManager.add({
            type: "error",
            title: "Failed to add project",
            description,
          });
        } else {
          setAddProjectError(description);
        }
        return;
      }

      try {
        await handleNewThread(projectId);
      } catch (error) {
        finishAddingProject();
        toastManager.add({
          type: "error",
          title: "Project added, but the first thread could not be created",
          description:
            error instanceof Error ? error.message : "Create a thread manually and try again.",
        });
        return;
      }

      finishAddingProject();
    },
    [
      focusMostRecentThreadForProject,
      handleNewThread,
      isAddingProject,
      projects,
      shouldBrowseForProjectImmediately,
    ],
  );

  const handleAddProject = () => {
    void addProjectFromPath(newCwd);
  };

  const canAddProject = newCwd.trim().length > 0 && !isAddingProject;

  const handlePickFolder = async () => {
    const api = readNativeApi();
    if (!api || isPickingFolder) return;
    setIsPickingFolder(true);
    let pickedPath: string | null = null;
    try {
      pickedPath = await api.dialogs.pickFolder();
    } catch {
      // Ignore picker failures and leave the current thread selection unchanged.
    }
    if (pickedPath) {
      await addProjectFromPath(pickedPath);
    } else if (!shouldBrowseForProjectImmediately) {
      addProjectInputRef.current?.focus();
    }
    setIsPickingFolder(false);
  };

  const handleStartAddProject = () => {
    setAddProjectError(null);
    if (shouldBrowseForProjectImmediately) {
      void handlePickFolder();
      return;
    }
    setAddingProject((prev) => !prev);
  };

  const cancelRename = useCallback(() => {
    setRenamingThreadId(null);
    renamingInputRef.current = null;
  }, []);

  const commitRename = useCallback(
    async (threadId: ThreadId, newTitle: string, originalTitle: string) => {
      const finishRename = () => {
        setRenamingThreadId((current) => {
          if (current !== threadId) return current;
          renamingInputRef.current = null;
          return null;
        });
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }
      const api = readNativeApi();
      if (!api) {
        finishRename();
        return;
      }
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId,
          title: trimmed,
          titleSource: "manual",
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      finishRename();
    },
    [],
  );

  /**
   * Delete a single thread: stop session, close terminal, dispatch delete,
   * clean up drafts/state, and optionally remove orphaned worktree.
   * Callers handle thread-level confirmation; this still prompts for worktree removal.
   */
  const deleteThread = useCallback(
    async (
      threadId: ThreadId,
      opts: { deletedThreadIds?: ReadonlySet<ThreadId> } = {},
    ): Promise<void> => {
      const api = readNativeApi();
      if (!api) return;
      const thread = threads.find((t) => t.id === threadId);
      if (!thread) return;

      const threadProject = projects.find((project) => project.id === thread.projectId);
      // When bulk-deleting, exclude the other threads being deleted so
      // getOrphanedWorktreePathForThread correctly detects that no surviving
      // threads will reference this worktree.
      const deletedIds = opts.deletedThreadIds;
      const survivingThreads =
        deletedIds && deletedIds.size > 0
          ? threads.filter((t) => t.id === threadId || !deletedIds.has(t.id))
          : threads;
      const orphanedWorktreePath = getOrphanedWorktreePathForThread(survivingThreads, threadId);
      const displayWorktreePath = orphanedWorktreePath
        ? formatWorktreePathForDisplay(orphanedWorktreePath)
        : null;
      const canDeleteWorktree = orphanedWorktreePath !== null && threadProject !== undefined;
      const shouldDeleteWorktree =
        canDeleteWorktree &&
        (await api.dialogs.confirm(
          [
            "This thread is the only one linked to this worktree:",
            displayWorktreePath ?? orphanedWorktreePath,
            "",
            "Delete the worktree too?",
          ].join("\n"),
        ));

      if (thread.session && thread.session.status !== "closed") {
        await api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }

      try {
        await api.terminal.close({ threadId, deleteHistory: true });
      } catch {
        // Terminal may already be closed
      }

      const allDeletedIds = deletedIds ?? new Set<ThreadId>();
      const shouldNavigateToFallback = routeThreadId === threadId;
      const fallbackThreadId =
        threads.find((entry) => entry.id !== threadId && !allDeletedIds.has(entry.id))?.id ?? null;
      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId,
      });
      // Optimistically remove from sidebar immediately — the domain event
      // round-trip can race with navigation, leaving the entry visible.
      useStore.getState().removeThread(threadId);
      clearProjectDraftThreadById(thread.projectId, thread.id);
      claudeCache.dispose(threadId);
      clearTerminalState(threadId);
      if (shouldNavigateToFallback) {
        if (fallbackThreadId) {
          void navigate({
            to: "/$threadId",
            params: { threadId: fallbackThreadId },
            replace: true,
          });
        } else {
          void navigate({ to: "/", replace: true });
        }
      }

      if (!shouldDeleteWorktree || !orphanedWorktreePath || !threadProject) {
        return;
      }

      try {
        await removeWorktreeMutation.mutateAsync({
          cwd: threadProject.cwd,
          path: orphanedWorktreePath,
          force: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing worktree.";
        console.error("Failed to remove orphaned worktree after thread deletion", {
          threadId,
          projectCwd: threadProject.cwd,
          worktreePath: orphanedWorktreePath,
          error,
        });
        toastManager.add({
          type: "error",
          title: "Thread deleted, but worktree removal failed",
          description: `Could not remove ${displayWorktreePath ?? orphanedWorktreePath}. ${message}`,
        });
      }
    },
    [
      clearProjectDraftThreadById,
      clearTerminalState,
      navigate,
      projects,
      removeWorktreeMutation,
      routeThreadId,
      threads,
    ],
  );

  const archiveThread = useCallback(
    async (threadId: ThreadId, archivedAt: string | null): Promise<void> => {
      const api = readNativeApi();
      if (!api) return;
      const thread = threads.find((entry) => entry.id === threadId);
      if (!thread) return;

      if (archivedAt !== null && routeThreadId === threadId) {
        const fallbackThread = getTopUnarchivedThreadForProject(thread.projectId, threadId);
        if (fallbackThread) {
          await navigate({
            to: "/$threadId",
            params: { threadId: fallbackThread.id },
            replace: true,
          });
        } else {
          await navigate({ to: "/", replace: true });
        }
      }

      if (archivedAt !== null) {
        if (thread.session && thread.session.status !== "closed") {
          await api.orchestration
            .dispatchCommand({
              type: "thread.session.stop",
              commandId: newCommandId(),
              threadId,
              createdAt: new Date().toISOString(),
            })
            .catch(() => undefined);
        }

        const hibernate =
          thread.harness === "pi"
            ? api.pi.hibernate({ threadId })
            : api.claude.hibernate({ threadId });
        await hibernate.catch(() => undefined);

        await api.terminal.close({ threadId }).catch(() => undefined);
        claudeCache.dispose(threadId);
        clearTerminalState(threadId);
      }

      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId,
          archivedAt,
        });
        setThreadArchived(threadId, archivedAt);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: archivedAt ? "Failed to archive thread" : "Failed to unarchive thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [clearTerminalState, getTopUnarchivedThreadForProject, navigate, routeThreadId, setThreadArchived, threads],
  );

  const handleThreadContextMenu = useCallback(
    async (threadId: ThreadId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = threads.find((t) => t.id === threadId);
      if (!thread) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename thread" },
          { id: "archive", label: thread.archivedAt ? "Unarchive" : "Archive" },
          { id: "bookmark", label: thread.bookmarked ? "Remove bookmark" : "Mark for later" },
          { id: "mark-unread", label: "Mark unread" },
          { id: "reset-status", label: "Reset status badge" },
          { id: "copy-thread-id", label: "Copy Thread ID" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "rename") {
        startRenameThread(thread);
        return;
      }

      if (clicked === "archive") {
        await archiveThread(threadId, thread.archivedAt ? null : new Date().toISOString());
        return;
      }

      if (clicked === "bookmark") {
        const newBookmarked = !thread.bookmarked;
        // Optimistic update — reflect immediately in the sidebar
        useStore.setState((state) => {
          const threads = state.threads.map((t) =>
            t.id === threadId ? { ...t, bookmarked: newBookmarked } : t,
          );
          return { threads };
        });
        void api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId,
          bookmarked: newBookmarked,
        });
        return;
      }

      if (clicked === "reset-status") {
        getGlobalSessionEventState()?.clearThread(threadId);
        useStore.getState().resetThreadStatus(threadId);
        return;
      }

      if (clicked === "mark-unread") {
        markThreadUnread(threadId);
        return;
      }
      if (clicked === "copy-thread-id") {
        try {
          await copyTextToClipboard(threadId);
          toastManager.add({
            type: "success",
            title: "Thread ID copied",
            description: threadId,
          });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to copy thread ID",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }
      if (clicked !== "delete") return;
      if (appSettings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete thread "${thread.title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }
      await deleteThread(threadId);
    },
    [appSettings.confirmThreadDelete, archiveThread, deleteThread, markThreadUnread, startRenameThread, threads],
  );

  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const ids = [...selectedThreadIds];
      if (ids.length === 0) return;
      const count = ids.length;
      const selectedThreads = threads.filter((thread) => ids.includes(thread.id));
      const allArchived =
        selectedThreads.length > 0 && selectedThreads.every((thread) => thread.archivedAt !== null);

      const clicked = await api.contextMenu.show(
        [
          { id: "archive", label: `${allArchived ? "Unarchive" : "Archive"} (${count})` },
          { id: "mark-unread", label: `Mark unread (${count})` },
          { id: "delete", label: `Delete (${count})`, destructive: true },
        ],
        position,
      );

      if (clicked === "archive") {
        const nextArchivedAt = allArchived ? null : new Date().toISOString();
        for (const id of ids) {
          await archiveThread(id, nextArchivedAt);
        }
        return;
      }

      if (clicked === "mark-unread") {
        for (const id of ids) {
          markThreadUnread(id);
        }
        clearSelection();
        return;
      }

      if (clicked !== "delete") return;

      if (appSettings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete ${count} thread${count === 1 ? "" : "s"}?`,
            "This permanently clears conversation history for these threads.",
          ].join("\n"),
        );
        if (!confirmed) return;
      }

      const deletedIds = new Set<ThreadId>(ids);
      for (const id of ids) {
        await deleteThread(id, { deletedThreadIds: deletedIds });
      }
      removeFromSelection(ids);
    },
    [
      appSettings.confirmThreadDelete,
      archiveThread,
      clearSelection,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
      selectedThreadIds,
      threads,
    ],
  );

  const handleThreadClick = useCallback(
    (event: MouseEvent, threadId: ThreadId, orderedProjectThreadIds: readonly ThreadId[]) => {
      if (dragInProgressRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (suppressThreadClickAfterDragRef.current) {
        suppressThreadClickAfterDragRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const isShiftClick = event.shiftKey;

      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadId);
        return;
      }

      if (isShiftClick) {
        event.preventDefault();
        rangeSelectTo(threadId, orderedProjectThreadIds);
        return;
      }

      // Plain click — clear selection, set anchor for future shift-clicks, and navigate
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadId);
      void navigate({
        to: "/$threadId",
        params: { threadId },
      });
    },
    [
      clearSelection,
      navigate,
      rangeSelectTo,
      selectedThreadIds.size,
      setSelectionAnchor,
      toggleThreadSelection,
    ],
  );

  const handleProjectContextMenu = useCallback(
    async (projectId: ProjectId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "hide", label: "Hide" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );
      if (clicked === null) return;

      const project = projects.find((entry) => entry.id === projectId);
      if (!project) return;

      const projectThreads = threads.filter((thread) => thread.projectId === projectId);
      if (clicked === "hide") {
        const activeThread = routeThreadId ? threads.find((thread) => thread.id === routeThreadId) : null;
        if (activeThread?.projectId === projectId) {
          const fallbackThread = threads.find(
            (thread) => thread.projectId !== projectId && thread.archivedAt === null,
          );
          if (fallbackThread) {
            await navigate({
              to: "/$threadId",
              params: { threadId: fallbackThread.id },
              replace: true,
            });
          } else {
            await navigate({ to: "/", replace: true });
          }
        }

        try {
          clearProjectDraftThreadId(projectId);
          await api.orchestration.dispatchCommand({
            type: "project.meta.update",
            commandId: newCommandId(),
            projectId,
            hiddenAt: new Date().toISOString(),
          });
          const snapshot = await api.orchestration.getSnapshot().catch(() => null);
          if (snapshot) {
            useStore.getState().syncServerReadModel(snapshot);
          }
          const projectTerminalId = projectTerminalThreadId(projectId);
          storeSetTerminalOpen(projectTerminalId, false);
          clearTerminalState(projectTerminalId);
          for (const thread of projectThreads) {
            claudeCache.dispose(thread.id);
            clearTerminalState(thread.id);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error hiding project.";
          console.error("Failed to hide project", { projectId, error });
          toastManager.add({
            type: "error",
            title: `Failed to hide "${project.name}"`,
            description: message,
          });
        }
        return;
      }

      if (projectThreads.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Project is not empty",
          description: "Delete all threads in this project before deleting it.",
        });
        return;
      }

      const confirmed = await api.dialogs.confirm(
        [`Delete project "${project.name}"?`, "This action cannot be undone."].join("\n"),
      );
      if (!confirmed) return;

      try {
        clearProjectDraftThreadId(projectId);
        await api.orchestration.dispatchCommand({
          type: "project.delete",
          commandId: newCommandId(),
          projectId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error deleting project.";
        console.error("Failed to remove project", { projectId, error });
        toastManager.add({
          type: "error",
          title: `Failed to delete "${project.name}"`,
          description: message,
        });
      }
    },
    [
      clearProjectDraftThreadId,
      clearTerminalState,
      navigate,
      projects,
      routeThreadId,
      storeSetTerminalOpen,
      threads,
    ],
  );

  const sidebarDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const sidebarCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }

    return closestCorners(args);
  }, []);

  const handleSidebarDragEnd = useCallback(
    (event: DragEndEvent) => {
      dragInProgressRef.current = false;
      setActiveDragItem(null);
      setActiveDragOverlaySize(null);
      const activeData = event.active.data.current as SidebarDragData | undefined;
      const overData = event.over?.data.current as SidebarDragData | undefined;
      if (!overData || !activeData || event.active.id === event.over?.id) return;

      if (activeData.kind === "project") {
        reorderProjects(activeData.projectId, overData.projectId);
        return;
      }

      if (
        activeData.kind === "thread" &&
        overData.kind === "thread" &&
        activeData.projectId === overData.projectId
      ) {
        reorderThreadsInProject(activeData.projectId, activeData.threadId, overData.threadId);
      }
    },
    [reorderProjects, reorderThreadsInProject],
  );

  const handleSidebarDragStart = useCallback((event: DragStartEvent) => {
    dragInProgressRef.current = true;
    const activeData = event.active.data.current as SidebarDragData | undefined;
    const initialRect = event.active.rect.current.initial ?? event.active.rect.current.translated;
    if (activeData?.kind === "project") {
      suppressProjectClickAfterDragRef.current = true;
    }
    if (activeData?.kind === "thread") {
      suppressThreadClickAfterDragRef.current = true;
    }
    setActiveDragItem(activeData ?? null);
    setActiveDragOverlaySize(
      initialRect ? { width: initialRect.width, height: initialRect.height } : null,
    );
  }, []);

  const handleSidebarDragCancel = useCallback((_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
    setActiveDragItem(null);
    setActiveDragOverlaySize(null);
  }, []);

  const handleProjectTitlePointerDownCapture = useCallback(() => {
    suppressProjectClickAfterDragRef.current = false;
  }, []);

  const handleProjectTitleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (dragInProgressRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (suppressProjectClickAfterDragRef.current) {
        // Consume the synthetic click emitted after a drag release.
        suppressProjectClickAfterDragRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      toggleProject(projectId);
    },
    [clearSelection, selectedThreadIds.size, toggleProject],
  );

  const handleProjectTitleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      toggleProject(projectId);
    },
    [toggleProject],
  );

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selectedThreadIds.size > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      const activeThread = routeThreadId
        ? threads.find((thread) => thread.id === routeThreadId)
        : undefined;
      const activeDraftThread = routeThreadId ? getDraftThread(routeThreadId) : null;
      if (isChatNewLocalShortcut(event, keybindings)) {
        const projectId =
          activeThread?.projectId ?? activeDraftThread?.projectId ?? projects[0]?.id;
        if (!projectId) return;
        event.preventDefault();
        void handleNewThread(projectId);
        return;
      }

      if (!isChatNewShortcut(event, keybindings)) return;
      const projectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? projects[0]?.id;
      if (!projectId) return;
      event.preventDefault();
      void handleNewThread(projectId, {
        branch: activeThread?.branch ?? activeDraftThread?.branch ?? null,
        worktreePath: activeThread?.worktreePath ?? activeDraftThread?.worktreePath ?? null,
      });
    };

    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (selectedThreadIds.size === 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      clearSelection();
    };

    window.addEventListener("keydown", onWindowKeyDown);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [
    clearSelection,
    getDraftThread,
    handleNewThread,
    keybindings,
    projects,
    routeThreadId,
    selectedThreadIds.size,
    threads,
  ]);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setDesktopUpdateState(nextState);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (showArchivedThreads || routeThreadId === null) return;
    const currentThread = threads.find((thread) => thread.id === routeThreadId);
    if (!currentThread || currentThread.archivedAt === null) return;

    const fallbackThread = getTopUnarchivedThreadForProject(currentThread.projectId, routeThreadId);
    if (fallbackThread) {
      void navigate({
        to: "/$threadId",
        params: { threadId: fallbackThread.id },
        replace: true,
      });
      return;
    }

    void navigate({ to: "/", replace: true });
  }, [getTopUnarchivedThreadForProject, navigate, routeThreadId, showArchivedThreads, threads]);

  const desktopUpdateButtonDisabled = isDesktopUpdateButtonDisabled(desktopUpdateState);
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const showDesktopUpdateBanner = isElectron && shouldShowDesktopUpdateBanner(desktopUpdateState);
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const newThreadShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "chat.newLocal") ??
      shortcutLabelForCommand(keybindings, "chat.new"),
    [keybindings],
  );
  const searchShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "thread.search"),
    [keybindings],
  );

  const handleDesktopUpdateButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (desktopUpdateButtonDisabled || desktopUpdateButtonAction === "none") return;

    if (shouldOpenReleasesPage(desktopUpdateState) && desktopUpdateState.releasesUrl) {
      void bridge.openExternal(desktopUpdateState.releasesUrl);
      return;
    }

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            toastManager.add({
              type: "success",
              title: "Update downloaded",
              description: "Restart the app from the update button to install it.",
            });
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not start update download",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
    }
  }, [desktopUpdateButtonAction, desktopUpdateButtonDisabled, desktopUpdateState]);

  const expandThreadListForProject = useCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((current) => {
      if (current.has(projectId)) return current;
      const next = new Set(current);
      next.add(projectId);
      return next;
    });
  }, []);

  const collapseThreadListForProject = useCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
  }, []);

  const wordmark = (
    <div className="flex items-center gap-2">
      <SidebarTrigger className="shrink-0 md:hidden" />
      <div className="flex min-w-0 flex-1 items-center gap-1.5 mt-1.5 ml-1">
        <CluiWordmark />
        <span className="rounded-full bg-muted/50 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
          {APP_STAGE_LABEL}
        </span>
      </div>
    </div>
  );

  return (
    <>
      {isElectron ? (
        <>
          <SidebarHeader className="drag-region h-[52px] flex-row items-center gap-2 px-4 py-0 pl-[90px]">
            {wordmark}
          </SidebarHeader>
        </>
      ) : (
        <SidebarHeader className="gap-3 px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-3">
          {wordmark}
        </SidebarHeader>
      )}

      <SidebarContent className="gap-0">
        {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
          <SidebarGroup className="px-2 pt-2 pb-0">
            <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8">
              <TriangleAlertIcon />
              <AlertTitle>Intel build on Apple Silicon</AlertTitle>
              <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
              {desktopUpdateButtonAction !== "none" ? (
                <AlertAction>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={desktopUpdateButtonDisabled}
                    onClick={handleDesktopUpdateButtonClick}
                  >
                    {desktopUpdateButtonAction === "download"
                      ? "Download ARM build"
                      : "Install ARM build"}
                  </Button>
                </AlertAction>
              ) : null}
            </Alert>
          </SidebarGroup>
        ) : null}
        <SidebarGroup className="px-2 py-2">
          <div className="mb-1 flex items-center justify-between px-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Projects
            </span>
            <div className="flex items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Search threads"
                      className="inline-flex size-5 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                      onClick={onSearchClick}
                    />
                  }
                >
                  <SearchIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="right">
                  {searchShortcutLabel
                    ? `Search threads (${searchShortcutLabel})`
                    : "Search threads"}
                </TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={showArchivedThreads ? "Hide archived threads" : "Show archived threads"}
                      aria-pressed={showArchivedThreads}
                      className={`inline-flex size-5 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground ${
                        showArchivedThreads
                          ? "bg-accent/70 text-foreground"
                          : "text-muted-foreground/60"
                      }`}
                      onClick={() => setShowArchivedThreads((current) => !current)}
                    />
                  }
                >
                  <ArchiveIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="right">
                  {showArchivedThreads ? "Hide archived threads" : "Show archived threads"}
                </TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Add project"
                      aria-pressed={shouldShowProjectPathEntry}
                      className="inline-flex size-5 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                      onClick={handleStartAddProject}
                    />
                  }
                >
                  <PlusIcon
                    className={`size-3.5 transition-transform duration-150 ${
                      shouldShowProjectPathEntry ? "rotate-45" : "rotate-0"
                    }`}
                  />
                </TooltipTrigger>
                <TooltipPopup side="right">Add project</TooltipPopup>
              </Tooltip>
            </div>
          </div>

          {shouldShowProjectPathEntry && (
            <div className="mb-2 px-1">
              {isElectron && (
                <button
                  type="button"
                  className="mb-1.5 flex w-full items-center justify-center gap-2 rounded-md border border-border bg-secondary py-1.5 text-xs text-foreground/80 transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => void handlePickFolder()}
                  disabled={isPickingFolder || isAddingProject}
                >
                  <FolderIcon className="size-3.5" />
                  {isPickingFolder ? "Picking folder..." : "Browse for folder"}
                </button>
              )}
              <div className="flex gap-1.5">
                <input
                  ref={addProjectInputRef}
                  className={`min-w-0 flex-1 rounded-md border bg-secondary px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none ${
                    addProjectError
                      ? "border-red-500/70 focus:border-red-500"
                      : "border-border focus:border-ring"
                  }`}
                  placeholder="/path/to/project"
                  value={newCwd}
                  onChange={(event) => {
                    setNewCwd(event.target.value);
                    setAddProjectError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleAddProject();
                    if (event.key === "Escape") {
                      setAddingProject(false);
                      setAddProjectError(null);
                    }
                  }}
                  autoFocus
                />
                <button
                  type="button"
                  className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:opacity-60"
                  onClick={handleAddProject}
                  disabled={!canAddProject}
                >
                  {isAddingProject ? "Adding..." : "Add"}
                </button>
              </div>
              {addProjectError && (
                <p className="mt-1 px-0.5 text-[11px] leading-tight text-red-400">
                  {addProjectError}
                </p>
              )}
              <div className="mt-1.5 px-0.5">
                <button
                  type="button"
                  className="text-[11px] text-muted-foreground/50 transition-colors hover:text-muted-foreground"
                  onClick={() => {
                    setAddingProject(false);
                    setAddProjectError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <DndContext
            sensors={sidebarDnDSensors}
            collisionDetection={sidebarCollisionDetection}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragStart={handleSidebarDragStart}
            onDragEnd={handleSidebarDragEnd}
            onDragCancel={handleSidebarDragCancel}
          >
            <SidebarMenu>
              <SortableContext
                items={projects.map((project) => projectSortableId(project.id))}
                strategy={verticalListSortingStrategy}
              >
                {projects.map((project) => {
                  const projectThreads = orderThreadsForProject(
                    visibleSidebarThreads.filter((thread) => thread.projectId === project.id),
                    threadOrderByProject[project.id],
                  );
                  const isThreadListExpanded = expandedThreadListsByProject.has(project.id);
                  const hasHiddenThreads = projectThreads.length > THREAD_PREVIEW_LIMIT;
                  const visibleThreads =
                    hasHiddenThreads && !isThreadListExpanded
                      ? projectThreads.slice(0, THREAD_PREVIEW_LIMIT)
                      : projectThreads;
                  const orderedProjectThreadIds = projectThreads.map((t) => t.id);

                  return (
                    <SortableProjectItem key={project.id} project={project}>
                      {(dragHandleProps) => (
                        <Collapsible className="group/collapsible" open={project.expanded}>
                          <div className="group/project-header relative">
                            <SidebarMenuButton
                              size="sm"
                              className="gap-2 px-2 py-1.5 text-left cursor-grab active:cursor-grabbing hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground"
                              {...dragHandleProps.attributes}
                              {...dragHandleProps.listeners}
                              onPointerDownCapture={handleProjectTitlePointerDownCapture}
                              onClick={(event) => handleProjectTitleClick(event, project.id)}
                              onKeyDown={(event) => handleProjectTitleKeyDown(event, project.id)}
                              onContextMenu={(event) => {
                                event.preventDefault();
                                void handleProjectContextMenu(project.id, {
                                  x: event.clientX,
                                  y: event.clientY,
                                });
                              }}
                            >
                              <ChevronRightIcon
                                className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                                  project.expanded ? "rotate-90" : ""
                                }`}
                              />
                              <ProjectFavicon cwd={project.cwd} />
                              <span className="flex-1 truncate text-xs font-medium text-foreground/90">
                                {project.name}
                              </span>
                            </SidebarMenuButton>
                            {(() => {
                              const projTermThreadId = projectTerminalThreadId(project.id);
                              const projTermState = selectThreadTerminalState(
                                terminalStateByThreadId,
                                projTermThreadId,
                              );
                              const hasRunning = projTermState.runningTerminalIds.length > 0;
                              const isOpen = projTermState.terminalOpen;
                              return (
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <SidebarMenuAction
                                        render={
                                          <button
                                            type="button"
                                            aria-label={`Toggle project terminal for ${project.name}`}
                                          />
                                        }
                                        showOnHover={!hasRunning}
                                        className={`top-1 right-7 size-5 rounded-md p-0 hover:bg-secondary hover:text-foreground ${
                                          hasRunning
                                            ? "text-teal-600 dark:text-teal-300/90"
                                            : isOpen
                                              ? "text-foreground"
                                              : "text-muted-foreground/70"
                                        }`}
                                        onClick={(event) => {
                                          event.preventDefault();
                                          event.stopPropagation();
                                          storeSetTerminalOpen(projTermThreadId, !isOpen);
                                        }}
                                      >
                                        <TerminalIcon
                                          className={`size-3.5 ${hasRunning ? "animate-pulse" : ""}`}
                                        />
                                      </SidebarMenuAction>
                                    }
                                  />
                                  <TooltipPopup side="top">
                                    {isOpen ? "Close project terminal" : "Open project terminal"}
                                  </TooltipPopup>
                                </Tooltip>
                              );
                            })()}
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <SidebarMenuAction
                                    render={
                                      <button
                                        type="button"
                                        aria-label={`Create new thread in ${project.name}`}
                                      />
                                    }
                                    showOnHover
                                    className="top-1 right-1 size-5 rounded-md p-0 text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      void handleNewThread(project.id);
                                    }}
                                  >
                                    <SquarePenIcon className="size-3.5" />
                                  </SidebarMenuAction>
                                }
                              />
                              <TooltipPopup side="top">
                                {newThreadShortcutLabel
                                  ? `New thread (${newThreadShortcutLabel})`
                                  : "New thread"}
                              </TooltipPopup>
                            </Tooltip>
                          </div>

                          <CollapsibleContent keepMounted>
                            <SidebarMenuSub className="mx-1 my-0 w-full translate-x-0 gap-0.5 px-1.5 py-0">
                              <SortableContext
                                items={visibleThreads.map((thread) => threadSortableId(thread.id))}
                                strategy={verticalListSortingStrategy}
                              >
                                {visibleThreads.map((thread) => {
                                  const isActive = routeThreadId === thread.id;
                                  const isSelected = selectedThreadIds.has(thread.id);
                                  const isHighlighted = isActive || isSelected;
                                  const threadStatus = resolveThreadStatusPill({
                                    thread,
                                    hasPendingApprovals:
                                      pendingApprovalByThreadId.get(thread.id) === true,
                                    hasPendingUserInput:
                                      pendingUserInputByThreadId.get(thread.id) === true,
                                  });
                                  const prStatus = prStatusIndicator(
                                    prByThreadId.get(thread.id) ?? null,
                                  );
                                  const terminalStatus = terminalStatusFromRunningIds(
                                    selectThreadTerminalState(terminalStateByThreadId, thread.id)
                                      .runningTerminalIds,
                                  );

                                  return (
                                    <SortableThreadItem key={thread.id} thread={thread}>
                                      {(dragHandleProps) => (
                                        <TooltipProvider delay={0} closeDelay={0}>
                                          <Tooltip>
                                            <div className="relative box-border pl-4">
                                              <SidebarThreadDragHandle
                                                ariaLabel={`Reorder ${thread.title}`}
                                                handleProps={dragHandleProps}
                                                disabled={renamingThreadId === thread.id}
                                              />
                                              <SidebarMenuSubButton
                                                render={
                                                  thread.branch ? (
                                                    <TooltipTrigger
                                                      render={<div role="button" tabIndex={0} />}
                                                    />
                                                  ) : (
                                                    <div role="button" tabIndex={0} />
                                                  )
                                                }
                                                size="sm"
                                                isActive={isActive}
                                                className={getSidebarThreadRowClassName({
                                                  isActive,
                                                  isSelected,
                                                  isArchived: thread.archivedAt !== null,
                                                  interactive: true,
                                                })}
                                                onClick={(event) => {
                                                  handleThreadClick(
                                                    event,
                                                    thread.id,
                                                    orderedProjectThreadIds,
                                                  );
                                                }}
                                                onKeyDown={(event) => {
                                                  if (event.key !== "Enter" && event.key !== " ")
                                                    return;
                                                  event.preventDefault();
                                                  if (selectedThreadIds.size > 0) {
                                                    clearSelection();
                                                  }
                                                  setSelectionAnchor(thread.id);
                                                  void navigate({
                                                    to: "/$threadId",
                                                    params: { threadId: thread.id },
                                                  });
                                                }}
                                                onContextMenu={(event) => {
                                                  event.preventDefault();
                                                  if (
                                                    selectedThreadIds.size > 0 &&
                                                    selectedThreadIds.has(thread.id)
                                                  ) {
                                                    void handleMultiSelectContextMenu({
                                                      x: event.clientX,
                                                      y: event.clientY,
                                                    });
                                                  } else {
                                                    if (selectedThreadIds.size > 0) {
                                                      clearSelection();
                                                    }
                                                    void handleThreadContextMenu(thread.id, {
                                                      x: event.clientX,
                                                      y: event.clientY,
                                                    });
                                                  }
                                                }}
                                              >
                                                <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                                                  {prStatus && (
                                                    <Tooltip>
                                                      <TooltipTrigger
                                                        render={
                                                          <button
                                                            type="button"
                                                            aria-label={prStatus.tooltip}
                                                            className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
                                                            onClick={(event) => {
                                                              openPrLink(event, prStatus.url);
                                                            }}
                                                          >
                                                            <GitPullRequestIcon className="size-3" />
                                                          </button>
                                                        }
                                                      />
                                                      <TooltipPopup side="top">
                                                        {prStatus.tooltip}
                                                      </TooltipPopup>
                                                    </Tooltip>
                                                  )}
                                                  {threadStatus && (
                                                    <span
                                                      role="status"
                                                      aria-label={threadStatus.label}
                                                      className={`inline-flex items-center gap-1 text-[10px] ${threadStatus.colorClass}`}
                                                    >
                                                      <span
                                                        aria-hidden="true"
                                                        className={`h-1.5 w-1.5 rounded-full ${threadStatus.dotClass} ${
                                                          threadStatus.pulse ? "animate-pulse" : ""
                                                        }`}
                                                      />
                                                      <span className="hidden md:inline">
                                                        {threadStatus.label}
                                                      </span>
                                                    </span>
                                                  )}
                                                  {thread.archivedAt && (
                                                    <ArchiveIcon className="size-3 shrink-0 text-muted-foreground/55" />
                                                  )}
                                                  {thread.bookmarked && (
                                                    <BookmarkIcon className="size-3 shrink-0 fill-amber-400 text-amber-500 dark:fill-amber-300/80 dark:text-amber-400/80" />
                                                  )}
                                                  {renamingThreadId === thread.id ? (
                                                    <input
                                                      ref={(el) => {
                                                        if (el && renamingInputRef.current !== el) {
                                                          renamingInputRef.current = el;
                                                          el.focus();
                                                          el.select();
                                                        }
                                                      }}
                                                      className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-xs outline-none"
                                                      value={renamingTitle}
                                                      onChange={(e) =>
                                                        setRenamingTitle(e.target.value)
                                                      }
                                                      onKeyDown={(e) => {
                                                        e.stopPropagation();
                                                        if (e.key === "Enter") {
                                                          e.preventDefault();
                                                          renamingCommittedRef.current = true;
                                                          void commitRename(
                                                            thread.id,
                                                            renamingTitle,
                                                            thread.title,
                                                          );
                                                        } else if (e.key === "Escape") {
                                                          e.preventDefault();
                                                          renamingCommittedRef.current = true;
                                                          cancelRename();
                                                        }
                                                      }}
                                                      onBlur={() => {
                                                        if (!renamingCommittedRef.current) {
                                                          void commitRename(
                                                            thread.id,
                                                            renamingTitle,
                                                            thread.title,
                                                          );
                                                        }
                                                      }}
                                                      onClick={(e) => e.stopPropagation()}
                                                    />
                                                  ) : (
                                                    <span
                                                      className="min-w-0 flex-1 truncate text-xs"
                                                      title="Double-click to rename"
                                                      onDoubleClick={(event) => {
                                                        event.preventDefault();
                                                        event.stopPropagation();
                                                        startRenameThread(thread);
                                                      }}
                                                    >
                                                      {thread.title}
                                                    </span>
                                                  )}
                                                </div>
                                                <div className="relative ml-auto flex shrink-0 items-center gap-1.5">
                                                  {terminalStatus && (
                                                    <span
                                                      role="img"
                                                      aria-label={terminalStatus.label}
                                                      title={terminalStatus.label}
                                                      className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
                                                    >
                                                      <TerminalIcon
                                                        className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`}
                                                      />
                                                    </span>
                                                  )}
                                                  <span
                                                    className={`text-[10px] ${
                                                      isHighlighted
                                                        ? "text-foreground/65"
                                                        : "text-muted-foreground/40"
                                                    }`}
                                                  >
                                                    {formatRelativeTime(thread.updatedAt)}
                                                  </span>
                                                </div>
                                              </SidebarMenuSubButton>
                                            </div>
                                            {thread.branch && (
                                              <TooltipPopup side="right" sideOffset={12} arrow>
                                                <span className="inline-flex items-center gap-1.5">
                                                  <GitBranchIcon className="size-3 shrink-0" />
                                                  {formatBranchForDisplay(thread.branch)}
                                                </span>
                                              </TooltipPopup>
                                            )}
                                          </Tooltip>
                                        </TooltipProvider>
                                      )}
                                    </SortableThreadItem>
                                  );
                                })}
                              </SortableContext>

                              {hasHiddenThreads && !isThreadListExpanded && (
                                <SidebarMenuSubItem className="w-full">
                                  <SidebarMenuSubButton
                                    render={<button type="button" />}
                                    data-thread-selection-safe
                                    size="sm"
                                    className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                                    onClick={() => {
                                      expandThreadListForProject(project.id);
                                    }}
                                  >
                                    <span>Show more</span>
                                  </SidebarMenuSubButton>
                                </SidebarMenuSubItem>
                              )}
                              {hasHiddenThreads && isThreadListExpanded && (
                                <SidebarMenuSubItem className="w-full">
                                  <SidebarMenuSubButton
                                    render={<button type="button" />}
                                    data-thread-selection-safe
                                    size="sm"
                                    className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                                    onClick={() => {
                                      collapseThreadListForProject(project.id);
                                    }}
                                  >
                                    <span>Show less</span>
                                  </SidebarMenuSubButton>
                                </SidebarMenuSubItem>
                              )}
                            </SidebarMenuSub>
                          </CollapsibleContent>
                        </Collapsible>
                      )}
                    </SortableProjectItem>
                  );
                })}
              </SortableContext>
            </SidebarMenu>
            {typeof document !== "undefined"
              ? createPortal(
                  <DragOverlay
                    dropAnimation={{
                      duration: 220,
                      easing: "cubic-bezier(0.18, 0.67, 0.6, 1.22)",
                    }}
                    zIndex={50}
                  >
                    {activeDragItem ? (
                      <SidebarDragOverlayPreview
                        item={activeDragItem}
                        size={activeDragOverlaySize}
                        thread={activeDragThread}
                        isActive={activeDragThread ? routeThreadId === activeDragThread.id : false}
                        isSelected={
                          activeDragThread ? selectedThreadIds.has(activeDragThread.id) : false
                        }
                        threadStatus={activeDragThreadStatus}
                        pr={activeDragThread ? (prByThreadId.get(activeDragThread.id) ?? null) : null}
                        terminalStatus={activeDragThreadTerminalStatus}
                      />
                    ) : null}
                  </DragOverlay>,
                  document.body,
                )
              : null}
          </DndContext>

          {projects.length === 0 && !shouldShowProjectPathEntry && (
            <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">
              No projects yet
            </div>
          )}
        </SidebarGroup>
      </SidebarContent>

      <SidebarSeparator />
      <SidebarFooter className="p-2">
        <SidebarMenu>
          {showDesktopUpdateBanner && !showArm64IntelBuildWarning && !updateBannerDismissed ? (
            <SidebarMenuItem>
              <SidebarMenuButton
                size="sm"
                className={`gap-2 px-2 py-1 ${
                  desktopUpdateButtonDisabled
                    ? "cursor-not-allowed opacity-60"
                    : "hover:bg-accent hover:text-foreground"
                } ${
                  desktopUpdateState?.status === "error"
                    ? "text-destructive"
                    : desktopUpdateState?.status === "downloaded"
                      ? "text-emerald-500"
                      : "text-amber-500"
                }`}
                disabled={desktopUpdateButtonDisabled}
                onClick={handleDesktopUpdateButtonClick}
              >
                {desktopUpdateState?.status === "downloading" ? (
                  <>
                    <DownloadIcon className="size-3 shrink-0" />
                    <span className="min-w-0 truncate text-xs">
                      Downloading
                      {typeof desktopUpdateState.downloadPercent === "number"
                        ? ` ${Math.floor(desktopUpdateState.downloadPercent)}%`
                        : "…"}
                    </span>
                  </>
                ) : desktopUpdateState?.status === "downloaded" ? (
                  <>
                    <RocketIcon className="size-3 shrink-0" />
                    <span className="min-w-0 truncate text-xs">Restart to update</span>
                  </>
                ) : (
                  <>
                    <DownloadIcon className="size-3 shrink-0" />
                    <span className="min-w-0 truncate text-xs">Update available</span>
                  </>
                )}
                <button
                  type="button"
                  aria-label="Dismiss"
                  className="ml-auto inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    setUpdateBannerDismissed(true);
                  }}
                >
                  <XIcon className="size-3" />
                </button>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
          <SidebarMenuItem>
            <PurgeSessionsButton routeThreadId={routeThreadId} />
          </SidebarMenuItem>
          <SidebarMenuItem>
            {isOnSettings ? (
              <SidebarMenuButton
                size="sm"
                className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                onClick={() => window.history.back()}
              >
                <ArrowLeftIcon className="size-3.5" />
                <span className="text-xs">Back</span>
              </SidebarMenuButton>
            ) : (
              <SidebarMenuButton
                size="sm"
                className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                onClick={() => void navigate({ to: "/settings" })}
              >
                <SettingsIcon className="size-3.5" />
                <span className="text-xs">Settings</span>
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
