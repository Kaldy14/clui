import { Outlet, createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import MemoryPressureBanner from "../components/MemoryPressureBanner";
import { useQuery } from "@tanstack/react-query";
import { type ResolvedKeybindingsConfig, ThreadId } from "@clui/contracts";

import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import ThreadSidebar from "../components/Sidebar";
import { Sidebar, SidebarProvider } from "~/components/ui/sidebar";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { projectTerminalThreadId } from "../types";
import { isMacPlatform } from "../lib/utils";
import { setEvictionGuard } from "../lib/claudeTerminalCache";
import {
  isProjectTerminalToggleShortcut,
  isSpeechToggleShortcut,
  isTerminalToggleShortcut,
  isThreadNextShortcut,
  isThreadPrevShortcut,
  isThreadSearchShortcut,
  resolveShortcutCommand,
} from "../keybindings";
import { useSpeechStore } from "../speechStore";
import { projectScriptIdFromCommand } from "../projectScripts";
import { runProjectScriptInTerminal } from "../components/TerminalToolbar";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { toastManager } from "../components/ui/toast";

const ProjectTerminalDrawer = lazy(() => import("../components/ProjectTerminalDrawer"));
const ThreadSearchDialog = lazy(() => import("../components/ThreadSearchDialog"));

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

function ProjectTerminalDrawers() {
  const projects = useStore((s) => s.projects);
  const terminalStateByThreadId = useTerminalStateStore((s) => s.terminalStateByThreadId);
  const setTerminalOpen = useTerminalStateStore((s) => s.setTerminalOpen);
  const setTerminalHeight = useTerminalStateStore((s) => s.setTerminalHeight);

  const openProjectTerminals = projects.filter((project) => {
    const syntheticId = projectTerminalThreadId(project.id);
    const state = terminalStateByThreadId[syntheticId];
    return state?.terminalOpen === true;
  });

  if (openProjectTerminals.length === 0) return null;

  return (
    <Suspense fallback={null}>
      {openProjectTerminals.map((project) => {
        const syntheticId = projectTerminalThreadId(project.id);
        const state = terminalStateByThreadId[syntheticId];
        return (
          <ProjectTerminalDrawer
            key={project.id}
            projectId={project.id}
            cwd={project.cwd}
            height={state?.terminalHeight ?? 280}
            onHeightChange={(height) => setTerminalHeight(syntheticId, height)}
            onClose={() => setTerminalOpen(syntheticId, false)}
          />
        );
      })}
    </Suspense>
  );
}

/** Hook statuses that indicate the thread is busy and should not be evicted. */
const BUSY_HOOK_STATUSES = new Set(["working", "needsInput", "pendingApproval"]);

function ChatRouteLayout() {
  const navigate = useNavigate();
  const [searchOpen, setSearchOpen] = useState(false);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const { data: keybindings = EMPTY_KEYBINDINGS } = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.keybindings,
  });

  // Register eviction guard so the terminal cache never disposes busy threads.
  // Uses getState() to read the latest snapshot without subscribing to re-renders.
  useEffect(() => {
    setEvictionGuard((threadId) => {
      const thread = useStore.getState().threads.find((t) => t.id === threadId);
      if (!thread) return false;
      if (thread.terminalStatus === "active") return true;
      if (thread.hookStatus && BUSY_HOOK_STATUSES.has(thread.hookStatus)) return true;
      return false;
    });
  }, []);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "open-settings") return;
      void navigate({ to: "/settings" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  const threads = useStore((s) => s.threads);
  const terminalStateByThreadId = useTerminalStateStore((s) => s.terminalStateByThreadId);
  const setTerminalOpen = useTerminalStateStore((s) => s.setTerminalOpen);
  const setProjectTerminalOpen = useTerminalStateStore((s) => s.setProjectTerminalOpen);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isThreadSearchShortcut(event, keybindings)) {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }

      // Cmd+J: Toggle thread terminal drawer
      if (isTerminalToggleShortcut(event, keybindings)) {
        event.preventDefault();
        if (routeThreadId) {
          const isOpen = terminalStateByThreadId[routeThreadId]?.terminalOpen ?? false;
          setTerminalOpen(routeThreadId, !isOpen);
        }
        return;
      }

      // Cmd+Shift+J: Toggle project terminal drawer
      if (isProjectTerminalToggleShortcut(event, keybindings)) {
        event.preventDefault();
        const currentThread = routeThreadId
          ? threads.find((t) => t.id === routeThreadId)
          : undefined;
        if (currentThread) {
          const syntheticId = projectTerminalThreadId(currentThread.projectId);
          const isOpen = terminalStateByThreadId[syntheticId]?.terminalOpen ?? false;
          setProjectTerminalOpen(syntheticId, !isOpen);
        }
        return;
      }

      // Thread next/prev: Cmd+Shift+] / Cmd+Shift+[
      if (isThreadNextShortcut(event, keybindings) || isThreadPrevShortcut(event, keybindings)) {
        event.preventDefault();
        const isNext = isThreadNextShortcut(event, keybindings);
        const allThreads = threads.filter((t) => t.terminalStatus !== undefined);
        if (allThreads.length === 0) return;
        const currentIndex = allThreads.findIndex((t) => t.id === routeThreadId);
        const nextIndex = isNext
          ? (currentIndex + 1) % allThreads.length
          : (currentIndex - 1 + allThreads.length) % allThreads.length;
        const nextThread = allThreads[nextIndex];
        if (nextThread) {
          void navigate({ to: "/$threadId", params: { threadId: nextThread.id } });
        }
        return;
      }

      if (isSpeechToggleShortcut(event, keybindings)) {
        event.preventDefault();
        if (routeThreadId) {
          const store = useSpeechStore.getState();
          if (!store.modelDownloaded && store.status === "idle") {
            toastManager.add({
              type: "info",
              title: "Voice input requires a speech model",
              description: "Click the mic icon in the toolbar or go to Settings to download one.",
            });
            return;
          }
          window.dispatchEvent(new CustomEvent("clui:speech-toggle", { detail: { threadId: routeThreadId } }));
        }
        return;
      }

      // Cmd+1-9: Switch to thread by index
      const modKey = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
      if (modKey && !event.shiftKey && !event.altKey && event.key >= "1" && event.key <= "9") {
        event.preventDefault();
        const index = Number.parseInt(event.key, 10) - 1;
        if (index < threads.length) {
          const targetThread = threads[index];
          if (targetThread) {
            void navigate({ to: "/$threadId", params: { threadId: targetThread.id } });
          }
        }
        return;
      }

      // Script keybindings: script.<id>.run
      const resolvedCommand = resolveShortcutCommand(event, keybindings);
      if (resolvedCommand) {
        const scriptId = projectScriptIdFromCommand(resolvedCommand);
        if (scriptId) {
          event.preventDefault();
          const currentThread = routeThreadId
            ? threads.find((t) => t.id === routeThreadId)
            : undefined;
          if (currentThread) {
            const { projects } = useStore.getState();
            const project = projects.find((p) => p.id === currentThread.projectId);
            if (project) {
              const script = project.scripts.find((s) => s.id === scriptId);
              if (script) {
                runProjectScriptInTerminal(script, currentThread.id, project, currentThread.worktreePath);
              }
            }
          }
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, threads, navigate, routeThreadId, terminalStateByThreadId, setTerminalOpen, setProjectTerminalOpen]);

  const handleSearchClick = useCallback(() => setSearchOpen(true), []);

  return (
    <SidebarProvider defaultOpen>
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-card text-foreground"
      >
        <ThreadSidebar onSearchClick={handleSearchClick} />
      </Sidebar>
      <DiffWorkerPoolProvider>
        <div className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col">
          <MemoryPressureBanner />
          <div className="flex min-h-0 min-w-0 flex-1">
            <Outlet />
          </div>
          <ProjectTerminalDrawers />
        </div>
      </DiffWorkerPoolProvider>
      <Suspense fallback={null}>
        <ThreadSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      </Suspense>
    </SidebarProvider>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
