import type { FileDiffMetadata } from "@pierre/diffs/react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileCode,
  Folder,
  FolderOpen,
} from "lucide-react";
import { useMemo, useState } from "react";
import type {
  TurnDiffTreeDirectoryNode,
  TurnDiffTreeFileNode,
  TurnDiffTreeNode,
} from "~/lib/turnDiffTree";
import { buildTurnDiffTree } from "~/lib/turnDiffTree";
import { cn } from "~/lib/utils";

interface DiffFileTreeProps {
  files: FileDiffMetadata[];
  viewedFiles: Set<string>;
  onFileClick: (filePath: string) => void;
  onToggleViewed: (filePath: string) => void;
  resolveFilePath: (fileDiff: FileDiffMetadata) => string;
  getFileStats: (fileDiff: FileDiffMetadata) => { additions: number; deletions: number };
}

type ChangeKind = "added" | "deleted" | "modified" | "renamed";

function mapChangeType(type: string): ChangeKind {
  if (type === "new") return "added";
  if (type === "deleted") return "deleted";
  if (type === "rename-pure" || type === "rename-changed") return "renamed";
  return "modified";
}

const CHANGE_BADGE: Record<ChangeKind, { label: string; className: string }> = {
  added: {
    label: "A",
    className: "bg-green-600/20 text-green-600 dark:bg-green-500/20 dark:text-green-400",
  },
  modified: {
    label: "M",
    className: "bg-yellow-600/20 text-yellow-600 dark:bg-yellow-500/20 dark:text-yellow-400",
  },
  deleted: {
    label: "D",
    className: "bg-red-600/20 text-red-600 dark:bg-red-500/20 dark:text-red-400",
  },
  renamed: {
    label: "R",
    className: "bg-blue-600/20 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400",
  },
};

function collectDirectoryPaths(nodes: TurnDiffTreeNode[]): Set<string> {
  const paths = new Set<string>();
  for (const node of nodes) {
    if (node.kind === "directory") {
      paths.add(node.path);
      for (const path of collectDirectoryPaths(node.children)) {
        paths.add(path);
      }
    }
  }
  return paths;
}

function FileNodeRow({
  node,
  depth,
  changeKind,
  isViewed,
  onFileClick,
  onToggleViewed,
}: {
  node: TurnDiffTreeFileNode;
  depth: number;
  changeKind: ChangeKind;
  isViewed: boolean;
  onFileClick: (filePath: string) => void;
  onToggleViewed: (filePath: string) => void;
}) {
  const badge = CHANGE_BADGE[changeKind];
  return (
    <div
      className={cn(
        "group flex items-center gap-1.5 py-0.5 pr-2 text-[12px] leading-tight",
        isViewed && "opacity-50",
      )}
      style={{ paddingLeft: `${depth * 16 + 4}px` }}
    >
      <button
        type="button"
        className="flex shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => onToggleViewed(node.path)}
        title={isViewed ? "Mark as unviewed" : "Mark as viewed"}
      >
        {isViewed ? (
          <Check className="size-3 text-blue-500" />
        ) : (
          <div className="size-3 rounded-sm border border-muted-foreground/40 group-hover:border-muted-foreground/70" />
        )}
      </button>
      <span
        className={cn("inline-flex size-4 shrink-0 items-center justify-center rounded text-[9px] font-bold leading-none", badge.className)}
      >
        {badge.label}
      </span>
      <FileCode className="size-3.5 shrink-0 text-muted-foreground/70" />
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left text-foreground/90 hover:text-foreground hover:underline"
        onClick={() => onFileClick(node.path)}
        title={node.path}
      >
        {node.name}
      </button>
      {node.stat && (
        <div className="flex shrink-0 items-center gap-1.5 tabular-nums text-[11px]">
          {node.stat.additions > 0 && (
            <span className="text-green-600 dark:text-green-400">+{node.stat.additions}</span>
          )}
          {node.stat.deletions > 0 && (
            <span className="text-red-500 dark:text-red-400">-{node.stat.deletions}</span>
          )}
        </div>
      )}
    </div>
  );
}

