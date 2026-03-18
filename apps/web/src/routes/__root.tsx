import { type OrchestrationSessionStatus, ThreadId } from "@clui/contracts";
import type { SessionPhase } from "../types";
import {
  Outlet,
  createRootRouteWithContext,
  type ErrorComponentProps,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { Throttler } from "@tanstack/react-pacer";

import { APP_DISPLAY_NAME } from "../branding";
import { Button } from "../components/ui/button";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../components/ui/toast";
import { serverConfigQueryOptions, serverQueryKeys } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { preferredTerminalEditor } from "../terminal-links";
import { terminalRunningSubprocessFromEvent } from "../terminalActivity";
import { onServerConfigUpdated, onServerWelcome } from "../wsNativeApi";
import {
  dispatchActivityNotification,
  dispatchHookNotification,
  dispatchSessionSetNotification,
  dispatchTurnCompletedNotification,
  requestNotificationPermission,
} from "../lib/notifications";
import { providerQueryKeys } from "../lib/providerReactQuery";
import { createSessionEventState } from "../lib/sessionEventState";
import { collectActiveTerminalThreadIds } from "../lib/terminalStateCleanup";

/** Lightweight mapping duplicating the store's toLegacySessionStatus so we can
 *  eagerly patch background-thread session status without a full snapshot sync. */
function toLegacySessionStatusFromOrchestration(
  status: OrchestrationSessionStatus,
): SessionPhase | "error" | "closed" {
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

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteView() {
  if (!readNativeApi()) {
    return (
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">
            Connecting to {APP_DISPLAY_NAME} server...
          </p>
        </div>
      </div>
    );
  }

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <EventRouter />
        <DesktopProjectBootstrap />
        <Outlet />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function RootRouteErrorView({ error, reset }: ErrorComponentProps) {
  const message = errorMessage(error);
  const details = errorDetails(error);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          Something went wrong.
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => reset()}>
            Try again
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        </div>

        <details className="group mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground">
            <span className="group-open:hidden">Show error details</span>
            <span className="hidden group-open:inline">Hide error details</span>
          </summary>
          <pre className="max-h-56 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs text-foreground/85">
            {details}
          </pre>
        </details>
      </section>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

function EventRouter() {
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const setProjectExpanded = useStore((store) => store.setProjectExpanded);
  const removeOrphanedTerminalStates = useTerminalStateStore(
    (store) => store.removeOrphanedTerminalStates,
  );
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const pathnameRef = useRef(pathname);
  const lastConfigIssuesSignatureRef = useRef<string | null>(null);
  const deferredThreadIdsRef = useRef(new Set<string>());
  const syncSnapshotRef = useRef<(() => Promise<void>) | null>(null);

  pathnameRef.current = pathname;

  useEffect(() => {
    requestNotificationPermission();
  }, []);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    let disposed = false;
    let latestSequence = 0;
    let syncing = false;
    let pending = false;
    let needsProviderInvalidation = false;
    const sessionStatusByThread = new Map<
      string,
      import("@clui/contracts").OrchestrationSessionStatus
    >();

    const flushSnapshotSync = async (): Promise<void> => {
      const snapshot = await api.orchestration.getSnapshot();
      if (disposed) return;
      latestSequence = Math.max(latestSequence, snapshot.snapshotSequence);
      syncServerReadModel(snapshot);
      const activeThreadIds = collectActiveTerminalThreadIds({
        snapshotThreads: snapshot.threads,
        draftThreadIds: [],
        projectIds: snapshot.projects.map((p) => p.id),
      });
      removeOrphanedTerminalStates(activeThreadIds);
      if (pending) {
        pending = false;
        await flushSnapshotSync();
      }
    };

    const syncSnapshot = async () => {
      if (syncing) {
        pending = true;
        return;
      }
      syncing = true;
      pending = false;
      try {
        await flushSnapshotSync();
      } catch {
        // Keep prior state and wait for next domain event to trigger a resync.
      }
      syncing = false;
    };
    syncSnapshotRef.current = syncSnapshot;

    const domainEventFlushThrottler = new Throttler(
      () => {
        if (needsProviderInvalidation) {
          needsProviderInvalidation = false;
          void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
        }
        void syncSnapshot();
      },
      {
        wait: 100,
        leading: false,
        trailing: true,
      },
    );

    const getCurrentThreadId = (): string | null => {
      const match = pathnameRef.current.match(/^\/([^/]+)/);
      return match?.[1] ?? null;
    };

    const unsubDomainEvent = api.orchestration.onDomainEvent((event) => {
      if (event.sequence <= latestSequence) {
        return;
      }
      latestSequence = event.sequence;

      // Determine if this event is for the currently viewed thread.
      const currentThreadId = getCurrentThreadId();
      const isProjectEvent = event.aggregateKind === "project";
      const isCurrentThread =
        event.aggregateKind === "thread" && event.aggregateId === currentThreadId;

      if (event.type === "thread.turn-diff-completed" || event.type === "thread.reverted") {
        needsProviderInvalidation = true;
      }

      // Always handle notifications regardless of which thread.
      if (event.type === "thread.activity-appended") {
        const threadId = event.payload.threadId;
        const threads = useStore.getState().threads;
        const thread = threads.find((t) => t.id === threadId);
        dispatchActivityNotification(
          event.payload.activity,
          thread?.title ?? "Thread",
          threadId === currentThreadId,
          () => {
            void navigate({ to: "/$threadId", params: { threadId } });
          },
        );
      }
      if (event.type === "thread.session-set") {
        const { threadId, session } = event.payload;
        const previousStatus = sessionStatusByThread.get(threadId) ?? null;
        sessionStatusByThread.set(threadId, session.status);
        const threads = useStore.getState().threads;
        const thread = threads.find((t) => t.id === threadId);
        dispatchSessionSetNotification(
          threadId,
          thread?.title ?? "Thread",
          session.status,
          previousStatus,
          threadId === currentThreadId,
          () => {
            void navigate({ to: "/$threadId", params: { threadId } });
          },
        );

        // For background threads the full snapshot sync is deferred, so the
        // sidebar would keep showing stale "Working" status indefinitely.
        // Eagerly patch session status in the store so the UI reflects the
        // real state without waiting for a full sync.
        if (!isCurrentThread && thread?.session) {
          useStore.setState((state) => ({
            threads: state.threads.map((t) => {
              if (t.id !== threadId || !t.session) return t;
              return {
                ...t,
                session: {
                  ...t.session,
                  orchestrationStatus: session.status,
                  status: toLegacySessionStatusFromOrchestration(session.status),
                  activeTurnId: session.activeTurnId ?? undefined,
                  updatedAt: session.updatedAt,
                  ...(session.lastError ? { lastError: session.lastError } : {}),
                },
              };
            }),
          }));
        }
      }

      // Eagerly patch thread title for background threads so the sidebar
      // shows the auto-generated title without waiting for a full sync.
      if (!isCurrentThread && event.type === "thread.meta-updated") {
        const { threadId, title, titleSource } = event.payload;
        if (title !== undefined) {
          useStore.setState((state) => ({
            threads: state.threads.map((t) => {
              if (t.id !== threadId) return t;
              return {
                ...t,
                title,
                ...(titleSource !== undefined ? { titleSource } : {}),
              };
            }),
          }));
        }
      }

      // Only trigger expensive full snapshot sync for the currently viewed thread
      // or for project-level events that affect the sidebar/navigation.
      if (isCurrentThread || isProjectEvent) {
        domainEventFlushThrottler.maybeExecute();
      } else if (event.aggregateKind === "thread") {
        // For background threads, defer the sync until the user navigates there.
        deferredThreadIdsRef.current.add(event.aggregateId);
      }
    });
    const unsubTerminalEvent = api.terminal.onEvent((event) => {
      const hasRunningSubprocess = terminalRunningSubprocessFromEvent(event);
      if (hasRunningSubprocess === null) {
        return;
      }
      useTerminalStateStore
        .getState()
        .setTerminalActivity(
          ThreadId.makeUnsafe(event.threadId),
          event.terminalId,
          hasRunningSubprocess,
        );
    });
    const sessionState = createSessionEventState({
      getThreadHookStatus: (rawId) =>
        useStore.getState().threads.find((t) => t.id === rawId)?.hookStatus ?? null,
      getThreadTerminalStatus: (rawId) =>
        useStore.getState().threads.find((t) => t.id === rawId)?.terminalStatus,
      setHookStatus: (rawId, status) =>
        useStore.getState().setHookStatus(ThreadId.makeUnsafe(rawId), status),
      setTerminalStatus: (rawId, status) =>
        useStore.getState().setTerminalStatus(ThreadId.makeUnsafe(rawId), status),
      setTerminalLifecycle: (rawId, status, hookStatus, dormantReason) =>
        useStore.getState().setTerminalLifecycle(
          ThreadId.makeUnsafe(rawId),
          status,
          hookStatus,
          dormantReason,
        ),
    });

    const unsubClaudeSessionEvent = api.claude.onSessionEvent((event) => {
      if (event.type === "hookStatus") {
        const result = sessionState.handleHookStatus(event.threadId, event.hookStatus);

        // Fire OS notification for turn completion (kept here — depends on navigate/thread title)
        if (result.applied && result.hookStatus === "completed") {
          const currentThreadId = getCurrentThreadId();
          const threads = useStore.getState().threads;
          const thread = threads.find((t) => t.id === event.threadId);
          dispatchTurnCompletedNotification(
            event.threadId,
            thread?.title ?? "Thread",
            event.threadId === currentThreadId,
            () => {
              void navigate({ to: "/$threadId", params: { threadId: event.threadId } });
            },
          );
        }
      }
      if (event.type === "output") {
        sessionState.handleOutput(event.threadId, event.data);
      }
      if (event.type === "started") {
        sessionState.handleStarted(event.threadId);
      }
      if (event.type === "hibernated" || event.type === "exited") {
        sessionState.handleDormant(event.threadId, event.type);
      }
      // Forward hook notifications as OS notifications
      if (event.type === "hookNotification") {
        const currentThreadId = getCurrentThreadId();
        const threads = useStore.getState().threads;
        const thread = threads.find((t) => t.id === event.threadId);
        dispatchHookNotification(
          event.subtitle,
          event.body,
          thread?.title ?? "Thread",
          event.threadId === currentThreadId,
          () => {
            void navigate({ to: "/$threadId", params: { threadId: event.threadId } });
          },
        );
      }
    });
    const unsubWelcome = onServerWelcome((payload) => {
      void (async () => {
        // Reset connection-scoped state on reconnect so stale entries from
        // a previous server session don't cause dropped or misfiltered events.
        latestSequence = 0;
        sessionState.clearAll();
        deferredThreadIdsRef.current.clear();

        await syncSnapshot();
        if (disposed) {
          return;
        }

        if (!payload.bootstrapProjectId || !payload.bootstrapThreadId) {
          return;
        }
        setProjectExpanded(payload.bootstrapProjectId, true);
      })().catch(() => undefined);
    });
    const unsubServerConfigUpdated = onServerConfigUpdated((payload) => {
      const signature = JSON.stringify(payload.issues);
      if (lastConfigIssuesSignatureRef.current === signature) {
        return;
      }
      lastConfigIssuesSignatureRef.current = signature;

      void queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
      const issue = payload.issues.find((entry) => entry.kind.startsWith("keybindings."));
      if (!issue) {
        toastManager.add({
          type: "success",
          title: "Keybindings updated",
          description: "Keybindings configuration reloaded successfully.",
        });
        return;
      }

      toastManager.add({
        type: "warning",
        title: "Invalid keybindings configuration",
        description: issue.message,
        actionProps: {
          children: "Open keybindings.json",
          onClick: () => {
            void queryClient
              .ensureQueryData(serverConfigQueryOptions())
              .then((config) =>
                api.shell.openInEditor(config.keybindingsConfigPath, preferredTerminalEditor()),
              )
              .catch((error) => {
                toastManager.add({
                  type: "error",
                  title: "Unable to open keybindings file",
                  description:
                    error instanceof Error ? error.message : "Unknown error opening file.",
                });
              });
          },
        },
      });
    });
    return () => {
      disposed = true;
      needsProviderInvalidation = false;
      syncSnapshotRef.current = null;
      domainEventFlushThrottler.cancel();
      sessionState.clearAll();
      unsubDomainEvent();
      unsubTerminalEvent();
      unsubClaudeSessionEvent();
      unsubWelcome();
      unsubServerConfigUpdated();
    };
  }, [
    navigate,
    queryClient,
    removeOrphanedTerminalStates,
    setProjectExpanded,
    syncServerReadModel,
  ]);

  useEffect(() => {
    // When the user switches threads, flush any deferred sync through the
    // proper syncSnapshot mutex so it respects sequence tracking and the
    // syncing/pending guard.
    const match = pathname.match(/^\/([^/]+)/);
    const threadId = match ? match[1] : null;
    if (threadId && deferredThreadIdsRef.current.has(threadId)) {
      deferredThreadIdsRef.current.delete(threadId);
      if (syncSnapshotRef.current) {
        void syncSnapshotRef.current();
      }
    }
  }, [pathname]);

  return null;
}

function DesktopProjectBootstrap() {
  // Desktop hydration runs through EventRouter project + orchestration sync.
  return null;
}
