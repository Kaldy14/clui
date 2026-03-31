import { Fragment, type ReactNode, createElement, useEffect } from "react";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ProviderKind,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationSessionStatus,
  type ClaudeHookStatus,
  type TerminalStatus,
} from "@clui/contracts";
import {
  getModelOptions,
  normalizeModelSlug,
  resolveModelSlug,
  resolveModelSlugForProvider,
} from "@clui/shared/model";
import { create } from "zustand";
import { type ChatMessage, type Project, type Thread, type DormantReason } from "./types";
import { Debouncer } from "@tanstack/react-pacer";

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  threads: Thread[];
  threadsHydrated: boolean;
  /** Custom project display order — array of ProjectId strings. */
  projectOrder: string[];
}

const PERSISTED_STATE_KEY = "clui:renderer-state:v8";
const LEGACY_PERSISTED_STATE_KEYS = [
  "clui:renderer-state:v7",
  "t3code:renderer-state:v8",
  "t3code:renderer-state:v7",
  "t3code:renderer-state:v6",
  "t3code:renderer-state:v5",
  "t3code:renderer-state:v4",
  "t3code:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;

const initialState: AppState = {
  projects: [],
  threads: [],
  threadsHydrated: false,
  projectOrder: [],
};
const persistedExpandedProjectCwds = new Set<string>();
const persistedProjectOrderCwds: string[] = [];

// ── Persist helpers ──────────────────────────────────────────────────

function readPersistedState(): AppState {
  if (typeof window === "undefined") return initialState;
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) return initialState;
    const parsed = JSON.parse(raw) as {
      expandedProjectCwds?: string[];
      projectOrderCwds?: string[];
    };
    persistedExpandedProjectCwds.clear();
    persistedProjectOrderCwds.length = 0;
    for (const cwd of parsed.expandedProjectCwds ?? []) {
      if (typeof cwd === "string" && cwd.length > 0) {
        persistedExpandedProjectCwds.add(cwd);
      }
    }
    for (const cwd of parsed.projectOrderCwds ?? []) {
      if (typeof cwd === "string" && cwd.length > 0 && !persistedProjectOrderCwds.includes(cwd)) {
        persistedProjectOrderCwds.push(cwd);
      }
    }
    return { ...initialState };
  } catch {
    return initialState;
  }
}

let legacyKeysCleanedUp = false;

function persistState(state: AppState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        expandedProjectCwds: state.projects
          .filter((project) => project.expanded)
          .map((project) => project.cwd),
        projectOrderCwds: state.projects.map((project) => project.cwd),
      }),
    );
    if (!legacyKeysCleanedUp) {
      legacyKeysCleanedUp = true;
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        window.localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}
const debouncedPersistState = new Debouncer(persistState, { wait: 500 });

// ── Pure helpers ──────────────────────────────────────────────────────

export function updateThread(
  threads: Thread[],
  threadId: ThreadId,
  updater: (t: Thread) => Thread,
): Thread[] {
  let changed = false;
  const next = threads.map((t) => {
    if (t.id !== threadId) return t;
    const updated = updater(t);
    if (updated !== t) changed = true;
    return updated;
  });
  return changed ? next : threads;
}

