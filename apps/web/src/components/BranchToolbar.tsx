import type { ThreadId } from "@clui/contracts";
import { useCallback } from "react";

import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import {
  EnvMode,
  resolveEffectiveEnvMode,
} from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { Button } from "./ui/button";

interface BranchToolbarProps {
  threadId: ThreadId;
  onEnvModeChange: (mode: EnvMode) => void;
  envLocked: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
}

export default function BranchToolbar({
  threadId,
  onEnvModeChange,
  envLocked,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
}: BranchToolbarProps) {
  const threads = useStore((store) => store.threads);
  const projects = useStore((store) => store.projects);
  const setThreadBranchAction = useStore((store) => store.setThreadBranch);

  const serverThread = threads.find((thread) => thread.id === threadId);
  const activeProjectId = serverThread?.projectId ?? null;
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const activeThreadId = serverThread?.id;
  const activeThreadBranch = serverThread?.branch ?? null;
  const activeWorktreePath = serverThread?.worktreePath ?? null;
  const branchCwd = activeWorktreePath ?? activeProject?.cwd ?? null;
  const hasServerThread = serverThread !== undefined;
  const effectiveEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread,
    draftThreadEnvMode: undefined,
  });

  const setThreadBranch = useCallback(
    (branch: string | null, worktreePath: string | null) => {
      if (!activeThreadId) return;
      const api = readNativeApi();
      // If the effective cwd is about to change, stop the running session so the
      // next message creates a new one with the correct cwd.
      if (serverThread?.session && worktreePath !== activeWorktreePath && api) {
        void api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId: activeThreadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }
      // Hibernate the claude terminal when cwd changes so it restarts in the
      // new worktree directory on next interaction.
      if (worktreePath !== activeWorktreePath && api) {
        void api.claude.hibernate({ threadId: activeThreadId }).catch(() => undefined);
      }
      if (api && hasServerThread) {
        void api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeThreadId,
          branch,
          worktreePath,
        });
      }
      if (hasServerThread) {
        setThreadBranchAction(activeThreadId, branch, worktreePath);
      }
    },
    [
      activeThreadId,
      serverThread?.session,
      activeWorktreePath,
      hasServerThread,
      setThreadBranchAction,
    ],
  );

  if (!activeThreadId || !activeProject) return null;

  return (
    <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 pb-3 pt-1">
      <div className="flex items-center gap-2">
        {envLocked || activeWorktreePath ? (
          <span className="border border-transparent px-[calc(--spacing(2)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs">
            {activeWorktreePath ? "Worktree" : "Local"}
          </span>
        ) : (
          <Button
            type="button"
            variant="ghost"
            className="text-muted-foreground/70 hover:text-foreground/80"
            size="xs"
            onClick={() => onEnvModeChange(effectiveEnvMode === "local" ? "worktree" : "local")}
          >
            {effectiveEnvMode === "worktree" ? "New worktree" : "Local"}
          </Button>
        )}
      </div>

      <BranchToolbarBranchSelector
        activeProjectCwd={activeProject.cwd}
        activeThreadBranch={activeThreadBranch}
        activeWorktreePath={activeWorktreePath}
        branchCwd={branchCwd}
        effectiveEnvMode={effectiveEnvMode}
        envLocked={envLocked}
        onSetThreadBranch={setThreadBranch}
        {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
        {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
      />
    </div>
  );
}
