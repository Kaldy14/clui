import type { ThreadId } from "@clui/contracts";
import { useCallback } from "react";

import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { resolveEffectiveEnvMode } from "./BranchToolbar.logic";

export function useBranchToolbar(threadId: ThreadId) {
  const serverThread = useStore((store) => store.threads.find((thread) => thread.id === threadId));
  const activeProjectId = serverThread?.projectId ?? null;
  const activeProject = useStore(
    (store) => store.projects.find((project) => project.id === activeProjectId),
  );
  const setThreadBranchAction = useStore((store) => store.setThreadBranch);
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
      // Hibernate the active harness terminal when cwd changes so it restarts in the
      // new worktree directory on next interaction.
      if (worktreePath !== activeWorktreePath && api) {
        const hibernate =
          serverThread?.harness === "pi"
            ? api.pi.hibernate({ threadId: activeThreadId })
            : api.claude.hibernate({ threadId: activeThreadId });
        void hibernate.catch(() => undefined);
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
      serverThread?.harness,
      activeWorktreePath,
      hasServerThread,
      setThreadBranchAction,
    ],
  );

  return {
    activeProjectCwd: activeProject?.cwd ?? null,
    activeThreadBranch,
    activeWorktreePath,
    branchCwd,
    effectiveEnvMode,
    setThreadBranch,
    isReady: activeThreadId != null && activeProject != null,
  };
}