function mapProjectsFromReadModel(
  incoming: OrchestrationReadModel["projects"],
  previous: Project[],
): Project[] {
  const previousById = new Map(previous.map((project) => [project.id, project] as const));
  const previousByCwd = new Map(previous.map((project) => [project.cwd, project] as const));
  const previousOrderById = new Map(previous.map((project, index) => [project.id, index] as const));
  const previousOrderByCwd = new Map(
    previous.map((project, index) => [project.cwd, index] as const),
  );
  const persistedOrderByCwd = new Map(
    persistedProjectOrderCwds.map((cwd, index) => [cwd, index] as const),
  );
  const usePersistedOrder = previous.length === 0;

  let anyProjectChanged = false;
  const mappedProjects = incoming.map((project) => {
    const existing = previousById.get(project.id) ?? previousByCwd.get(project.workspaceRoot);
    const newProject: Project = {
      id: project.id,
      name: project.title,
      cwd: project.workspaceRoot,
      model:
        existing?.model ??
        resolveModelSlug(project.defaultModel ?? DEFAULT_MODEL_BY_PROVIDER.codex),
      expanded:
        existing?.expanded ??
        (persistedExpandedProjectCwds.size > 0
          ? persistedExpandedProjectCwds.has(project.workspaceRoot)
          : true),
      scripts: project.scripts.map((script) => ({ ...script })),
    };
    if (existing && !projectChanged(existing, newProject)) {
      return existing;
    }
    anyProjectChanged = true;
    return newProject;
  });

  const sorted = mappedProjects
    .map((project, incomingIndex) => {
      const previousIndex =
        previousOrderById.get(project.id) ?? previousOrderByCwd.get(project.cwd);
      const persistedIndex = usePersistedOrder ? persistedOrderByCwd.get(project.cwd) : undefined;
      const orderIndex =
        previousIndex ??
        persistedIndex ??
        (usePersistedOrder ? persistedProjectOrderCwds.length : previous.length) + incomingIndex;
      return { project, incomingIndex, orderIndex };
    })
    .toSorted((a, b) => {
      const byOrder = a.orderIndex - b.orderIndex;
      if (byOrder !== 0) return byOrder;
      return a.incomingIndex - b.incomingIndex;
    })
    .map((entry) => entry.project);
  if (!anyProjectChanged && sorted.length === previous.length) {
    // Check if order is also unchanged
    let orderUnchanged = true;
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i] !== previous[i]) {
        orderUnchanged = false;
        break;
      }
    }
    if (orderUnchanged) return previous;
  }
  return sorted;
}

function toLegacySessionStatus(
  status: OrchestrationSessionStatus,
): "connecting" | "ready" | "running" | "error" | "closed" {
  switch (status) {
    case "starting":
      return "connecting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
    case "interrupted":
      return "ready";
    case "idle":
    case "stopped":
      return "closed";
  }
}

function toLegacyProvider(providerName: string | null): ProviderKind {
  if (providerName === "codex" || providerName === "claudeCode" || providerName === "cursor") {
    return providerName;
  }
  return "codex";
}

const CODEX_MODEL_SLUGS = new Set<string>(getModelOptions("codex").map((option) => option.slug));
const CLAUDE_MODEL_SLUGS = new Set<string>(
  getModelOptions("claudeCode").map((option) => option.slug),
);
const CURSOR_MODEL_SLUGS = new Set<string>(getModelOptions("cursor").map((option) => option.slug));
const CURSOR_DISTINCT_MODEL_SLUGS = new Set(
  [...CURSOR_MODEL_SLUGS].filter(
    (slug) => !CODEX_MODEL_SLUGS.has(slug) && !CLAUDE_MODEL_SLUGS.has(slug),
  ),
);

function inferProviderForThreadModel(input: {
  readonly model: string;
  readonly sessionProviderName: string | null;
}): ProviderKind {
  if (
    input.sessionProviderName === "codex" ||
    input.sessionProviderName === "claudeCode" ||
    input.sessionProviderName === "cursor"
  ) {
    return input.sessionProviderName;
  }
  const normalizedCursor = normalizeModelSlug(input.model, "cursor");
  if (normalizedCursor && CURSOR_DISTINCT_MODEL_SLUGS.has(normalizedCursor)) {
    return "cursor";
  }
  const normalizedClaude = normalizeModelSlug(input.model, "claudeCode");
  if (normalizedClaude && CLAUDE_MODEL_SLUGS.has(normalizedClaude)) {
    return "claudeCode";
  }
  const normalizedCodex = normalizeModelSlug(input.model, "codex");
  if (normalizedCodex && CODEX_MODEL_SLUGS.has(normalizedCodex)) {
    return "codex";
  }
  if (
    input.model.trim().startsWith("composer-") ||
    input.model.trim().startsWith("gemini-") ||
    input.model.trim().endsWith("-thinking")
  ) {
    return "cursor";
  }
  return input.model.trim().startsWith("claude-") ? "claudeCode" : "codex";
}

