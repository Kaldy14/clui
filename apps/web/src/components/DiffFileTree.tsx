import type { FileDiffMetadata } from "@pierre/diffs/react";
import {
  prepareFileTreeInput,
  type ContextMenuItem,
  type ContextMenuOpenContext,
  type FileTreeIcons,
  type FileTreePreparedInput,
  type FileTreeRowDecorationRenderer,
  type GitStatusEntry,
} from "@pierre/trees";
import { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react";
import { useCallback, useEffect, useMemo, useRef, type CSSProperties } from "react";

interface DiffFileTreeProps {
  files: FileDiffMetadata[];
  viewedFiles: Set<string>;
  onFileClick: (filePath: string) => void;
  onToggleViewed: (filePath: string) => void;
  resolveFilePath: (fileDiff: FileDiffMetadata) => string;
  getFileStats: (fileDiff: FileDiffMetadata) => { additions: number; deletions: number };
  reviewDecorations?:
    | ReadonlyMap<string, { rank: number; significance: "high" | "medium" | "low" }>
    | undefined;
}

type ChangeKind = GitStatusEntry["status"];

type TreeHostStyle = CSSProperties & Record<`--${string}`, string | number>;

interface DiffTreeStat {
  additions: number;
  deletions: number;
}

interface DiffTreeData {
  directoryStatsByPath: ReadonlyMap<string, DiffTreeStat>;
  filePathSet: ReadonlySet<string>;
  fileStatsByPath: ReadonlyMap<string, DiffTreeStat>;
  gitStatus: readonly GitStatusEntry[];
  paths: readonly string[];
  preparedInput: FileTreePreparedInput;
}

interface DiffFileTreeRuntimeState {
  directoryStatsByPath: ReadonlyMap<string, DiffTreeStat>;
  filePathSet: ReadonlySet<string>;
  fileStatsByPath: ReadonlyMap<string, DiffTreeStat>;
  onFileClick: (filePath: string) => void;
  onToggleViewed: (filePath: string) => void;
  reviewDecorations: ReadonlyMap<string, { rank: number; significance: "high" | "medium" | "low" }>;
  viewedFiles: ReadonlySet<string>;
}

function mapChangeType(type: string): ChangeKind {
  if (type === "new") return "added";
  if (type === "deleted") return "deleted";
  if (type === "rename-pure" || type === "rename-changed") return "renamed";
  return "modified";
}

const CHANGE_LABEL: Record<ChangeKind, string> = {
  added: "Added",
  deleted: "Deleted",
  ignored: "Ignored",
  modified: "Modified",
  renamed: "Renamed",
  untracked: "Untracked",
};

const DIFF_TREE_ICONS = {
  colored: false,
  set: "standard",
} satisfies FileTreeIcons;

const DIFF_TREE_STYLE = {
  height: "100%",
  minHeight: 0,
  width: "100%",
  display: "block",
  background: "transparent",
  "--trees-bg-override": "transparent",
  "--trees-fg-override": "var(--foreground)",
  "--trees-fg-muted-override": "var(--muted-foreground)",
  "--trees-bg-muted-override": "var(--accent)",
  "--trees-border-color-override": "var(--border)",
  "--trees-accent-override": "var(--primary)",
  "--trees-focus-ring-color-override": "var(--ring)",
  "--trees-selected-bg-override": "var(--accent)",
  "--trees-selected-fg-override": "var(--accent-foreground)",
  "--trees-selected-focused-border-color-override": "var(--ring)",
  "--trees-font-family-override": "inherit",
  "--trees-font-size-override": "12px",
  "--trees-font-weight-semibold-override": 500,
  "--trees-item-padding-x-override": "2px",
  "--trees-item-margin-x-override": "2px",
  "--trees-item-row-gap-override": "3px",
  "--trees-level-gap-override": "4px",
  "--trees-icon-width-override": "14px",
  "--trees-padding-inline-override": "4px",
  "--trees-git-lane-width-override": "10px",
  "--trees-status-added-override": "var(--success-foreground)",
  "--trees-status-deleted-override": "var(--destructive-foreground)",
  "--trees-status-modified-override": "var(--warning-foreground)",
  "--trees-status-renamed-override": "var(--info-foreground)",
  "--trees-git-added-color-override": "var(--success-foreground)",
  "--trees-git-deleted-color-override": "var(--destructive-foreground)",
  "--trees-git-modified-color-override": "var(--warning-foreground)",
  "--trees-git-renamed-color-override": "var(--info-foreground)",
} satisfies TreeHostStyle;

const DIFF_TREE_UNSAFE_CSS = `
  [data-file-tree-virtualized-scroll='true'] {
    overflow-x: hidden;
  }

  [data-type='item'] {
    box-sizing: border-box;
    min-width: 0;
    max-width: 100%;
    --trees-bg-alpha-light: 6%;
    --trees-bg-alpha-dark: 8%;
  }

  [data-item-section='spacing'] {
    flex: 0 0 auto;
    padding-left: 1px;
  }

  [data-item-section='spacing-item'] {
    box-sizing: border-box;
    flex: 0 0 4px;
    width: 4px;
    margin-right: 1px;
    opacity: 0.45;
  }

  [data-item-section='spacing-item'] + [data-item-section='spacing-item'] {
    margin-left: 0;
  }

  :host(:hover) [data-item-section='spacing-item'] {
    opacity: 0.7;
  }

  [data-item-section='decoration'] {
    max-width: 68px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
`;

function normalizeTreePath(pathValue: string): string {
  return pathValue
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0)
    .join("/");
}

