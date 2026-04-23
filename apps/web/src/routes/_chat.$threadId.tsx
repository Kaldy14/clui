import { ThreadId } from "@clui/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { getViewedThreadCompletionVisit } from "../lib/threadVisit";
import { useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { Sheet, SheetPopup } from "../components/ui/sheet";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";
import TerminalToolbar from "~/components/TerminalToolbar";
import ThreadTerminalView from "~/components/ThreadTerminalView";

const ThreadTerminalDrawer = lazy(() => import("../components/ThreadTerminalDrawer"));

const newTerminalId = () => crypto.randomUUID().slice(0, 8);
const DiffPanel = lazy(() => import("../components/DiffPanel"));
const DIFF_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 1180px)";
const DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_diff_sidebar_width";
const DIFF_INLINE_DEFAULT_WIDTH = "clamp(28rem,48vw,44rem)";
const DIFF_INLINE_SIDEBAR_MIN_WIDTH = 26 * 16;

const DiffPanelSheet = (props: {
  children: ReactNode;
  diffOpen: boolean;
  onCloseDiff: () => void;
}) => {
  return (
    <Sheet
      open={props.diffOpen}
      onOpenChange={(open) => {
        if (!open) {
          props.onCloseDiff();
        }
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        className="w-[min(88vw,820px)] max-w-[820px] p-0"
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
};

const DiffLoadingFallback = (props: { inline: boolean }) => {
  if (props.inline) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-4 text-center text-xs text-muted-foreground/70">
        Loading diff viewer...
      </div>
    );
  }

  return (
    <aside className="flex h-full w-[560px] shrink-0 items-center justify-center border-l border-border bg-card px-4 text-center text-xs text-muted-foreground/70">
      Loading diff viewer...
    </aside>
  );
};

const DiffPanelInlineSidebar = (props: {
  diffOpen: boolean;
  onCloseDiff: () => void;
  onOpenDiff: () => void;
}) => {
  const { diffOpen, onCloseDiff, onOpenDiff } = props;
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onOpenDiff();
        return;
      }
      onCloseDiff();
    },
    [onCloseDiff, onOpenDiff],
  );
  const shouldAcceptInlineSidebarWidth = useCallback(() => true, []);

  return (
    <SidebarProvider
      defaultOpen={false}
      open={diffOpen}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": DIFF_INLINE_DEFAULT_WIDTH } as React.CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          minWidth: DIFF_INLINE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <Suspense fallback={<DiffLoadingFallback inline />}>
          <DiffPanel mode="sidebar" />
        </Suspense>
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
};

function ThreadTerminalDrawerContainer({ threadId }: { threadId: ThreadId }) {
  const thread = useStore((s) => s.threads.find((t) => t.id === threadId));
  const project = useStore((s) => s.projects.find((p) => p.id === thread?.projectId));
  const terminalState = useTerminalStateStore((s) =>
    selectThreadTerminalState(s.terminalStateByThreadId, threadId),
  );
  const setTerminalOpen = useTerminalStateStore((s) => s.setTerminalOpen);
  const setTerminalHeight = useTerminalStateStore((s) => s.setTerminalHeight);
  const splitTerminal = useTerminalStateStore((s) => s.splitTerminal);
  const newTerminal = useTerminalStateStore((s) => s.newTerminal);
  const setActiveTerminal = useTerminalStateStore((s) => s.setActiveTerminal);
  const closeTerminal = useTerminalStateStore((s) => s.closeTerminal);

  // Track explicit open transitions (closed→open) to auto-focus only on user
  // action, not on mount from persisted state. key={threadId} on the component
  // resets this state when navigating between threads.
  const [focusRequestId, setFocusRequestId] = useState(0);
  const prevTerminalOpenRef = useRef(terminalState.terminalOpen);
  useEffect(() => {
    if (terminalState.terminalOpen && !prevTerminalOpenRef.current) {
      setFocusRequestId((prev) => prev + 1);
    }
    prevTerminalOpenRef.current = terminalState.terminalOpen;
  }, [terminalState.terminalOpen]);

  const cwd = thread?.worktreePath ?? project?.cwd;
  if (!terminalState.terminalOpen || !cwd) return null;

  return (
    <Suspense fallback={null}>
      <ThreadTerminalDrawer
        threadId={threadId}
        cwd={cwd}
        height={terminalState.terminalHeight}
        terminalIds={terminalState.terminalIds}
        activeTerminalId={terminalState.activeTerminalId}
        terminalGroups={terminalState.terminalGroups}
        activeTerminalGroupId={terminalState.activeTerminalGroupId}
        focusRequestId={focusRequestId}
        onSplitTerminal={() => splitTerminal(threadId, newTerminalId())}
        onNewTerminal={() => newTerminal(threadId, newTerminalId())}
        onActiveTerminalChange={(id) => setActiveTerminal(threadId, id)}
        onCloseTerminal={(id) => {
          closeTerminal(threadId, id);
          // If no terminals left, close the drawer
          if (terminalState.terminalIds.length <= 1) {
            setTerminalOpen(threadId, false);
          }
        }}
        onHeightChange={(h) => setTerminalHeight(threadId, h)}
      />
    </Suspense>
  );
}