function resolveWsHttpOrigin(): string {
  if (typeof window === "undefined") return "";
  const bridgeWsUrl = window.desktopBridge?.getWsUrl?.();
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsCandidate =
    typeof bridgeWsUrl === "string" && bridgeWsUrl.length > 0
      ? bridgeWsUrl
      : typeof envWsUrl === "string" && envWsUrl.length > 0
        ? envWsUrl
        : null;
  if (!wsCandidate) return window.location.origin;
  try {
    const wsUrl = new URL(wsCandidate);
    const protocol =
      wsUrl.protocol === "wss:" ? "https:" : wsUrl.protocol === "ws:" ? "http:" : wsUrl.protocol;
    return `${protocol}//${wsUrl.host}`;
  } catch {
    return window.location.origin;
  }
}

function toAttachmentPreviewUrl(rawUrl: string): string {
  if (rawUrl.startsWith("/")) {
    return `${resolveWsHttpOrigin()}${rawUrl}`;
  }
  return rawUrl;
}

function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}

// ── Change-detection helpers ──────────────────────────────────────────

function threadChanged(existing: Thread, incoming: Thread): boolean {
  // Quick scalar checks first
  if (existing.updatedAt !== incoming.updatedAt) return true;
  if (existing.title !== incoming.title) return true;
  if (existing.model !== incoming.model) return true;
  if (existing.branch !== incoming.branch) return true;
  if (existing.worktreePath !== incoming.worktreePath) return true;
  if (existing.runtimeMode !== incoming.runtimeMode) return true;
  if (existing.interactionMode !== incoming.interactionMode) return true;
  if (existing.titleSource !== incoming.titleSource) return true;
  if (existing.bookmarked !== incoming.bookmarked) return true;
  // Session check
  if ((existing.session?.updatedAt ?? null) !== (incoming.session?.updatedAt ?? null)) return true;
  if ((existing.session?.orchestrationStatus ?? null) !== (incoming.session?.orchestrationStatus ?? null))
    return true;
  // Array length heuristics — if lengths differ, something changed
  if (existing.messages.length !== incoming.messages.length) return true;
  if (existing.activities.length !== incoming.activities.length) return true;
  if (existing.turnDiffSummaries.length !== incoming.turnDiffSummaries.length) return true;
  if (existing.proposedPlans.length !== incoming.proposedPlans.length) return true;
  // Check latest message streaming status (active streaming changes frequently)
  const lastExMsg = existing.messages.at(-1);
  const lastInMsg = incoming.messages.at(-1);
  if (lastExMsg?.streaming !== lastInMsg?.streaming) return true;
  if (lastExMsg?.id !== lastInMsg?.id) return true;
  // Latest turn
  if (existing.latestTurn?.startedAt !== incoming.latestTurn?.startedAt) return true;
  if (existing.latestTurn?.completedAt !== incoming.latestTurn?.completedAt) return true;
  // Remaining scalars
  if (existing.scrollbackSnapshot !== incoming.scrollbackSnapshot) return true;
  if (existing.claudeSessionId !== incoming.claudeSessionId) return true;
  return false;
}

function projectChanged(existing: Project, incoming: Project): boolean {
  if (existing.name !== incoming.name) return true;
  if (existing.cwd !== incoming.cwd) return true;
  if (existing.model !== incoming.model) return true;
  if (existing.expanded !== incoming.expanded) return true;
  if (existing.scripts.length !== incoming.scripts.length) return true;
  return false;
}

// ── Pending branch-update guard ───────────────────────────────────────
//
// When the user changes branch/worktreePath, the optimistic update races
// with in-flight snapshot syncs that may carry stale server state.  We
// track a timestamp per thread so syncServerReadModel can preserve the
// local values until the server catches up.

