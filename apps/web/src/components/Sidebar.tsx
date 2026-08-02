import {
  ArchiveIcon,
  AlarmClockIcon,
  AlarmClockOffIcon,
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  Clock3Icon,
  DownloadIcon,
  XIcon,
  FolderIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  GripVerticalIcon,
  NetworkIcon,
  PinIcon,
  PlusIcon,
  RocketIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
  Trash2Icon,
  TriangleAlertIcon,
  Undo2Icon,
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
  DEFAULT_ACTIVE_HARNESS_SESSION_CAP,
  DEFAULT_MODEL_BY_PROVIDER,
  type CodingHarness,
  type DesktopUpdateState,
  ProjectId,
  ThreadId,
  type GitStatusResult,
  type ResolvedKeybindingsConfig,
} from "@clui/contracts";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { CODING_HARNESS_LABELS, CODING_HARNESS_OPTIONS, useAppSettings } from "../appSettings";
import { isElectron } from "../env";
import { APP_STAGE_LABEL } from "../branding";
import { copyTextToClipboard } from "../lib/clipboard";
import { cn, isMacPlatform, newCommandId, newProjectId } from "../lib/utils";
import { useNewThreadHandler } from "../hooks/useNewThreadHandler";
import { subscribeProjectAddRequests } from "../lib/projectAddRequest";
import { useStore } from "../store";
import { isChatNewLocalShortcut, isChatNewShortcut, shortcutLabelForCommand } from "../keybindings";
import { projectTerminalThreadId, type Project, type Thread } from "../types";
import { derivePendingApprovals, derivePendingUserInputs } from "../session-logic";
import { getGlobalSessionEventState } from "../lib/sessionEventState";
import { gitRemoveWorktreeMutationOptions, gitStatusQueryOptions } from "../lib/gitReactQuery";
import { dispatchThreadArchiveUpdate } from "../lib/threadArchive";
import {
  dispatchThreadSettle,
  dispatchThreadSnooze,
  dispatchThreadUnsettle,
  dispatchThreadUnsnooze,
} from "../lib/threadLifecycle";
import {
  dispatchThreadSelectedEvent,
  dispatchThreadSelectedEventAfterRouteChange,
} from "../lib/threadSelectionEvent";
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
import { Skeleton } from "./ui/skeleton";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
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
import { PurgeSessionsButton, PurgeSessionsDialog } from "./PurgeSessionsButton";
import { WorktreeIndicator } from "./WorktreeIndicator";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import {
  type ThreadPr,
  formatBranchForDisplay,
  formatRelativeTime,
  terminalStatusFromRunningIds,
  prStatusIndicator,
  settledPrHoverColorClass,
} from "../lib/threadStatus";
import {
  canSettleThread,
  canSnoozeThread,
  effectiveSettled,
  effectiveSnoozed,
  threadLastActivityAt,
  threadWokeAt,
} from "@clui/shared/threadLifecycle";
import { isNonEmpty as isNonEmptyString } from "effect/String";
import { getTopThreadForProject, orderThreadsForProject } from "../lib/threadOrdering";
import {
  formatWorkingDurationLabel,
  getSidebarLifecycleRefreshDelay,
  getWorkingDurationRefreshDelay,
  getActiveHarnessSessionStats,
  hasUnseenCompletion,
  partitionSidebarLifecycleThreads,
  resolveSidebarV2Status,
  resolveSidebarV2TopStatus,
  resolveThreadStatusPill,
  resolveWorkingStartedAt,
  shouldClearThreadSelectionOnMouseDown,
  type ActiveHarnessSessionStats,
} from "./Sidebar.logic";
import { HarnessIcon } from "./HarnessIcon";
import { resolveSnoozePresets, snoozeWakeLabel, type SnoozePreset } from "./Sidebar.snooze";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const THREAD_PREVIEW_LIMIT = 6;
const SIDEBAR_V2_ENABLED = import.meta.env.VITE_SIDEBAR_V2 !== "false";

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

const HARNESS_SESSION_STAT_ROWS = CODING_HARNESS_OPTIONS.map((key) => ({
  key,
  label: CODING_HARNESS_LABELS[key],
}));