function addStatToMap(map: Map<string, DiffTreeStat>, path: string, stat: DiffTreeStat) {
  const existing = map.get(path);
  if (!existing) {
    map.set(path, { additions: stat.additions, deletions: stat.deletions });
    return;
  }

  map.set(path, {
    additions: existing.additions + stat.additions,
    deletions: existing.deletions + stat.deletions,
  });
}

export function buildDiffTreeData(
  files: readonly FileDiffMetadata[],
  resolveFilePath: (fileDiff: FileDiffMetadata) => string,
  getFileStats: (fileDiff: FileDiffMetadata) => DiffTreeStat,
): DiffTreeData {
  const paths: string[] = [];
  const filePathSet = new Set<string>();
  const fileStatsByPath = new Map<string, DiffTreeStat>();
  const directoryStatsByPath = new Map<string, DiffTreeStat>();
  const gitStatus: GitStatusEntry[] = [];

  for (const fileDiff of files) {
    const path = normalizeTreePath(resolveFilePath(fileDiff));
    if (!path) continue;

    const stat = getFileStats(fileDiff);
    addStatToMap(fileStatsByPath, path, stat);

    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      addStatToMap(directoryStatsByPath, segments.slice(0, index).join("/"), stat);
    }

    if (filePathSet.has(path)) continue;

    filePathSet.add(path);
    paths.push(path);
    gitStatus.push({ path, status: mapChangeType(fileDiff.type) });
  }

  const preparedInput = prepareFileTreeInput(paths);

  return {
    directoryStatsByPath,
    filePathSet,
    fileStatsByPath,
    gitStatus,
    paths: preparedInput.paths,
    preparedInput,
  };
}

function formatStatText(
  stat: DiffTreeStat | undefined,
  viewed: boolean,
  review: { rank: number; significance: "high" | "medium" | "low" } | undefined,
): string | null {
  const parts: string[] = [];
  if (review) parts.push(`#${review.rank} ${review.significance}`);
  if (viewed) parts.push("✓");
  if (stat && stat.additions > 0) parts.push(`+${stat.additions}`);
  if (stat && stat.deletions > 0) parts.push(`-${stat.deletions}`);
  return parts.length > 0 ? parts.join(" ") : null;
}

function reviewDecorationForDirectory(
  directoryPath: string,
  reviewDecorations: ReadonlyMap<string, { rank: number; significance: "high" | "medium" | "low" }>,
): { rank: number; significance: "high" | "medium" | "low" } | undefined {
  const prefix = directoryPath.endsWith("/") ? directoryPath : `${directoryPath}/`;
  let best: { rank: number; significance: "high" | "medium" | "low" } | undefined;
  for (const [filePath, review] of reviewDecorations) {
    if (!filePath.startsWith(prefix)) continue;
    if (!best || review.rank < best.rank) best = review;
  }
  return best;
}

function formatStatTitle(path: string, stat: DiffTreeStat | undefined, viewed: boolean): string {
  const pieces = [path];
  if (viewed) pieces.push("viewed");
  if (stat && (stat.additions > 0 || stat.deletions > 0)) {
    pieces.push(`${stat.additions} additions, ${stat.deletions} deletions`);
  }
  return pieces.join(" · ");
}

