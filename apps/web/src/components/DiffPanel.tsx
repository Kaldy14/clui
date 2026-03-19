import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata, Virtualizer } from "@pierre/diffs/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ThreadId, type TurnId } from "@clui/contracts";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns2Icon,
  FolderTreeIcon,
  PencilIcon,
  RotateCcw,
  Rows3Icon,
  Square,
  SquareCheckBig,
  XIcon,
} from "lucide-react";
import {
  type WheelEvent as ReactWheelEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { gitBranchesQueryOptions } from "~/lib/gitReactQuery";
import {
  checkpointDiffQueryOptions,
  workingTreeDiffQueryOptions,
} from "~/lib/providerReactQuery";
import { readFileQueryOptions } from "~/lib/projectReactQuery";
import { cn } from "~/lib/utils";
import { readNativeApi } from "../nativeApi";
import { preferredTerminalEditor, resolvePathLinkTarget } from "../terminal-links";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import { isElectron } from "../env";
import { useTheme } from "../hooks/useTheme";
import { buildPatchCacheKey } from "../lib/diffRendering";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useStore } from "../store";
import DiffFileTree from "./DiffFileTree";
import { ToggleGroup, Toggle } from "./ui/toggle-group";

const DiffInlineEditor = lazy(() => import("./DiffInlineEditor"));

type DiffRenderMode = "stacked" | "split";
type DiffThemeType = "light" | "dark";

