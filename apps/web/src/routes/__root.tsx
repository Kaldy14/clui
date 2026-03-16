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
    // Track when threads were marked completed to ignore late Notification hooks
    // that arrive after the Stop hook (race condition).
    const completedAt = new Map<string, number>();
    const COMPLETED_GRACE_MS = 2000;

    // Safety net: if hookStatus stays "working" with no output/hooks for too long,
    // the Stop hook likely failed — clear it so the UI doesn't stay stuck.
    // 90s accommodates long-running tool operations (large file reads, bash commands).
    const WORKING_IDLE_TIMEOUT_MS = 90_000;
    // Throttle timer resets to avoid churn during high-frequency output streaming.
    const IDLE_TIMER_RESET_THROTTLE_MS = 2_000;
    const workingIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const workingIdleLastReset = new Map<string, number>();
    const resetWorkingIdleTimer = (rawThreadId: string, force = false) => {
      // Throttle: skip reset if last reset was recent (unless forced by hook events)
      if (!force) {
        const lastReset = workingIdleLastReset.get(rawThreadId) ?? 0;
        if (Date.now() - lastReset < IDLE_TIMER_RESET_THROTTLE_MS) return;
      }
      workingIdleLastReset.set(rawThreadId, Date.now());
      const existing = workingIdleTimers.get(rawThreadId);
      if (existing) clearTimeout(existing);
      const thread = useStore.getState().threads.find((t) => t.id === rawThreadId);
      if (thread?.hookStatus !== "working") return;
      workingIdleTimers.set(
        rawThreadId,
        setTimeout(() => {
          workingIdleTimers.delete(rawThreadId);
          workingIdleLastReset.delete(rawThreadId);
          const current = useStore.getState().threads.find((t) => t.id === rawThreadId);
          if (current?.hookStatus === "working") {
            useStore.getState().setHookStatus(ThreadId.makeUnsafe(rawThreadId), null);
          }
        }, WORKING_IDLE_TIMEOUT_MS),
      );
    };
    const clearWorkingIdleTimer = (rawThreadId: string) => {
      const existing = workingIdleTimers.get(rawThreadId);
      if (existing) {
        clearTimeout(existing);
        workingIdleTimers.delete(rawThreadId);
      }
      workingIdleLastReset.delete(rawThreadId);
    };

    const unsubClaudeSessionEvent = api.claude.onSessionEvent((event) => {
      if (event.type === "hookStatus") {
        const threadId = ThreadId.makeUnsafe(event.threadId);

        if (event.hookStatus === "completed") {
          completedAt.set(event.threadId, Date.now());
          clearWorkingIdleTimer(event.threadId);
          useStore.getState().setHookStatus(threadId, "completed");
          // Fire OS notification for turn completion
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
        } else if (event.hookStatus === "working") {
          // "working" means user sent a new prompt — but could also be a late
          // PostToolUse hook arriving after the session exited/completed.
          // Guard: ignore if the terminal is already dormant or within grace period.
          const thread = useStore.getState().threads.find((t) => t.id === event.threadId);
          if (thread?.terminalStatus === "dormant" || thread?.terminalStatus === "new") {
            // Stale hook for a dead session — ignore
          } else {
            const doneTs = completedAt.get(event.threadId);
            if (doneTs && Date.now() - doneTs < COMPLETED_GRACE_MS) {
              // Late hook after Stop/exit — ignore
            } else {
              completedAt.delete(event.threadId);
              useStore.getState().setHookStatus(threadId, event.hookStatus);
              resetWorkingIdleTimer(event.threadId, true);
            }
          }
        } else {
          // For needsInput/pendingApproval/error: ignore if within grace period after completed
          const doneTs = completedAt.get(event.threadId);
          if (doneTs && Date.now() - doneTs < COMPLETED_GRACE_MS) {
            // Late hook after Stop — ignore
          } else {
            clearWorkingIdleTimer(event.threadId);
            useStore.getState().setHookStatus(threadId, event.hookStatus);
          }
        }
      }
      // Detect user-initiated interrupts (Escape to cancel).
      // Claude Code doesn't fire the Stop hook when cancelled via Escape,
      // so hookStatus stays stuck. Clear it when we see "Interrupted" in output.
      if (event.type === "output") {
        const threadId = ThreadId.makeUnsafe(event.threadId);
        const thread = useStore.getState().threads.find((t) => t.id === event.threadId);
        // Reset idle timer — output means Claude is still working
        if (thread?.hookStatus === "working") {
          resetWorkingIdleTimer(event.threadId);
        }
        if (
          (thread?.hookStatus === "working" ||
            thread?.hookStatus === "pendingApproval" ||
            thread?.hookStatus === "needsInput") &&
          event.data.includes("Interrupted")
        ) {
          completedAt.set(event.threadId, Date.now());
          clearWorkingIdleTimer(event.threadId);
          useStore.getState().setHookStatus(threadId, null);
        }
      }
      // Eagerly patch terminalStatus so background threads reflect the real
      // state without waiting for the (deferred) full snapshot sync.
      if (event.type === "started") {
        useStore.getState().setTerminalStatus(
          ThreadId.makeUnsafe(event.threadId),
          "active",
        );
      }
      // Atomically clear hook status and set dormant when terminal goes dormant.
      // Set grace window (don't delete) so late hooks arriving after exit are filtered.
      if (event.type === "hibernated" || event.type === "exited") {
        completedAt.set(event.threadId, Date.now());
        clearWorkingIdleTimer(event.threadId);
        useStore.getState().setTerminalLifecycle(
          ThreadId.makeUnsafe(event.threadId),
          "dormant",
          null,
        );
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
        completedAt.clear();
        for (const timer of workingIdleTimers.values()) clearTimeout(timer);
        workingIdleTimers.clear();
        workingIdleLastReset.clear();
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
      completedAt.clear();
      for (const timer of workingIdleTimers.values()) clearTimeout(timer);
      workingIdleTimers.clear();
      workingIdleLastReset.clear();
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