const pendingBranchUpdates = new Map<string, number>();
const BRANCH_UPDATE_GUARD_MS = 5_000;

export function markBranchUpdatePending(threadId: string): void {
  pendingBranchUpdates.set(threadId, Date.now());
}

export function clearBranchUpdatePending(threadId: string): void {
  pendingBranchUpdates.delete(threadId);
}

function hasPendingBranchUpdate(threadId: string): boolean {
  const ts = pendingBranchUpdates.get(threadId);
  if (ts === undefined) return false;
  if (Date.now() - ts > BRANCH_UPDATE_GUARD_MS) {
    pendingBranchUpdates.delete(threadId);
    return false;
  }
  return true;
}

// ── Pure state transition functions ────────────────────────────────────

export function syncServerReadModel(state: AppState, readModel: OrchestrationReadModel): AppState {
  const projects = mapProjectsFromReadModel(
    readModel.projects.filter((project) => project.deletedAt === null),
    state.projects,
  );
  const existingThreadById = new Map(state.threads.map((thread) => [thread.id, thread] as const));
  let anyThreadChanged = false;
  const threads = readModel.threads
    .filter((thread) => thread.deletedAt === null)
    .map((thread) => {
      const existing = existingThreadById.get(thread.id);

      // If server already reflects the local branch, clear the guard early
      // so the snapshot values are used as-is.
      if (
        existing &&
        pendingBranchUpdates.has(thread.id) &&
        thread.branch === existing.branch &&
        thread.worktreePath === existing.worktreePath
      ) {
        pendingBranchUpdates.delete(thread.id);
      }
      const preserveLocalBranch = existing != null && hasPendingBranchUpdate(thread.id);

      const newThread: Thread = {
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        model: resolveModelSlugForProvider(
          inferProviderForThreadModel({
            model: thread.model,
            sessionProviderName: thread.session?.providerName ?? null,
          }),
          thread.model,
        ),
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        session: thread.session
          ? {
              provider: toLegacyProvider(thread.session.providerName),
              status: toLegacySessionStatus(thread.session.status),
              orchestrationStatus: thread.session.status,
              activeTurnId: thread.session.activeTurnId ?? undefined,
              createdAt: thread.session.updatedAt,
              updatedAt: thread.session.updatedAt,
              ...(thread.session.lastError ? { lastError: thread.session.lastError } : {}),
            }
          : null,
        messages: thread.messages.map((message) => {
          const attachments = message.attachments?.map((attachment) => ({
            type: "image" as const,
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            previewUrl: toAttachmentPreviewUrl(attachmentPreviewRoutePath(attachment.id)),
          }));
          const normalizedMessage: ChatMessage = {
            id: message.id,
            role: message.role,
            text: message.text,
            createdAt: message.createdAt,
            streaming: message.streaming,
            ...(message.streaming ? {} : { completedAt: message.updatedAt }),
            ...(attachments && attachments.length > 0 ? { attachments } : {}),
          };
          return normalizedMessage;
        }),
        proposedPlans: thread.proposedPlans.map((proposedPlan) => ({
          id: proposedPlan.id,
          turnId: proposedPlan.turnId,
          planMarkdown: proposedPlan.planMarkdown,
          createdAt: proposedPlan.createdAt,
          updatedAt: proposedPlan.updatedAt,
        })),
        error: thread.session?.lastError ?? null,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        lastInteractedAt: thread.lastInteractedAt || thread.updatedAt,
        latestTurn: thread.latestTurn,
        lastVisitedAt: existing?.lastVisitedAt ?? thread.updatedAt,
        branch: preserveLocalBranch ? existing.branch : thread.branch,
        worktreePath: preserveLocalBranch ? existing.worktreePath : thread.worktreePath,
        turnDiffSummaries: thread.checkpoints.map((checkpoint) => ({
          turnId: checkpoint.turnId,
          completedAt: checkpoint.completedAt,
          status: checkpoint.status,
          assistantMessageId: checkpoint.assistantMessageId ?? undefined,
          checkpointTurnCount: checkpoint.checkpointTurnCount,
          checkpointRef: checkpoint.checkpointRef,
          files: checkpoint.files.map((file) => ({ ...file })),
        })),
        activities: thread.activities.map((activity) => ({ ...activity })),
        terminalStatus: existing?.terminalStatus ?? thread.terminalStatus ?? "new",
        dormantReason: existing?.dormantReason ?? null,
        claudeSessionId: thread.claudeSessionId ?? null,
        scrollbackSnapshot: thread.scrollbackSnapshot ?? null,
        titleSource: thread.titleSource ?? "auto",
        bookmarked: thread.bookmarked ?? false,
        hookStatus: existing?.hookStatus ?? null,
      };
      if (existing && !threadChanged(existing, newThread)) {
        return existing;
      }
      anyThreadChanged = true;
      return newThread;
    });
  const finalThreads =
    anyThreadChanged || threads.length !== state.threads.length ? threads : state.threads;
  return {
    ...state,
    projects,
    threads: finalThreads,
    threadsHydrated: true,
  };
}

