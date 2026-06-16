import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_ACTIVE_HARNESS_SESSION_CAP,
  DEFAULT_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS,
  DEFAULT_PREVENT_MACOS_SLEEP_WHEN_THREAD_IN_PROGRESS,
  MAX_ACTIVE_HARNESS_SESSION_CAP,
  MAX_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS,
  MIN_ACTIVE_HARNESS_SESSION_CAP,
  MIN_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS,
  type CodingHarness,
  type ProviderKind,
  type ServerConfig,
  type ServerUpdateSettingsInput,
  type ThreadId,
  type TitleGenerationProvider,
} from "@clui/contracts";
import { getModelOptions, normalizeModelSlug } from "@clui/shared/model";

import {
  CODING_HARNESS_OPTIONS,
  DEFAULT_TERMINAL_FONT_FAMILY,
  MAX_CUSTOM_MODEL_LENGTH,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  type TerminalColorTheme,
  WHISPER_MODEL_TIERS,
  type WhisperModelTier,
  useAppSettings,
} from "../appSettings";
import whisperManager from "../lib/whisperManager";
import * as claudeCache from "../lib/claudeTerminalCache";
import { isElectron } from "../env";
import { useTheme } from "../hooks/useTheme";
import { serverConfigQueryOptions, serverQueryKeys } from "../lib/serverReactQuery";
import { dispatchThreadArchiveUpdate } from "../lib/threadArchive";
import { formatRelativeTime } from "../lib/threadStatus";
import { ensureNativeApi } from "../nativeApi";
import { preferredTerminalEditor } from "../terminal-links";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { SidebarInset } from "~/components/ui/sidebar";
import { useStore } from "../store";
import { groupByProject, searchThreads } from "../components/ThreadSearchDialog.logic";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
    description: "Match your OS appearance setting.",
  },
  {
    value: "light",
    label: "Light",
    description: "Always use the light theme.",
  },
  {
    value: "dark",
    label: "Dark",
    description: "Always use the dark theme.",
  },
] as const;

const TERMINAL_COLOR_THEME_OPTIONS: Array<{
  value: TerminalColorTheme;
  label: string;
  description: string;
}> = [
  {
    value: "muted-earth",
    label: "Muted Earth",
    description: "Desaturated earthy tones on a near-black background.",
  },
  {
    value: "classic-pastel",
    label: "Classic Pastel",
    description: "Bright pastel palette on the app background.",
  },
];

const CODING_HARNESS_LABELS: Record<CodingHarness, { label: string; description: string }> = {
  claudeCode: {
    label: "Claude Code",
    description: "Use the existing Claude Code terminal harness for new threads.",
  },
  pi: {
    label: "pi",
    description: "Use the pi coding agent terminal harness for new threads.",
  },
};

const MODEL_PROVIDER_SETTINGS: Array<{
  provider: ProviderKind;
  title: string;
  description: string;
  placeholder: string;
  example: string;
}> = [
  {
    provider: "codex",
    title: "Codex",
    description: "Save additional Codex model slugs for the picker and `/model` command.",
    placeholder: "your-codex-model-slug",
    example: "gpt-6.7-codex-ultra-preview",
  },
  {
    provider: "claudeCode",
    title: "Claude Code",
    description: "Save additional Claude model slugs for the picker and `/model` command.",
    placeholder: "your-claude-model-slug",
    example: "claude-sonnet-5-0",
  },
] as const;

function getCustomModelsForProvider(
  settings: ReturnType<typeof useAppSettings>["settings"],
  provider: ProviderKind,
) {
  switch (provider) {
    case "claudeCode":
      return settings.customClaudeModels;
    case "cursor":
      return settings.customCursorModels;
    case "codex":
    default:
      return settings.customCodexModels;
  }
}

function getDefaultCustomModelsForProvider(
  defaults: ReturnType<typeof useAppSettings>["defaults"],
  provider: ProviderKind,
) {
  switch (provider) {
    case "claudeCode":
      return defaults.customClaudeModels;
    case "cursor":
      return defaults.customCursorModels;
    case "codex":
    default:
      return defaults.customCodexModels;
  }
}

function patchCustomModels(provider: ProviderKind, models: string[]) {
  switch (provider) {
    case "claudeCode":
      return { customClaudeModels: models };
    case "cursor":
      return { customCursorModels: models };
    case "codex":
    default:
      return { customCodexModels: models };
  }
}