function ChatThreadRouteView() {
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const navigate = useNavigate();
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const search = Route.useSearch();
  const routeThreadExists = useStore((store) => store.threads.some((thread) => thread.id === threadId));
  // Subscribe to completion-related state so the badge-clearing effect below
  // re-fires when a thread completes while we're already viewing it.
  const hookStatus = useStore((store) => store.threads.find((t) => t.id === threadId)?.hookStatus ?? null);
  const completedAt = useStore(
    (store) => store.threads.find((t) => t.id === threadId)?.latestTurn?.completedAt ?? null,
  );
  const diffOpen = search.diff === "1";
  const shouldUseDiffSheet = useMediaQuery(DIFF_INLINE_LAYOUT_MEDIA_QUERY);
  const lastHandledCompletionVisitKeyRef = useRef<string | null>(null);
  const closeDiff = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => {
        return stripDiffSearchParams(previous);
      },
    });
  }, [navigate, threadId]);
  const openDiff = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1" };
      },
    });
  }, [navigate, threadId]);

  // Mark thread as visited when navigating to it.
  useEffect(() => {
    if (!threadsHydrated || !routeThreadExists) return;
    useStore.getState().markThreadVisited(threadId);
  }, [threadsHydrated, routeThreadExists, threadId]);

  // Clear a viewed completion exactly once per completion signal so we don't
  // keep issuing new visit timestamps while the current thread is already open.
  useEffect(() => {
    if (!threadsHydrated || !routeThreadExists) return;

    const store = useStore.getState();
    const completionVisit = getViewedThreadCompletionVisit({
      threadId,
      hookStatus,
      completedAt,
      lastHandledKey: lastHandledCompletionVisitKeyRef.current,
    });

    if (completionVisit) {
      lastHandledCompletionVisitKeyRef.current = completionVisit.key;
      store.markThreadVisited(threadId, completionVisit.visitedAt);
    }

    if (hookStatus === "completed") {
      store.setHookStatus(threadId, null);
    }
  }, [threadsHydrated, routeThreadExists, threadId, hookStatus, completedAt]);

  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }

    if (!routeThreadExists) {
      void navigate({ to: "/", replace: true });
      return;
    }
  }, [navigate, routeThreadExists, threadsHydrated, threadId]);

  if (!threadsHydrated || !routeThreadExists) {
    return null;
  }

  if (!shouldUseDiffSheet) {
    return (
      <>
        <SidebarInset className="h-full min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
          <div className="flex h-full flex-col">
            <TerminalToolbar threadId={threadId} diffOpen={diffOpen} />
            <div className="min-h-0 flex-1">
              <ThreadTerminalView threadId={threadId} />
            </div>
            <ThreadTerminalDrawerContainer key={threadId} threadId={threadId} />
          </div>
        </SidebarInset>
        <DiffPanelInlineSidebar diffOpen={diffOpen} onCloseDiff={closeDiff} onOpenDiff={openDiff} />
      </>
    );
  }

  return (
    <>
      <SidebarInset className="h-full min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <div className="flex h-full flex-col">
          <TerminalToolbar threadId={threadId} diffOpen={diffOpen} />
          <div className="min-h-0 flex-1">
            <ThreadTerminalView threadId={threadId} />
          </div>
          <ThreadTerminalDrawerContainer key={threadId} threadId={threadId} />
        </div>
      </SidebarInset>
      <DiffPanelSheet diffOpen={diffOpen} onCloseDiff={closeDiff}>
        <Suspense fallback={<DiffLoadingFallback inline={false} />}>
          <DiffPanel mode="sheet" />
        </Suspense>
      </DiffPanelSheet>
    </>
  );
}

export const Route = createFileRoute("/_chat/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  component: ChatThreadRouteView,
});