export function markThreadVisited(
  state: AppState,
  threadId: ThreadId,
  visitedAt?: string,
): AppState {
  const at = visitedAt ?? new Date().toISOString();
  const visitedAtMs = Date.parse(at);
  const threads = updateThread(state.threads, threadId, (thread) => {
    const previousVisitedAtMs = thread.lastVisitedAt ? Date.parse(thread.lastVisitedAt) : NaN;
    if (
      Number.isFinite(previousVisitedAtMs) &&
      Number.isFinite(visitedAtMs) &&
      previousVisitedAtMs >= visitedAtMs
    ) {
      return thread;
    }
    return { ...thread, lastVisitedAt: at };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function markThreadUnread(state: AppState, threadId: ThreadId): AppState {
  const threads = updateThread(state.threads, threadId, (thread) => {
    if (!thread.latestTurn?.completedAt) return thread;
    const latestTurnCompletedAtMs = Date.parse(thread.latestTurn.completedAt);
    if (Number.isNaN(latestTurnCompletedAtMs)) return thread;
    const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
    if (thread.lastVisitedAt === unreadVisitedAt) return thread;
    return { ...thread, lastVisitedAt: unreadVisitedAt };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function toggleProject(state: AppState, projectId: Project["id"]): AppState {
  return {
    ...state,
    projects: state.projects.map((p) => (p.id === projectId ? { ...p, expanded: !p.expanded } : p)),
  };
}

export function setProjectExpanded(
  state: AppState,
  projectId: Project["id"],
  expanded: boolean,
): AppState {
  let changed = false;
  const projects = state.projects.map((p) => {
    if (p.id !== projectId || p.expanded === expanded) return p;
    changed = true;
    return { ...p, expanded };
  });
  return changed ? { ...state, projects } : state;
}

export function reorderProjects(
  state: AppState,
  draggedProjectId: Project["id"],
  targetProjectId: Project["id"],
): AppState {
  if (draggedProjectId === targetProjectId) return state;
  const draggedIndex = state.projects.findIndex((project) => project.id === draggedProjectId);
  const targetIndex = state.projects.findIndex((project) => project.id === targetProjectId);
  if (draggedIndex < 0 || targetIndex < 0) return state;
  const projects = [...state.projects];
  const [draggedProject] = projects.splice(draggedIndex, 1);
  if (!draggedProject) return state;
  projects.splice(targetIndex, 0, draggedProject);
  return { ...state, projects };
}

export function setError(state: AppState, threadId: ThreadId, error: string | null): AppState {
  const threads = updateThread(state.threads, threadId, (t) => {
    if (t.error === error) return t;
    return { ...t, error };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function setThreadBranch(
  state: AppState,
  threadId: ThreadId,
  branch: string | null,
  worktreePath: string | null,
): AppState {
  markBranchUpdatePending(threadId);
  const threads = updateThread(state.threads, threadId, (t) => {
    if (t.branch === branch && t.worktreePath === worktreePath) return t;
    const cwdChanged = t.worktreePath !== worktreePath;
    return {
      ...t,
      branch,
      worktreePath,
      ...(cwdChanged ? { session: null } : {}),
    };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function addOptimisticThread(
  state: AppState,
  input: {
    id: ThreadId;
    projectId: Project["id"];
    title: string;
    branch: string | null;
    worktreePath: string | null;
    createdAt: string;
  },
): AppState {
  // Skip if thread already exists
  if (state.threads.some((t) => t.id === input.id)) return state;
  const thread: Thread = {
    id: input.id,
    projectId: input.projectId,
    title: input.title,
    model: "",
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    lastInteractedAt: input.createdAt,
    latestTurn: null,
    lastVisitedAt: input.createdAt,
    branch: input.branch,
    worktreePath: input.worktreePath,
    turnDiffSummaries: [],
    activities: [],
    terminalStatus: "new",
    dormantReason: null,
    claudeSessionId: null,
    scrollbackSnapshot: null,
    titleSource: "auto",
    bookmarked: false,
    hookStatus: null,
  };
  return { ...state, threads: [...state.threads, thread] };
}

export function setProjectOrder(state: AppState, order: string[]): AppState {
  return { ...state, projectOrder: order };
}

export function setTerminalStatus(
  state: AppState,
  threadId: ThreadId,
  terminalStatus: TerminalStatus,
): AppState {
  const threads = updateThread(state.threads, threadId, (thread) => {
    if (thread.terminalStatus === terminalStatus && thread.dormantReason === null) return thread;
    // Clear dormantReason when terminal becomes active (e.g. on "started" event)
    return { ...thread, terminalStatus, dormantReason: null };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function setTerminalLifecycle(
  state: AppState,
  threadId: ThreadId,
  terminalStatus: TerminalStatus,
  hookStatus: ClaudeHookStatus | null,
  dormantReason?: DormantReason,
): AppState {
  const threads = updateThread(state.threads, threadId, (thread) => {
    const newDormantReason = dormantReason !== undefined ? dormantReason : thread.dormantReason;
    if (
      thread.terminalStatus === terminalStatus &&
      thread.hookStatus === hookStatus &&
      thread.dormantReason === newDormantReason
    )
      return thread;
    return { ...thread, terminalStatus, hookStatus, dormantReason: newDormantReason };
  });
  return threads === state.threads ? state : { ...state, threads };
}

/**
 * Apply the persisted custom order to projects.
 *
 * Projects present in `order` appear first (in that order).
 * Projects not in `order` (newly added) are appended at the end.
 */
export function orderProjects(projects: readonly Project[], order: readonly string[]): Project[] {
  if (order.length === 0 || projects.length <= 1) return [...projects];
  const positionMap = new Map(order.map((id, index) => [id, index]));
  return projects.toSorted((a, b) => {
    const aPos = positionMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bPos = positionMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return aPos - bPos;
  });
}

// ── Zustand store ────────────────────────────────────────────────────

interface AppStore extends AppState {
  syncServerReadModel: (readModel: OrchestrationReadModel) => void;
  markThreadVisited: (threadId: ThreadId, visitedAt?: string) => void;
  markThreadUnread: (threadId: ThreadId) => void;
  toggleProject: (projectId: Project["id"]) => void;
  setProjectExpanded: (projectId: Project["id"], expanded: boolean) => void;
  reorderProjects: (draggedProjectId: Project["id"], targetProjectId: Project["id"]) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
  setThreadBranch: (threadId: ThreadId, branch: string | null, worktreePath: string | null) => void;
  setProjectOrder: (order: string[]) => void;
  removeThread: (threadId: ThreadId) => void;
  setHookStatus: (threadId: ThreadId, hookStatus: ClaudeHookStatus | null) => void;
  /** Bump lastInteractedAt to now. Called once on turnStart (user sent a message). */
  bumpLastInteractedAt: (threadId: ThreadId) => void;
  /** Reset all status-related fields for a thread (hookStatus, activities, session status). */
  resetThreadStatus: (threadId: ThreadId) => void;
  setTerminalStatus: (threadId: ThreadId, terminalStatus: TerminalStatus) => void;
  /** Atomically update terminalStatus, hookStatus, and dormantReason in a single render. */
  setTerminalLifecycle: (threadId: ThreadId, terminalStatus: TerminalStatus, hookStatus: ClaudeHookStatus | null, dormantReason?: DormantReason) => void;
  addOptimisticThread: (input: {
    id: ThreadId;
    projectId: Project["id"];
    title: string;
    branch: string | null;
    worktreePath: string | null;
    createdAt: string;
  }) => void;
}

export const useStore = create<AppStore>((set) => ({
  ...readPersistedState(),
  syncServerReadModel: (readModel) => set((state) => syncServerReadModel(state, readModel)),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId) => set((state) => markThreadUnread(state, threadId)),
  toggleProject: (projectId) => set((state) => toggleProject(state, projectId)),
  setProjectExpanded: (projectId, expanded) =>
    set((state) => setProjectExpanded(state, projectId, expanded)),
  reorderProjects: (draggedProjectId, targetProjectId) =>
    set((state) => reorderProjects(state, draggedProjectId, targetProjectId)),
  setError: (threadId, error) => set((state) => setError(state, threadId, error)),
  setThreadBranch: (threadId, branch, worktreePath) =>
    set((state) => setThreadBranch(state, threadId, branch, worktreePath)),
  setProjectOrder: (order) => set((state) => setProjectOrder(state, order)),
  addOptimisticThread: (input) => set((state) => addOptimisticThread(state, input)),
  removeThread: (threadId) =>
    set((state) => {
      const threads = state.threads.filter((t) => t.id !== threadId);
      return threads.length === state.threads.length ? state : { ...state, threads };
    }),
  setHookStatus: (threadId, hookStatus) =>
    set((state) => {
      const threads = updateThread(state.threads, threadId, (thread) => {
        if (thread.hookStatus === hookStatus) return thread;
        return { ...thread, hookStatus };
      });
      return threads === state.threads ? state : { ...state, threads };
    }),
  bumpLastInteractedAt: (threadId) =>
    set((state) => {
      const now = new Date().toISOString();
      const threads = updateThread(state.threads, threadId, (thread) => {
        // Skip if already bumped within the same second
        if (thread.lastInteractedAt && thread.lastInteractedAt.slice(0, 19) === now.slice(0, 19)) {
          return thread;
        }
        return { ...thread, lastInteractedAt: now };
      });
      return threads === state.threads ? state : { ...state, threads };
    }),
  resetThreadStatus: (threadId) =>
    set((state) => {
      const threads = updateThread(state.threads, threadId, (thread) => ({
        ...thread,
        hookStatus: null,
        activities: [],
      }));
      return threads === state.threads ? state : { ...state, threads };
    }),
  setTerminalStatus: (threadId, terminalStatus) =>
    set((state) => setTerminalStatus(state, threadId, terminalStatus)),
  setTerminalLifecycle: (threadId, terminalStatus, hookStatus, dormantReason) =>
    set((state) => setTerminalLifecycle(state, threadId, terminalStatus, hookStatus, dormantReason)),
}));

// Persist state changes with debouncing to avoid localStorage thrashing
useStore.subscribe((state) => debouncedPersistState.maybeExecute(state));

// Flush pending writes synchronously before page unload to prevent data loss.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}

export function StoreProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    persistState(useStore.getState());
  }, []);
  return createElement(Fragment, null, children);
}
