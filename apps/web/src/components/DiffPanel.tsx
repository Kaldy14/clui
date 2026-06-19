import { parsePatchFiles } from "@pierre/diffs";
import {
  FileDiff,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  Virtualizer,
} from "@pierre/diffs/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  ThreadId,
  type OrchestrationDiffReviewChange,
  type OrchestrationDiffReviewScope,
  type OrchestrationGenerateDiffReviewResult,
  type TurnId,
} from "@clui/contracts";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  Columns2Icon,
  FolderTreeIcon,
  PencilIcon,
  RotateCcw,
  Rows3Icon,
  Square,
  SquareCheckBig,
  FolderGit2,
  MessageSquareTextIcon,
  SparklesIcon,
  UnfoldVerticalIcon,
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
  providerQueryKeys,
  workingTreeDiffQueryOptions,
} from "~/lib/providerReactQuery";
import { readFileQueryOptions } from "~/lib/projectReactQuery";
import { cn } from "~/lib/utils";
import { readNativeApi } from "../nativeApi";
import { preferredTerminalEditor, resolvePathLinkTarget } from "../terminal-links";
import {
  parseDiffRouteSearch,
  stripAiReviewSearchParams,
  stripDiffSearchParams,
} from "../diffRouteSearch";
import { isElectron } from "../env";
import { useTheme } from "../hooks/useTheme";
import {
  diffReviewProgressStage,
  diffReviewRunKey,
  formatDiffReviewElapsed,
  useAiDiffReviewStore,
} from "../lib/aiDiffReviewStore";
import { buildPatchCacheKey } from "../lib/diffRendering";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useStore } from "../store";
import DiffFileTree from "./DiffFileTree";
import DiffQuickAskPopover, { type DiffQuickAskSelection } from "./DiffQuickAskPopover";
import { ToggleGroup, Toggle } from "./ui/toggle-group";

const DiffInlineEditor = lazy(() => import("./DiffInlineEditor"));

type DiffRenderMode = "stacked" | "split";
type DiffThemeType = "light" | "dark";

const DIFF_PREF_RENDER_MODE_KEY = "diff_render_mode";
const DIFF_PREF_FILE_TREE_KEY = "diff_show_file_tree";
const DIFF_PREF_EXPAND_UNCHANGED_KEY = "diff_expand_unchanged";

function readDiffPref<T>(key: string, fallback: T, validate: (v: unknown) => v is T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw);
    return validate(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}
function writeDiffPref(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* quota exceeded — ignore */ }
}
const isDiffRenderMode = (v: unknown): v is DiffRenderMode => v === "stacked" || v === "split";
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

const DIFF_CSS_COMMON = `
:host {
  --diffs-font-size: 12px;
  --diffs-line-height: 17px;
}

[data-overflow='wrap'] [data-line],
[data-overflow='wrap'] [data-annotation-content] {
  overflow-wrap: anywhere;
}
`;

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

function buildSelectedCodePatchContext(selectedText: string, filePatch: string): string {
  return [
    "Selected code:",
    selectedText.slice(0, 12_000),
    "",
    "Containing file patch:",
    filePatch,
  ].join("\n").slice(0, 80_000);
}

function extractFilePatchSection(patch: string | undefined, filePath: string): string {
  if (!patch) return "";
  const normalizedPath = filePath.startsWith("a/") || filePath.startsWith("b/")
    ? filePath.slice(2)
    : filePath;
  const patchLower = patch.toLowerCase();
  const needles = [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    `+++ b/${normalizedPath}`,
    `--- a/${normalizedPath}`,
  ].map((value) => value.toLowerCase());

  let headerIndex = -1;
  for (const needle of needles) {
    headerIndex = patchLower.indexOf(needle);
    if (headerIndex >= 0) break;
  }
  if (headerIndex < 0) return patch.slice(0, 80_000);

  const diffStart = patchLower.lastIndexOf("\ndiff --git", headerIndex);
  const start = diffStart >= 0 ? diffStart + 1 : headerIndex;
  const nextDiff = patchLower.indexOf("\ndiff --git", start + 1);
  const section = nextDiff >= 0 ? patch.slice(start, nextDiff) : patch.slice(start);
  return section.slice(0, 80_000);
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
  selectedText?: string | undefined;
}

type AiReviewWorkbenchStatus = "idle" | "generating" | "ready" | "error";

interface DiffHighlightRange {
  id: string;
  filePath: string;
  lineNumber: number | null;
  selectedText?: string | undefined;
  contextPatch: string;
  instruction?: string | undefined;
  createdAt: number;
}

interface DiffHighlightAnnotationMetadata {
  id: string;
  label: string;
  selectedText?: string | undefined;
}

function asDiffReviewErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "AI review failed.";
}

function aiReviewScopeLabel(scope: OrchestrationDiffReviewScope): string {
  switch (scope.type) {
    case "branch":
      return "Branch + local changes";
    case "workingTree":
      return "Working tree";
    case "turn":
      return `Turn ${scope.toTurnCount}`;
    case "fullThread":
      return `All turns through ${scope.toTurnCount}`;
  }
}