function SidebarProjectsLoading() {
  return (
    <div className="px-1 pt-1" aria-busy="true" aria-live="polite" role="status">
      <div className="mb-2 px-2 text-[11px] text-muted-foreground/60">Loading projects…</div>
      <div className="space-y-2">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="space-y-1.5 rounded-md px-1 py-1">
            <div className="flex items-center gap-2 px-1">
              <Skeleton className="size-3.5 rounded-sm" />
              <Skeleton className="h-3 flex-1" />
            </div>
            <div className="space-y-1 pl-6">
              <Skeleton className="h-6 w-[86%] rounded-md" />
              <Skeleton className="h-6 w-[72%] rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function HarnessSessionUsageBadge({
  onPurgeInactiveSessionsClick,
  stats,
}: {
  onPurgeInactiveSessionsClick: () => void;
  stats: ActiveHarnessSessionStats;
}) {
  const isAtLimit = stats.busiestHarnessActive >= stats.maxActivePerHarness;
  const isNearLimit =
    !isAtLimit && stats.busiestHarnessActive >= Math.ceil(stats.maxActivePerHarness * 0.8);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={
              `Active harness sessions: ${stats.totalActive}/${stats.maxActivePerHarness}; ` +
              "cap is per harness"
            }
            className={cn(
              "inline-flex h-4 items-center rounded px-1 text-[9px] leading-none font-medium tracking-normal tabular-nums text-muted-foreground/45 transition-colors hover:bg-accent/70 hover:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
              isAtLimit &&
                "text-amber-600/75 hover:text-amber-600 dark:text-amber-300/75 dark:hover:text-amber-300",
              isNearLimit && "text-muted-foreground/65",
            )}
          />
        }
      >
        {stats.totalActive}/{stats.maxActivePerHarness}
      </PopoverTrigger>
      <PopoverPopup side="right" align="start" className="w-64">
        <div className="space-y-3 text-xs">
          <div>
            <p className="font-medium text-foreground">Active thread sessions</p>
            <p className="mt-1 leading-4 text-muted-foreground">
              Live Claude Code, pi, and Codex CLI PTY sessions kept awake right now. The cap is per
              harness; the oldest active thread is hibernated when a harness goes over it.
            </p>
          </div>

          <div className="space-y-1.5">
            {HARNESS_SESSION_STAT_ROWS.map((row) => {
              const active = stats.activeByHarness[row.key];
              const width =
                stats.maxActivePerHarness > 0
                  ? Math.min(100, (active / stats.maxActivePerHarness) * 100)
                  : 0;
              const rowAtLimit = active >= stats.maxActivePerHarness;

              return (
                <div key={row.key} className="rounded-md bg-muted/35 px-2 py-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">{row.label}</span>
                    <span
                      className={cn(
                        "font-mono text-[11px] text-foreground tabular-nums",
                        rowAtLimit && "text-amber-600 dark:text-amber-300",
                      )}
                    >
                      {active}/{stats.maxActivePerHarness}
                    </span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-background/70">
                    <div
                      className={cn(
                        "h-full rounded-full bg-muted-foreground/45",
                        rowAtLimit && "bg-amber-500/80",
                      )}
                      style={{ width: `${width}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="space-y-2 border-t border-border/70 pt-2">
            <p className="text-[11px] leading-4 text-muted-foreground">
              Badge shows {stats.totalActive} active globally against the configured{" "}
              {stats.maxActivePerHarness} per-harness cap.
            </p>
            <Button
              size="xs"
              variant="outline"
              className="w-full justify-start gap-1.5 text-[11px]"
              onClick={onPurgeInactiveSessionsClick}
            >
              <Trash2Icon className="size-3.5" />
              Purge inactive sessions
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
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

function WorkingDuration({ startedAt }: { startedAt: string | null }) {
  const startedMs = startedAt === null ? Number.NaN : Date.parse(startedAt);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (Number.isNaN(startedMs)) return;
    let timeoutId: number | null = null;

    const clearScheduledTick = () => {
      if (timeoutId === null) return;
      window.clearTimeout(timeoutId);
      timeoutId = null;
    };
    const scheduleTick = () => {
      clearScheduledTick();
      if (document.visibilityState === "hidden") return;
      timeoutId = window.setTimeout(
        () => {
          timeoutId = null;
          setTick((tick) => tick + 1);
          scheduleTick();
        },
        getWorkingDurationRefreshDelay(Date.now() - startedMs),
      );
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        clearScheduledTick();
        return;
      }
      setTick((tick) => tick + 1);
      scheduleTick();
    };

    scheduleTick();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      clearScheduledTick();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [startedMs]);

  if (Number.isNaN(startedMs)) return null;
  return <span className="tabular-nums">{formatWorkingDurationLabel(Date.now() - startedMs)}</span>;
}

function useSidebarLifecycleNow(threads: ReadonlyArray<Thread>): string {
  const snoozeDeadlineSignature = useMemo(
    () => threads.map((thread) => thread.snoozedUntil ?? "").join("\n"),
    [threads],
  );
  const [now, setNow] = useState(() => new Date().toISOString());

  useEffect(() => {
    let timeoutId: number | null = null;
    const snoozeDeadlines = snoozeDeadlineSignature.split("\n");

    const clearScheduledRefresh = () => {
      if (timeoutId === null) return;
      window.clearTimeout(timeoutId);
      timeoutId = null;
    };
    const scheduleRefresh = () => {
      clearScheduledRefresh();
      if (document.visibilityState === "hidden") return;
      const currentTime = Date.now();
      timeoutId = window.setTimeout(
        () => {
          timeoutId = null;
          setNow(new Date().toISOString());
          scheduleRefresh();
        },
        getSidebarLifecycleRefreshDelay(snoozeDeadlines, currentTime),
      );
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        clearScheduledRefresh();
        return;
      }
      setNow(new Date().toISOString());
      scheduleRefresh();
    };

    scheduleRefresh();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      clearScheduledRefresh();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [snoozeDeadlineSignature]);

  return now;
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
      harness: CodingHarness;
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
    "sidebar-thread-row group/thread relative h-[30px] w-full translate-x-0 cursor-default justify-start rounded-[9px] px-[9px] text-left select-none focus-visible:ring-1 focus-visible:ring-ring/60",
    interactive && "hover:text-foreground focus-visible:text-foreground",
    isSelected
      ? "bg-primary/15 text-foreground dark:bg-primary/10"
      : isActive
        ? "bg-accent/85 text-foreground font-medium dark:bg-accent/55"
        : isArchived
          ? "text-muted-foreground/70 opacity-80"
          : "text-foreground/80 dark:text-[#dedede]",
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
          : "opacity-0 hover:opacity-100 group-hover/menu-sub-item:opacity-100 focus-visible:opacity-100",
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

function SidebarThreadStatusLabel({
  threadStatus,
}: {
  threadStatus: ReturnType<typeof resolveThreadStatusPill> | null;
}) {
  if (!threadStatus) return null;

  return (
    <span
      role="status"
      aria-label={threadStatus.label}
      className={`inline-flex items-center text-[10px] ${threadStatus.colorClass}`}
    >
      <span className="hidden md:inline">{threadStatus.label}</span>
    </span>
  );
}

function SidebarThreadHoverActions({
  archived,
  bookmarked,
  onToggleArchive,
  onToggleBookmark,
}: {
  archived: boolean;
  bookmarked: boolean;
  onToggleArchive: () => Promise<void>;
  onToggleBookmark: () => Promise<void>;
}) {
  const pendingActionRef = useRef<"archive" | "bookmark" | null>(null);
  const [pendingAction, setPendingAction] = useState<"archive" | "bookmark" | null>(null);

  const runAction = useCallback(
    async (action: "archive" | "bookmark", callback: () => Promise<void>) => {
      if (pendingActionRef.current !== null) return;
      pendingActionRef.current = action;
      setPendingAction(action);
      try {
        await callback();
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to update chat",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      } finally {
        pendingActionRef.current = null;
        setPendingAction(null);
      }
    },
    [],
  );

  const stopMouseEvent = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const stopKeyboardEvent = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };
  const actionClassName =
    "size-7 rounded-[7px] border-transparent p-0 text-muted-foreground/70 before:rounded-[7px] hover:bg-foreground/6 hover:text-foreground focus-visible:bg-foreground/8 focus-visible:text-foreground focus-visible:ring-1 disabled:cursor-default disabled:opacity-35";
  const tooltipClassName =
    "h-7 min-w-[67px] border-white/10 bg-[#2d2d2d] text-xs leading-none font-medium text-white shadow-lg [&_[data-slot=tooltip-viewport]]:flex [&_[data-slot=tooltip-viewport]]:items-center [&_[data-slot=tooltip-viewport]]:justify-center [&_[data-slot=tooltip-viewport]]:py-0";

  return (
    <div
      className="sidebar-thread-hover-actions absolute inset-y-0 -right-[9px] z-20 flex w-14 items-center justify-end"
      data-thread-hover-actions
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-busy={pendingAction === "bookmark"}
              aria-label={bookmarked ? "Unpin chat" : "Pin chat"}
              aria-pressed={bookmarked}
              className={actionClassName}
              disabled={pendingAction !== null}
              onClick={(event) => {
                stopMouseEvent(event);
                void runAction("bookmark", onToggleBookmark);
              }}
              onContextMenu={stopMouseEvent}
              onDoubleClick={stopMouseEvent}
              onKeyDown={stopKeyboardEvent}
              onKeyUp={stopKeyboardEvent}
            />
          }
        >
          <PinIcon className="size-[13px] rotate-45" strokeWidth={1.8} />
        </TooltipTrigger>
        <TooltipPopup side="top" sideOffset={2} className={tooltipClassName}>
          {bookmarked ? "Unpin chat" : "Pin chat"}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-busy={pendingAction === "archive"}
              aria-label={archived ? "Unarchive chat" : "Archive chat"}
              className={actionClassName}
              disabled={pendingAction !== null}
              onClick={(event) => {
                stopMouseEvent(event);
                void runAction("archive", onToggleArchive);
              }}
              onContextMenu={stopMouseEvent}
              onDoubleClick={stopMouseEvent}
              onKeyDown={stopKeyboardEvent}
              onKeyUp={stopKeyboardEvent}
            />
          }
        >
          <ArchiveIcon className="size-[13px]" strokeWidth={1.8} />
        </TooltipTrigger>
        <TooltipPopup side="top" sideOffset={2} className={tooltipClassName}>
          {archived ? "Unarchive chat" : "Archive chat"}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function SidebarThreadRowBody({
  thread,
  threadStatus,
  prStatus,
  terminalStatus,
  hoverActions,
  onOpenPr,
  onTitleDoubleClick,
  showBranchTooltip = true,
  titleEditor,
}: {
  thread: Thread;
  threadStatus: ReturnType<typeof resolveThreadStatusPill> | null;
  prStatus: ReturnType<typeof prStatusIndicator>;
  terminalStatus: ReturnType<typeof terminalStatusFromRunningIds> | null;
  hoverActions?: React.ReactNode;
  onOpenPr?: (event: React.MouseEvent<HTMLElement>, prUrl: string) => void;
  onTitleDoubleClick?: (event: React.MouseEvent<HTMLSpanElement>) => void;
  showBranchTooltip?: boolean;
  titleEditor?: React.ReactNode;
}) {
  const title = titleEditor ?? (
    <span
      className="thread-title-fade block min-w-0 flex-1 overflow-hidden whitespace-nowrap text-[13px] leading-none"
      onDoubleClick={onTitleDoubleClick}
    >
      {thread.title}
    </span>
  );

  return (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        <SidebarThreadStatusLabel threadStatus={threadStatus} />
        {thread.surface === "journey" && (
          <span
            role="img"
            aria-label="Journey"
            title="Journey"
            className="inline-flex items-center justify-center text-violet-600 dark:text-violet-300/90"
          >
            <NetworkIcon className="size-3" />
          </span>
        )}
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
        {prStatus &&
          (onOpenPr ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={prStatus.tooltip}
                    className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
                    onClick={(event) => onOpenPr(event, prStatus.url)}
                  />
                }
              >
                <GitPullRequestIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
            </Tooltip>
          ) : (
            <span
              aria-hidden="true"
              className={`inline-flex items-center justify-center ${prStatus.colorClass}`}
            >
              <GitPullRequestIcon className="size-3" />
            </span>
          ))}
        {thread.archivedAt && <ArchiveIcon className="size-3 shrink-0 text-muted-foreground/55" />}
        {thread.bookmarked && (
          <span role="img" aria-label="Pinned" className="inline-flex shrink-0 items-center">
            <PinIcon
              aria-hidden="true"
              className="size-3 rotate-45 text-muted-foreground/70"
              strokeWidth={1.8}
            />
          </span>
        )}
        {thread.branch && showBranchTooltip && !titleEditor ? (
          <Tooltip disableHoverablePopup>
            <TooltipTrigger render={title as React.ReactElement} />
            <TooltipPopup side="bottom" align="start" sideOffset={6} arrow>
              <span className="inline-flex items-center gap-1.5">
                <GitBranchIcon className="size-3 shrink-0" />
                {formatBranchForDisplay(thread.branch)}
              </span>
            </TooltipPopup>
          </Tooltip>
        ) : (
          title
        )}
      </div>
      <div
        className={cn(
          "sidebar-thread-trailing relative ml-auto h-full shrink-0",
          thread.worktreePath ? "w-[11px]" : "w-0",
        )}
      >
        <WorktreeIndicator
          className="sidebar-thread-worktree absolute top-1/2 right-0 -translate-y-1/2"
          variant="sidebar"
          worktreePath={thread.worktreePath}
        />
        {hoverActions}
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
            {CODING_HARNESS_LABELS[item.harness]}
          </div>
        </div>
      </div>
    );
  }

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
        data-interactive="false"
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
          threadStatus={threadStatus}
          prStatus={prStatus}
          terminalStatus={terminalStatus}
          showBranchTooltip={false}
        />
      </SidebarMenuSubButton>
    </div>
  );
}

function SidebarV2SnoozePopover({
  disabled,
  onSnooze,
}: {
  disabled: boolean;
  onSnooze: (preset: SnoozePreset) => void;
}) {
  const [open, setOpen] = useState(false);
  const presets = useMemo(() => (open ? resolveSnoozePresets(new Date()) : []), [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Snooze thread"
            className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-[var(--sidebar-muted-foreground)] hover:text-[var(--sidebar-foreground)] disabled:cursor-not-allowed disabled:opacity-35"
            disabled={disabled}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          />
        }
      >
        <Clock3Icon className="size-3" />
        Snooze
      </PopoverTrigger>
      <PopoverPopup side="right" align="start" className="w-60">
        <div className="space-y-1">
          <p className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">Snooze until</p>
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
              onClick={() => {
                setOpen(false);
                onSnooze(preset);
              }}
            >
              <span className="flex-1">{preset.label}</span>
              <span className="text-muted-foreground">{preset.whenLabel}</span>
            </button>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export default function Sidebar({ onSearchClick }: { onSearchClick?: () => void }) {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
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
  const projectTerminalCwdByThreadId = useTerminalStateStore(
    (state) => state.projectTerminalCwdByThreadId,
  );
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const storeSetTerminalOpen = useTerminalStateStore((state) => state.setProjectTerminalOpen);
  const clearProjectDraftThreadId = useCallback((_projectId: ProjectId) => {}, []);
  const clearProjectDraftThreadById = useCallback(
    (_projectId: ProjectId, _threadId: ThreadId) => {},
    [],
  );
  const setThreadArchived = useStore((store) => store.setThreadArchived);
  const setThreadBookmarked = useStore((store) => store.setThreadBookmarked);
  const setThreadSettled = useStore((store) => store.setThreadSettled);
  const setThreadSnoozed = useStore((store) => store.setThreadSnoozed);
  const navigate = useNavigate();
  const isOnSettings = useLocation({ select: (loc) => loc.pathname === "/settings" });
  const { settings: appSettings } = useAppSettings();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const { data: serverConfig } = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfig?.keybindings ?? EMPTY_KEYBINDINGS;
  const maxActiveHarnessSessions =
    serverConfig?.settings.maxActiveHarnessSessions ?? DEFAULT_ACTIVE_HARNESS_SESSION_CAP;
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
  const [projectScopeId, setProjectScopeId] = useState<ProjectId | null>(null);
  const [snoozedShelfExpanded, setSnoozedShelfExpanded] = useState(false);
  const [settledShelfExpanded, setSettledShelfExpanded] = useState(true);
  const [settledVisibleCount, setSettledVisibleCount] = useState(10);
  const lifecycleNow = useSidebarLifecycleNow(threads);
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
  const [activeDragOverlaySize, setActiveDragOverlaySize] = useState<SidebarDragOverlaySize | null>(
    null,
  );
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false);
  const [showArchivedThreads, setShowArchivedThreads] = useState(false);
  const [purgeDialogOpen, setPurgeDialogOpen] = useState(false);
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
  useEffect(() => {
    if (projectScopeId !== null && !projects.some((project) => project.id === projectScopeId)) {
      setProjectScopeId(null);
    }
  }, [projectScopeId, projects]);
  const visibleSidebarThreads = useMemo(
    () => (showArchivedThreads ? threads : threads.filter((thread) => thread.archivedAt === null)),
    [showArchivedThreads, threads],
  );
  const activeHarnessSessionStats = useMemo(
    () =>
      getActiveHarnessSessionStats({
        threads,
        maxActivePerHarness: maxActiveHarnessSessions,
      }),
    [maxActiveHarnessSessions, threads],
  );
  const projectCwdById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.cwd] as const)),
    [projects],
  );
  const toggleProjectTerminalForCwd = useCallback(
    (projectId: ProjectId, cwd: string) => {
      const syntheticId = projectTerminalThreadId(projectId);
      const terminalStore = useTerminalStateStore.getState();
      const terminalState = selectThreadTerminalState(
        terminalStore.terminalStateByThreadId,
        syntheticId,
      );
      const currentCwd =
        terminalStore.projectTerminalCwdByThreadId[syntheticId] ??
        projectCwdById.get(projectId) ??
        null;
      const shouldClose = terminalState.terminalOpen && currentCwd === cwd;
      storeSetTerminalOpen(syntheticId, !shouldClose, cwd);
    },
    [projectCwdById, storeSetTerminalOpen],
  );
  const potentialThreadGitTargets = useMemo(
    () =>
      threads
        .filter(
          (thread) =>
            thread.archivedAt === null &&
            (!SIDEBAR_V2_ENABLED ||
              projectScopeId === null ||
              thread.projectId === projectScopeId ||
              thread.id === routeThreadId),
        )
        .map((thread) => ({
          threadId: thread.id,
          branch: thread.branch,
          cwd: thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null,
        })),
    [projectCwdById, projectScopeId, routeThreadId, threads],
  );
  const cachedPrSignature = potentialThreadGitTargets
    .map((target) => {
      const status = target.cwd
        ? queryClient.getQueryData<GitStatusResult>(gitStatusQueryOptions(target.cwd).queryKey)
        : undefined;
      return `${target.threadId}\0${status?.branch ?? ""}\0${JSON.stringify(status?.pr ?? null)}`;
    })
    .join("\u0001");
  const cachedPrByThreadId = useMemo(() => {
    // React Query owns the mutable cache; this signature is its memoization version.
    void cachedPrSignature;
    const map = new Map<ThreadId, ThreadPr>();
    for (const target of potentialThreadGitTargets) {
      const status = target.cwd
        ? queryClient.getQueryData<GitStatusResult>(gitStatusQueryOptions(target.cwd).queryKey)
        : undefined;
      const branchMatches =
        target.branch !== null && status?.branch !== null && status?.branch === target.branch;
      map.set(target.threadId, branchMatches ? (status?.pr ?? null) : null);
    }
    return map;
  }, [cachedPrSignature, potentialThreadGitTargets, queryClient]);
  const cachedChangeRequestStateByThreadId = useMemo(
    () =>
      new Map(
        [...cachedPrByThreadId].map(([threadId, pr]) => [threadId, pr?.state ?? null] as const),
      ),
    [cachedPrByThreadId],
  );
  const preliminaryLifecyclePartitions = useMemo(
    () =>
      partitionSidebarLifecycleThreads({
        threads,
        projectScopeId,
        showArchivedThreads,
        now: lifecycleNow,
        autoSettleAfterDays: appSettings.sidebarAutoSettleAfterDays,
        pendingApprovalByThreadId,
        pendingUserInputByThreadId,
        changeRequestStateByThreadId: cachedChangeRequestStateByThreadId,
      }),
    [
      appSettings.sidebarAutoSettleAfterDays,
      cachedChangeRequestStateByThreadId,
      lifecycleNow,
      pendingApprovalByThreadId,
      pendingUserInputByThreadId,
      projectScopeId,
      showArchivedThreads,
      threads,
    ],
  );
  const relevantGitThreadIds = useMemo(() => {
    const relevant = new Set<ThreadId>();
    if (SIDEBAR_V2_ENABLED) {
      for (const thread of preliminaryLifecyclePartitions.active) {
        relevant.add(thread.id);
      }
      if (snoozedShelfExpanded) {
        for (const thread of preliminaryLifecyclePartitions.snoozed) {
          relevant.add(thread.id);
        }
      }
      if (settledShelfExpanded) {
        for (const thread of preliminaryLifecyclePartitions.settled.slice(0, settledVisibleCount)) {
          relevant.add(thread.id);
        }
      }
    } else {
      for (const project of projects) {
        if (!project.expanded) continue;
        const projectThreads = orderThreadsForProject(
          threads.filter((thread) => thread.archivedAt === null && thread.projectId === project.id),
          threadOrderByProject[project.id],
        );
        const visibleThreads = expandedThreadListsByProject.has(project.id)
          ? projectThreads
          : projectThreads.slice(0, THREAD_PREVIEW_LIMIT);
        for (const thread of visibleThreads) {
          relevant.add(thread.id);
        }
      }
    }
    if (routeThreadId !== null) {
      relevant.add(routeThreadId);
    }
    return relevant;
  }, [
    expandedThreadListsByProject,
    preliminaryLifecyclePartitions,
    projects,
    routeThreadId,
    settledShelfExpanded,
    settledVisibleCount,
    snoozedShelfExpanded,
    threadOrderByProject,
    threads,
  ]);
  const threadGitTargets = useMemo(
    () => potentialThreadGitTargets.filter((target) => relevantGitThreadIds.has(target.threadId)),
    [potentialThreadGitTargets, relevantGitThreadIds],
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

    const map = new Map(cachedPrByThreadId);
    for (const target of threadGitTargets) {
      const status = target.cwd ? statusByCwd.get(target.cwd) : undefined;
      if (!status) continue;
      const branchMatches =
        target.branch !== null && status?.branch !== null && status?.branch === target.branch;
      map.set(target.threadId, branchMatches ? (status?.pr ?? null) : null);
    }
    return map;
  }, [cachedPrByThreadId, threadGitStatusCwds, threadGitStatusQueries, threadGitTargets]);
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project] as const)),
    [projects],
  );
  const changeRequestStateByThreadId = useMemo(
    () =>
      new Map([...prByThreadId].map(([threadId, pr]) => [threadId, pr?.state ?? null] as const)),
    [prByThreadId],
  );
  const lifecyclePartitions = useMemo(
    () =>
      partitionSidebarLifecycleThreads({
        threads,
        projectScopeId,
        showArchivedThreads,
        now: lifecycleNow,
        autoSettleAfterDays: appSettings.sidebarAutoSettleAfterDays,
        pendingApprovalByThreadId,
        pendingUserInputByThreadId,
        changeRequestStateByThreadId,
      }),
    [
      appSettings.sidebarAutoSettleAfterDays,
      changeRequestStateByThreadId,
      lifecycleNow,
      pendingApprovalByThreadId,
      pendingUserInputByThreadId,
      projectScopeId,
      showArchivedThreads,
      threads,
    ],
  );
  const orderedLifecycleThreadIds = useMemo(
    () =>
      [
        ...lifecyclePartitions.active,
        ...lifecyclePartitions.snoozed,
        ...lifecyclePartitions.settled,
        ...lifecyclePartitions.archived,
      ].map((thread) => thread.id),
    [lifecyclePartitions],
  );
  useEffect(() => {
    if (routeThreadId === null) return;
    if (lifecyclePartitions.snoozed.some((thread) => thread.id === routeThreadId)) {
      setSnoozedShelfExpanded(true);
    }
    const settledIndex = lifecyclePartitions.settled.findIndex(
      (thread) => thread.id === routeThreadId,
    );
    if (settledIndex >= 0) {
      setSettledShelfExpanded(true);
      setSettledVisibleCount((current) => Math.max(current, settledIndex + 1));
    }
  }, [lifecyclePartitions.settled, lifecyclePartitions.snoozed, routeThreadId]);

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

  const handleNewThread = useNewThreadHandler();

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

  const handlePickFolder = useCallback(async () => {
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
  }, [addProjectFromPath, isPickingFolder, shouldBrowseForProjectImmediately]);

  const handleStartAddProject = useCallback(() => {
    setAddProjectError(null);
    if (shouldBrowseForProjectImmediately) {
      void handlePickFolder();
      return;
    }
    setAddingProject((prev) => !prev);
  }, [handlePickFolder, shouldBrowseForProjectImmediately]);

  useEffect(
    () =>
      subscribeProjectAddRequests(() => {
        setAddProjectError(null);
        if (shouldBrowseForProjectImmediately) {
          void handlePickFolder();
          return;
        }
        setAddingProject(true);
      }),
    [handlePickFolder, shouldBrowseForProjectImmediately],
  );

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
        await dispatchThreadArchiveUpdate(api, threadId, archivedAt);
        setThreadArchived(threadId, archivedAt);
        if (archivedAt !== null) {
          removeFromSelection([threadId]);
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: archivedAt ? "Failed to archive thread" : "Failed to unarchive thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [
      clearTerminalState,
      getTopUnarchivedThreadForProject,
      navigate,
      removeFromSelection,
      routeThreadId,
      setThreadArchived,
      threads,
    ],
  );

  const settlingThreadIdsRef = useRef(new Set<ThreadId>());
  const snoozingThreadIdsRef = useRef(new Set<ThreadId>());
  const navigateAfterParking = useCallback(
    async (threadId: ThreadId) => {
      if (routeThreadId !== threadId) return;
      const nextThread = lifecyclePartitions.active.find((thread) => thread.id !== threadId);
      if (nextThread) {
        await navigate({
          to: "/$threadId",
          params: { threadId: nextThread.id },
          replace: true,
        });
        return;
      }
      const currentThread = threads.find((thread) => thread.id === threadId);
      const projectId = projectScopeId ?? currentThread?.projectId ?? projects[0]?.id;
      if (projectId) {
        await handleNewThread(projectId);
      } else {
        await navigate({ to: "/", replace: true });
      }
    },
    [
      handleNewThread,
      lifecyclePartitions.active,
      navigate,
      projectScopeId,
      projects,
      routeThreadId,
      threads,
    ],
  );
  const settleThread = useCallback(
    async (threadId: ThreadId): Promise<void> => {
      if (settlingThreadIdsRef.current.has(threadId)) return;
      const thread = useStore.getState().threads.find((entry) => entry.id === threadId);
      const api = readNativeApi();
      if (!thread || !api) return;
      const blockers = {
        hasPendingApprovals: pendingApprovalByThreadId.get(threadId) === true,
        hasPendingUserInput: pendingUserInputByThreadId.get(threadId) === true,
      };
      if (!canSettleThread(thread, blockers, { now: new Date().toISOString() })) {
        toastManager.add({
          type: "warning",
          title: "Thread cannot be settled yet",
          description: "Finish or respond to its active work first.",
        });
        return;
      }
      settlingThreadIdsRef.current.add(threadId);
      const previous = {
        settledOverride: thread.settledOverride,
        settledAt: thread.settledAt,
      };
      const settledAt = new Date().toISOString();
      setThreadSettled(threadId, "settled", settledAt);
      try {
        await dispatchThreadSettle(api, threadId);
        await navigateAfterParking(threadId);
      } catch (error) {
        setThreadSettled(threadId, previous.settledOverride, previous.settledAt);
        toastManager.add({
          type: "error",
          title: "Failed to settle thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      } finally {
        settlingThreadIdsRef.current.delete(threadId);
      }
    },
    [navigateAfterParking, pendingApprovalByThreadId, pendingUserInputByThreadId, setThreadSettled],
  );
  const unsettleThread = useCallback(
    async (threadId: ThreadId): Promise<void> => {
      const thread = useStore.getState().threads.find((entry) => entry.id === threadId);
      const api = readNativeApi();
      if (!thread || !api) return;
      const previous = {
        settledOverride: thread.settledOverride,
        settledAt: thread.settledAt,
      };
      setThreadSettled(threadId, "active", null);
      try {
        await dispatchThreadUnsettle(api, threadId);
      } catch (error) {
        setThreadSettled(threadId, previous.settledOverride, previous.settledAt);
        toastManager.add({
          type: "error",
          title: "Failed to un-settle thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [setThreadSettled],
  );
  const snoozeThread = useCallback(
    async (threadId: ThreadId, preset: SnoozePreset): Promise<void> => {
      if (snoozingThreadIdsRef.current.has(threadId)) return;
      const thread = useStore.getState().threads.find((entry) => entry.id === threadId);
      const api = readNativeApi();
      if (!thread || !api) return;
      const blockers = {
        hasPendingApprovals: pendingApprovalByThreadId.get(threadId) === true,
        hasPendingUserInput: pendingUserInputByThreadId.get(threadId) === true,
      };
      if (!canSnoozeThread(thread, blockers, { now: new Date().toISOString() })) {
        toastManager.add({
          type: "warning",
          title: "Thread cannot be snoozed",
          description: "Respond to its pending approval or input request first.",
        });
        return;
      }
      snoozingThreadIdsRef.current.add(threadId);
      const previous = {
        snoozedUntil: thread.snoozedUntil,
        snoozedAt: thread.snoozedAt,
      };
      const snoozedAt = new Date().toISOString();
      setThreadSnoozed(threadId, preset.snoozedUntil, snoozedAt);
      try {
        await dispatchThreadSnooze(api, threadId, preset.snoozedUntil);
        toastManager.add({
          type: "success",
          title: `Snoozed until ${preset.whenLabel}`,
        });
        await navigateAfterParking(threadId);
      } catch (error) {
        setThreadSnoozed(threadId, previous.snoozedUntil, previous.snoozedAt);
        toastManager.add({
          type: "error",
          title: "Failed to snooze thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      } finally {
        snoozingThreadIdsRef.current.delete(threadId);
      }
    },
    [navigateAfterParking, pendingApprovalByThreadId, pendingUserInputByThreadId, setThreadSnoozed],
  );
  const unsnoozeThread = useCallback(
    async (threadId: ThreadId): Promise<void> => {
      const thread = useStore.getState().threads.find((entry) => entry.id === threadId);
      const api = readNativeApi();
      if (!thread || !api) return;
      const previous = {
        snoozedUntil: thread.snoozedUntil,
        snoozedAt: thread.snoozedAt,
      };
      setThreadSnoozed(threadId, null, null);
      try {
        await dispatchThreadUnsnooze(api, threadId);
      } catch (error) {
        setThreadSnoozed(threadId, previous.snoozedUntil, previous.snoozedAt);
        toastManager.add({
          type: "error",
          title: "Failed to wake thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [setThreadSnoozed],
  );

  const toggleThreadBookmark = useCallback(
    async (threadId: ThreadId): Promise<void> => {
      const api = readNativeApi();
      if (!api) return;

      const thread = useStore.getState().threads.find((entry) => entry.id === threadId);
      if (!thread) return;

      const wasBookmarked = thread.bookmarked;
      const bookmarked = !wasBookmarked;
      setThreadBookmarked(threadId, bookmarked);

      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId,
          bookmarked,
        });
      } catch (error) {
        const currentThread = useStore.getState().threads.find((entry) => entry.id === threadId);
        if (currentThread?.bookmarked === bookmarked) {
          setThreadBookmarked(threadId, wasBookmarked);
        }
        toastManager.add({
          type: "error",
          title: bookmarked ? "Failed to pin chat" : "Failed to unpin chat",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [setThreadBookmarked],
  );

  const handleThreadContextMenu = useCallback(
    async (threadId: ThreadId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = threads.find((t) => t.id === threadId);
      if (!thread) return;

      const worktreePath = thread.worktreePath;
      const projectTerminalId = projectTerminalThreadId(thread.projectId);
      const terminalStore = useTerminalStateStore.getState();
      const projectTerminalState = selectThreadTerminalState(
        terminalStore.terminalStateByThreadId,
        projectTerminalId,
      );
      const projectCwd = projectCwdById.get(thread.projectId) ?? null;
      const projectTerminalCwd =
        terminalStore.projectTerminalCwdByThreadId[projectTerminalId] ?? projectCwd;
      const isWorktreeTerminalOpen =
        worktreePath !== null &&
        projectTerminalState.terminalOpen &&
        projectTerminalCwd === worktreePath;
      const lifecycleBlockers = {
        hasPendingApprovals: pendingApprovalByThreadId.get(thread.id) === true,
        hasPendingUserInput: pendingUserInputByThreadId.get(thread.id) === true,
      };
      const isSnoozed = effectiveSnoozed(thread, lifecycleBlockers, { now: lifecycleNow });
      const isSettled =
        !isSnoozed &&
        effectiveSettled(thread, lifecycleBlockers, {
          now: lifecycleNow,
          autoSettleAfterDays: appSettings.sidebarAutoSettleAfterDays,
          changeRequestState: prByThreadId.get(thread.id)?.state ?? null,
        });
      const snoozePresets = resolveSnoozePresets(new Date());
      const lifecycleAvailable = thread.archivedAt === null;
      const snoozeAvailable =
        lifecycleAvailable &&
        !isSnoozed &&
        canSnoozeThread(thread, lifecycleBlockers, { now: lifecycleNow });

      const clicked = await api.contextMenu.show(
        [
          ...(lifecycleAvailable
            ? [
                isSettled
                  ? { id: "unsettle", label: "Un-settle thread" }
                  : { id: "settle", label: "Settle thread" },
                ...(isSnoozed
                  ? [{ id: "unsnooze", label: "Wake thread" }]
                  : snoozeAvailable
                    ? snoozePresets.map((preset) => ({
                        id: `snooze:${preset.id}`,
                        label: `Snooze — ${preset.label} (${preset.whenLabel})`,
                      }))
                    : []),
              ]
            : []),
          { id: "rename", label: "Rename thread" },
          { id: "archive", label: thread.archivedAt ? "Unarchive chat" : "Archive chat" },
          { id: "bookmark", label: thread.bookmarked ? "Unpin chat" : "Pin chat" },
          ...(worktreePath
            ? [
                {
                  id: "worktree-terminal",
                  label: isWorktreeTerminalOpen
                    ? "Close project terminal in worktree"
                    : "Open project terminal in worktree",
                },
              ]
            : []),
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

      if (clicked === "settle") {
        await settleThread(threadId);
        return;
      }

      if (clicked === "unsettle") {
        await unsettleThread(threadId);
        return;
      }

      if (clicked === "unsnooze") {
        await unsnoozeThread(threadId);
        return;
      }

      if (clicked?.startsWith("snooze:")) {
        const preset = snoozePresets.find((candidate) => `snooze:${candidate.id}` === clicked);
        if (preset) await snoozeThread(threadId, preset);
        return;
      }

      if (clicked === "archive") {
        await archiveThread(threadId, thread.archivedAt ? null : new Date().toISOString());
        return;
      }

      if (clicked === "bookmark") {
        await toggleThreadBookmark(threadId);
        return;
      }

      if (clicked === "worktree-terminal" && worktreePath) {
        toggleProjectTerminalForCwd(thread.projectId, worktreePath);
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
    [
      appSettings.confirmThreadDelete,
      appSettings.sidebarAutoSettleAfterDays,
      archiveThread,
      deleteThread,
      lifecycleNow,
      markThreadUnread,
      pendingApprovalByThreadId,
      pendingUserInputByThreadId,
      prByThreadId,
      projectCwdById,
      settleThread,
      snoozeThread,
      startRenameThread,
      threads,
      toggleProjectTerminalForCwd,
      toggleThreadBookmark,
      unsettleThread,
      unsnoozeThread,
    ],
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
      // If the route remounts, dispatch after navigation so the new terminal
      // listener can catch the resize-style recovery signal.
      if (routeThreadId === threadId) {
        dispatchThreadSelectedEvent(threadId);
      } else {
        dispatchThreadSelectedEventAfterRouteChange(threadId);
      }
    },
    [
      clearSelection,
      navigate,
      rangeSelectTo,
      routeThreadId,
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
        const activeThread = routeThreadId
          ? threads.find((thread) => thread.id === routeThreadId)
          : null;
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

      const confirmed = await api.dialogs.confirm(
        (projectThreads.length > 0
          ? [
              `Remove project "${project.name}" from Clui?`,
              `Its ${projectThreads.length} thread${projectThreads.length === 1 ? "" : "s"} will be kept and restored if you add this folder again.`,
            ]
          : [`Delete project "${project.name}"?`, "This action cannot be undone."]
        ).join("\n"),
      );
      if (!confirmed) return;

      const activeThread = routeThreadId
        ? threads.find((thread) => thread.id === routeThreadId)
        : null;
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
          type: "project.delete",
          commandId: newCommandId(),
          projectId,
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

  const defaultNewThreadProjectId =
    projectScopeId ??
    (routeThreadId
      ? (threads.find((thread) => thread.id === routeThreadId)?.projectId ?? null)
      : null) ??
    projects[0]?.id ??
    null;
  const renderSidebarV2Thread = (
    thread: Thread,
    section: "active" | "snoozed" | "settled" | "archived",
  ) => {
    const project = projectById.get(thread.projectId);
    if (!project) return null;
    const isCard = section === "active";
    const isActive = routeThreadId === thread.id;
    const isSelected = selectedThreadIds.has(thread.id);
    const blockers = {
      hasPendingApprovals: pendingApprovalByThreadId.get(thread.id) === true,
      hasPendingUserInput: pendingUserInputByThreadId.get(thread.id) === true,
    };
    const status = resolveSidebarV2Status({ thread, ...blockers });
    const terminalWorkingStartedAt =
      getGlobalSessionEventState()?.getWorkingStartedAt(thread.id) ?? null;
    const workingStartedAt =
      terminalWorkingStartedAt === null
        ? resolveWorkingStartedAt(thread)
        : new Date(terminalWorkingStartedAt).toISOString();
    const isUnread = hasUnseenCompletion(thread);
    const wokeAt = threadWokeAt(thread, blockers, { now: lifecycleNow });
    const wokeAtTime = wokeAt === null ? Number.NaN : Date.parse(wokeAt);
    const lastVisitedTime =
      thread.lastVisitedAt === undefined ? Number.NaN : Date.parse(thread.lastVisitedAt);
    const isWoke =
      Number.isFinite(wokeAtTime) &&
      (!Number.isFinite(lastVisitedTime) || lastVisitedTime < wokeAtTime);
    const isInFlight = status === "working" || status === "approval" || status === "input";
    const shouldRecede =
      (status === "ready" || isInFlight) && !isUnread && !isWoke && !isActive && !isSelected;
    const topStatus =
      resolveSidebarV2TopStatus(status) ??
      (isWoke
        ? {
            label: "Woke",
            icon: "woke" as const,
            className: "text-amber-700 dark:text-amber-300",
          }
        : isUnread
          ? {
              label: "Done",
              icon: "done" as const,
              className: "text-emerald-700 dark:text-emerald-300",
            }
          : null);
    const pr = prByThreadId.get(thread.id) ?? null;
    const prStatus = prStatusIndicator(pr);
    const canSettle = canSettleThread(thread, blockers, { now: lifecycleNow });
    const canSnooze = canSnoozeThread(thread, blockers, { now: lifecycleNow });
    const title =
      renamingThreadId === thread.id ? (
        <input
          ref={(element) => {
            if (element && renamingInputRef.current !== element) {
              renamingInputRef.current = element;
              element.focus();
              element.select();
            }
          }}
          className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground outline-none focus:border-foreground"
          value={renamingTitle}
          onChange={(event) => setRenamingTitle(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              renamingCommittedRef.current = true;
              void commitRename(thread.id, renamingTitle, thread.title);
            } else if (event.key === "Escape") {
              event.preventDefault();
              renamingCommittedRef.current = true;
              cancelRename();
            }
          }}
          onBlur={() => {
            if (!renamingCommittedRef.current) {
              void commitRename(thread.id, renamingTitle, thread.title);
            }
          }}
          onClick={(event) => event.stopPropagation()}
        />
      ) : (
        <span
          className={cn(
            "min-w-0 flex-1 text-sm",
            shouldRecede ? "font-normal" : "font-medium",
            isCard
              ? cn(
                  "truncate",
                  isUnread || isWoke
                    ? "text-foreground"
                    : shouldRecede
                      ? "text-muted-foreground/80"
                      : status === "failed"
                        ? "text-foreground/95"
                        : "text-foreground/90",
                )
              : cn(
                  "truncate group-hover/v2-row:text-foreground",
                  isActive || isWoke
                    ? "text-foreground"
                    : isUnread
                      ? "text-muted-foreground"
                      : "text-muted-foreground/70",
                ),
          )}
        >
          {thread.title}
        </span>
      );
    const prBadge =
      prStatus && pr ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={prStatus.tooltip}
                className={cn(
                  "shrink-0 cursor-pointer font-mono text-xs hover:underline",
                  isCard
                    ? prStatus.colorClass
                    : cn(
                        "text-muted-foreground/35 transition-colors",
                        settledPrHoverColorClass(pr.state),
                      ),
                )}
                onClick={(event) => openPrLink(event, prStatus.url)}
              />
            }
          >
            #{pr.number}
          </TooltipTrigger>
          <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
        </Tooltip>
      ) : null;
    const activateThread = () => {
      if (selectedThreadIds.size > 0) clearSelection();
      setSelectionAnchor(thread.id);
      void navigate({ to: "/$threadId", params: { threadId: thread.id } });
      if (routeThreadId === thread.id) {
        dispatchThreadSelectedEvent(thread.id);
      } else {
        dispatchThreadSelectedEventAfterRouteChange(thread.id);
      }
    };
    const rowProps = {
      onClick: (event: React.MouseEvent<HTMLElement>) =>
        handleThreadClick(event, thread.id, orderedLifecycleThreadIds),
      onDoubleClick: (event: React.MouseEvent<HTMLElement>) => {
        if ((event.target as HTMLElement).closest("button, a, input")) return;
        event.preventDefault();
        startRenameThread(thread);
      },
      onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        activateThread();
      },
      onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
        event.preventDefault();
        if (selectedThreadIds.size > 0 && selectedThreadIds.has(thread.id)) {
          void handleMultiSelectContextMenu({ x: event.clientX, y: event.clientY });
          return;
        }
        if (selectedThreadIds.size > 0) clearSelection();
        void handleThreadContextMenu(thread.id, { x: event.clientX, y: event.clientY });
      },
    };
    const rowSurface = cn(
      "group/v2-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none",
      isActive
        ? "bg-[var(--sidebar-row-active)] text-[var(--sidebar-foreground)]"
        : isSelected
          ? "bg-[var(--sidebar-row-selected)] text-[var(--sidebar-foreground)]"
          : section === "archived"
            ? "text-[color-mix(in_srgb,var(--sidebar-muted-foreground)_65%,transparent)] hover:bg-[var(--sidebar-row-hover)] hover:text-[var(--sidebar-foreground)]"
            : shouldRecede
              ? "text-[color-mix(in_srgb,var(--sidebar-muted-foreground)_75%,transparent)] hover:bg-[var(--sidebar-row-hover)] hover:text-[var(--sidebar-foreground)]"
              : "bg-transparent text-[var(--sidebar-foreground)] hover:bg-[var(--sidebar-row-hover)]",
      isInFlight && !isActive && !isSelected && "opacity-70 transition-opacity hover:opacity-100",
    );

    if (!isCard) {
      return (
        <li
          key={`${thread.id}:${section}`}
          className="list-none [content-visibility:auto] [contain-intrinsic-size:auto_36px]"
        >
          <div
            role="button"
            tabIndex={0}
            data-testid={`sidebar-v2-row-${section}`}
            className={cn(rowSurface, "flex h-9 items-center gap-2.5 px-2.5")}
            {...rowProps}
          >
            <span className="shrink-0 opacity-40 grayscale transition-all group-hover/v2-row:opacity-100 group-hover/v2-row:grayscale-0">
              <ProjectFavicon cwd={project.cwd} />
            </span>
            {title}
            {prBadge}
            <span className="relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end">
              <span className="text-xs text-muted-foreground/55 tabular-nums transition-opacity group-hover/v2-row:opacity-0">
                {section === "snoozed" && thread.snoozedUntil ? (
                  snoozeWakeLabel(thread.snoozedUntil, new Date(lifecycleNow))
                ) : isWoke ? (
                  <span
                    role="status"
                    aria-label="Woke from snooze"
                    className="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-300"
                  >
                    <AlarmClockIcon className="size-3" />
                    Woke
                  </span>
                ) : section === "archived" && thread.archivedAt ? (
                  formatRelativeTime(thread.archivedAt)
                ) : (
                  formatRelativeTime(thread.settledAt ?? thread.lastInteractedAt)
                )}
              </span>
              {section === "snoozed" ? (
                <button
                  type="button"
                  aria-label="Wake thread now"
                  className="absolute inset-y-0 right-0 inline-flex items-center rounded-md px-2 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/v2-row:opacity-100"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void unsnoozeThread(thread.id);
                  }}
                >
                  <AlarmClockOffIcon className="size-3" />
                </button>
              ) : section === "settled" ? (
                <button
                  type="button"
                  aria-label="Un-settle thread"
                  className="absolute inset-y-0 right-0 inline-flex items-center rounded-md px-2 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/v2-row:opacity-100"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void unsettleThread(thread.id);
                  }}
                >
                  <Undo2Icon className="size-3" />
                </button>
              ) : (
                <button
                  type="button"
                  aria-label="Unarchive thread"
                  className="absolute inset-y-0 right-0 inline-flex items-center rounded-md px-2 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/v2-row:opacity-100"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void archiveThread(thread.id, null);
                  }}
                >
                  <ArchiveIcon className="size-3" />
                </button>
              )}
            </span>
          </div>
        </li>
      );
    }

    return (
      <li
        key={`${thread.id}:${section}`}
        className="list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_82px]"
      >
        <div
          role="button"
          tabIndex={0}
          data-testid="sidebar-v2-row-card"
          className={rowSurface}
          {...rowProps}
        >
          <div className="relative z-10 h-[4.875rem] px-2.5 py-2">
            <div className="flex h-5 min-w-0 items-center gap-1.5">
              <ProjectFavicon cwd={project.cwd} />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs text-muted-foreground/85",
                  shouldRecede ? "font-normal" : "font-medium",
                )}
              >
                {project.name}
              </span>
              {thread.bookmarked ? (
                <PinIcon
                  aria-label="Pinned"
                  className="size-3 shrink-0 rotate-45 text-muted-foreground/60"
                />
              ) : null}
              <span className="relative ml-auto flex h-5 min-w-8 shrink-0 items-center justify-end pl-1 text-xs">
                <span className="tabular-nums text-muted-foreground/65 transition-opacity group-hover/v2-row:opacity-0">
                  {topStatus ? (
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 font-medium",
                        topStatus.className,
                      )}
                    >
                      {topStatus.icon === "working" ? (
                        <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
                      ) : topStatus.icon === "done" ? (
                        <CircleCheckIcon aria-hidden className="size-4 shrink-0" />
                      ) : topStatus.icon === "woke" ? (
                        <AlarmClockIcon aria-hidden className="size-4 shrink-0" />
                      ) : null}
                      <span role="status">{topStatus.label}</span>
                      {status === "working" ? (
                        <span aria-hidden>
                          <WorkingDuration startedAt={workingStartedAt} />
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    formatRelativeTime(threadLastActivityAt(thread) ?? thread.createdAt)
                  )}
                </span>
                <span className="absolute inset-y-0 right-0 flex items-stretch gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/v2-row:opacity-100">
                  <SidebarV2SnoozePopover
                    disabled={!canSnooze}
                    onSnooze={(preset) => void snoozeThread(thread.id, preset)}
                  />
                  <button
                    type="button"
                    aria-label="Settle thread"
                    className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-[var(--sidebar-muted-foreground)] hover:text-[var(--sidebar-foreground)] disabled:cursor-not-allowed disabled:opacity-35"
                    disabled={!canSettle}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void settleThread(thread.id);
                    }}
                  >
                    <CheckIcon className="size-3" />
                    Settle
                  </button>
                </span>
              </span>
            </div>
            <div className="mt-1 flex min-w-0">{title}</div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/75">
              {thread.branch ? (
                <span className="min-w-0 flex-1 truncate whitespace-nowrap">{thread.branch}</span>
              ) : (
                <span className="flex-1" />
              )}
              {prBadge}
              <HarnessIcon
                harness={thread.harness}
                className="ml-auto size-3.5 shrink-0 opacity-60"
              />
            </div>
          </div>
        </div>
      </li>
    );
  };

  if (SIDEBAR_V2_ENABLED) {
    const visibleSettledThreads = lifecyclePartitions.settled.slice(0, settledVisibleCount);
    const selectedProject = projectScopeId ? projectById.get(projectScopeId) : null;
    return (
      <div className="contents" data-sidebar-version="v2">
        <PurgeSessionsDialog
          open={purgeDialogOpen}
          onOpenChange={setPurgeDialogOpen}
          routeThreadId={routeThreadId}
        />
        {isElectron ? (
          <SidebarHeader className="drag-region h-[52px] flex-row items-center gap-2 px-4 py-0 pl-[90px]">
            {wordmark}
          </SidebarHeader>
        ) : (
          <SidebarHeader className="gap-3 px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-3">
            {wordmark}
          </SidebarHeader>
        )}

        <SidebarContent className="gap-0">
          {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
            <SidebarGroup className="px-2 pt-2 pb-0">
              <Alert variant="warning" className="rounded-xl border-warning/40 bg-warning/8">
                <TriangleAlertIcon />
                <AlertTitle>Intel build on Apple Silicon</AlertTitle>
                <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
              </Alert>
            </SidebarGroup>
          ) : null}

          <SidebarGroup className="px-2 py-2">
            <div className="mb-1 flex items-center gap-1.5">
              <button
                type="button"
                className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md bg-[var(--sidebar-control-surface)] px-2 text-xs text-[var(--sidebar-muted-foreground)] hover:text-[var(--sidebar-foreground)]"
                onClick={onSearchClick}
              >
                <SearchIcon className="size-3.5" />
                <span>Search</span>
                {searchShortcutLabel ? (
                  <kbd className="ml-auto text-[10px] opacity-60">{searchShortcutLabel}</kbd>
                ) : null}
              </button>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="New thread"
                      className="inline-flex size-8 items-center justify-center rounded-md bg-[var(--sidebar-control-surface)] text-[var(--sidebar-muted-foreground)] hover:text-[var(--sidebar-foreground)] disabled:opacity-35"
                      disabled={defaultNewThreadProjectId === null}
                      onClick={() => {
                        if (defaultNewThreadProjectId)
                          void handleNewThread(defaultNewThreadProjectId);
                      }}
                    />
                  }
                >
                  <SquarePenIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="right">
                  {newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"}
                </TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={
                        showArchivedThreads ? "Hide archived threads" : "Show archived threads"
                      }
                      aria-pressed={showArchivedThreads}
                      className={cn(
                        "inline-flex size-8 items-center justify-center rounded-md bg-[var(--sidebar-control-surface)] text-[var(--sidebar-muted-foreground)] hover:text-[var(--sidebar-foreground)]",
                        showArchivedThreads && "text-[var(--sidebar-foreground)]",
                      )}
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
            </div>

            <div className="mb-1 flex items-center gap-1.5">
              <Popover>
                <PopoverTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Filter threads by project"
                      className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md bg-[var(--sidebar-control-surface)] px-2 text-xs text-[var(--sidebar-muted-foreground)] hover:text-[var(--sidebar-foreground)]"
                    />
                  }
                >
                  <FolderIcon className="size-3.5" />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {selectedProject?.name ?? "All projects"}
                  </span>
                  <ChevronDownIcon className="size-3.5" />
                </PopoverTrigger>
                <PopoverPopup side="bottom" align="start" className="w-64">
                  <div className="space-y-1">
                    <button
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent",
                        projectScopeId === null && "bg-accent",
                      )}
                      onClick={() => setProjectScopeId(null)}
                    >
                      <FolderIcon className="size-3.5 text-muted-foreground" />
                      <span className="flex-1">All projects</span>
                    </button>
                    {projects.map((project) => (
                      <div key={project.id} className="flex items-center gap-1">
                        <button
                          type="button"
                          className={cn(
                            "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent",
                            projectScopeId === project.id && "bg-accent",
                          )}
                          onClick={() => setProjectScopeId(project.id)}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            void handleProjectContextMenu(project.id, {
                              x: event.clientX,
                              y: event.clientY,
                            });
                          }}
                        >
                          <ProjectFavicon cwd={project.cwd} />
                          <span className="min-w-0 flex-1 truncate">{project.name}</span>
                        </button>
                        <button
                          type="button"
                          aria-label={`Toggle project terminal for ${project.name}`}
                          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                          onClick={() => toggleProjectTerminalForCwd(project.id, project.cwd)}
                        >
                          <TerminalIcon className="size-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </PopoverPopup>
              </Popover>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Add project"
                      className="inline-flex size-8 items-center justify-center rounded-md bg-[var(--sidebar-control-surface)] text-[var(--sidebar-muted-foreground)] hover:text-[var(--sidebar-foreground)]"
                      onClick={handleStartAddProject}
                    />
                  }
                >
                  <PlusIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="right">Add project</TooltipPopup>
              </Tooltip>
            </div>

            {shouldShowProjectPathEntry ? (
              <div className="mb-2 rounded-md border border-[var(--sidebar-border)] bg-[var(--sidebar-control-surface)] p-2">
                {isElectron ? (
                  <button
                    type="button"
                    className="mb-1.5 flex w-full items-center justify-center gap-2 rounded-md border border-border bg-secondary py-1.5 text-xs"
                    onClick={() => void handlePickFolder()}
                    disabled={isPickingFolder || isAddingProject}
                  >
                    <FolderIcon className="size-3.5" />
                    {isPickingFolder ? "Picking folder…" : "Browse for folder"}
                  </button>
                ) : null}
                <div className="flex gap-1.5">
                  <input
                    ref={addProjectInputRef}
                    className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none focus:border-ring"
                    placeholder="/path/to/project"
                    value={newCwd}
                    onChange={(event) => {
                      setNewCwd(event.target.value);
                      setAddProjectError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") handleAddProject();
                      if (event.key === "Escape") setAddingProject(false);
                    }}
                    autoFocus
                  />
                  <button
                    type="button"
                    className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-60"
                    onClick={handleAddProject}
                    disabled={!canAddProject}
                  >
                    {isAddingProject ? "Adding…" : "Add"}
                  </button>
                </div>
                {addProjectError ? (
                  <p className="mt-1 text-[11px] text-red-500">{addProjectError}</p>
                ) : null}
              </div>
            ) : null}

            {!threadsHydrated ? <SidebarProjectsLoading /> : null}
            <TooltipProvider delay={150} closeDelay={0}>
              <ul role="list" className="flex flex-col gap-px">
                {lifecyclePartitions.active.map((thread) =>
                  renderSidebarV2Thread(thread, "active"),
                )}
                {lifecyclePartitions.snoozed.length > 0 ? (
                  <>
                    <li className="list-none" data-thread-selection-safe>
                      <button
                        type="button"
                        aria-expanded={snoozedShelfExpanded}
                        className="mt-3 mb-1 flex w-full items-center gap-2 px-2.5 text-left"
                        onClick={() => setSnoozedShelfExpanded((current) => !current)}
                      >
                        <span className="text-xs font-medium text-blue-600 dark:text-blue-400">
                          {snoozedShelfExpanded
                            ? "Snoozed"
                            : `Snoozed (${lifecyclePartitions.snoozed.length})`}
                        </span>
                        <span className="h-px flex-1 bg-blue-500/20 dark:bg-blue-400/15" />
                        {snoozedShelfExpanded ? (
                          <ChevronUpIcon className="size-3 text-blue-500/70" />
                        ) : (
                          <ChevronDownIcon className="size-3 text-blue-500/70" />
                        )}
                      </button>
                    </li>
                    {snoozedShelfExpanded
                      ? lifecyclePartitions.snoozed.map((thread) =>
                          renderSidebarV2Thread(thread, "snoozed"),
                        )
                      : null}
                  </>
                ) : null}
                {lifecyclePartitions.settled.length > 0 ? (
                  <>
                    <li className="list-none" data-thread-selection-safe>
                      <button
                        type="button"
                        aria-expanded={settledShelfExpanded}
                        className="mt-3 mb-1 flex w-full items-center gap-2 px-2.5 text-left"
                        onClick={() => setSettledShelfExpanded((current) => !current)}
                      >
                        <span className="text-xs font-medium text-[var(--sidebar-muted-foreground)]">
                          {settledShelfExpanded
                            ? "Settled"
                            : `Settled (${lifecyclePartitions.settled.length})`}
                        </span>
                        <span className="h-px flex-1 bg-[var(--sidebar-border)]" />
                        {settledShelfExpanded ? (
                          <ChevronUpIcon className="size-3 text-muted-foreground/60" />
                        ) : (
                          <ChevronDownIcon className="size-3 text-muted-foreground/60" />
                        )}
                      </button>
                    </li>
                    {settledShelfExpanded
                      ? visibleSettledThreads.map((thread) =>
                          renderSidebarV2Thread(thread, "settled"),
                        )
                      : null}
                    {settledShelfExpanded &&
                    lifecyclePartitions.settled.length > visibleSettledThreads.length ? (
                      <li className="list-none">
                        <button
                          type="button"
                          className="h-7 w-full rounded-md px-2.5 text-left text-xs text-muted-foreground hover:bg-[var(--sidebar-row-hover)] hover:text-foreground"
                          onClick={() => setSettledVisibleCount((current) => current + 25)}
                        >
                          Show more
                        </button>
                      </li>
                    ) : null}
                  </>
                ) : null}
                {showArchivedThreads && lifecyclePartitions.archived.length > 0 ? (
                  <>
                    <li className="list-none" data-thread-selection-safe>
                      <div className="mt-3 mb-1 flex w-full items-center gap-2 px-2.5">
                        <span className="text-xs font-medium text-muted-foreground">Archived</span>
                        <span className="h-px flex-1 bg-[var(--sidebar-border)]" />
                      </div>
                    </li>
                    {lifecyclePartitions.archived.map((thread) =>
                      renderSidebarV2Thread(thread, "archived"),
                    )}
                  </>
                ) : null}
              </ul>
            </TooltipProvider>

            {threadsHydrated &&
            projects.length > 0 &&
            lifecyclePartitions.active.length === 0 &&
            lifecyclePartitions.snoozed.length === 0 &&
            lifecyclePartitions.settled.length === 0 &&
            lifecyclePartitions.archived.length === 0 ? (
              <div className="px-2 pt-5 text-center text-xs text-muted-foreground">
                No threads in this project
              </div>
            ) : null}
            {threadsHydrated && projects.length === 0 && !shouldShowProjectPathEntry ? (
              <div className="px-2 pt-5 text-center text-xs text-muted-foreground">
                No projects yet
              </div>
            ) : null}
          </SidebarGroup>
        </SidebarContent>

        <SidebarSeparator />
        <SidebarFooter className="p-2">
          <SidebarMenu>
            {showDesktopUpdateBanner && !showArm64IntelBuildWarning && !updateBannerDismissed ? (
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="sm"
                  className="gap-2 px-2 py-1 text-amber-500 hover:bg-[var(--sidebar-row-hover)]"
                  disabled={desktopUpdateButtonDisabled}
                  onClick={handleDesktopUpdateButtonClick}
                >
                  {desktopUpdateState?.status === "downloaded" ? (
                    <RocketIcon className="size-3" />
                  ) : (
                    <DownloadIcon className="size-3" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs">
                    {desktopUpdateState?.status === "downloaded"
                      ? "Restart to update"
                      : "Update available"}
                  </span>
                  <button
                    type="button"
                    aria-label="Dismiss"
                    className="inline-flex size-4 items-center justify-center"
                    onClick={(event) => {
                      event.stopPropagation();
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
            <SidebarMenuItem className="flex items-center gap-1">
              <SidebarMenuButton
                size="sm"
                className="min-w-0 flex-1 gap-2 px-2 py-1.5 text-[var(--sidebar-muted-foreground)] hover:bg-[var(--sidebar-row-hover)] hover:text-[var(--sidebar-foreground)]"
                onClick={() =>
                  isOnSettings ? window.history.back() : void navigate({ to: "/settings" })
                }
              >
                {isOnSettings ? (
                  <ArrowLeftIcon className="size-3.5" />
                ) : (
                  <SettingsIcon className="size-3.5" />
                )}
                <span className="text-xs">{isOnSettings ? "Back" : "Settings"}</span>
              </SidebarMenuButton>
              <HarnessSessionUsageBadge
                onPurgeInactiveSessionsClick={() => setPurgeDialogOpen(true)}
                stats={activeHarnessSessionStats}
              />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </div>
    );
  }

  return (
    <>
      <PurgeSessionsDialog
        open={purgeDialogOpen}
        onOpenChange={setPurgeDialogOpen}
        routeThreadId={routeThreadId}
      />
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
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                Projects
              </span>
              <HarnessSessionUsageBadge
                onPurgeInactiveSessionsClick={() => setPurgeDialogOpen(true)}
                stats={activeHarnessSessionStats}
              />
            </div>
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
                      aria-label={
                        showArchivedThreads ? "Hide archived threads" : "Show archived threads"
                      }
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

          {!threadsHydrated && <SidebarProjectsLoading />}

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
                              const isOpenForProjectCwd =
                                isOpen &&
                                (projectTerminalCwdByThreadId[projTermThreadId] ?? project.cwd) ===
                                  project.cwd;
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
                                        className={`top-1 right-13 size-5 rounded-md p-0 hover:bg-secondary hover:text-foreground ${
                                          hasRunning
                                            ? "text-teal-600 dark:text-teal-300/90"
                                            : isOpen
                                              ? "text-foreground"
                                              : "text-muted-foreground/70"
                                        }`}
                                        onClick={(event) => {
                                          event.preventDefault();
                                          event.stopPropagation();
                                          toggleProjectTerminalForCwd(project.id, project.cwd);
                                        }}
                                      >
                                        <TerminalIcon
                                          className={`size-3.5 ${hasRunning ? "animate-pulse" : ""}`}
                                        />
                                      </SidebarMenuAction>
                                    }
                                  />
                                  <TooltipPopup side="top">
                                    {isOpenForProjectCwd
                                      ? "Close project terminal"
                                      : "Open project terminal"}
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
                                        aria-label={`Create new journey in ${project.name}`}
                                      />
                                    }
                                    showOnHover
                                    className="top-1 right-7 size-5 rounded-md p-0 text-violet-600 hover:bg-secondary hover:text-violet-700 dark:text-violet-300/85 dark:hover:text-violet-200"
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      void handleNewThread(project.id, { surface: "journey" });
                                    }}
                                  >
                                    <NetworkIcon className="size-3.5" />
                                  </SidebarMenuAction>
                                }
                              />
                              <TooltipPopup side="top">New journey</TooltipPopup>
                            </Tooltip>
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
                            <SidebarMenuSub className="mx-1 my-0 w-full translate-x-0 gap-px px-1.5 py-0">
                              <SortableContext
                                items={visibleThreads.map((thread) => threadSortableId(thread.id))}
                                strategy={verticalListSortingStrategy}
                              >
                                {visibleThreads.map((thread) => {
                                  const isActive = routeThreadId === thread.id;
                                  const isSelected = selectedThreadIds.has(thread.id);
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
                                          <div className="relative box-border pl-4">
                                            <SidebarThreadDragHandle
                                              ariaLabel={`Reorder ${thread.title}`}
                                              handleProps={dragHandleProps}
                                              disabled={renamingThreadId === thread.id}
                                            />
                                            <SidebarMenuSubButton
                                              render={<div role="link" tabIndex={0} />}
                                              aria-label={
                                                thread.branch
                                                  ? `${thread.title}, branch ${formatBranchForDisplay(thread.branch)}`
                                                  : thread.title
                                              }
                                              data-has-thread-actions={
                                                project.expanded && renamingThreadId !== thread.id
                                                  ? "true"
                                                  : undefined
                                              }
                                              data-interactive="true"
                                              data-selected={isSelected ? "true" : undefined}
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
                                                if (event.target !== event.currentTarget) return;
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
                                                if (routeThreadId === thread.id) {
                                                  dispatchThreadSelectedEvent(thread.id);
                                                } else {
                                                  dispatchThreadSelectedEventAfterRouteChange(
                                                    thread.id,
                                                  );
                                                }
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
                                              <SidebarThreadRowBody
                                                thread={thread}
                                                threadStatus={threadStatus}
                                                prStatus={prStatus}
                                                terminalStatus={terminalStatus}
                                                hoverActions={
                                                  project.expanded &&
                                                  renamingThreadId !== thread.id ? (
                                                    <SidebarThreadHoverActions
                                                      archived={thread.archivedAt !== null}
                                                      bookmarked={thread.bookmarked}
                                                      onToggleArchive={() =>
                                                        archiveThread(
                                                          thread.id,
                                                          thread.archivedAt
                                                            ? null
                                                            : new Date().toISOString(),
                                                        )
                                                      }
                                                      onToggleBookmark={() =>
                                                        toggleThreadBookmark(thread.id)
                                                      }
                                                    />
                                                  ) : undefined
                                                }
                                                onOpenPr={openPrLink}
                                                onTitleDoubleClick={(event) => {
                                                  event.preventDefault();
                                                  event.stopPropagation();
                                                  startRenameThread(thread);
                                                }}
                                                titleEditor={
                                                  renamingThreadId === thread.id ? (
                                                    <input
                                                      ref={(element) => {
                                                        if (
                                                          element &&
                                                          renamingInputRef.current !== element
                                                        ) {
                                                          renamingInputRef.current = element;
                                                          element.focus();
                                                          element.select();
                                                        }
                                                      }}
                                                      className="min-w-0 flex-1 rounded border border-ring bg-transparent px-0.5 text-[13px] leading-none outline-none"
                                                      value={renamingTitle}
                                                      onChange={(event) =>
                                                        setRenamingTitle(event.target.value)
                                                      }
                                                      onKeyDown={(event) => {
                                                        event.stopPropagation();
                                                        if (event.key === "Enter") {
                                                          event.preventDefault();
                                                          renamingCommittedRef.current = true;
                                                          void commitRename(
                                                            thread.id,
                                                            renamingTitle,
                                                            thread.title,
                                                          );
                                                        } else if (event.key === "Escape") {
                                                          event.preventDefault();
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
                                                      onClick={(event) => event.stopPropagation()}
                                                    />
                                                  ) : undefined
                                                }
                                              />
                                            </SidebarMenuSubButton>
                                          </div>
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
                        pr={
                          activeDragThread ? (prByThreadId.get(activeDragThread.id) ?? null) : null
                        }
                        terminalStatus={activeDragThreadTerminalStatus}
                      />
                    ) : null}
                  </DragOverlay>,
                  document.body,
                )
              : null}
          </DndContext>

          {threadsHydrated && projects.length === 0 && !shouldShowProjectPathEntry && (
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