function SettingsRouteView() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { settings, defaults, updateSettings } = useAppSettings();
  const queryClient = useQueryClient();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const navigate = useNavigate();
  const projects = useStore((state) => state.projects);
  const threads = useStore((state) => state.threads);
  const setThreadArchived = useStore((state) => state.setThreadArchived);
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const [maxActiveHarnessSessionsInput, setMaxActiveHarnessSessionsInput] = useState("");
  const [autoArchiveInactiveThreadDaysInput, setAutoArchiveInactiveThreadDaysInput] = useState("");
  const [serverSettingsError, setServerSettingsError] = useState<string | null>(null);
  const [serverSettingsErrorSource, setServerSettingsErrorSource] = useState<
    "titleGeneration" | "sessionHibernation" | "chatHistory" | null
  >(null);
  const [isSavingServerSettings, setIsSavingServerSettings] = useState(false);
  const [archivedThreadQuery, setArchivedThreadQuery] = useState("");
  const [archivedThreadsError, setArchivedThreadsError] = useState<string | null>(null);
  const [restoringArchivedThreadIds, setRestoringArchivedThreadIds] = useState<
    ReadonlySet<ThreadId>
  >(() => new Set<ThreadId>());
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
    claudeCode: "",
    cursor: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [whisperDownloadProgress, setWhisperDownloadProgress] = useState<number | null>(null);
  const [whisperModelReady, setWhisperModelReady] = useState(false);

  useEffect(() => {
    setWhisperModelReady(whisperManager.isModelReady(settings.whisperModel as WhisperModelTier));
  }, [settings.whisperModel]);

  useEffect(() => {
    const currentCap = serverConfigQuery.data?.settings.maxActiveHarnessSessions;
    if (typeof currentCap === "number") {
      setMaxActiveHarnessSessionsInput(String(currentCap));
      setServerSettingsError(null);
      setServerSettingsErrorSource(null);
    }
  }, [serverConfigQuery.data?.settings.maxActiveHarnessSessions]);

  useEffect(() => {
    const currentDays = serverConfigQuery.data?.settings.autoArchiveInactiveThreadDays;
    if (typeof currentDays === "number") {
      setAutoArchiveInactiveThreadDaysInput(String(currentDays));
      setServerSettingsError(null);
      setServerSettingsErrorSource(null);
    }
  }, [serverConfigQuery.data?.settings.autoArchiveInactiveThreadDays]);

  // Scroll to section when navigated with hash (e.g. /settings#speech-to-text)
  useEffect(() => {
    const hash = window.location.hash.replace("#", "");
    if (hash) {
      requestAnimationFrame(() => {
        document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
  }, []);

  const handleDownloadModel = useCallback(() => {
    setWhisperDownloadProgress(0);
    void whisperManager
      .downloadModel(settings.whisperModel as WhisperModelTier, (progress: number) => {
        setWhisperDownloadProgress(progress);
      })
      .then(() => {
        setWhisperModelReady(true);
        setWhisperDownloadProgress(null);
      })
      .catch(() => {
        setWhisperDownloadProgress(null);
      });
  }, [settings.whisperModel]);

  const keybindingsConfigPath = serverConfigQuery.data?.keybindingsConfigPath ?? null;
  const cliProviderStatuses = useMemo(
    () =>
      serverConfigQuery.data?.providers.filter(
        (provider) => provider.provider === "claudeCode" || provider.provider === "codex",
      ) ?? [],
    [serverConfigQuery.data?.providers],
  );

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);
    const api = ensureNativeApi();
    void api.shell
      .openInEditor(keybindingsConfigPath, preferredTerminalEditor())
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => {
        setIsOpeningKeybindings(false);
      });
  }, [keybindingsConfigPath]);

  const persistServerSettings = useCallback(
    (
      patch: ServerUpdateSettingsInput,
      source: "titleGeneration" | "sessionHibernation" | "chatHistory",
    ) => {
      setServerSettingsError(null);
      setServerSettingsErrorSource(null);
      setIsSavingServerSettings(true);
      const previousConfig = queryClient.getQueryData<ServerConfig>(serverQueryKeys.config());
      queryClient.setQueryData<ServerConfig>(serverQueryKeys.config(), (previous) =>
        previous
          ? {
              ...previous,
              settings: {
                titleGenerationProvider:
                  patch.titleGenerationProvider ?? previous.settings.titleGenerationProvider,
                maxActiveHarnessSessions:
                  patch.maxActiveHarnessSessions ?? previous.settings.maxActiveHarnessSessions,
                preventMacosSleepWhenThreadInProgress:
                  patch.preventMacosSleepWhenThreadInProgress ??
                  previous.settings.preventMacosSleepWhenThreadInProgress,
                autoArchiveInactiveThreadDays:
                  patch.autoArchiveInactiveThreadDays ??
                  previous.settings.autoArchiveInactiveThreadDays,
              },
            }
          : previous,
      );

      const api = ensureNativeApi();
      void api.server
        .updateSettings(patch)
        .then((nextSettings) => {
          queryClient.setQueryData<ServerConfig>(serverQueryKeys.config(), (previous) =>
            previous ? { ...previous, settings: nextSettings } : previous,
          );
        })
        .catch((error) => {
          queryClient.setQueryData<ServerConfig>(serverQueryKeys.config(), previousConfig);
          setServerSettingsErrorSource(source);
          setServerSettingsError(
            error instanceof Error ? error.message : "Unable to save server settings.",
          );
        })
        .finally(() => {
          setIsSavingServerSettings(false);
        });
    },
    [queryClient],
  );

  const restoreArchivedThread = useCallback(
    (threadId: ThreadId) => {
      setArchivedThreadsError(null);
      setRestoringArchivedThreadIds((current) => new Set(current).add(threadId));

      let api: ReturnType<typeof ensureNativeApi>;
      try {
        api = ensureNativeApi();
      } catch (error) {
        setArchivedThreadsError(
          error instanceof Error ? error.message : "Unable to restore archived chat.",
        );
        setRestoringArchivedThreadIds((current) => {
          const next = new Set(current);
          next.delete(threadId);
          return next;
        });
        return;
      }

      void dispatchThreadArchiveUpdate(api, threadId, null)
        .then(() => {
          setThreadArchived(threadId, null);
        })
        .catch((error) => {
          setArchivedThreadsError(
            error instanceof Error ? error.message : "Unable to restore archived chat.",
          );
        })
        .finally(() => {
          setRestoringArchivedThreadIds((current) => {
            const next = new Set(current);
            next.delete(threadId);
            return next;
          });
        });
    },
    [setThreadArchived],
  );

  const saveServerSettings = useCallback(() => {
    const nextCap = Number.parseInt(maxActiveHarnessSessionsInput, 10);
    if (
      !Number.isInteger(nextCap) ||
      nextCap < MIN_ACTIVE_HARNESS_SESSION_CAP ||
      nextCap > MAX_ACTIVE_HARNESS_SESSION_CAP
    ) {
      setServerSettingsErrorSource("sessionHibernation");
      setServerSettingsError(
        `Enter a whole number between ${MIN_ACTIVE_HARNESS_SESSION_CAP} and ${MAX_ACTIVE_HARNESS_SESSION_CAP}.`,
      );
      return;
    }

    persistServerSettings({ maxActiveHarnessSessions: nextCap }, "sessionHibernation");
  }, [maxActiveHarnessSessionsInput, persistServerSettings]);

  const saveAutoArchiveSettings = useCallback(() => {
    const nextDays = Number.parseInt(autoArchiveInactiveThreadDaysInput, 10);
    if (
      !Number.isInteger(nextDays) ||
      nextDays < MIN_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS ||
      nextDays > MAX_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS
    ) {
      setServerSettingsErrorSource("chatHistory");
      setServerSettingsError(
        `Enter a whole number between ${MIN_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS} and ${MAX_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS}.`,
      );
      return;
    }

    persistServerSettings({ autoArchiveInactiveThreadDays: nextDays }, "chatHistory");
  }, [autoArchiveInactiveThreadDaysInput, persistServerSettings]);

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      const customModelInput = customModelInputByProvider[provider];
      const customModels = getCustomModelsForProvider(settings, provider);
      const normalized = normalizeModelSlug(customModelInput, provider);
      if (!normalized) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "Enter a model slug.",
        }));
        return;
      }
      if (getModelOptions(provider).some((option) => option.slug === normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That model is already built in.",
        }));
        return;
      }
      if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
        }));
        return;
      }
      if (customModels.includes(normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That custom model is already saved.",
        }));
        return;
      }

      updateSettings(patchCustomModels(provider, [...customModels, normalized]));
      setCustomModelInputByProvider((existing) => ({
        ...existing,
        [provider]: "",
      }));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [customModelInputByProvider, settings, updateSettings],
  );

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      const customModels = getCustomModelsForProvider(settings, provider);
      updateSettings(
        patchCustomModels(
          provider,
          customModels.filter((model) => model !== slug),
        ),
      );
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [settings, updateSettings],
  );

  const configuredMaxActiveHarnessSessions =
    serverConfigQuery.data?.settings.maxActiveHarnessSessions ?? DEFAULT_ACTIVE_HARNESS_SESSION_CAP;
  const configuredPreventMacosSleepWhenThreadInProgress =
    serverConfigQuery.data?.settings.preventMacosSleepWhenThreadInProgress ??
    DEFAULT_PREVENT_MACOS_SLEEP_WHEN_THREAD_IN_PROGRESS;
  const configuredAutoArchiveInactiveThreadDays =
    serverConfigQuery.data?.settings.autoArchiveInactiveThreadDays ??
    DEFAULT_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS;
  const parsedMaxActiveHarnessSessions = Number.parseInt(maxActiveHarnessSessionsInput, 10);
  const parsedAutoArchiveInactiveThreadDays = Number.parseInt(
    autoArchiveInactiveThreadDaysInput,
    10,
  );
  const hasValidMaxActiveHarnessSessions =
    Number.isInteger(parsedMaxActiveHarnessSessions) &&
    parsedMaxActiveHarnessSessions >= MIN_ACTIVE_HARNESS_SESSION_CAP &&
    parsedMaxActiveHarnessSessions <= MAX_ACTIVE_HARNESS_SESSION_CAP;
  const hasValidAutoArchiveInactiveThreadDays =
    Number.isInteger(parsedAutoArchiveInactiveThreadDays) &&
    parsedAutoArchiveInactiveThreadDays >= MIN_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS &&
    parsedAutoArchiveInactiveThreadDays <= MAX_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS;
  const hasPendingServerSettingsChange =
    hasValidMaxActiveHarnessSessions &&
    parsedMaxActiveHarnessSessions !== configuredMaxActiveHarnessSessions;
  const hasPendingAutoArchiveSettingsChange =
    hasValidAutoArchiveInactiveThreadDays &&
    parsedAutoArchiveInactiveThreadDays !== configuredAutoArchiveInactiveThreadDays;
  const archivedThreads = useMemo(
    () => threads.filter((thread) => thread.archivedAt !== null),
    [threads],
  );
  const archivedSearchResults = useMemo(
    () => searchThreads(archivedThreads, projects, archivedThreadQuery),
    [archivedThreadQuery, archivedThreads, projects],
  );
  const archivedGroups = useMemo(() => {
    const groupsByProject = new Map(
      groupByProject(archivedSearchResults, projects).map((group) => [group.project.id, group]),
    );
    return projects.flatMap((project) => {
      const group = groupsByProject.get(project.id);
      return group ? [group] : [];
    });
  }, [archivedSearchResults, projects]);

  return (
    <SidebarInset className="h-full min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Settings
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <header className="space-y-1">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
              <p className="text-sm text-muted-foreground">
                Configure app-level preferences for this device.
              </p>
            </header>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-sm font-medium text-foreground">CLI availability</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Which command-line tools Clui can reach on your PATH.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => serverConfigQuery.refetch()}
                  disabled={serverConfigQuery.isFetching}
                >
                  {serverConfigQuery.isFetching ? "Checking…" : "Refresh"}
                </Button>
              </div>

              {serverConfigQuery.isLoading ? (
                <div className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                  Checking CLI availability…
                </div>
              ) : cliProviderStatuses.length > 0 ? (
                <ul className="space-y-2">
                  {cliProviderStatuses.map((provider) => (
                    <li
                      key={provider.provider}
                      className="flex items-start gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs"
                    >
                      <span
                        className={`mt-0.5 size-1.5 shrink-0 rounded-full ${
                          provider.available ? "bg-emerald-500" : "bg-amber-500"
                        }`}
                        aria-hidden="true"
                      />
                      <span className="flex flex-col">
                        <span className="font-medium text-foreground">
                          {provider.provider === "claudeCode" ? "Claude Code" : "Codex"}
                        </span>
                        <span className="text-muted-foreground">{provider.message}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                  CLI status unavailable.
                </div>
              )}

              <div className="mt-4">
                <h3 className="text-xs font-medium text-foreground">Title generation</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Pick the primary provider for new thread titles. The other is used as fallback.
                </p>
                <div
                  className="mt-2 space-y-2"
                  role="radiogroup"
                  aria-label="Title generation provider"
                >
                  {(
                    [
                      { value: "claudeCode", label: "Claude Code" },
                      { value: "codex", label: "Codex" },
                    ] as const
                  ).map((option) => {
                    const selected =
                      serverConfigQuery.data?.settings.titleGenerationProvider === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={serverConfigQuery.isLoading || isSavingServerSettings}
                        className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                          selected
                            ? "border-primary/60 bg-primary/8 text-foreground"
                            : "border-border bg-background text-muted-foreground hover:bg-accent"
                        }`}
                        onClick={() =>
                          persistServerSettings(
                            {
                              titleGenerationProvider: option.value as TitleGenerationProvider,
                            },
                            "titleGeneration",
                          )
                        }
                      >
                        <span>{option.label}</span>
                        {selected ? (
                          <span className="rounded bg-primary/14 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                            Selected
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
                {serverSettingsError && serverSettingsErrorSource === "titleGeneration" ? (
                  <p className="mt-2 text-xs text-destructive">{serverSettingsError}</p>
                ) : null}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Default coding harness</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose which harness new threads start with by default. You can still change it
                  before the thread is first launched.
                </p>
              </div>

              <div className="space-y-2" role="radiogroup" aria-label="Default coding harness">
                {CODING_HARNESS_OPTIONS.map((option) => {
                  const selected = settings.defaultCodingHarness === option;
                  const copy = CODING_HARNESS_LABELS[option];
                  return (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`flex w-full items-start justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
                        selected
                          ? "border-primary/60 bg-primary/8 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:bg-accent"
                      }`}
                      onClick={() => updateSettings({ defaultCodingHarness: option })}
                    >
                      <span className="flex flex-col">
                        <span className="text-sm font-medium">{copy.label}</span>
                        <span className="text-xs">{copy.description}</span>
                      </span>
                      {selected ? (
                        <span className="rounded bg-primary/14 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                          Selected
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Session hibernation</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Limit how many active thread PTY sessions Clui keeps per harness before it
                  hibernates the least recently used one. Claude Code and pi each use their own cap.
                </p>
              </div>

              <div className="space-y-3">
                <label htmlFor="max-active-harness-sessions" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">
                    Active sessions per harness
                  </span>
                  <div className="flex flex-wrap items-center gap-3">
                    <Input
                      id="max-active-harness-sessions"
                      type="number"
                      min={MIN_ACTIVE_HARNESS_SESSION_CAP}
                      max={MAX_ACTIVE_HARNESS_SESSION_CAP}
                      value={maxActiveHarnessSessionsInput}
                      onChange={(event) => {
                        setMaxActiveHarnessSessionsInput(event.target.value);
                        setServerSettingsError(null);
                        setServerSettingsErrorSource(null);
                      }}
                      className="w-28"
                    />
                    <span className="text-xs text-muted-foreground">
                      {MIN_ACTIVE_HARNESS_SESSION_CAP}–{MAX_ACTIVE_HARNESS_SESSION_CAP} active
                      sessions per harness
                    </span>
                  </div>
                </label>

                <p className="text-xs text-muted-foreground">
                  Current setting: {configuredMaxActiveHarnessSessions}. When a harness goes over
                  the cap, Clui hibernates the oldest active thread and resumes it on demand later.
                </p>

                <div className="rounded-lg border border-border bg-background px-3 py-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <label
                        htmlFor="prevent-macos-sleep-when-thread-in-progress"
                        className="text-xs font-medium text-foreground"
                      >
                        Prevent macOS sleep while a thread is working
                      </label>
                      <p className="text-xs text-muted-foreground">
                        Keeps your Mac awake with <code>caffeinate</code> while Claude Code or pi is
                        actively processing a turn. Sleep is allowed again when the thread
                        completes, exits, hibernates, or waits for input.
                      </p>
                    </div>
                    <Switch
                      id="prevent-macos-sleep-when-thread-in-progress"
                      checked={configuredPreventMacosSleepWhenThreadInProgress}
                      disabled={serverConfigQuery.isLoading || isSavingServerSettings}
                      onCheckedChange={(checked) => {
                        persistServerSettings(
                          {
                            preventMacosSleepWhenThreadInProgress: checked,
                          },
                          "sessionHibernation",
                        );
                      }}
                    />
                  </div>
                </div>

                {serverSettingsError && serverSettingsErrorSource === "sessionHibernation" ? (
                  <p className="text-xs text-destructive">{serverSettingsError}</p>
                ) : null}

                <div className="flex justify-end gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={
                      isSavingServerSettings ||
                      maxActiveHarnessSessionsInput === String(configuredMaxActiveHarnessSessions)
                    }
                    onClick={() => {
                      setMaxActiveHarnessSessionsInput(String(configuredMaxActiveHarnessSessions));
                      setServerSettingsError(null);
                      setServerSettingsErrorSource(null);
                    }}
                  >
                    Reset
                  </Button>
                  <Button
                    size="xs"
                    disabled={
                      isSavingServerSettings ||
                      serverConfigQuery.isLoading ||
                      !hasPendingServerSettingsChange
                    }
                    onClick={saveServerSettings}
                  >
                    {isSavingServerSettings ? "Saving…" : "Save session cap"}
                  </Button>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Chat history</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Keep inactive chats out of the sidebar without deleting their history.
                </p>
              </div>

              <div className="space-y-4">
                <div className="rounded-lg border border-border bg-background px-3 py-3">
                  <div className="space-y-3">
                    <label htmlFor="auto-archive-inactive-days" className="block space-y-1">
                      <span className="text-xs font-medium text-foreground">
                        Auto-archive inactive chats
                      </span>
                      <p className="text-xs text-muted-foreground">
                        Threads are archived when their last server update is older than this many
                        days. Use 0 to disable automatic archiving.
                      </p>
                      <div className="flex flex-wrap items-center gap-3">
                        <Input
                          id="auto-archive-inactive-days"
                          type="number"
                          min={MIN_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS}
                          max={MAX_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS}
                          value={autoArchiveInactiveThreadDaysInput}
                          onChange={(event) => {
                            setAutoArchiveInactiveThreadDaysInput(event.target.value);
                            setServerSettingsError(null);
                            setServerSettingsErrorSource(null);
                          }}
                          className="w-28"
                        />
                        <span className="text-xs text-muted-foreground">
                          {MIN_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS}–
                          {MAX_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS} days
                        </span>
                      </div>
                    </label>

                    <p className="text-xs text-muted-foreground">
                      Current setting:{" "}
                      {configuredAutoArchiveInactiveThreadDays === 0
                        ? "disabled"
                        : `${configuredAutoArchiveInactiveThreadDays} days`}
                      .
                    </p>

                    {serverSettingsError && serverSettingsErrorSource === "chatHistory" ? (
                      <p className="text-xs text-destructive">{serverSettingsError}</p>
                    ) : null}

                    <div className="flex justify-end gap-2">
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={
                          isSavingServerSettings ||
                          autoArchiveInactiveThreadDaysInput ===
                            String(configuredAutoArchiveInactiveThreadDays)
                        }
                        onClick={() => {
                          setAutoArchiveInactiveThreadDaysInput(
                            String(configuredAutoArchiveInactiveThreadDays),
                          );
                          setServerSettingsError(null);
                          setServerSettingsErrorSource(null);
                        }}
                      >
                        Reset
                      </Button>
                      <Button
                        size="xs"
                        disabled={
                          isSavingServerSettings ||
                          serverConfigQuery.isLoading ||
                          !hasPendingAutoArchiveSettingsChange
                        }
                        onClick={saveAutoArchiveSettings}
                      >
                        {isSavingServerSettings ? "Saving…" : "Save auto-archive"}
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border border-border bg-background px-3 py-3">
                  <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-xs font-medium text-foreground">Archived chats</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Archived chats remain searchable and are grouped by their project. Restore a
                        chat to show it in the sidebar again.
                      </p>
                    </div>
                    <span className="rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                      {archivedThreads.length} archived
                    </span>
                  </div>

                  <Input
                    value={archivedThreadQuery}
                    onChange={(event) => setArchivedThreadQuery(event.target.value)}
                    placeholder="Search archived chats..."
                    className="mb-3"
                  />

                  {archivedThreadsError ? (
                    <p className="mb-3 text-xs text-destructive">{archivedThreadsError}</p>
                  ) : null}

                  {archivedSearchResults.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border bg-card/40 px-3 py-6 text-center text-xs text-muted-foreground">
                      {archivedThreads.length === 0
                        ? "No archived chats yet."
                        : "No archived chats match your search."}
                    </div>
                  ) : (
                    <div className="max-h-80 space-y-4 overflow-y-auto pr-1">
                      {archivedGroups.map((group) => (
                        <div key={group.project.id} className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <h4 className="truncate text-xs font-medium text-muted-foreground">
                              {group.project.name}
                            </h4>
                            <span className="text-[11px] text-muted-foreground/70">
                              {group.results.length}
                            </span>
                          </div>
                          <div className="space-y-2">
                            {group.results.map((result) => {
                              const { thread } = result;
                              const isRestoring = restoringArchivedThreadIds.has(thread.id);
                              return (
                                <div
                                  key={thread.id}
                                  className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                                >
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-xs font-medium text-foreground">
                                      {thread.title}
                                    </p>
                                    <p className="mt-1 text-[11px] text-muted-foreground">
                                      Updated {formatRelativeTime(thread.updatedAt)}
                                      {thread.archivedAt
                                        ? ` · Archived ${formatRelativeTime(thread.archivedAt)}`
                                        : ""}
                                      {thread.branch ? ` · ${thread.branch}` : ""}
                                    </p>
                                  </div>
                                  <div className="flex shrink-0 gap-2">
                                    <Button
                                      size="xs"
                                      variant="outline"
                                      onClick={() =>
                                        void navigate({
                                          to: "/$threadId",
                                          params: { threadId: thread.id },
                                        })
                                      }
                                    >
                                      Open
                                    </Button>
                                    <Button
                                      size="xs"
                                      disabled={isRestoring}
                                      onClick={() => restoreArchivedThread(thread.id)}
                                    >
                                      {isRestoring ? "Restoring…" : "Restore"}
                                    </Button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Appearance</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose how Clui handles light and dark mode.
                </p>
              </div>

              <div className="space-y-2" role="radiogroup" aria-label="Theme preference">
                {THEME_OPTIONS.map((option) => {
                  const selected = theme === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`flex w-full items-start justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
                        selected
                          ? "border-primary/60 bg-primary/8 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:bg-accent"
                      }`}
                      onClick={() => setTheme(option.value)}
                    >
                      <span className="flex flex-col">
                        <span className="text-sm font-medium">{option.label}</span>
                        <span className="text-xs">{option.description}</span>
                      </span>
                      {selected ? (
                        <span className="rounded bg-primary/14 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                          Selected
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              <p className="mt-4 text-xs text-muted-foreground">
                Active theme: <span className="font-medium text-foreground">{resolvedTheme}</span>
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                To match Claude Code's output colors, type{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono text-foreground">
                  /theme
                </code>{" "}
                inside a terminal session and select{" "}
                <span className="font-medium">{resolvedTheme}</span>.
              </p>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Models</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Save additional provider model slugs so they appear in the chat model picker and
                  `/model` command suggestions.
                </p>
              </div>

              <div className="space-y-5">
                {MODEL_PROVIDER_SETTINGS.map((providerSettings) => {
                  const provider = providerSettings.provider;
                  const customModels = getCustomModelsForProvider(settings, provider);
                  const customModelInput = customModelInputByProvider[provider];
                  const customModelError = customModelErrorByProvider[provider] ?? null;
                  return (
                    <div
                      key={provider}
                      className="rounded-xl border border-border bg-background/50 p-4"
                    >
                      <div className="mb-4">
                        <h3 className="text-sm font-medium text-foreground">
                          {providerSettings.title}
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {providerSettings.description}
                        </p>
                      </div>

                      <div className="space-y-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                          <label
                            htmlFor={`custom-model-slug-${provider}`}
                            className="block flex-1 space-y-1"
                          >
                            <span className="text-xs font-medium text-foreground">
                              Custom model slug
                            </span>
                            <Input
                              id={`custom-model-slug-${provider}`}
                              value={customModelInput}
                              onChange={(event) => {
                                const value = event.target.value;
                                setCustomModelInputByProvider((existing) => ({
                                  ...existing,
                                  [provider]: value,
                                }));
                                if (customModelError) {
                                  setCustomModelErrorByProvider((existing) => ({
                                    ...existing,
                                    [provider]: null,
                                  }));
                                }
                              }}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter") return;
                                event.preventDefault();
                                addCustomModel(provider);
                              }}
                              placeholder={providerSettings.placeholder}
                              spellCheck={false}
                            />
                            <span className="text-xs text-muted-foreground">
                              Example: <code>{providerSettings.example}</code>
                            </span>
                          </label>

                          <Button
                            className="sm:mt-6"
                            type="button"
                            onClick={() => addCustomModel(provider)}
                          >
                            Add model
                          </Button>
                        </div>

                        {customModelError ? (
                          <p className="text-xs text-destructive">{customModelError}</p>
                        ) : null}

                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                            <p>Saved custom models: {customModels.length}</p>
                            {customModels.length > 0 ? (
                              <Button
                                size="xs"
                                variant="outline"
                                onClick={() =>
                                  updateSettings(
                                    patchCustomModels(provider, [
                                      ...getDefaultCustomModelsForProvider(defaults, provider),
                                    ]),
                                  )
                                }
                              >
                                Reset custom models
                              </Button>
                            ) : null}
                          </div>

                          {customModels.length > 0 ? (
                            <div className="space-y-2">
                              {customModels.map((slug) => (
                                <div
                                  key={`${provider}:${slug}`}
                                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
                                >
                                  <code className="min-w-0 flex-1 truncate text-xs text-foreground">
                                    {slug}
                                  </code>
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={() => removeCustomModel(provider, slug)}
                                  >
                                    Remove
                                  </Button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                              No custom models saved yet.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Terminal</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Configure terminal appearance for Claude sessions.
                </p>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <span className="text-xs font-medium text-foreground">Color theme</span>
                  <div className="space-y-2" role="radiogroup" aria-label="Terminal color theme">
                    {TERMINAL_COLOR_THEME_OPTIONS.map((option) => {
                      const selected =
                        (settings.terminalColorTheme as TerminalColorTheme) === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          className={`flex w-full items-start justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
                            selected
                              ? "border-primary/60 bg-primary/8 text-foreground"
                              : "border-border bg-background text-muted-foreground hover:bg-accent"
                          }`}
                          onClick={() => {
                            updateSettings({ terminalColorTheme: option.value });
                            claudeCache.refreshTheme();
                          }}
                        >
                          <span className="flex flex-col">
                            <span className="text-sm font-medium">{option.label}</span>
                            <span className="text-xs">{option.description}</span>
                          </span>
                          {selected ? (
                            <span className="rounded bg-primary/14 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                              Selected
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <label htmlFor="terminal-font-size" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Font size</span>
                  <div className="flex items-center gap-3">
                    <Input
                      id="terminal-font-size"
                      type="number"
                      min={MIN_TERMINAL_FONT_SIZE}
                      max={MAX_TERMINAL_FONT_SIZE}
                      value={settings.terminalFontSize}
                      onChange={(event) => {
                        const value = Number.parseInt(event.target.value, 10);
                        if (Number.isNaN(value)) return;
                        const clamped = Math.max(
                          MIN_TERMINAL_FONT_SIZE,
                          Math.min(MAX_TERMINAL_FONT_SIZE, value),
                        );
                        updateSettings({ terminalFontSize: clamped });
                        claudeCache.updateFontSettings();
                      }}
                      className="w-24"
                    />
                    <span className="text-xs text-muted-foreground">
                      {MIN_TERMINAL_FONT_SIZE}–{MAX_TERMINAL_FONT_SIZE}px
                    </span>
                  </div>
                </label>

                <label htmlFor="terminal-font-family" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Font family</span>
                  <Input
                    id="terminal-font-family"
                    value={settings.terminalFontFamily}
                    onChange={(event) => {
                      updateSettings({ terminalFontFamily: event.target.value });
                      claudeCache.updateFontSettings();
                    }}
                    placeholder={DEFAULT_TERMINAL_FONT_FAMILY}
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    CSS font-family value. Leave blank for the default monospace font.
                  </span>
                </label>

                <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-foreground">Sticky pi input mirror</p>
                    <p className="text-xs text-muted-foreground">
                      Show the sticky mirrored pi input block while reading scrollback away from the
                      bottom.
                    </p>
                  </div>
                  <Switch
                    checked={settings.stickyPiInputMirror}
                    onCheckedChange={(checked) =>
                      updateSettings({
                        stickyPiInputMirror: Boolean(checked),
                      })
                    }
                    aria-label="Sticky pi input mirror"
                  />
                </div>

                {settings.terminalFontSize !== defaults.terminalFontSize ||
                settings.terminalFontFamily !== defaults.terminalFontFamily ||
                settings.terminalColorTheme !== defaults.terminalColorTheme ||
                settings.stickyPiInputMirror !== defaults.stickyPiInputMirror ? (
                  <div className="flex justify-end">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        updateSettings({
                          terminalFontSize: defaults.terminalFontSize,
                          terminalFontFamily: defaults.terminalFontFamily,
                          terminalColorTheme: defaults.terminalColorTheme,
                          stickyPiInputMirror: defaults.stickyPiInputMirror,
                        });
                        claudeCache.updateFontSettings();
                        claudeCache.refreshTheme();
                      }}
                    >
                      Reset terminal defaults
                    </Button>
                  </div>
                ) : null}
              </div>
            </section>

            <section id="speech-to-text" className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Speech-to-Text</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Transcribe voice input using a local Whisper model. Shortcut:{" "}
                  <span className="inline-flex items-center gap-0.5">
                    <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                      ⌘
                    </kbd>
                    <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                      ⇧
                    </kbd>
                    <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                      V
                    </kbd>
                  </span>
                </p>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <span className="text-xs font-medium text-foreground">Model tier</span>
                  <div className="space-y-2" role="radiogroup" aria-label="Whisper model tier">
                    {WHISPER_MODEL_TIERS.map((tier) => {
                      const selected = (settings.whisperModel as WhisperModelTier) === tier.id;
                      return (
                        <button
                          key={tier.id}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
                            selected
                              ? "border-primary/60 bg-primary/8 text-foreground"
                              : "border-border bg-background text-muted-foreground hover:bg-accent"
                          }`}
                          onClick={() => {
                            updateSettings({ whisperModel: tier.id });
                            setWhisperModelReady(whisperManager.isModelReady(tier.id));
                            setWhisperDownloadProgress(null);
                          }}
                        >
                          <span className="flex flex-col">
                            <span className="text-sm font-medium">{tier.label}</span>
                            <span className="text-xs">{tier.size}</span>
                          </span>
                          {selected ? (
                            <span className="rounded bg-primary/14 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                              Selected
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={whisperModelReady || whisperDownloadProgress !== null}
                    onClick={handleDownloadModel}
                  >
                    {whisperDownloadProgress !== null
                      ? `Downloading… ${whisperDownloadProgress}%`
                      : whisperModelReady
                        ? "Ready ✓"
                        : "Download Model"}
                  </Button>
                  {!whisperModelReady && whisperDownloadProgress === null && (
                    <span className="text-xs text-muted-foreground">
                      Model is not downloaded yet. Click to download.
                    </span>
                  )}
                  {whisperModelReady && (
                    <span className="text-xs text-muted-foreground">Model is ready for use.</span>
                  )}
                </div>

                <label htmlFor="whisper-language" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Language</span>
                  <select
                    id="whisper-language"
                    value={settings.whisperLanguage}
                    onChange={(event) => updateSettings({ whisperLanguage: event.target.value })}
                    className="block w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  >
                    <option value="auto">Auto-detect</option>
                    <option value="en">English</option>
                    <option value="es">Spanish</option>
                    <option value="fr">French</option>
                    <option value="de">German</option>
                    <option value="ja">Japanese</option>
                    <option value="zh">Chinese</option>
                    <option value="ko">Korean</option>
                  </select>
                </label>

                <label htmlFor="voice-prefix" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Voice prefix</span>
                  <p className="text-[11px] text-muted-foreground">
                    Text prepended to every voice transcription before sending. Leave empty for
                    none.
                  </p>
                  <input
                    id="voice-prefix"
                    type="text"
                    value={settings.voicePrefix ?? ""}
                    onChange={(event) => updateSettings({ voicePrefix: event.target.value })}
                    placeholder="e.g. ultrathink"
                    className="block w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </label>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Keybindings</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Open the persisted <code>keybindings.json</code> file to edit advanced bindings
                  directly.
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground">Config file path</p>
                    <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                      {keybindingsConfigPath ?? "Resolving keybindings path..."}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!keybindingsConfigPath || isOpeningKeybindings}
                    onClick={openKeybindingsFile}
                  >
                    {isOpeningKeybindings ? "Opening..." : "Open keybindings.json"}
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  Opens in your preferred editor selection.
                </p>
                {openKeybindingsError ? (
                  <p className="text-xs text-destructive">{openKeybindingsError}</p>
                ) : null}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Safety</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Additional guardrails for destructive local actions.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Confirm thread deletion</p>
                  <p className="text-xs text-muted-foreground">
                    Ask for confirmation before deleting a thread and its chat history.
                  </p>
                </div>
                <Switch
                  checked={settings.confirmThreadDelete}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      confirmThreadDelete: Boolean(checked),
                    })
                  }
                  aria-label="Confirm thread deletion"
                />
              </div>

              {settings.confirmThreadDelete !== defaults.confirmThreadDelete ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        confirmThreadDelete: defaults.confirmThreadDelete,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </section>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  component: SettingsRouteView,
});