function aiReviewTone(significance: OrchestrationDiffReviewChange["significance"]): string {
  switch (significance) {
    case "high":
      return "border-red-500/35 bg-red-500/[0.08] text-red-600 dark:text-red-300";
    case "medium":
      return "border-amber-500/35 bg-amber-500/[0.08] text-amber-700 dark:text-amber-300";
    case "low":
      return "border-blue-500/30 bg-blue-500/[0.07] text-blue-700 dark:text-blue-300";
  }
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

function DiffAiReviewWorkbenchSummary({
  active,
  status,
  scope,
  review,
  error,
  startedAt,
  now,
  stackItems,
  stackAnswer,
  stackPending,
  onGenerate,
  onClose,
  onSubmitStack,
  onClearStack,
}: {
  active: boolean;
  status: AiReviewWorkbenchStatus;
  scope: OrchestrationDiffReviewScope;
  review: OrchestrationGenerateDiffReviewResult | null;
  error: string | null;
  startedAt: number | null;
  now: number;
  stackItems: readonly DiffHighlightRange[];
  stackAnswer: string | null;
  stackPending: boolean;
  onGenerate: () => void;
  onClose: () => void;
  onSubmitStack: () => void;
  onClearStack: () => void;
}) {
  if (!active) return null;

  const progress =
    status === "generating" && startedAt !== null
      ? {
          elapsed: formatDiffReviewElapsed(now - startedAt),
          stage: diffReviewProgressStage(now - startedAt),
        }
      : null;

  return (
    <section className="shrink-0 border-b border-border/60 bg-blue-500/[0.035] px-3 py-3">
      <div className="rounded-xl border border-blue-500/20 bg-background/80 p-3 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-lg bg-blue-500/12 text-blue-600 dark:text-blue-300">
                <SparklesIcon className="size-4" />
              </span>
              <div>
                <h2 className="font-semibold text-sm text-foreground">AI Review workbench</h2>
                <p className="text-[11px] text-muted-foreground">{aiReviewScopeLabel(scope)}</p>
              </div>
            </div>
            <p className="mt-2 max-w-3xl text-[12px] leading-relaxed text-muted-foreground">
              Files stay diff-first. AI ranks the review path, explains risky files, and lets you
              stack highlighted ranges for one batched Pi question.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button
              type="button"
              className="rounded-md border border-border/70 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground"
              onClick={onClose}
            >
              Normal diff
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-60"
              disabled={status === "generating"}
              onClick={onGenerate}
            >
              <SparklesIcon className={cn("size-3", status === "generating" && "animate-pulse")} />
              {review ? "Regenerate" : status === "generating" ? "Generating…" : "Generate AI review"}
            </button>
          </div>
        </div>

        {progress && (
          <div className="mt-3 rounded-lg border border-blue-500/20 bg-blue-500/[0.06] p-2 text-[12px] text-blue-700 dark:text-blue-200">
            <div className="flex items-center justify-between gap-2">
              <span>{progress.stage}</span>
              <span className="font-mono text-[11px]">{progress.elapsed}</span>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-blue-500/15">
              <div className="h-full w-1/2 animate-pulse rounded-full bg-blue-500/60" />
            </div>
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/[0.06] p-2 text-[12px] leading-relaxed text-red-600 dark:text-red-300">
            <div className="font-medium">AI review failed</div>
            <div className="mt-0.5 text-muted-foreground">{error}</div>
          </div>
        )}

        {review && (
          <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.4fr)]">
            <div className="space-y-3">
              <div className="rounded-lg border border-border/70 bg-card/70 p-3">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>{review.sourceLabel}</span>
                <span className="font-mono">{review.diffStat}</span>
                <span>
                  covered {review.coveredFileCount}/{review.totalFileCount} files
                  {review.summarizedFileCount > 0 ? ` · ${review.summarizedFileCount} summarized` : ""}
                </span>
              </div>
                <p className="text-[13px] leading-relaxed text-foreground/90">{review.overview}</p>
              </div>
              {(review.keyChanges.length > 0 || review.testFocus.length > 0 || review.followUps.length > 0) && (
                <div className="grid gap-3 md:grid-cols-3">
                  {review.keyChanges.length > 0 && (
                    <div className="rounded-lg border border-border/70 bg-card/70 p-3">
                      <p className="mb-2 font-semibold text-xs text-foreground">Ranked path</p>
                      <ol className="space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
                        {review.keyChanges.slice(0, 5).map((change) => (
                          <li key={change.id} className="flex gap-1.5">
                            <span className="shrink-0 font-mono text-foreground/70">#{change.rank}</span>
                            <span className="min-w-0 truncate">{change.filePath}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                  {review.testFocus.length > 0 && (
                    <div className="rounded-lg border border-border/70 bg-card/70 p-3">
                      <p className="mb-2 font-semibold text-xs text-foreground">Test focus</p>
                      <ul className="space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
                        {review.testFocus.slice(0, 5).map((item, index) => (
                          <li key={`${index}-${item}`} className="list-inside list-disc">{item}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {review.followUps.length > 0 && (
                    <div className="rounded-lg border border-border/70 bg-card/70 p-3">
                      <p className="mb-2 font-semibold text-xs text-foreground">Follow-up questions</p>
                      <ul className="space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
                        {review.followUps.slice(0, 5).map((item, index) => (
                          <li key={`${index}-${item}`} className="list-inside list-disc">{item}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="rounded-lg border border-border/70 bg-card/70 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold text-xs text-foreground">AI stack</p>
                {stackItems.length > 0 && (
                  <button
                    type="button"
                    className="text-[10px] text-muted-foreground hover:text-foreground"
                    onClick={onClearStack}
                  >
                    Clear
                  </button>
                )}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                {stackItems.length === 0
                  ? "Highlight ranges from the diff and add them here for one batched Pi pass."
                  : `${stackItems.length} highlighted ${stackItems.length === 1 ? "range" : "ranges"} ready.`}
              </p>
              {stackItems.length > 0 && (
                <div className="mt-2 max-h-28 space-y-1 overflow-auto pr-1">
                  {stackItems.map((item, index) => (
                    <div key={item.id} className="rounded-md bg-muted/30 px-2 py-1 text-[10px] text-muted-foreground">
                      <span className="font-mono text-foreground/75">{index + 1}.</span> {item.filePath}
                      {item.lineNumber != null ? `:${item.lineNumber}` : ""}
                      {item.selectedText ? " · selection" : ""}
                    </div>
                  ))}
                </div>
              )}
              <button
                type="button"
                className="mt-2 w-full rounded-md border border-border/70 px-2 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
                disabled={stackItems.length === 0 || status === "generating" || stackPending}
                onClick={onSubmitStack}
              >
                {stackPending ? "Sending stack…" : "Send stack to Pi"}
              </button>
            </div>
          </div>
        )}

        {stackAnswer && (
          <div className="mt-3 whitespace-pre-wrap rounded-lg border border-border/70 bg-card/70 p-3 text-[12px] leading-relaxed text-foreground/90">
            {stackAnswer}
          </div>
        )}
      </div>
    </section>
  );
}

function DiffAiReviewFileSummary({ change }: { change: OrchestrationDiffReviewChange | undefined }) {
  if (!change) return null;
  return (
    <div className="border-b border-border/50 bg-blue-500/[0.035] px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded-full border px-1.5 py-0.5 font-medium text-[10px] uppercase tracking-wide", aiReviewTone(change.significance))}>
          #{change.rank} · {change.significance}
        </span>
        <span className="min-w-0 truncate text-[12px] font-medium text-foreground">{change.title}</span>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{change.summary}</p>
      {(change.reviewFocus.length > 0 || change.risks.length > 0) && (
        <div className="mt-2 grid gap-2 text-[11px] leading-relaxed text-muted-foreground md:grid-cols-2">
          {change.reviewFocus.length > 0 && (
            <div>
              <span className="font-medium text-foreground/80">Review focus: </span>
              {change.reviewFocus.slice(0, 3).join(" · ")}
            </div>
          )}
          {change.risks.length > 0 && (
            <div>
              <span className="font-medium text-foreground/80">Risks: </span>
              {change.risks.slice(0, 3).join(" · ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({ mode = "inline" }: DiffPanelProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();
  const [diffRenderMode, setDiffRenderModeRaw] = useState<DiffRenderMode>(() =>
    readDiffPref(DIFF_PREF_RENDER_MODE_KEY, "stacked" as DiffRenderMode, isDiffRenderMode),
  );
  const setDiffRenderMode = useCallback((mode: DiffRenderMode) => {
    setDiffRenderModeRaw(mode);
    writeDiffPref(DIFF_PREF_RENDER_MODE_KEY, mode);
  }, []);
  const [showFileTree, setShowFileTreeRaw] = useState(() =>
    readDiffPref(DIFF_PREF_FILE_TREE_KEY, true, isBoolean),
  );
  const setShowFileTree = useCallback((fn: boolean | ((prev: boolean) => boolean)) => {
    setShowFileTreeRaw((prev) => {
      const next = typeof fn === "function" ? fn(prev) : fn;
      writeDiffPref(DIFF_PREF_FILE_TREE_KEY, next);
      return next;
    });
  }, []);
  const [expandUnchanged, setExpandUnchangedRaw] = useState(() =>
    readDiffPref(DIFF_PREF_EXPAND_UNCHANGED_KEY, false, isBoolean),
  );
  const setExpandUnchanged = useCallback((fn: boolean | ((prev: boolean) => boolean)) => {
    setExpandUnchangedRaw((prev) => {
      const next = typeof fn === "function" ? fn(prev) : fn;
      writeDiffPref(DIFF_PREF_EXPAND_UNCHANGED_KEY, next);
      return next;
    });
  }, []);
  const [showWorkingTree, setShowWorkingTree] = useState(false);
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelWide, setPanelWide] = useState(false);
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
  const shouldShowWorkingTreeDiff = !hasTurns || showWorkingTree;
  const shouldLiveRefreshWorkingTreeDiff =
    shouldShowWorkingTreeDiff && activeThread?.terminalStatus === "active";
  const workingTreeDiffQuery = useQuery(
    workingTreeDiffQueryOptions({
      threadId: activeThreadId,
      enabled: isGitRepo && shouldShowWorkingTreeDiff,
      refetchIntervalMs: shouldLiveRefreshWorkingTreeDiff ? 5_000 : false,
    }),
  );
  const selectedTurnCheckpointDiff = selectedTurn
    ? activeCheckpointDiffQuery.data?.diff
    : undefined;
  const conversationCheckpointDiff = selectedTurn
    ? undefined
    : activeCheckpointDiffQuery.data?.diff;
  const isLoadingCheckpointDiff = showWorkingTree
    ? workingTreeDiffQuery.isLoading
    : hasTurns
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

  const selectedPatch = showWorkingTree
    ? workingTreeDiffQuery.data?.diff
    : hasTurns
      ? (selectedTurn ? selectedTurnCheckpointDiff : conversationCheckpointDiff)
      : workingTreeDiffQuery.data?.diff;
  const currentSelectedReviewScope = useMemo<OrchestrationDiffReviewScope>(() => {
    if (showWorkingTree) {
      return { type: "workingTree" };
    }
    if (selectedTurn && selectedCheckpointRange) {
      return {
        type: "turn",
        fromTurnCount: selectedCheckpointRange.fromTurnCount,
        toTurnCount: selectedCheckpointRange.toTurnCount,
      };
    }
    if (!selectedTurn && typeof conversationCheckpointTurnCount === "number") {
      return { type: "fullThread", toTurnCount: conversationCheckpointTurnCount };
    }
    return { type: "branch" };
  }, [conversationCheckpointTurnCount, selectedCheckpointRange, selectedTurn, showWorkingTree]);
  const aiReviewActive = diffSearch.diffAiReview === "1";
  const aiReviewRunToken = diffSearch.diffAiReviewRun ?? null;
  const aiReviewRunKey = useMemo(
    () => diffReviewRunKey({ threadId: activeThreadId, scope: currentSelectedReviewScope }),
    [activeThreadId, currentSelectedReviewScope],
  );
  const aiReviewRun = useAiDiffReviewStore((state) =>
    aiReviewRunKey ? state.runsByKey[aiReviewRunKey] ?? null : null,
  );
  const startAiReviewRun = useAiDiffReviewStore((state) => state.startRun);
  const markAiReviewRunSeen = useAiDiffReviewStore((state) => state.markRunSeen);
  const aiReviewResult = aiReviewRun?.result ?? null;
  const aiReviewError =
    aiReviewRun?.status === "error" ? aiReviewRun.error ?? "AI review failed." : null;
  const [aiReviewNow, setAiReviewNow] = useState(() => Date.now());
  const [aiStackItems, setAiStackItems] = useState<DiffHighlightRange[]>([]);
  const [aiStackAnswer, setAiStackAnswer] = useState<string | null>(null);
  const [quickAskSelection, setQuickAskSelection] = useState<DiffQuickAskSelection | null>(null);
  const [selectionAskTrigger, setSelectionAskTrigger] = useState<DiffQuickAskSelection | null>(null);
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const renderablePatch = useMemo(
    () => getRenderablePatch(selectedPatch, `diff-panel:${resolvedTheme}`),
    [resolvedTheme, selectedPatch],
  );
  const diffUnsafeCSS = useMemo(
    () => `${DIFF_CSS_COMMON}\n${resolvedTheme === "dark" ? DIFF_CSS_DARK : DIFF_CSS_LIGHT}`,
    [resolvedTheme],
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

  const startCurrentAiReview = useCallback(() => {
    setAiStackAnswer(null);
    void startAiReviewRun({ threadId: activeThreadId, scope: currentSelectedReviewScope }).catch(
      () => undefined,
    );
  }, [activeThreadId, currentSelectedReviewScope, startAiReviewRun]);

  const aiStackMutation = useMutation({
    mutationFn: async (items: DiffHighlightRange[]) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) throw new Error("Select a thread before asking Pi about a stack.");
      const contextPatch = items
        .map((item, index) =>
          [
            `Stack item ${index + 1}`,
            `File: ${item.filePath}`,
            `Line: ${item.lineNumber ?? "selection"}`,
            item.instruction ? `Instruction: ${item.instruction}` : null,
            item.selectedText ? `Selected text:\n${item.selectedText}` : null,
            "Patch context:",
            item.contextPatch,
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
        )
        .join("\n\n---\n\n")
        .slice(0, 80_000);
      return await api.orchestration.askDiffReview({
        threadId: activeThreadId,
        filePath: "AI review stack",
        lineNumber: null,
        prompt: "Review these highlighted diff ranges together. Cluster related risks, answer any item instructions, and suggest what to verify next.",
        contextPatch,
      });
    },
    onMutate: () => setAiStackAnswer(null),
    onSuccess: (result) => setAiStackAnswer(result.answer),
    onError: (error) => setAiStackAnswer(asDiffReviewErrorMessage(error)),
  });

  useEffect(() => {
    if (!aiReviewActive || !aiReviewRunToken || !activeThreadId) return;
    setAiStackAnswer(null);
    void startAiReviewRun({ threadId: activeThreadId, scope: currentSelectedReviewScope }).catch(
      () => undefined,
    );
    // The run token is only changed by the explicit AI Review button/shortcut.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId, aiReviewActive, aiReviewRunToken, startAiReviewRun]);

  useEffect(() => {
    if (!aiReviewActive || !aiReviewRunKey || !aiReviewRun?.unread) return;
    markAiReviewRunSeen(aiReviewRunKey);
  }, [aiReviewActive, aiReviewRun?.unread, aiReviewRunKey, markAiReviewRunSeen]);

  useEffect(() => {
    if (aiReviewRun?.status !== "running") return;
    setAiReviewNow(Date.now());
    const intervalId = window.setInterval(() => setAiReviewNow(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [aiReviewRun?.key, aiReviewRun?.status]);

  const aiReviewStatus: AiReviewWorkbenchStatus = aiReviewRun?.status === "running"
    ? "generating"
    : aiReviewError
      ? "error"
      : aiReviewResult
        ? "ready"
        : "idle";

  const aggregateStats = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const fileDiff of renderableFiles) {
      const stats = getFileDiffStats(fileDiff);
      additions += stats.additions;
      deletions += stats.deletions;
    }
    return { additions, deletions, fileCount: renderableFiles.length };
  }, [renderableFiles]);

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

  const addAiStackItem = useCallback((input: {
    filePath: string;
    lineNumber: number | null;
    selectedText?: string | undefined;
    instruction?: string | undefined;
    contextPatch: string;
  }) => {
    const item: DiffHighlightRange = {
      id: `stack-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      filePath: input.filePath,
      lineNumber: input.lineNumber,
      selectedText: input.selectedText,
      instruction: input.instruction,
      contextPatch: input.contextPatch,
      createdAt: Date.now(),
    };
    setAiStackItems((current) => [...current, item]);
    setAiStackAnswer(null);
  }, []);

  const [editingFiles, setEditingFiles] = useState<Set<string>>(new Set());
  const [editScrollLine, setEditScrollLine] = useState<Record<string, number>>({});
  const [contextMenu, setContextMenu] = useState<DiffContextMenu | null>(null);

  useEffect(() => {
    setEditingFiles(new Set());
    setSelectionAskTrigger(null);
    setQuickAskSelection(null);
    setAiStackItems([]);
    setAiStackAnswer(null);
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

  const aiReviewChangeByPath = useMemo(() => {
    const map = new Map<string, OrchestrationDiffReviewChange>();
    for (const change of aiReviewResult?.keyChanges ?? []) {
      if (!map.has(change.filePath)) map.set(change.filePath, change);
    }
    return map;
  }, [aiReviewResult]);

  const aiReviewTreeDecorations = useMemo(() => {
    const map = new Map<string, { rank: number; significance: "high" | "medium" | "low" }>();
    for (const change of aiReviewResult?.keyChanges ?? []) {
      map.set(change.filePath, { rank: change.rank, significance: change.significance });
    }
    return map;
  }, [aiReviewResult]);

  const sortedRenderableFiles = useMemo(() => {
    if (!aiReviewActive || !aiReviewResult || aiReviewResult.keyChanges.length === 0) {
      return renderableFiles;
    }
    const rankByPath = new Map(aiReviewResult.keyChanges.map((change) => [change.filePath, change.rank]));
    return renderableFiles.toSorted((left, right) => {
      const leftPath = resolveFileDiffPath(left);
      const rightPath = resolveFileDiffPath(right);
      const leftRank = rankByPath.get(leftPath) ?? Number.POSITIVE_INFINITY;
      const rightRank = rankByPath.get(rightPath) ?? Number.POSITIVE_INFINITY;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return leftPath.localeCompare(rightPath, undefined, { numeric: true, sensitivity: "base" });
    });
  }, [aiReviewActive, aiReviewResult, renderableFiles]);

  const [focusedFileIndex, setFocusedFileIndex] = useState<number | null>(null);
  const [fileTreeHeight, setFileTreeHeight] = useState(240);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Reset focus and search when files change
  useEffect(() => {
    setFocusedFileIndex(null);
    setSearchOpen(false);
    setSearchQuery("");
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

  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const lower = searchQuery.toLowerCase();
    const matches: number[] = [];
    const matchedSet = new Set<number>();
    for (let i = 0; i < sortedRenderableFiles.length; i++) {
      const filePath = resolveFileDiffPath(sortedRenderableFiles[i]!);
      if (filePath.toLowerCase().includes(lower)) {
        matches.push(i);
        matchedSet.add(i);
      }
    }
    if (selectedPatch) {
      const patchLower = selectedPatch.toLowerCase();
      for (let i = 0; i < sortedRenderableFiles.length; i++) {
        if (matchedSet.has(i)) continue;
        const fileDiff = sortedRenderableFiles[i]!;
        const filePath = resolveFileDiffPath(fileDiff);
        const headerVariants = [`--- a/${filePath}`, `+++ b/${filePath}`];
        const prevName = fileDiff.prevName;
        if (prevName) headerVariants.push(`--- a/${prevName}`);
        let headerIdx = -1;
        for (const hv of headerVariants) {
          headerIdx = patchLower.indexOf(hv.toLowerCase());
          if (headerIdx !== -1) break;
        }
        if (headerIdx === -1) continue;
        const nextDiff = patchLower.indexOf("\ndiff --git", headerIdx + 1);
        const section = nextDiff === -1 ? patchLower.slice(headerIdx) : patchLower.slice(headerIdx, nextDiff);
        if (section.includes(lower)) {
          matches.push(i);
        }
      }
      matches.sort((a, b) => a - b);
    }
    return matches;
  }, [searchQuery, sortedRenderableFiles, selectedPatch]);

  const goToSearchMatch = useCallback(
    (index: number) => {
      if (searchMatches.length === 0) return;
      const wrapped = ((index % searchMatches.length) + searchMatches.length) % searchMatches.length;
      setSearchMatchIndex(wrapped);
      const fileIndex = searchMatches[wrapped]!;
      setFocusedFileIndex(fileIndex);
      requestAnimationFrame(() => scrollToFileByIndex(fileIndex));
    },
    [searchMatches, scrollToFileByIndex],
  );

  useEffect(() => {
    if (!searchOpen || searchMatches.length === 0) return;
    const firstMatch = searchMatches[0]!;
    setSearchMatchIndex(0);
    setFocusedFileIndex(firstMatch);
    requestAnimationFrame(() => scrollToFileByIndex(firstMatch));
  }, [searchMatches, searchOpen, scrollToFileByIndex]);

  const closeDiff = useCallback(() => {
    if (!routeThreadId) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: routeThreadId },
      search: (previous) => stripDiffSearchParams(previous),
    });
  }, [navigate, routeThreadId]);

  const closeAiReview = useCallback(() => {
    if (!routeThreadId) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: routeThreadId },
      search: (previous) => stripAiReviewSearchParams(previous),
    });
  }, [navigate, routeThreadId]);

  // Keyboard navigation: j/k to move, v to toggle viewed, e to edit, Escape to close
  // Registered on panelRef so shortcuts work regardless of which panel area has focus
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

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

      if ((event.metaKey || event.ctrlKey) && event.key === "f") {
        event.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        if (searchOpen) {
          setSearchOpen(false);
          setSearchQuery("");
          panelRef.current?.focus();
        } else if (aiReviewActive) {
          closeAiReview();
          panelRef.current?.focus();
        } else {
          closeDiff();
        }
        return;
      }

      // File navigation shortcuts require files to be present
      if (sortedRenderableFiles.length === 0) return;

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
          const next = Math.min(prev + 1, sortedRenderableFiles.length - 1);
          requestAnimationFrame(() => scrollToFileByIndex(next));
          return next;
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

    panel.addEventListener("keydown", onKeyDown);
    return () => panel.removeEventListener("keydown", onKeyDown);
  }, [sortedRenderableFiles, scrollToFileByIndex, toggleFileViewed, editingFiles, startEditing, stopEditing, closeDiff, closeAiReview, searchOpen, aiReviewActive]);

  // Auto-focus the panel when it mounts so keyboard shortcuts work immediately
  useEffect(() => {
    const panel = panelRef.current;
    if (panel) {
      panel.focus({ preventScroll: true });
    }
  }, []);

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

  const openAiReview = useCallback(() => {
    if (!activeThread) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThread.id },
      search: (previous) => {
        const rest = stripAiReviewSearchParams(previous);
        return {
          ...rest,
          diff: "1",
          diffAiReview: "1",
          diffAiReviewRun: String(Date.now()),
        };
      },
    });
  }, [activeThread, navigate]);

  const selectTurn = (turnId: TurnId) => {
    setShowWorkingTree(false);
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
    setShowWorkingTree(false);
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
  const selectWorkingTree = () => {
    setShowWorkingTree(true);
    if (!activeThreadId) return;
    void queryClient.invalidateQueries({
      queryKey: providerQueryKeys.workingTreeDiff(activeThreadId),
    });
  };
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
    const el = panelRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setPanelWide(width >= 600);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
            data-turn-chip-selected={!showWorkingTree && selectedTurnId === null}
          >
            <div
              className={cn(
                "rounded-md border px-2 py-1 text-left transition-colors",
                !showWorkingTree && selectedTurnId === null
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
              data-turn-chip-selected={!showWorkingTree && summary.turnId === selectedTurn?.turnId}
            >
              <div
                className={cn(
                  "rounded-md border px-2 py-1 text-left transition-colors",
                  !showWorkingTree && summary.turnId === selectedTurn?.turnId
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
          <button
            type="button"
            className="shrink-0 rounded-md"
            onClick={selectWorkingTree}
            data-turn-chip-selected={showWorkingTree}
          >
            <div
              className={cn(
                "flex items-center gap-1 rounded-md border px-2 py-1 text-left transition-colors",
                showWorkingTree
                  ? "border-border bg-accent text-accent-foreground"
                  : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
              )}
            >
              <FolderGit2 className="size-3" />
              <span className="text-[10px] leading-tight font-medium">Working tree</span>
            </div>
          </button>
        </div>
      </div>
      {renderableFiles.length > 0 && (
        <div className="flex shrink-0 items-center gap-1.5 [-webkit-app-region:no-drag]">
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {aggregateStats.fileCount} {aggregateStats.fileCount === 1 ? "file" : "files"}
            {aggregateStats.additions > 0 && (
              <span className="text-green-600 dark:text-green-400"> +{aggregateStats.additions}</span>
            )}
            {aggregateStats.deletions > 0 && (
              <span className="text-red-500 dark:text-red-400"> -{aggregateStats.deletions}</span>
            )}
          </span>
          <span className="text-[9px] text-muted-foreground/50">·</span>
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
          "shrink-0 rounded-md border p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 [-webkit-app-region:no-drag]",
          aiReviewActive
            ? "border-blue-500/50 bg-blue-500/15 text-blue-600 dark:text-blue-300"
            : "border-border/70 text-muted-foreground hover:border-border hover:text-foreground",
        )}
        onClick={openAiReview}
        disabled={!activeThreadId || !isGitRepo}
        title={`Generate AI review for ${aiReviewScopeLabel(currentSelectedReviewScope)}`}
        data-ai-review-button
      >
        <SparklesIcon className="size-3" />
      </button>
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
      <button
        type="button"
        className={cn(
          "shrink-0 rounded-md border p-1.5 transition-colors [-webkit-app-region:no-drag]",
          expandUnchanged
            ? "border-border bg-accent text-foreground"
            : "border-border/70 text-muted-foreground hover:border-border hover:text-foreground",
        )}
        onClick={() => setExpandUnchanged((prev) => !prev)}
        title="Expand full file context"
      >
        <UnfoldVerticalIcon className="size-3" />
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
      ref={panelRef}
      className={cn(
        "relative flex h-full min-w-0 flex-col bg-background outline-none",
        mode === "inline"
          ? "w-[42vw] min-w-[360px] max-w-[560px] shrink-0 border-l border-border"
          : "w-full",
      )}
      tabIndex={-1}
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
          {searchOpen && (
            <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 bg-background px-3 py-1.5">
              <input
                ref={searchInputRef}
                type="text"
                className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/50"
                placeholder="Search files and content…"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setSearchMatchIndex(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setSearchOpen(false);
                    setSearchQuery("");
                    panelRef.current?.focus();
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    goToSearchMatch(e.shiftKey ? searchMatchIndex - 1 : searchMatchIndex + 1);
                  } else if ((e.metaKey || e.ctrlKey) && e.key === "f") {
                    e.preventDefault();
                    e.currentTarget.select();
                  }
                }}
              />
              {searchQuery && (
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {searchMatches.length > 0
                    ? `${searchMatchIndex + 1}/${searchMatches.length}`
                    : "No matches"}
                </span>
              )}
              <button
                type="button"
                className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                onClick={() => goToSearchMatch(searchMatchIndex - 1)}
                disabled={searchMatches.length === 0}
                title="Previous match (Shift+Enter)"
              >
                <ChevronUpIcon className="size-3.5" />
              </button>
              <button
                type="button"
                className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                onClick={() => goToSearchMatch(searchMatchIndex + 1)}
                disabled={searchMatches.length === 0}
                title="Next match (Enter)"
              >
                <ChevronDownIcon className="size-3.5" />
              </button>
              <button
                type="button"
                className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setSearchOpen(false);
                  setSearchQuery("");
                  panelRef.current?.focus();
                }}
                title="Close search (Esc)"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          )}
          <DiffAiReviewWorkbenchSummary
            active={aiReviewActive}
            status={aiReviewStatus}
            scope={currentSelectedReviewScope}
            review={aiReviewResult}
            error={aiReviewError}
            startedAt={aiReviewRun?.startedAt ?? null}
            now={aiReviewNow}
            stackItems={aiStackItems}
            stackAnswer={aiStackAnswer}
            stackPending={aiStackMutation.isPending}
            onGenerate={startCurrentAiReview}
            onClose={closeAiReview}
            onSubmitStack={() => aiStackMutation.mutate(aiStackItems)}
            onClearStack={() => {
              setAiStackItems([]);
              setAiStackAnswer(null);
            }}
          />
          {/* Narrow layout: file tree above diff — resizable via drag handle */}
          {showFileTree && !panelWide && renderableFiles.length > 0 && (
            <div className="relative shrink-0 border-b border-border/60 dark:bg-[#1e2228]" style={{ height: fileTreeHeight, maxHeight: "60%" }}>
              <div className="h-full min-h-0 overflow-hidden">
                <DiffFileTree
                  files={renderableFiles}
                  viewedFiles={viewedFiles}
                  onFileClick={scrollToFile}
                  onToggleViewed={toggleFileViewed}
                  resolveFilePath={resolveFileDiffPath}
                  getFileStats={getFileDiffStats}
                  reviewDecorations={aiReviewTreeDecorations}
                />
              </div>
              <div
                className="absolute bottom-0 left-0 right-0 h-1 cursor-row-resize transition-colors hover:bg-blue-500/30 active:bg-blue-500/50"
                onMouseDown={(e) => {
                  e.preventDefault();
                  const startY = e.clientY;
                  const startH = fileTreeHeight;
                  const onMove = (ev: MouseEvent) => setFileTreeHeight(Math.max(60, startH + ev.clientY - startY));
                  const onUp = () => {
                    document.removeEventListener("mousemove", onMove);
                    document.removeEventListener("mouseup", onUp);
                    document.body.style.cursor = "";
                    document.body.style.userSelect = "";
                  };
                  document.body.style.cursor = "row-resize";
                  document.body.style.userSelect = "none";
                  document.addEventListener("mousemove", onMove);
                  document.addEventListener("mouseup", onUp);
                }}
              />
            </div>
          )}
          <div className="flex min-h-0 flex-1">
            {/* Wide layout: file tree as left sidebar */}
            {showFileTree && panelWide && renderableFiles.length > 0 && (
              <div className="w-[220px] shrink-0 overflow-hidden border-r border-border/60 dark:bg-[#1e2228]">
                <DiffFileTree
                  files={renderableFiles}
                  viewedFiles={viewedFiles}
                  onFileClick={scrollToFile}
                  onToggleViewed={toggleFileViewed}
                  resolveFilePath={resolveFileDiffPath}
                  getFileStats={getFileDiffStats}
                  reviewDecorations={aiReviewTreeDecorations}
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
                    ? (showWorkingTree ? "Loading working tree changes..." : "Loading checkpoint diff...")
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
                  const aiChange = aiReviewChangeByPath.get(filePath);
                  const fileStackAnnotations: DiffLineAnnotation<DiffHighlightAnnotationMetadata>[] = aiStackItems
                    .filter((item) => item.filePath === filePath)
                    .map((item, index) => ({
                      side: "additions" as const,
                      lineNumber: item.lineNumber ?? fileDiff.hunks[0]?.additionStart ?? 1,
                      metadata: {
                        id: item.id,
                        label: `AI stack ${index + 1}`,
                        selectedText: item.selectedText,
                      },
                    }));
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
                        {aiChange && (
                          <span
                            className={cn(
                              "shrink-0 rounded-full border px-1.5 py-0.5 font-medium text-[10px] uppercase tracking-wide",
                              aiReviewTone(aiChange.significance),
                            )}
                            title={aiChange.title}
                          >
                            #{aiChange.rank}
                          </span>
                        )}
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
                      {aiReviewActive && !isViewed && (
                        <DiffAiReviewFileSummary change={aiReviewChangeByPath.get(filePath)} />
                      )}
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
                            if (lineNumber == null) return;
                            event.preventDefault();
                            setSelectionAskTrigger(null);
                            const selectedText = window.getSelection()?.toString().trim() ?? "";
                            setContextMenu({
                              x: event.clientX,
                              y: event.clientY,
                              filePath,
                              lineNumber,
                              ...(selectedText.length >= 2 ? { selectedText } : {}),
                            });
                          }}
                          onMouseUp={(event) => {
                            const selectedText = window.getSelection()?.toString().trim() ?? "";
                            if (selectedText.length < 2) {
                              setSelectionAskTrigger(null);
                              return;
                            }
                            const range = window.getSelection()?.rangeCount
                              ? window.getSelection()?.getRangeAt(0)
                              : null;
                            const rect = range?.getBoundingClientRect();
                            const x = rect && rect.width > 0 ? rect.right + 8 : event.clientX;
                            const y = rect && rect.height > 0 ? rect.bottom + 8 : event.clientY;
                            const filePatch = extractFilePatchSection(selectedPatch, filePath);
                            setSelectionAskTrigger({
                              x,
                              y,
                              filePath,
                              lineNumber: null,
                              selectedText,
                              contextPatch: buildSelectedCodePatchContext(selectedText, filePatch),
                            });
                          }}
                        >
                          <FileDiff<DiffHighlightAnnotationMetadata>
                            fileDiff={fileDiff}
                            lineAnnotations={fileStackAnnotations}
                            renderAnnotation={(annotation) => (
                              <div className="mx-2 my-1 rounded-md border border-blue-500/25 bg-blue-500/[0.07] px-2 py-1 text-[11px] text-blue-700 shadow-sm dark:text-blue-200">
                                <span className="font-medium">{annotation.metadata?.label ?? "AI stack"}</span>
                                {annotation.metadata?.selectedText ? (
                                  <span className="ml-1 text-muted-foreground">highlighted selection saved</span>
                                ) : null}
                              </div>
                            )}
                            options={{
                              diffStyle: diffRenderMode === "split" ? "split" : "unified",
                              lineDiffType: "word",
                              overflow: "wrap",
                              theme: resolveDiffThemeName(resolvedTheme),
                              themeType: resolvedTheme as DiffThemeType,
                              disableFileHeader: true,
                              expandUnchanged,
                              unsafeCSS: diffUnsafeCSS,
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
                  <pre className="max-h-[72vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90">
                    {renderablePatch.text}
                  </pre>
                </div>
              </div>
            )}
          </div>
          </div>
        </>
      )}
      {sortedRenderableFiles.length > 0 && (
        <div className="flex shrink-0 items-center gap-3 border-t border-border/50 px-3 py-1.5 text-[10px] text-muted-foreground/50">
          <span><kbd className="rounded border border-border/40 px-1 font-mono">j</kbd>/<kbd className="rounded border border-border/40 px-1 font-mono">k</kbd> navigate</span>
          <span><kbd className="rounded border border-border/40 px-1 font-mono">v</kbd> viewed</span>
          <span><kbd className="rounded border border-border/40 px-1 font-mono">e</kbd> edit</span>
          <span><kbd className="rounded border border-border/40 px-1 font-mono">⌘F</kbd> search</span>
          <span><kbd className="rounded border border-border/40 px-1 font-mono">esc</kbd> close</span>
        </div>
      )}
      {selectionAskTrigger && !quickAskSelection && (
        <button
          type="button"
          className="fixed z-[65] inline-flex items-center gap-1 rounded-full border border-blue-500/40 bg-popover px-2.5 py-1.5 text-[11px] font-medium text-blue-600 shadow-xl transition-colors hover:bg-blue-500/10 dark:text-blue-300"
          style={{ left: selectionAskTrigger.x, top: selectionAskTrigger.y }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setQuickAskSelection(selectionAskTrigger);
            setSelectionAskTrigger(null);
          }}
          data-diff-selection-ask
        >
          <MessageSquareTextIcon className="size-3.5" />
          Ask Pi
        </button>
      )}
      {quickAskSelection && (
        <DiffQuickAskPopover
          threadId={activeThreadId}
          selection={quickAskSelection}
          initialPrompt={quickAskSelection.initialPrompt}
          autoAsk={quickAskSelection.autoAsk}
          onClose={() => setQuickAskSelection(null)}
        />
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
                const filePatch = extractFilePatchSection(selectedPatch, contextMenu.filePath);
                setQuickAskSelection({
                  x: contextMenu.x,
                  y: contextMenu.y,
                  filePath: contextMenu.filePath,
                  lineNumber: contextMenu.lineNumber,
                  selectedText: contextMenu.selectedText,
                  contextPatch: contextMenu.selectedText
                    ? buildSelectedCodePatchContext(contextMenu.selectedText, filePatch)
                    : filePatch,
                  initialPrompt: contextMenu.selectedText
                    ? "Explain this selected code in the context of the diff."
                    : `Explain line ${contextMenu.lineNumber} in the context of this diff.`,
                  autoAsk: true,
                });
                setContextMenu(null);
              }}
            >
              <SparklesIcon className="size-3.5" />
              Explain {contextMenu.selectedText ? "selection" : `line ${contextMenu.lineNumber}`}
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-foreground hover:bg-accent"
              onClick={() => {
                const filePatch = extractFilePatchSection(selectedPatch, contextMenu.filePath);
                setQuickAskSelection({
                  x: contextMenu.x,
                  y: contextMenu.y,
                  filePath: contextMenu.filePath,
                  lineNumber: contextMenu.lineNumber,
                  selectedText: contextMenu.selectedText,
                  contextPatch: contextMenu.selectedText
                    ? buildSelectedCodePatchContext(contextMenu.selectedText, filePatch)
                    : filePatch,
                  initialPrompt: "Explain this change with this additional instruction: ",
                });
                setContextMenu(null);
              }}
            >
              <MessageSquareTextIcon className="size-3.5" />
              Explain with instruction
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-foreground hover:bg-accent"
              onClick={() => {
                const filePatch = extractFilePatchSection(selectedPatch, contextMenu.filePath);
                addAiStackItem({
                  filePath: contextMenu.filePath,
                  lineNumber: contextMenu.lineNumber,
                  selectedText: contextMenu.selectedText,
                  contextPatch: contextMenu.selectedText
                    ? buildSelectedCodePatchContext(contextMenu.selectedText, filePatch)
                    : filePatch,
                });
                setContextMenu(null);
              }}
            >
              <SquareCheckBig className="size-3.5" />
              Add to AI stack
            </button>
            {activeCwd && (
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
            )}
          </div>
        </div>
      )}
    </div>
  );
}