function DirectoryNodeRow({
  node,
  depth,
  isExpanded,
  onToggle,
  fileChangeKinds,
  viewedFiles,
  onFileClick,
  onToggleViewed,
  expandedPaths,
}: {
  node: TurnDiffTreeDirectoryNode;
  depth: number;
  isExpanded: boolean;
  onToggle: (path: string) => void;
  fileChangeKinds: Map<string, ChangeKind>;
  viewedFiles: Set<string>;
  onFileClick: (filePath: string) => void;
  onToggleViewed: (filePath: string) => void;
  expandedPaths: Set<string>;
}) {
  return (
    <div>
      <button
        type="button"
        className="group flex w-full items-center gap-1.5 py-0.5 pr-2 text-[12px] leading-tight text-foreground/90 hover:bg-accent/50"
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
        onClick={() => onToggle(node.path)}
      >
        {isExpanded ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        {isExpanded ? (
          <FolderOpen className="size-3.5 shrink-0 text-muted-foreground/70" />
        ) : (
          <Folder className="size-3.5 shrink-0 text-muted-foreground/70" />
        )}
        <span className="min-w-0 flex-1 truncate text-left font-medium">{node.name}</span>
        <div className="flex shrink-0 items-center gap-1.5 tabular-nums text-[11px]">
          {node.stat.additions > 0 && (
            <span className="text-green-600 dark:text-green-400">+{node.stat.additions}</span>
          )}
          {node.stat.deletions > 0 && (
            <span className="text-red-500 dark:text-red-400">-{node.stat.deletions}</span>
          )}
        </div>
      </button>
      {isExpanded && (
        <TreeNodeList
          nodes={node.children}
          depth={depth + 1}
          fileChangeKinds={fileChangeKinds}
          viewedFiles={viewedFiles}
          onFileClick={onFileClick}
          onToggleViewed={onToggleViewed}
          expandedPaths={expandedPaths}
          onToggleExpanded={onToggle}
        />
      )}
    </div>
  );
}

function TreeNodeList({
  nodes,
  depth,
  fileChangeKinds,
  viewedFiles,
  onFileClick,
  onToggleViewed,
  expandedPaths,
  onToggleExpanded,
}: {
  nodes: TurnDiffTreeNode[];
  depth: number;
  fileChangeKinds: Map<string, ChangeKind>;
  viewedFiles: Set<string>;
  onFileClick: (filePath: string) => void;
  onToggleViewed: (filePath: string) => void;
  expandedPaths: Set<string>;
  onToggleExpanded: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === "directory") {
          return (
            <DirectoryNodeRow
              key={node.path}
              node={node}
              depth={depth}
              isExpanded={expandedPaths.has(node.path)}
              onToggle={onToggleExpanded}
              fileChangeKinds={fileChangeKinds}
              viewedFiles={viewedFiles}
              onFileClick={onFileClick}
              onToggleViewed={onToggleViewed}
              expandedPaths={expandedPaths}
            />
          );
        }
        return (
          <FileNodeRow
            key={node.path}
            node={node}
            depth={depth}
            changeKind={fileChangeKinds.get(node.path) ?? "modified"}
            isViewed={viewedFiles.has(node.path)}
            onFileClick={onFileClick}
            onToggleViewed={onToggleViewed}
          />
        );
      })}
    </>
  );
}

export default function DiffFileTree({
  files,
  viewedFiles,
  onFileClick,
  onToggleViewed,
  resolveFilePath,
  getFileStats,
}: DiffFileTreeProps) {
  const { tree, fileChangeKinds } = useMemo(() => {
    const changes = files.map((fileDiff) => {
      const path = resolveFilePath(fileDiff);
      const stats = getFileStats(fileDiff);
      const kind = mapChangeType(fileDiff.type);
      return { path, kind, stats };
    });

    const treeInput = changes.map((change) => ({
      path: change.path,
      kind: change.kind,
      additions: change.stats.additions,
      deletions: change.stats.deletions,
    }));

    const builtTree = buildTurnDiffTree(treeInput);
    const kindMap = new Map<string, ChangeKind>();
    for (const change of changes) {
      kindMap.set(change.path, change.kind);
    }

    return { tree: builtTree, fileChangeKinds: kindMap };
  }, [files, resolveFilePath, getFileStats]);

  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() =>
    collectDirectoryPaths(tree),
  );

  const toggleExpanded = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  if (tree.length === 0) {
    return null;
  }

  return (
    <div className="select-none py-1">
      <TreeNodeList
        nodes={tree}
        depth={0}
        fileChangeKinds={fileChangeKinds}
        viewedFiles={viewedFiles}
        onFileClick={onFileClick}
        onToggleViewed={onToggleViewed}
        expandedPaths={expandedPaths}
        onToggleExpanded={toggleExpanded}
      />
    </div>
  );
}