const DIFF_CSS_LIGHT = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--success));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 88%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--background) 80%,
    var(--destructive)
  );

  background-color: var(--diffs-bg) !important;
}
`;

const DIFF_CSS_DARK = `
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: #1e2228 !important;
  --diffs-light-bg: #1e2228 !important;
  --diffs-dark-bg: #1e2228 !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: #1b1e23;
  --diffs-bg-hover-override: #22272e;
  --diffs-bg-separator-override: #2a2f38;
  --diffs-bg-buffer-override: #1b1e23;

  --diffs-bg-addition-override: #315037;
  --diffs-bg-addition-number-override: #2a4530;
  --diffs-bg-addition-hover-override: #3a6042;
  --diffs-bg-addition-emphasis-override: #3a6042;

  --diffs-bg-deletion-override: #392428;
  --diffs-bg-deletion-number-override: #321f23;
  --diffs-bg-deletion-hover-override: #462a2f;
  --diffs-bg-deletion-emphasis-override: #592A2D;

  background-color: var(--diffs-bg) !important;
}
`;

type RenderablePatch =
  | {
      kind: "files";
      files: FileDiffMetadata[];
    }
  | {
      kind: "raw";
      text: string;
      reason: string;
    };

function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
): RenderablePatch | null {
  if (!patch) return null;
  const normalizedPatch = patch.trim();
  if (normalizedPatch.length === 0) return null;

  try {
    const parsedPatches = parsePatchFiles(
      normalizedPatch,
      buildPatchCacheKey(normalizedPatch, cacheScope),
    );
    const files = parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    if (files.length > 0) {
      return { kind: "files", files };
    }

    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Unsupported diff format. Showing raw patch.",
    };
  } catch {
    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Failed to parse patch. Showing raw patch.",
    };
  }
}

function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "";
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
}

function getFileDiffStats(fileDiff: FileDiffMetadata): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of fileDiff.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { additions, deletions };
}

type ChangeType = FileDiffMetadata["type"];

function getChangeTypeBadge(type: ChangeType): { label: string; className: string } {
  switch (type) {
    case "new":
      return { label: "A", className: "bg-green-600/20 text-green-500 dark:text-green-400" };
    case "deleted":
      return { label: "D", className: "bg-red-600/20 text-red-500 dark:text-red-400" };
    case "rename-pure":
    case "rename-changed":
      return { label: "R", className: "bg-blue-600/20 text-blue-500 dark:text-blue-400" };
    default:
      return { label: "M", className: "bg-yellow-600/20 text-yellow-500 dark:text-yellow-400" };
  }
}

/** Extract the line number from a right-click inside the @pierre/diffs Shadow DOM. */
function getLineNumberFromEvent(event: React.MouseEvent): number | null {
  for (const element of event.nativeEvent.composedPath()) {
    if (!(element instanceof HTMLElement)) continue;
    const columnNumber = element.getAttribute("data-column-number");
    if (columnNumber != null) return Number.parseInt(columnNumber, 10);
    const lineAttr = element.getAttribute("data-line");
    if (lineAttr != null) return Number.parseInt(lineAttr, 10);
    if (element.hasAttribute("data-code")) break;
  }
  return null;
}

interface DiffContextMenu {
  x: number;
  y: number;
  filePath: string;
  lineNumber: number;
}

function formatTurnChipTimestamp(isoDate: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(isoDate));
}

interface DiffPanelProps {
  mode?: "inline" | "sheet" | "sidebar";
}

function EditableFileView({
  filePath,
  cwd,
  onSave,
  onCancel,
  scrollToLine,
}: {
  filePath: string;
  cwd: string;
  onSave: (filePath: string, content: string) => void;
  onCancel: (filePath: string) => void;
  isSaving: boolean;
  scrollToLine?: number | undefined;
}) {
  const fileQuery = useQuery(readFileQueryOptions(cwd, filePath));
  const queryClient = useQueryClient();
  const writeMutation = useMutation({
    mutationFn: async (content: string) => {
      const api = readNativeApi();
      if (!api) throw new Error("API not available");
      return api.projects.writeFile({ cwd, relativePath: filePath, contents: content });
    },
    onSuccess: () => {
      // Invalidate diff + file queries so the diff view refreshes after save
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      void queryClient.invalidateQueries({ queryKey: ["projects", "readFile", cwd, filePath] });
      onSave(filePath, "");
    },
  });

  if (fileQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
        Loading file...
      </div>
    );
  }

  if (fileQuery.error) {
    return (
      <div className="px-3 py-4 text-xs text-red-400">
        Failed to load file: {fileQuery.error instanceof Error ? fileQuery.error.message : "Unknown error"}
        <span className="ml-1 text-muted-foreground/50">(cwd: {cwd})</span>
        <button
          type="button"
          className="ml-2 text-muted-foreground underline hover:text-foreground"
          onClick={() => onCancel(filePath)}
        >
          Close
        </button>
      </div>
    );
  }

  if (!fileQuery.data) return null;

  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
          Loading editor...
        </div>
      }
    >
      <DiffInlineEditor
        filePath={filePath}
        initialContent={fileQuery.data.contents}
        language={fileQuery.data.language}
        onSave={(content) => writeMutation.mutate(content)}
        onCancel={() => onCancel(filePath)}
        isSaving={writeMutation.isPending}
        scrollToLine={scrollToLine}
      />
    </Suspense>
  );
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({ mode = "inline" }: DiffPanelProps) {
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const [showFileTree, setShowFileTree] = useState(true);
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const turnStripRef = useRef<HTMLDivElement>(null);
  const [canScrollTurnStripLeft, setCanScrollTurnStripLeft] = useState(false);
  const [canScrollTurnStripRight, setCanScrollTurnStripRight] = useState(false);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const diffSearch = useSearch({ strict: false, select: (search) => parseDiffRouteSearch(search) });
  const activeThreadId = routeThreadId;
  const activeThread = useStore((store) =>
    activeThreadId ? store.threads.find((thread) => thread.id === activeThreadId) : undefined,
  );
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeProjectId ? store.projects.find((project) => project.id === activeProjectId) : undefined,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.cwd;
  const gitBranchesQuery = useQuery(gitBranchesQueryOptions(activeCwd ?? null));
  const isGitRepo = gitBranchesQuery.data?.isRepo ?? true;
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const orderedTurnDiffSummaries = useMemo(
    () =>
      [...turnDiffSummaries].toSorted((left, right) => {
        const leftTurnCount =
          left.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[left.turnId] ?? 0;
        const rightTurnCount =
          right.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[right.turnId] ?? 0;
        if (leftTurnCount !== rightTurnCount) {
          return rightTurnCount - leftTurnCount;
        }
        return right.completedAt.localeCompare(left.completedAt);
      }),
    [inferredCheckpointTurnCountByTurnId, turnDiffSummaries],
  );

  const selectedTurnId = diffSearch.diffTurnId ?? null;
  const selectedFilePath = selectedTurnId !== null ? (diffSearch.diffFilePath ?? null) : null;
  const selectedTurn =
    selectedTurnId === null
      ? undefined
      : (orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId) ??
        orderedTurnDiffSummaries[0]);
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[selectedTurn.turnId]);
  const selectedCheckpointRange = useMemo(
    () =>
      typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null,
    [selectedCheckpointTurnCount],
  );
  const conversationCheckpointTurnCount = useMemo(() => {
    const turnCounts = orderedTurnDiffSummaries
      .map(
        (summary) =>
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId],
      )
      .filter((value): value is number => typeof value === "number");
    if (turnCounts.length === 0) {
      return undefined;
    }
    const latest = Math.max(...turnCounts);
    return latest > 0 ? latest : undefined;
  }, [inferredCheckpointTurnCountByTurnId, orderedTurnDiffSummaries]);
  const conversationCheckpointRange = useMemo(
    () =>
      !selectedTurn && typeof conversationCheckpointTurnCount === "number"
        ? {
            fromTurnCount: 0,
            toTurnCount: conversationCheckpointTurnCount,
          }
        : null,
    [conversationCheckpointTurnCount, selectedTurn],
  );
  const activeCheckpointRange = selectedTurn
    ? selectedCheckpointRange
    : conversationCheckpointRange;
  const conversationCacheScope = useMemo(() => {
    if (selectedTurn || orderedTurnDiffSummaries.length === 0) {
      return null;
    }
    return `conversation:${orderedTurnDiffSummaries.map((summary) => summary.turnId).join(",")}`;
  }, [orderedTurnDiffSummaries, selectedTurn]);
  const hasTurns = orderedTurnDiffSummaries.length > 0;
  const activeCheckpointDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      threadId: activeThreadId,
      fromTurnCount: activeCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: activeCheckpointRange?.toTurnCount ?? null,
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : conversationCacheScope,
      enabled: isGitRepo && hasTurns,
    }),
  );
  const workingTreeDiffQuery = useQuery(
    workingTreeDiffQueryOptions({
      threadId: activeThreadId,
      enabled: isGitRepo && !hasTurns,
    }),
  );
  const selectedTurnCheckpointDiff = selectedTurn
    ? activeCheckpointDiffQuery.data?.diff
    : undefined;
  const conversationCheckpointDiff = selectedTurn
    ? undefined
    : activeCheckpointDiffQuery.data?.diff;
  const isLoadingCheckpointDiff = hasTurns
    ? activeCheckpointDiffQuery.isLoading
    : workingTreeDiffQuery.isLoading;
  const checkpointDiffError =
    activeCheckpointDiffQuery.error instanceof Error
      ? activeCheckpointDiffQuery.error.message
      : activeCheckpointDiffQuery.error
        ? "Failed to load checkpoint diff."
        : workingTreeDiffQuery.error instanceof Error
          ? workingTreeDiffQuery.error.message
          : null;

  const selectedPatch = hasTurns
    ? (selectedTurn ? selectedTurnCheckpointDiff : conversationCheckpointDiff)
    : workingTreeDiffQuery.data?.diff;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const renderablePatch = useMemo(
    () => getRenderablePatch(selectedPatch, `diff-panel:${resolvedTheme}`),
    [resolvedTheme, selectedPatch],
  );
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files.toSorted((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [renderablePatch]);

  const [viewedFiles, setViewedFiles] = useState<Set<string>>(new Set());

  useEffect(() => {
    setViewedFiles(new Set());
  }, [selectedPatch]);

  const toggleFileViewed = useCallback((filePath: string) => {
    setViewedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }, []);

  const resetAllViewed = useCallback(() => {
    setViewedFiles(new Set());
  }, []);

  const [editingFiles, setEditingFiles] = useState<Set<string>>(new Set());
  const [editScrollLine, setEditScrollLine] = useState<Record<string, number>>({});
  const [contextMenu, setContextMenu] = useState<DiffContextMenu | null>(null);

  useEffect(() => {
    setEditingFiles(new Set());
  }, [selectedPatch]);

  const startEditing = useCallback((filePath: string, lineNumber?: number) => {
    setEditingFiles((prev) => new Set(prev).add(filePath));
    if (lineNumber) {
      setEditScrollLine((prev) => ({ ...prev, [filePath]: lineNumber }));
    }
  }, []);

  const stopEditing = useCallback((filePath: string) => {
    setEditingFiles((prev) => {
      const next = new Set(prev);
      next.delete(filePath);
      return next;
    });
    setEditScrollLine((prev) => {
      const next = { ...prev };
      delete next[filePath];
      return next;
    });
    setContextMenu(null);
  }, []);

  // Files keep their original alphabetical order — viewed files just collapse in place
  const sortedRenderableFiles = renderableFiles;

  const [focusedFileIndex, setFocusedFileIndex] = useState<number | null>(null);

  // Reset focus when files change
  useEffect(() => {
    setFocusedFileIndex(null);
  }, [selectedPatch]);

  const scrollToFileByIndex = useCallback(
    (index: number) => {
      const viewport = patchViewportRef.current;
      if (!viewport) return;
      const filePath = sortedRenderableFiles[index]
        ? resolveFileDiffPath(sortedRenderableFiles[index])
        : null;
      if (!filePath) return;
      const target = viewport.querySelector<HTMLElement>(
        `[data-diff-file-path="${CSS.escape(filePath)}"]`,
      );
      target?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    },
    [sortedRenderableFiles],
  );

  // Keyboard navigation: j/k to move, v to toggle viewed
  useEffect(() => {
    const viewport = patchViewportRef.current;
    if (!viewport || sortedRenderableFiles.length === 0) return;

    const onKeyDown = (event: KeyboardEvent) => {
      // Don't capture when typing in inputs, editors, or when terminal has focus
      const target = event.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable ||
        target.closest("[data-terminal]") ||
        target.closest(".cm-editor")
      ) {
        return;
      }

      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        setFocusedFileIndex((prev) => {
          const next = prev === null ? 0 : Math.min(prev + 1, sortedRenderableFiles.length - 1);
          requestAnimationFrame(() => scrollToFileByIndex(next));
          return next;
        });
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        setFocusedFileIndex((prev) => {
          const next = prev === null ? 0 : Math.max(prev - 1, 0);
          requestAnimationFrame(() => scrollToFileByIndex(next));
          return next;
        });
      } else if (event.key === "v") {
        event.preventDefault();
        setFocusedFileIndex((prev) => {
          if (prev === null || !sortedRenderableFiles[prev]) return prev;
          const filePath = resolveFileDiffPath(sortedRenderableFiles[prev]);
          toggleFileViewed(filePath);
          return prev;
        });
      } else if (event.key === "e") {
        event.preventDefault();
        setFocusedFileIndex((prev) => {
          if (prev === null || !sortedRenderableFiles[prev]) return prev;
          const filePath = resolveFileDiffPath(sortedRenderableFiles[prev]);
          if (editingFiles.has(filePath)) {
            stopEditing(filePath);
          } else {
            startEditing(filePath);
          }
          return prev;
        });
      }
    };

    viewport.addEventListener("keydown", onKeyDown);
    return () => viewport.removeEventListener("keydown", onKeyDown);
  }, [sortedRenderableFiles, scrollToFileByIndex, toggleFileViewed, editingFiles, startEditing, stopEditing]);

  useEffect(() => {
    if (!selectedFilePath || !patchViewportRef.current) {
      return;
    }
    const target = Array.from(
      patchViewportRef.current.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
    ).find((element) => element.dataset.diffFilePath === selectedFilePath);
    target?.scrollIntoView({ block: "nearest" });
  }, [selectedFilePath, renderableFiles]);

  const scrollToFile = useCallback((filePath: string) => {
    const viewport = patchViewportRef.current;
    if (!viewport) return;
    const target = viewport.querySelector<HTMLElement>(
      `[data-diff-file-path="${CSS.escape(filePath)}"]`,
    );
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  const openDiffFileInEditor = useCallback(
    (filePath: string) => {
      const api = readNativeApi();
      if (!api) return;
      const targetPath = activeCwd ? resolvePathLinkTarget(filePath, activeCwd) : filePath;
      void api.shell.openInEditor(targetPath, preferredTerminalEditor()).catch((error) => {
        console.warn("Failed to open diff file in editor.", error);
      });
    },
    [activeCwd],
  );

  const selectTurn = (turnId: TurnId) => {
    if (!activeThread) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThread.id },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1", diffTurnId: turnId };
      },
    });
  };
  const selectWholeConversation = () => {
    if (!activeThread) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThread.id },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1" };
      },
    });
  };
  const closeDiff = useCallback(() => {
    if (!routeThreadId) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: routeThreadId },
      search: (previous) => stripDiffSearchParams(previous),
    });
  }, [navigate, routeThreadId]);
  const updateTurnStripScrollState = useCallback(() => {
    const element = turnStripRef.current;
    if (!element) {
      setCanScrollTurnStripLeft(false);
      setCanScrollTurnStripRight(false);
      return;
    }

    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    setCanScrollTurnStripLeft(element.scrollLeft > 4);
    setCanScrollTurnStripRight(element.scrollLeft < maxScrollLeft - 4);
  }, []);
  const scrollTurnStripBy = useCallback((offset: number) => {
    const element = turnStripRef.current;
    if (!element) return;
    element.scrollBy({ left: offset, behavior: "smooth" });
  }, []);
  const onTurnStripWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const element = turnStripRef.current;
    if (!element) return;
    if (element.scrollWidth <= element.clientWidth + 1) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

    event.preventDefault();
    element.scrollBy({ left: event.deltaY, behavior: "auto" });
  }, []);

  useEffect(() => {
    const element = turnStripRef.current;
    if (!element) return;

    const frameId = window.requestAnimationFrame(() => updateTurnStripScrollState());
    const onScroll = () => updateTurnStripScrollState();

    element.addEventListener("scroll", onScroll, { passive: true });

    const resizeObserver = new ResizeObserver(() => updateTurnStripScrollState());
    resizeObserver.observe(element);

    return () => {
      window.cancelAnimationFrame(frameId);
      element.removeEventListener("scroll", onScroll);
      resizeObserver.disconnect();
    };
  }, [updateTurnStripScrollState]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => updateTurnStripScrollState());
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [orderedTurnDiffSummaries, selectedTurnId, updateTurnStripScrollState]);

  useEffect(() => {
    const element = turnStripRef.current;
    if (!element) return;

    const selectedChip = element.querySelector<HTMLElement>("[data-turn-chip-selected='true']");
    selectedChip?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selectedTurn?.turnId, selectedTurnId]);

  const shouldUseDragRegion = isElectron && mode !== "sheet";
  const headerRow = (
    <>
      <div className="relative min-w-0 flex-1 [-webkit-app-region:no-drag]">
        {canScrollTurnStripLeft && (
          <div className="pointer-events-none absolute inset-y-0 left-8 z-10 w-7 bg-linear-to-r from-card to-transparent" />
        )}
        {canScrollTurnStripRight && (
          <div className="pointer-events-none absolute inset-y-0 right-8 z-10 w-7 bg-linear-to-l from-card to-transparent" />
        )}
        <button
          type="button"
          className={cn(
            "absolute left-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
            canScrollTurnStripLeft
              ? "border-border/70 hover:border-border hover:text-foreground"
              : "cursor-not-allowed border-border/40 text-muted-foreground/40",
          )}
          onClick={() => scrollTurnStripBy(-180)}
          disabled={!canScrollTurnStripLeft}
          aria-label="Scroll turn list left"
        >
          <ChevronLeftIcon className="size-3.5" />
        </button>
        <button
          type="button"
          className={cn(
            "absolute right-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
            canScrollTurnStripRight
              ? "border-border/70 hover:border-border hover:text-foreground"
              : "cursor-not-allowed border-border/40 text-muted-foreground/40",
          )}
          onClick={() => scrollTurnStripBy(180)}
          disabled={!canScrollTurnStripRight}
          aria-label="Scroll turn list right"
        >
          <ChevronRightIcon className="size-3.5" />
        </button>
        <div
          ref={turnStripRef}
          className="turn-chip-strip flex gap-1 overflow-x-auto px-8 py-0.5"
          onWheel={onTurnStripWheel}
        >
          <button
            type="button"
            className="shrink-0 rounded-md"
            onClick={selectWholeConversation}
            data-turn-chip-selected={selectedTurnId === null}
          >
            <div
              className={cn(
                "rounded-md border px-2 py-1 text-left transition-colors",
                selectedTurnId === null
                  ? "border-border bg-accent text-accent-foreground"
                  : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
              )}
            >
              <div className="text-[10px] leading-tight font-medium">All turns</div>
            </div>
          </button>
          {orderedTurnDiffSummaries.map((summary) => (
            <button
              key={summary.turnId}
              type="button"
              className="shrink-0 rounded-md"
              onClick={() => selectTurn(summary.turnId)}
              title={summary.turnId}
              data-turn-chip-selected={summary.turnId === selectedTurn?.turnId}
            >
              <div
                className={cn(
                  "rounded-md border px-2 py-1 text-left transition-colors",
                  summary.turnId === selectedTurn?.turnId
                    ? "border-border bg-accent text-accent-foreground"
                    : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
                )}
              >
                <div className="flex items-center gap-1">
                  <span className="text-[10px] leading-tight font-medium">
                    Turn{" "}
                    {summary.checkpointTurnCount ??
                      inferredCheckpointTurnCountByTurnId[summary.turnId] ??
                      "?"}
                  </span>
                  <span className="text-[9px] leading-tight opacity-70">
                    {formatTurnChipTimestamp(summary.completedAt)}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
      {renderableFiles.length > 0 && (
        <div className="flex shrink-0 items-center gap-1.5 [-webkit-app-region:no-drag]">
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {viewedFiles.size}/{renderableFiles.length} viewed
          </span>
          {viewedFiles.size > 0 && (
            <button
              type="button"
              className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={resetAllViewed}
              title="Reset viewed state"
            >
              <RotateCcw className="size-2.5" />
              Reset
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        className={cn(
          "shrink-0 rounded-md border p-1.5 transition-colors [-webkit-app-region:no-drag]",
          showFileTree
            ? "border-border bg-accent text-foreground"
            : "border-border/70 text-muted-foreground hover:border-border hover:text-foreground",
        )}
        onClick={() => setShowFileTree((prev) => !prev)}
        title="Toggle file tree"
      >
        <FolderTreeIcon className="size-3" />
      </button>
      <ToggleGroup
        className="shrink-0 [-webkit-app-region:no-drag]"
        variant="outline"
        size="xs"
        value={[diffRenderMode]}
        onValueChange={(value) => {
          const next = value[0];
          if (next === "stacked" || next === "split") {
            setDiffRenderMode(next);
          }
        }}
      >
        <Toggle aria-label="Stacked diff view" value="stacked">
          <Rows3Icon className="size-3" />
        </Toggle>
        <Toggle aria-label="Split diff view" value="split">
          <Columns2Icon className="size-3" />
        </Toggle>
      </ToggleGroup>
      <div className="h-3.5 w-px bg-border/50 dark:bg-border/30 shrink-0" />
      <button
        type="button"
        className="shrink-0 rounded-md border border-border/70 p-1.5 text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]"
        onClick={closeDiff}
        title="Close diff panel (Esc)"
      >
        <XIcon className="size-3" />
      </button>
    </>
  );
  const headerRowClassName = cn(
    "flex items-center justify-between gap-2 px-4",
    shouldUseDragRegion ? "drag-region h-[52px] border-b border-border" : "h-12",
  );

  return (
    <div
      className={cn(
        "flex h-full min-w-0 flex-col bg-background outline-none",
        mode === "inline"
          ? "w-[42vw] min-w-[360px] max-w-[560px] shrink-0 border-l border-border"
          : "w-full",
      )}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeDiff();
        }
      }}
    >
      {shouldUseDragRegion ? (
        <div className={headerRowClassName}>{headerRow}</div>
      ) : (
        <div className="border-b border-border">
          <div className={headerRowClassName}>{headerRow}</div>
        </div>
      )}

      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : orderedTurnDiffSummaries.length === 0 && !workingTreeDiffQuery.data?.diff ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          {workingTreeDiffQuery.isLoading
            ? "Loading workspace changes..."
            : "No changes detected."}
        </div>
      ) : (
        <>
          {renderableFiles.length > 0 && (
            <div
              className="h-0.5 shrink-0 bg-border/30"
            >
              <div
                className="h-full bg-green-500/70 transition-[width] duration-500 ease-out"
                style={{
                  width: `${renderableFiles.length > 0 ? (viewedFiles.size / renderableFiles.length) * 100 : 0}%`,
                }}
              />
            </div>
          )}
          {showFileTree && renderableFiles.length > 0 && (
            <div className="shrink-0 overflow-auto border-b border-border/60 dark:bg-[#1e2228]" style={{ maxHeight: "40%" }}>
              <DiffFileTree
                files={renderableFiles}
                viewedFiles={viewedFiles}
                onFileClick={scrollToFile}
                onToggleViewed={toggleFileViewed}
                resolveFilePath={resolveFileDiffPath}
                getFileStats={getFileDiffStats}
              />
            </div>
          )}
          <div
            ref={patchViewportRef}
            className="diff-panel-viewport min-h-0 min-w-0 flex-1 overflow-hidden outline-none"
            tabIndex={0}
          >
            {checkpointDiffError && !renderablePatch && (
              <div className="px-3">
                <p className="mb-2 text-[11px] text-red-500/80">{checkpointDiffError}</p>
              </div>
            )}
            {!renderablePatch ? (
              <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                <p>
                  {isLoadingCheckpointDiff
                    ? "Loading checkpoint diff..."
                    : hasNoNetChanges
                      ? "No net changes in this selection."
                      : "No patch available for this selection."}
                </p>
              </div>
            ) : renderablePatch.kind === "files" ? (
              <Virtualizer
                className="diff-render-surface h-full min-h-0 overflow-auto px-2 pb-2"
                config={{
                  overscrollSize: 600,
                  intersectionObserverMargin: 1200,
                }}
              >
                {sortedRenderableFiles.map((fileDiff, fileIndex) => {
                  const filePath = resolveFileDiffPath(fileDiff);
                  const fileKey = buildFileDiffRenderKey(fileDiff);
                  const themedFileKey = `${fileKey}:${resolvedTheme}`;
                  const isViewed = viewedFiles.has(filePath);
                  const isFocused = focusedFileIndex === fileIndex;
                  const stats = getFileDiffStats(fileDiff);
                  const badge = getChangeTypeBadge(fileDiff.type);
                  const lastSlash = filePath.lastIndexOf("/");
                  const dirPath = lastSlash >= 0 ? filePath.slice(0, lastSlash + 1) : "";
                  const baseName = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
                  return (
                    <div
                      key={themedFileKey}
                      data-diff-file-path={filePath}
                      className={cn(
                        "diff-render-file mb-2 rounded-md transition-[opacity,transform] duration-300 ease-out first:mt-2 last:mb-0",
                        isViewed && "opacity-60",
                        isFocused && "ring-1 ring-blue-500/50",
                      )}
                    >
                      <div
                        className={cn(
                          "sticky top-0 z-10 flex items-center gap-3 bg-background px-3 py-2.5 text-[13px] transition-[background-color,border-color] duration-300",
                          isViewed
                            ? "border-b border-border/30"
                            : "border-b border-border/60 dark:bg-[#252a31]",
                        )}
                      >
                        <button
                          type="button"
                          className="group shrink-0 transition-transform duration-200 active:scale-90"
                          onClick={() => toggleFileViewed(filePath)}
                          title={isViewed ? "Mark as unviewed" : "Mark as viewed"}
                        >
                          {isViewed ? (
                            <SquareCheckBig className="size-4 animate-[viewedPop_300ms_ease-out] text-blue-500 transition-colors" />
                          ) : (
                            <Square className="size-4 text-muted-foreground transition-colors group-hover:text-foreground" />
                          )}
                        </button>
                        <span
                          className={cn(
                            "inline-flex size-[18px] shrink-0 items-center justify-center rounded text-[10px] font-bold leading-none",
                            badge.className,
                          )}
                        >
                          {badge.label}
                        </span>
                        <button
                          type="button"
                          className={cn(
                            "min-w-0 flex-1 truncate text-left underline decoration-transparent underline-offset-2 transition-colors duration-200 hover:decoration-current",
                            isViewed
                              ? "text-muted-foreground hover:text-foreground"
                              : "text-foreground hover:text-foreground",
                          )}
                          onClick={() => openDiffFileInEditor(filePath)}
                          title={`Open ${filePath} in editor`}
                        >
                          {dirPath && (
                            <span className="opacity-40">{dirPath}</span>
                          )}
                          <span className="font-medium">{baseName}</span>
                        </button>
                        <div className="flex shrink-0 items-center gap-2 tabular-nums text-[13px]">
                          {stats.deletions > 0 && (
                            <span className="text-red-500 dark:text-red-400">
                              -{stats.deletions}
                            </span>
                          )}
                          {stats.additions > 0 && (
                            <span className="text-green-600 dark:text-green-400">
                              +{stats.additions}
                            </span>
                          )}
                        </div>
                        {activeCwd && !isViewed && (
                          <button
                            type="button"
                            className={cn(
                              "shrink-0 rounded p-1 transition-colors",
                              editingFiles.has(filePath)
                                ? "bg-blue-500/20 text-blue-400"
                                : "text-muted-foreground/60 hover:bg-accent hover:text-foreground",
                            )}
                            onClick={() =>
                              editingFiles.has(filePath) ? stopEditing(filePath) : startEditing(filePath)
                            }
                            title={editingFiles.has(filePath) ? "Close editor" : "Edit file (e)"}
                          >
                            <PencilIcon className="size-3.5" />
                          </button>
                        )}
                      </div>
                      {!isViewed && editingFiles.has(filePath) && activeCwd ? (
                        <EditableFileView
                          filePath={filePath}
                          cwd={activeCwd}
                          onSave={stopEditing}
                          onCancel={stopEditing}
                          isSaving={false}
                          scrollToLine={editScrollLine[filePath] ?? fileDiff.hunks[0]?.additionStart}
                        />
                      ) : !isViewed ? (
                        <div
                          className="animate-[diffExpand_250ms_ease-out] overflow-clip"
                          onContextMenu={(event) => {
                            const lineNumber = getLineNumberFromEvent(event);
                            if (lineNumber == null || !activeCwd) return;
                            event.preventDefault();
                            setContextMenu({
                              x: event.clientX,
                              y: event.clientY,
                              filePath,
                              lineNumber,
                            });
                          }}
                        >
                          <FileDiff
                            fileDiff={fileDiff}
                            options={{
                              diffStyle: diffRenderMode === "split" ? "split" : "unified",
                              lineDiffType: "word",
                              theme: resolveDiffThemeName(resolvedTheme),
                              themeType: resolvedTheme as DiffThemeType,
                              disableFileHeader: true,
                              unsafeCSS: resolvedTheme === "dark" ? DIFF_CSS_DARK : DIFF_CSS_LIGHT,
                            }}
                          />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </Virtualizer>
            ) : (
              <div className="h-full overflow-auto p-2">
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground/75">{renderablePatch.reason}</p>
                  <pre className="max-h-[72vh] overflow-auto rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90">
                    {renderablePatch.text}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </>
      )}
      {contextMenu && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setContextMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
          onKeyDown={(e) => { if (e.key === "Escape") setContextMenu(null); }}
          tabIndex={-1}
        >
          <div
            className="absolute rounded-md border border-border/80 bg-popover py-1 shadow-lg dark:border-[#30363d] dark:bg-[#252a31]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-foreground hover:bg-accent"
              onClick={() => {
                startEditing(contextMenu.filePath, contextMenu.lineNumber);
                setContextMenu(null);
              }}
            >
              <PencilIcon className="size-3.5" />
              Edit at line {contextMenu.lineNumber}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
