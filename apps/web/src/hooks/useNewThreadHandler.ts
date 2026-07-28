import {
  DEFAULT_CLAUDE_CODE_BACKEND,
  DEFAULT_CLAUDE_CODE_PROXY_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  type ProjectId,
  type ThreadId,
} from "@clui/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useAppSettings } from "../appSettings";
import { createThreadAndNavigate } from "../components/Sidebar.logic";
import { findReusableNewThreadForProject } from "../components/NewThreadView.logic";
import { newCommandId, newThreadId } from "../lib/utils";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";

export interface NewThreadOptions {
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly replace?: boolean;
  readonly reuseExistingDraft?: boolean;
}

export function useNewThreadHandler() {
  const navigate = useNavigate();
  const { settings: appSettings } = useAppSettings();
  const { data: serverConfig } = useQuery(serverConfigQueryOptions());
  const addOptimisticThread = useStore((store) => store.addOptimisticThread);

  return useCallback(
    async (projectId: ProjectId, options?: NewThreadOptions): Promise<ThreadId | null> => {
      if (options?.reuseExistingDraft) {
        const reusableThread = findReusableNewThreadForProject(
          useStore.getState().threads,
          projectId,
        );
        if (reusableThread) {
          await navigate({
            to: "/$threadId",
            params: { threadId: reusableThread.id },
            ...(options.replace === undefined ? {} : { replace: options.replace }),
          });
          return reusableThread.id;
        }
      }

      const api = readNativeApi();
      if (!api) return null;

      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const branch = options?.branch ?? null;
      const worktreePath = options?.worktreePath ?? null;
      const harness = appSettings.defaultCodingHarness;
      const claudeCodeBackend =
        serverConfig?.settings.defaultClaudeCodeBackend ?? DEFAULT_CLAUDE_CODE_BACKEND;
      const project = useStore.getState().projects.find((entry) => entry.id === projectId);
      const model =
        harness === "claudeCode" && claudeCodeBackend === "codex"
          ? (serverConfig?.settings.defaultClaudeCodeProxyModel ?? DEFAULT_CLAUDE_CODE_PROXY_MODEL)
          : (project?.model ??
            (harness === "claudeCode"
              ? DEFAULT_MODEL_BY_PROVIDER.claudeCode
              : DEFAULT_MODEL_BY_PROVIDER.codex));

      return createThreadAndNavigate({
        api,
        navigate,
        addOptimisticThread,
        commandId: newCommandId(),
        threadId,
        projectId,
        model,
        harness,
        claudeCodeBackend,
        createdAt,
        branch,
        worktreePath,
        ...(options?.replace === undefined ? {} : { replace: options.replace }),
      });
    },
    [addOptimisticThread, appSettings.defaultCodingHarness, navigate, serverConfig?.settings],
  );
}