export default function DiffFileTree({
  files,
  viewedFiles,
  onFileClick,
  onToggleViewed,
  resolveFilePath,
  getFileStats,
  reviewDecorations = new Map(),
}: DiffFileTreeProps) {
  const treeData = useMemo(
    () => buildDiffTreeData(files, resolveFilePath, getFileStats),
    [files, resolveFilePath, getFileStats],
  );

  const runtimeStateRef = useRef<DiffFileTreeRuntimeState>({
    directoryStatsByPath: new Map<string, DiffTreeStat>(),
    filePathSet: new Set<string>(),
    fileStatsByPath: new Map<string, DiffTreeStat>(),
    onFileClick,
    onToggleViewed,
    reviewDecorations,
    viewedFiles,
  });

  runtimeStateRef.current = {
    directoryStatsByPath: treeData.directoryStatsByPath,
    filePathSet: treeData.filePathSet,
    fileStatsByPath: treeData.fileStatsByPath,
    onFileClick,
    onToggleViewed,
    reviewDecorations,
    viewedFiles,
  };

  const handleSelectionChange = useCallback((selectedPaths: readonly string[]) => {
    const { filePathSet, onFileClick: openFile } = runtimeStateRef.current;
    for (let index = selectedPaths.length - 1; index >= 0; index -= 1) {
      const selectedPath = selectedPaths[index];
      if (selectedPath && filePathSet.has(selectedPath)) {
        openFile(selectedPath);
        return;
      }
    }
  }, []);

  const renderRowDecoration = useCallback<FileTreeRowDecorationRenderer>((context) => {
    const {
      directoryStatsByPath,
      fileStatsByPath,
      reviewDecorations: currentReviewDecorations,
      viewedFiles: currentViewedFiles,
    } = runtimeStateRef.current;
    const isFile = context.item.kind === "file";
    const stat = isFile
      ? fileStatsByPath.get(context.item.path)
      : directoryStatsByPath.get(context.item.path);
    const viewed = isFile && currentViewedFiles.has(context.item.path);
    const review = isFile
      ? currentReviewDecorations.get(context.item.path)
      : reviewDecorationForDirectory(context.item.path, currentReviewDecorations);
    const text = formatStatText(stat, viewed, review);

    if (!text) return null;

    return {
      text,
      title: formatStatTitle(context.item.path, stat, viewed),
    };
  }, []);

  const renderContextMenu = useCallback(
    (item: ContextMenuItem, context: ContextMenuOpenContext) => {
      if (item.kind !== "file") return null;

      const state = runtimeStateRef.current;
      const viewed = state.viewedFiles.has(item.path);
      const status =
        treeData.gitStatus.find((entry) => entry.path === item.path)?.status ?? "modified";
      const statusLabel = CHANGE_LABEL[status];

      return (
        <div
          className="min-w-40 rounded-md border border-border bg-popover p-1 text-xs text-popover-foreground shadow-lg"
          data-file-tree-context-menu-root="true"
          role="menu"
        >
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {statusLabel}
          </div>
          <button
            type="button"
            className="flex w-full items-center rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
            onClick={(event) => {
              event.preventDefault();
              state.onFileClick(item.path);
              context.close();
            }}
            role="menuitem"
          >
            Open diff
          </button>
          <button
            type="button"
            className="flex w-full items-center rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
            onClick={(event) => {
              event.preventDefault();
              state.onToggleViewed(item.path);
              context.close();
            }}
            role="menuitem"
          >
            {viewed ? "Mark as unviewed" : "Mark as viewed"}
          </button>
        </div>
      );
    },
    [treeData.gitStatus],
  );

  const { model } = useFileTree({
    composition: {
      contextMenu: {
        buttonVisibility: "when-needed",
        triggerMode: "right-click",
      },
    },
    density: "compact",
    flattenEmptyDirectories: true,
    gitStatus: treeData.gitStatus,
    icons: DIFF_TREE_ICONS,
    initialExpansion: "open",
    initialVisibleRowCount: 18,
    onSelectionChange: handleSelectionChange,
    overscan: 10,
    paths: treeData.paths,
    preparedInput: treeData.preparedInput,
    renderRowDecoration,
    unsafeCSS: DIFF_TREE_UNSAFE_CSS,
  });

  useEffect(() => {
    model.resetPaths(treeData.paths, { preparedInput: treeData.preparedInput });
    model.setGitStatus(treeData.gitStatus);
  }, [model, treeData]);

  useEffect(() => {
    // @pierre/trees exposes row decorations as an initial renderer in beta. Re-applying
    // git status is the public row-render refresh path for decoration-only viewed changes.
    model.setGitStatus(treeData.gitStatus);
  }, [model, treeData.gitStatus, viewedFiles]);

  if (treeData.paths.length === 0) {
    return null;
  }

  return (
    <PierreFileTree
      className="select-none"
      model={model}
      renderContextMenu={renderContextMenu}
      style={DIFF_TREE_STYLE}
    />
  );
}
