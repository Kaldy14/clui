import type {
  PiCommandSuggestion,
  PiExtensionUiState,
  PiExtensionUiWidget,
  PiSessionUsageStats,
  PiTranscriptItem,
  PiTranscriptPart,
  ThreadId,
} from "@clui/contracts";
import { AGENT_ACTIVITY_LABELS } from "@clui/shared/agentActivity";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ITheme } from "@xterm/xterm";
import type { Components } from "react-markdown";
import type {
  CSSProperties,
  ClipboardEvent as ReactClipboardEvent,
  Dispatch,
  FormEvent as ReactFormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  SetStateAction,
  WheelEvent as ReactWheelEvent,
} from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { useAppSettings } from "../appSettings";
import { clipboardImageFiles, readFileAsDataUrl } from "../lib/clipboard";
import { registerHarnessOutputSubscription } from "../lib/harnessOutputSubscriptions";
import { addPiHtmlComposerInsertListener, dispatchPiHtmlComposerInsert } from "../lib/piHtmlComposerEvents";
import { TERMINAL_LINE_HEIGHT } from "../lib/terminalSurfaceTheme";
import { terminalThemeFromApp } from "../lib/terminalTheme";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";

const TRANSCRIPT_REFRESH_DELAY_MS = 120;
const MAX_SUGGESTIONS = 9;
const PI_HTML_COMPOSER_MAX_ROWS = 6;
const PI_HTML_BUSY_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const PI_HTML_TRANSCRIPT_OVERSCAN = 10;
const PI_HTML_SCROLL_END_THRESHOLD_PX = 80;
const PI_HTML_ESTIMATED_MAX_ROW_LINES = 24;
const CLUI_RPC_QUESTIONNAIRE_PREFIX = "__clui_rpc_questionnaire_v1__:";
const CLUI_RPC_PLAN_REVIEW_PREFIX = "__clui_rpc_plan_review_v1__:";

const PI_HTML_BUILTIN_COMMANDS: readonly PiCommandSuggestion[] = [
  { name: "compact", description: "Compact context", source: "builtin" },
];

const PI_DARK_COLORS = {
  accent: "#8abeb7",
  border: "#5f87ff",
  borderAccent: "#00d7ff",
  borderMuted: "#505050",
  success: "#b5bd68",
  error: "#cc6666",
  warning: "#ffff00",
  muted: "#808080",
  dim: "#666666",
  text: "#d4d4d4",
  selectedBg: "#3a3a4a",
  userMessageBg: "#343541",
  toolPendingBg: "#282832",
  toolSuccessBg: "#283228",
  toolErrorBg: "#3c2828",
  customMessageBg: "#2d2838",
  customMessageLabel: "#9575cd",
  compactionBg: "#3a2536",
  compactionBorder: "#d183e8",
  compactionLabel: "#ff79c6",
  mdCode: "#8abeb7",
  mdCodeBlock: "#b5bd68",
  mdHeading: "#f0c674",
  mdLink: "#81a2be",
  thinkingOff: "#505050",
  thinkingMinimal: "#6e6e6e",
  thinkingLow: "#5f87af",
  thinkingMedium: "#81a2be",
  thinkingHigh: "#b294bb",
  thinkingXhigh: "#d183e8",
} as const;

const PI_LIGHT_COLORS = {
  accent: "#5a8080",
  border: "#547da7",
  borderAccent: "#5a8080",
  borderMuted: "#b0b0b0",
  success: "#588458",
  error: "#aa5555",
  warning: "#9a7326",
  muted: "#6c6c6c",
  dim: "#767676",
  text: "#1f2328",
  selectedBg: "#d0d0e0",
  userMessageBg: "#e8e8e8",
  toolPendingBg: "#e8e8f0",
  toolSuccessBg: "#e8f0e8",
  toolErrorBg: "#f0e8e8",
  customMessageBg: "#ede7f6",
  customMessageLabel: "#7e57c2",
  compactionBg: "#fce7f3",
  compactionBorder: "#db2777",
  compactionLabel: "#be185d",
  mdCode: "#5a8080",
  mdCodeBlock: "#588458",
  mdHeading: "#9a7326",
  mdLink: "#547da7",
  thinkingOff: "#b0b0b0",
  thinkingMinimal: "#767676",
  thinkingLow: "#547da7",
  thinkingMedium: "#5a8080",
  thinkingHigh: "#875f87",
  thinkingXhigh: "#8b008b",
} as const;

type PiHtmlColors = { readonly [Key in keyof typeof PI_DARK_COLORS]: string };
type PiHtmlTheme = PiHtmlColors & { terminal: ITheme };

type LoadState = "idle" | "loading" | "ready" | "error";
type DisplayTranscriptItem = PiTranscriptItem & { readonly mergedToolOutput?: string };
type LiveTranscriptItem = PiTranscriptItem & { readonly live: true; readonly pending?: boolean };
type GenericExtensionUiRequest = {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
};
type QuestionOption = { value: string; label: string; description?: string };
type QuestionnaireQuestion = {
  id: string;
  label: string;
  prompt: string;
  context?: string;
  options: QuestionOption[];
  allowOther: boolean;
};
type QuestionnaireAnswer = {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
  note?: string;
};
type LineNote = { lineNumber: number; lineText: string; note: string };
type ExtensionUiRequest =
  | GenericExtensionUiRequest
  | { id: string; method: "questionnaire"; questions: QuestionnaireQuestion[] }
  | { id: string; method: "planReview"; title: string; plan: string };
type EditorTextRequest = { text: string; nonce: number };
type Suggestion =
  | { type: "command"; value: string; label: string; description?: string }
  | { type: "file"; value: string; label: string; description?: string };
type PiModelOption = { provider: string; id: string; label: string };
type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | string;
type PendingPromptPreview = { id: number; text: string; transcriptBaselineCount: number };
type PiLocalNotice = { id: number; text: string; isError: boolean; createdAt: string };
type PiVirtualTranscriptRow =
  | { readonly type: "item"; readonly key: string; readonly item: DisplayTranscriptItem; readonly itemIndex: number }
  | { readonly type: "thinking"; readonly key: string }
  | { readonly type: "error"; readonly key: string; readonly text: string };

interface PiHtmlThreadViewProps {
  threadId: ThreadId;
  showComposer?: boolean;
  footer?: ReactNode;
}

function piHtmlThemeFromApp(baseTheme: ITheme): PiHtmlTheme {
  const piColors = document.documentElement.classList.contains("dark") ? PI_DARK_COLORS : PI_LIGHT_COLORS;
  return {
    ...piColors,
    terminal: {
      ...baseTheme,
      foreground: piColors.text,
      cursor: piColors.text,
      black: piColors.dim,
      brightBlack: piColors.muted,
      red: piColors.error,
      green: piColors.success,
      yellow: piColors.warning,
      blue: piColors.border,
      cyan: piColors.borderAccent,
      magenta: piColors.thinkingHigh,
      white: piColors.text,
      brightWhite: piColors.text,
      selectionBackground: piColors.selectedBg,
      selectionForeground: piColors.text,
    },
  };
}

function appendUniqueItems(current: PiTranscriptItem[], next: readonly PiTranscriptItem[]): PiTranscriptItem[] {
  if (next.length === 0) return current;
  const seen = new Set(current.map((item) => item.id));
  let changed = false;
  const merged = [...current];
  for (const item of next) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
    changed = true;
  }
  return changed ? merged : current;
}

function mergeToolResultsForDisplay(items: readonly PiTranscriptItem[]): DisplayTranscriptItem[] {
  const merged: DisplayTranscriptItem[] = [];
  const toolIndexById = new Map<string, number>();
  for (const item of items) {
    if (item.role === "toolResult") {
      let targetIndex = item.toolCallId ? toolIndexById.get(item.toolCallId) : undefined;
      if (targetIndex === undefined && item.toolName) {
        const resultToolName = normalizedToolName(item.toolName);
        targetIndex = merged.findLastIndex((candidate) =>
          candidate.parts.some(
            (part) => part.type === "toolCall" && normalizedToolName(part.name) === resultToolName,
          ),
        );
        if (targetIndex < 0) targetIndex = undefined;
      }
      if (targetIndex !== undefined) {
        const target = merged[targetIndex];
        if (target) {
          merged[targetIndex] = {
            ...target,
            mergedToolOutput: target.mergedToolOutput
              ? `${target.mergedToolOutput}\n${item.text}`
              : item.text,
            ...(item.isError === true ? { isError: true } : {}),
          };
          continue;
        }
      }
    }

    const outputIndex = merged.length;
    merged.push(item);
    for (const part of item.parts) {
      if (part.type === "toolCall" && part.id) {
        toolIndexById.set(part.id, outputIndex);
      }
    }
  }
  return merged;
}

function usePiTranscript(threadId: ThreadId) {
  const [items, setItems] = useState<PiTranscriptItem[]>([]);
  const [liveItems, setLiveItems] = useState<LiveTranscriptItem[]>([]);
  const [uiRequest, setUiRequest] = useState<ExtensionUiRequest | null>(null);
  const [extensionUiState, setExtensionUiState] = useState<PiExtensionUiState>({ statuses: {}, widgets: [] });
  const [editorTextRequest, setEditorTextRequest] = useState<EditorTextRequest | null>(null);
  const [usageStats, setUsageStats] = useState<PiSessionUsageStats | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const offsetRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);
  const refreshTimerRef = useRef<number | null>(null);

  const load = useCallback(
    async (mode: "reset" | "append") => {
      const api = readNativeApi();
      if (!api) return;
      if (inFlightRef.current) {
        pendingRef.current = true;
        return;
      }

      inFlightRef.current = true;
      setLoadState((previous) => (previous === "ready" ? previous : "loading"));
      setError(null);

      try {
        const sinceOffset = mode === "append" ? offsetRef.current : null;
        const result = await api.pi.getTranscript({
          threadId,
          ...(sinceOffset != null ? { sinceOffset } : {}),
        });
        offsetRef.current = result.offset;
        setItems((current) =>
          mode === "reset" || result.reset
            ? [...result.items]
            : appendUniqueItems(current, result.items),
        );
        setUiRequest(
          result.pendingExtensionUiRequest
            ? extensionUiRequestFromRpcEvent(result.pendingExtensionUiRequest)
            : null,
        );
        setExtensionUiState(result.extensionUiState);
        setUsageStats(result.usageStats);
        setLoadState("ready");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load transcript.");
        setLoadState("error");
      } finally {
        inFlightRef.current = false;
        if (pendingRef.current) {
          pendingRef.current = false;
          void load("append");
        }
      }
    },
    [threadId],
  );

  const scheduleAppend = useCallback(() => {
    if (refreshTimerRef.current !== null) return;
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void load("append");
    }, TRANSCRIPT_REFRESH_DELAY_MS);
  }, [load]);

  useEffect(() => {
    offsetRef.current = null;
    pendingRef.current = false;
    setItems([]);
    setLiveItems([]);
    setUiRequest(null);
    setExtensionUiState({ statuses: {}, widgets: [] });
    setEditorTextRequest(null);
    setUsageStats(null);
    void load("reset");
  }, [load]);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    const outputSubscription = registerHarnessOutputSubscription(api, "pi", threadId);
    return () => outputSubscription.unsubscribe();
  }, [threadId]);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    return api.pi.onSessionEvent((event) => {
      if (event.threadId !== threadId) return;
      if (event.type === "sessionFile") {
        offsetRef.current = null;
        setItems([]);
        setLiveItems([]);
        setUiRequest(null);
        setExtensionUiState({ statuses: {}, widgets: [] });
        setEditorTextRequest(null);
        setUsageStats(null);
        void load("reset");
        return;
      }
      if (event.type === "rpcEvent") {
        const extensionUiRequest = extensionUiRequestFromRpcEvent(event.event);
        if (extensionUiRequest) {
          setUiRequest(extensionUiRequest);
          return;
        }
        const handledExtensionUi = applyExtensionUiRequest(setExtensionUiState, event.event, (text) => {
          setEditorTextRequest({ text, nonce: Date.now() });
        });
        if (handledExtensionUi) return;
        const liveItem = liveItemFromRpcEvent(event.event, event.createdAt);
        if (liveItem) setLiveItems((current) => mergeLiveItem(current, liveItem));
        scheduleAppend();
        return;
      }
      if (event.type === "error") {
        const liveItem = liveNoticeItem({ id: `session-error:${event.createdAt}:${event.message}`, text: event.message, createdAt: event.createdAt, isError: true });
        if (liveItem) setLiveItems((current) => mergeLiveItem(current, liveItem));
        return;
      }
      if (event.type === "exited" && event.exitCode !== null && event.exitCode !== 0) {
        const liveItem = liveNoticeItem({ id: `session-exited:${event.createdAt}:${event.exitCode}`, text: `Pi exited with code ${event.exitCode}.`, createdAt: event.createdAt, isError: true });
        if (liveItem) setLiveItems((current) => mergeLiveItem(current, liveItem));
        return;
      }
      if (
        event.type === "output" ||
        event.type === "hookStatus" ||
        event.type === "activityStatus" ||
        event.type === "started" ||
        event.type === "hibernated" ||
        event.type === "exited"
      ) {
        scheduleAppend();
      }
    });
  }, [load, scheduleAppend, threadId]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, []);

  const clearUiRequest = useCallback((id: string) => {
    setUiRequest((current) => (current?.id === id ? null : current));
  }, []);

  return { items, liveItems, uiRequest, extensionUiState, editorTextRequest, usageStats, clearUiRequest, loadState, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelOptionFromUnknown(value: unknown): PiModelOption | null {
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.id !== "string") return null;
  return { provider: value.provider, id: value.id, label: `${value.provider}/${value.id}` };
}

function normalizeThinkingLevel(level: string): PiThinkingLevel | null {
  const normalized = level.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function thinkingLevelFromState(value: unknown): PiThinkingLevel | null {
  if (!isRecord(value) || typeof value.thinkingLevel !== "string") return null;
  return normalizeThinkingLevel(value.thinkingLevel);
}

function formatThinkingLevel(level: PiThinkingLevel | null): string | null {
  if (!level) return null;
  return `think ${level}`;
}

function thinkingBorderColor(level: PiThinkingLevel | null, piTheme: PiHtmlTheme): string {
  switch (level) {
    case "minimal":
      return piTheme.thinkingMinimal;
    case "low":
      return piTheme.thinkingLow;
    case "medium":
    case "normal":
      return piTheme.thinkingMedium;
    case "high":
      return piTheme.thinkingHigh;
    case "xhigh":
    case "ultrathink":
      return piTheme.thinkingXhigh;
    case "off":
    default:
      return piTheme.thinkingOff;
  }
}

function stringifyInput(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function decodeBase64UrlJson(value: string): unknown | null {
  try {
    const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
    const binary = window.atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function encodeBase64UrlJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function decodePrefixedPayload(title: string, prefix: string): unknown | null {
  if (!title.startsWith(prefix)) return null;
  return decodeBase64UrlJson(title.slice(prefix.length));
}

function normalizeQuestion(rawQuestion: unknown, index: number): QuestionnaireQuestion | null {
  if (!isRecord(rawQuestion)) return null;
  if (typeof rawQuestion.id !== "string" || typeof rawQuestion.prompt !== "string") return null;
  const options = Array.isArray(rawQuestion.options)
    ? rawQuestion.options.flatMap((rawOption): QuestionOption[] => {
        if (!isRecord(rawOption) || typeof rawOption.value !== "string" || typeof rawOption.label !== "string") return [];
        return [{ value: rawOption.value, label: rawOption.label, ...(typeof rawOption.description === "string" ? { description: rawOption.description } : {}) }];
      })
    : [];
  return {
    id: rawQuestion.id,
    label: typeof rawQuestion.label === "string" && rawQuestion.label.trim() ? rawQuestion.label : `Q${index + 1}`,
    prompt: rawQuestion.prompt,
    ...(typeof rawQuestion.context === "string" ? { context: rawQuestion.context } : {}),
    options,
    allowOther: rawQuestion.allowOther !== false,
  };
}

function questionnaireRequestFromTitle(id: string, title: string): ExtensionUiRequest | null {
  const payload = decodePrefixedPayload(title, CLUI_RPC_QUESTIONNAIRE_PREFIX);
  if (!isRecord(payload) || !Array.isArray(payload.questions)) return null;
  const questions = payload.questions.flatMap((question, index) => {
    const normalized = normalizeQuestion(question, index);
    return normalized ? [normalized] : [];
  });
  return questions.length > 0 ? { id, method: "questionnaire", questions } : null;
}

function planReviewRequestFromTitle(id: string, title: string): ExtensionUiRequest | null {
  const payload = decodePrefixedPayload(title, CLUI_RPC_PLAN_REVIEW_PREFIX);
  if (!isRecord(payload) || typeof payload.plan !== "string") return null;
  return {
    id,
    method: "planReview",
    title: typeof payload.title === "string" && payload.title.trim() ? payload.title : "Plan",
    plan: payload.plan,
  };
}

function extensionUiRequestFromRpcEvent(event: unknown): ExtensionUiRequest | null {
  if (!isRecord(event) || event.type !== "extension_ui_request") return null;
  const method = event.method;
  if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") return null;
  if (typeof event.id !== "string" || event.id.length === 0) return null;
  if (method === "select" && typeof event.title === "string") {
    const questionnaire = questionnaireRequestFromTitle(event.id, event.title);
    if (questionnaire) return questionnaire;
    const planReview = planReviewRequestFromTitle(event.id, event.title);
    if (planReview) return planReview;
  }
  return {
    id: event.id,
    method,
    ...(typeof event.title === "string" ? { title: event.title } : {}),
    ...(typeof event.message === "string" ? { message: event.message } : {}),
    ...(Array.isArray(event.options) ? { options: event.options.filter((option): option is string => typeof option === "string") } : {}),
    ...(typeof event.placeholder === "string" ? { placeholder: event.placeholder } : {}),
    ...(typeof event.prefill === "string" ? { prefill: event.prefill } : {}),
  };
}

function extensionWidgetPlacement(value: unknown): PiExtensionUiWidget["placement"] {
  return value === "belowEditor" ? "belowEditor" : "aboveEditor";
}

function applyExtensionUiRequest(
  setExtensionUiState: Dispatch<SetStateAction<PiExtensionUiState>>,
  event: unknown,
  setEditorText?: (text: string) => void,
): boolean {
  if (!isRecord(event) || event.type !== "extension_ui_request") return false;

  if (event.method === "setStatus") {
    if (typeof event.statusKey !== "string" || event.statusKey.length === 0) return true;
    const key = event.statusKey;
    const statusText = typeof event.statusText === "string" ? event.statusText : null;
    setExtensionUiState((current) => {
      const statuses = { ...current.statuses };
      if (statusText !== null) {
        statuses[key] = statusText;
      } else {
        delete statuses[key];
      }
      return { ...current, statuses };
    });
    return true;
  }

  if (event.method === "setWidget") {
    if (typeof event.widgetKey !== "string" || event.widgetKey.length === 0) return true;
    const key = event.widgetKey;
    const lines = Array.isArray(event.widgetLines)
      ? event.widgetLines.filter((line): line is string => typeof line === "string")
      : null;
    const placement = extensionWidgetPlacement(event.widgetPlacement);
    setExtensionUiState((current) => {
      const widgets = current.widgets.filter((widget) => widget.key !== key);
      if (lines) widgets.push({ key, lines, placement });
      return { ...current, widgets };
    });
    return true;
  }

  if (event.method === "set_editor_text") {
    if (typeof event.text === "string") setEditorText?.(event.text);
    return true;
  }

  return event.method === "notify" || event.method === "setTitle";
}

const TERMINAL_CONTROL_SEQUENCE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/gu;

function cleanTranscriptText(text: string): string {
  return text.replace(TERMINAL_CONTROL_SEQUENCE_PATTERN, "");
}

const ANSI_COLOR_MAP: Record<number, string> = {
  30: "#1d1f21",
  31: "#cc6666",
  32: "#b5bd68",
  33: "#f0c674",
  34: "#81a2be",
  35: "#b294bb",
  36: "#8abeb7",
  37: "#d4d4d4",
  90: "#666666",
  91: "#cc6666",
  92: "#b5bd68",
  93: "#ffff00",
  94: "#5f87ff",
  95: "#b294bb",
  96: "#00d7ff",
  97: "#ffffff",
};

function ansi256Color(index: number): string | null {
  if (index >= 0 && index <= 15) {
    const base = [30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97][index];
    return base !== undefined ? ANSI_COLOR_MAP[base] ?? null : null;
  }
  if (index >= 16 && index <= 231) {
    const value = index - 16;
    const r = Math.floor(value / 36);
    const g = Math.floor((value % 36) / 6);
    const b = value % 6;
    const channel = (part: number) => (part === 0 ? 0 : 55 + part * 40);
    return `rgb(${channel(r)}, ${channel(g)}, ${channel(b)})`;
  }
  if (index >= 232 && index <= 255) {
    const gray = 8 + (index - 232) * 10;
    return `rgb(${gray}, ${gray}, ${gray})`;
  }
  return null;
}

function renderAnsiText(text: string, defaultColor: string, keyPrefix: string): ReactNode {
  const nodes: ReactNode[] = [];
  const sgrPattern = /\x1B\[([0-9;]*)m/gu;
  let color = defaultColor;
  let fontWeight: CSSProperties["fontWeight"] = undefined;
  let opacity: CSSProperties["opacity"] = undefined;
  let cursor = 0;
  let partIndex = 0;

  const pushText = (value: string) => {
    if (!value) return;
    nodes.push(
      <span key={`${keyPrefix}:${partIndex++}`} style={{ color, fontWeight, opacity }}>
        {value}
      </span>,
    );
  };

  for (const match of text.matchAll(sgrPattern)) {
    pushText(text.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const codes = (match[1] || "0").split(";").map((code) => Number.parseInt(code, 10));
    for (let index = 0; index < codes.length; index += 1) {
      const code = Number.isFinite(codes[index]) ? codes[index]! : 0;
      if (code === 0) {
        color = defaultColor;
        fontWeight = undefined;
        opacity = undefined;
      } else if (code === 1) {
        fontWeight = 700;
      } else if (code === 2) {
        opacity = 0.72;
      } else if (code === 22) {
        fontWeight = undefined;
        opacity = undefined;
      } else if (code === 39) {
        color = defaultColor;
      } else if (ANSI_COLOR_MAP[code]) {
        color = ANSI_COLOR_MAP[code];
      } else if (code === 38 && codes[index + 1] === 2) {
        const red = codes[index + 2];
        const green = codes[index + 3];
        const blue = codes[index + 4];
        if (red !== undefined && green !== undefined && blue !== undefined) {
          color = `rgb(${red}, ${green}, ${blue})`;
          index += 4;
        }
      } else if (code === 38 && codes[index + 1] === 5) {
        const nextColor = ansi256Color(codes[index + 2] ?? -1);
        if (nextColor) color = nextColor;
        index += 2;
      }
    }
  }

  pushText(text.slice(cursor).replace(TERMINAL_CONTROL_SEQUENCE_PATTERN, ""));
  return nodes;
}

function normalizedToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function firstStringField(record: Record<string, unknown>, fields: readonly string[]): string | null {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function formatToolCall(name: string, input: unknown): string {
  const normalized = normalizedToolName(name);
  const record = isRecord(input) ? input : null;
  if (record) {
    if (normalized === "bash") {
      const command = firstStringField(record, ["command", "cmd"]);
      return command ? `$ ${command}` : "$ bash";
    }
    if (normalized === "read") {
      const filePath = firstStringField(record, ["path", "file", "filePath"]);
      return filePath ? `read ${filePath}` : "read";
    }
    if (normalized === "write" || normalized === "edit") {
      const filePath = firstStringField(record, ["path", "file", "filePath"]);
      return filePath ? `${name} ${filePath}` : name;
    }
    if (normalized === "questionnaire") {
      const questions = Array.isArray(record.questions) ? record.questions : [];
      const prompts = questions.flatMap((question) => {
        if (!isRecord(question)) return [];
        return typeof question.prompt === "string" ? [question.prompt.trim()] : [];
      });
      return prompts.length > 0 ? `? ${prompts.join(" / ")}` : "? questionnaire";
    }
    if (normalized === "decisiongate") {
      const question = firstStringField(record, ["question"]);
      return question ? `? ${question}` : "? decision_gate";
    }
    if (normalized === "planreview") {
      const title = firstStringField(record, ["title"]);
      return title ? `? plan_review ${title}` : "? plan_review";
    }
  }
  return input === undefined || input === null ? name : `${name} ${compactJson(input)}`;
}

function renderPartText(part: PiTranscriptPart): string {
  switch (part.type) {
    case "text":
      return cleanTranscriptText(part.text);
    case "thinking":
      return cleanTranscriptText(part.text);
    case "toolCall":
      return formatToolCall(part.name, part.input);
    case "image":
      return part.mimeType ? `[image: ${part.mimeType}]` : "[image]";
  }
}

function itemText(item: PiTranscriptItem): string {
  const text = item.parts.map(renderPartText).filter(Boolean).join("\n");
  return text || item.text;
}

function rpcContentParts(content: unknown): PiTranscriptPart[] {
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];

  const parts: PiTranscriptPart[] = [];
  for (const rawPart of content) {
    if (!isRecord(rawPart)) continue;
    if (rawPart.type === "text" && typeof rawPart.text === "string") {
      parts.push({ type: "text", text: rawPart.text });
      continue;
    }
    if (rawPart.type === "thinking") {
      const text = typeof rawPart.thinking === "string" ? rawPart.thinking : rawPart.text;
      if (typeof text === "string") parts.push({ type: "thinking", text });
      continue;
    }
    if (rawPart.type === "toolCall") {
      const name = typeof rawPart.name === "string" && rawPart.name.length > 0 ? rawPart.name : "tool";
      parts.push({
        type: "toolCall",
        name,
        input: rawPart.arguments ?? rawPart.input ?? {},
        ...(typeof rawPart.id === "string" ? { id: rawPart.id } : {}),
      });
      continue;
    }
    if (rawPart.type === "image") {
      const mimeType =
        typeof rawPart.mimeType === "string"
          ? rawPart.mimeType
          : typeof rawPart.mediaType === "string"
            ? rawPart.mediaType
            : null;
      parts.push({ type: "image", mimeType });
    }
  }
  return parts;
}

function liveNoticeItem(input: { id: string; text: string; createdAt?: string | null; isError?: boolean }): LiveTranscriptItem | null {
  const text = input.text.trim();
  if (!text) return null;
  return {
    id: input.id,
    role: "system",
    text,
    parts: [{ type: "text", text }],
    createdAt: input.createdAt ?? null,
    live: true,
    ...(input.isError === true ? { isError: true } : {}),
  };
}

function liveCompactionSummaryItem(event: Record<string, unknown>, createdAt?: string): LiveTranscriptItem | null {
  if (event.type !== "compaction_end" || event.aborted === true || !isRecord(event.result)) return null;
  const summary = typeof event.result.summary === "string" ? stripTrailingReadFilesSection(event.result.summary) : "";
  if (!summary.trim()) return null;
  return {
    id: `rpc-compaction:${createdAt ?? ""}:${summary}`,
    role: "summary",
    text: summary,
    parts: [{ type: "text", text: summary }],
    createdAt: createdAt ?? null,
    summaryKind: "compaction",
    live: true,
  };
}

function rpcErrorEventText(event: Record<string, unknown>): string | null {
  switch (event.type) {
    case "stderr":
      return firstStringField(event, ["text", "data", "message"]);
    case "extension_error": {
      const message = firstStringField(event, ["error", "message", "errorMessage"]);
      const source = firstStringField(event, ["extensionPath", "extension", "event"]);
      return message ? `${source ? `${source}: ` : ""}${message}` : null;
    }
    case "compaction_end": {
      const message = firstStringField(event, ["errorMessage", "error", "message"]);
      if (message) return `Compaction failed: ${message}`;
      return event.aborted === true ? "Compaction cancelled." : null;
    }
    case "auto_retry_start": {
      const message = firstStringField(event, ["errorMessage", "error", "message"]);
      return message ? `Error: ${message} Retrying…` : null;
    }
    case "auto_retry_end": {
      if (event.success !== false) return null;
      const message = firstStringField(event, ["finalError", "errorMessage", "error", "message"]);
      return message ? `Retry failed: ${message}` : "Retry failed.";
    }
    default:
      return null;
  }
}

function liveItemFromRpcMessage(event: Record<string, unknown>): LiveTranscriptItem | null {
  const message = event.message;
  if (!isRecord(message)) return null;
  const role = message.role;
  if (role !== "assistant" && role !== "user" && role !== "toolResult") return null;

  const parts = rpcContentParts(message.content);
  const text = parts.map(renderPartText).filter(Boolean).join("\n");
  if (!text.trim()) return null;

  const idSuffix = typeof message.id === "string" && message.id.length > 0 ? message.id : String(role);
  const hasToolCall = parts.some((part) => part.type === "toolCall");
  return {
    id: `rpc-message:${idSuffix}`,
    role,
    text,
    parts,
    createdAt: null,
    live: true,
    ...(hasToolCall ? { pending: true } : {}),
    ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
    ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
    ...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
  };
}

function liveItemFromRpcToolExecution(event: Record<string, unknown>): LiveTranscriptItem | null {
  const toolName = typeof event.toolName === "string" && event.toolName.length > 0 ? event.toolName : "tool";
  const toolCallId = typeof event.toolCallId === "string" && event.toolCallId.length > 0 ? event.toolCallId : toolName;
  const result = isRecord(event.partialResult) ? event.partialResult : isRecord(event.result) ? event.result : null;
  const resultParts = result ? rpcContentParts(result.content) : [];
  const toolCallPart: PiTranscriptPart = {
    type: "toolCall",
    name: toolName,
    input: event.args ?? {},
    id: toolCallId,
  };
  const parts: PiTranscriptPart[] = resultParts.length > 0 ? [toolCallPart, ...resultParts] : [toolCallPart];
  const text = parts.map(renderPartText).filter(Boolean).join("\n");
  return {
    id: `rpc-tool:${toolCallId}`,
    role: "toolResult",
    text,
    parts,
    createdAt: null,
    live: true,
    pending: event.type !== "tool_execution_end",
    toolName,
    toolCallId,
    ...(event.isError === true ? { isError: true } : {}),
  };
}

function liveItemFromRpcEvent(event: unknown, createdAt?: string): LiveTranscriptItem | null {
  if (!isRecord(event)) return null;
  const errorText = rpcErrorEventText(event);
  if (errorText) return liveNoticeItem({ id: `rpc-error:${createdAt ?? ""}:${event.type}:${errorText}`, text: errorText, createdAt: createdAt ?? null, isError: true });
  const compactionSummary = liveCompactionSummaryItem(event, createdAt);
  if (compactionSummary) return compactionSummary;
  switch (event.type) {
    case "message_start":
    case "message_update":
    case "message_end":
      return liveItemFromRpcMessage(event);
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return liveItemFromRpcToolExecution(event);
    default:
      return null;
  }
}

function mergeLiveItem(current: LiveTranscriptItem[], item: LiveTranscriptItem): LiveTranscriptItem[] {
  const next = current.filter((existing) => existing.id !== item.id);
  return [...next, item];
}

function transcriptSignature(item: PiTranscriptItem): string {
  if (item.role === "toolResult" && item.toolCallId) return `toolResult\u0000${item.toolCallId}`;
  return `${item.role}\u0000${itemText(item).trim()}`;
}

function themeText(theme: ITheme): string {
  return theme.foreground ?? "currentColor";
}

function themeMuted(theme: ITheme): string {
  return theme.brightBlack ?? theme.white ?? theme.foreground ?? "currentColor";
}

function themeDim(theme: ITheme): string {
  return theme.black ?? theme.brightBlack ?? theme.foreground ?? "currentColor";
}

function themeAccent(theme: ITheme): string {
  return theme.cyan ?? theme.yellow ?? theme.cursor ?? theme.foreground ?? "currentColor";
}

function formatPiUsageTokenCount(count: number): string {
  if (count < 1000) return String(Math.round(count));
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatPiUsageStats(stats: PiSessionUsageStats | null, usingCodexSubscription: boolean): string | null {
  if (!stats) return null;
  const parts: string[] = [];
  if (stats.tokens.input > 0) parts.push(`↑${formatPiUsageTokenCount(stats.tokens.input)}`);
  if (stats.tokens.output > 0) parts.push(`↓${formatPiUsageTokenCount(stats.tokens.output)}`);
  if (stats.tokens.cacheRead > 0) parts.push(`R${formatPiUsageTokenCount(stats.tokens.cacheRead)}`);
  if (stats.tokens.cacheWrite > 0) parts.push(`W${formatPiUsageTokenCount(stats.tokens.cacheWrite)}`);
  const promptTokenTotal = stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite;
  const cacheHitRate = stats.latestCacheHitRate ?? (promptTokenTotal > 0 ? (stats.tokens.cacheRead / promptTokenTotal) * 100 : undefined);
  if ((stats.tokens.cacheRead > 0 || stats.tokens.cacheWrite > 0) && cacheHitRate !== undefined) {
    parts.push(`CH${cacheHitRate.toFixed(1)}%`);
  }
  if (stats.cost > 0 || usingCodexSubscription) {
    parts.push(`$${stats.cost.toFixed(3)}${usingCodexSubscription ? " (sub)" : ""}`);
  }
  if (stats.contextUsage) {
    const percent = stats.contextUsage.percent === null ? "?" : stats.contextUsage.percent.toFixed(1);
    parts.push(`${percent}%/${formatPiUsageTokenCount(stats.contextUsage.contextWindow)} (auto)`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function estimatePiTranscriptRowHeight(row: PiVirtualTranscriptRow | undefined, terminalFontSize: number): number {
  const lineHeightPx = Math.max(12, terminalFontSize * TERMINAL_LINE_HEIGHT);
  if (!row || row.type === "thinking" || row.type === "error") return Math.ceil(lineHeightPx);

  const textLineCount = Math.max(1, itemText(row.item).split("\n").length);
  const estimatedTextLines = Math.min(PI_HTML_ESTIMATED_MAX_ROW_LINES, textLineCount);
  const extraLines =
    row.item.role === "user" || (row.item.role === "summary" && row.item.summaryKind === "compaction")
      ? 2.8
      : row.item.role === "toolResult" || row.item.role === "bashExecution"
        ? 3.2
        : 0.2;
  return Math.ceil((estimatedTextLines + extraLines) * lineHeightPx);
}

function piVirtualRowOuterMarginEm(row: PiVirtualTranscriptRow | undefined, toolsExpanded: boolean): number {
  if (!row || row.type !== "item") return 0;
  if (row.item.role === "user" || (row.item.role === "summary" && row.item.summaryKind === "compaction")) return 1.2;
  if ((row.item.role === "toolResult" || row.item.role === "bashExecution") && !shouldHideStandaloneToolResult(row.item, toolsExpanded)) return 1.2;
  return row.item.parts.some((part) => part.type === "toolCall") ? 1.2 : 0;
}

function rowStyle(item: PiTranscriptItem, theme: ITheme): CSSProperties {
  if (item.isError) return { color: theme.red ?? theme.foreground };
  switch (item.role) {
    case "user":
      return { color: theme.foreground };
    case "toolResult":
    case "bashExecution":
      return { color: theme.green ?? theme.foreground };
    case "summary":
    case "system":
    case "custom":
      return { color: themeMuted(theme) };
    case "assistant":
      return { color: theme.foreground };
  }
}

function PiTextBlock(props: {
  text: string;
  color: string;
  piTheme: PiHtmlTheme;
  className?: string;
  isThinking?: boolean;
}) {
  const components = useMemo<Components>(() => {
    const blockStyle: CSSProperties = {
      color: props.color,
      fontFamily: "inherit",
      fontSize: "1em",
      fontStyle: props.isThinking ? "italic" : undefined,
      lineHeight: TERMINAL_LINE_HEIGHT,
      margin: 0,
    };
    const terminalBlockStyle: CSSProperties = {
      ...blockStyle,
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
    };
    const headingStyle: CSSProperties = {
      ...terminalBlockStyle,
      color: props.isThinking ? props.color : props.piTheme.mdHeading,
      fontWeight: props.isThinking ? 400 : 700,
    };
    const codeBlockStyle: CSSProperties = {
      ...terminalBlockStyle,
      borderLeft: `2px solid ${props.piTheme.borderMuted}`,
      color: props.isThinking ? props.color : props.piTheme.mdCodeBlock,
      overflowX: "auto",
      padding: "0 1ch",
    };
    const tableCellStyle: CSSProperties = {
      ...blockStyle,
      border: `1px solid ${props.piTheme.borderMuted}`,
      padding: "0 1ch",
      verticalAlign: "top",
    };
    const renderHeading = (children: ReactNode) => <pre style={headingStyle}>{children}</pre>;

    return {
      p({ children }) {
        return <pre style={terminalBlockStyle}>{children}</pre>;
      },
      h1({ children }) {
        return renderHeading(children);
      },
      h2({ children }) {
        return renderHeading(children);
      },
      h3({ children }) {
        return renderHeading(children);
      },
      h4({ children }) {
        return renderHeading(children);
      },
      h5({ children }) {
        return renderHeading(children);
      },
      h6({ children }) {
        return renderHeading(children);
      },
      strong({ children }) {
        return <strong style={{ color: props.isThinking ? props.color : props.piTheme.accent, fontWeight: 700 }}>{children}</strong>;
      },
      em({ children }) {
        return <em style={{ color: props.color, fontStyle: "italic" }}>{children}</em>;
      },
      del({ children }) {
        return <span style={{ color: props.color, textDecoration: "line-through" }}>{children}</span>;
      },
      code({ children, className }) {
        const text = String(children);
        const isBlock = /(?:^|\s)language-/u.test(className ?? "") || text.includes("\n");
        return (
          <code
            className={className}
            style={{
              color: props.isThinking ? props.color : isBlock ? props.piTheme.mdCodeBlock : props.piTheme.mdCode,
              fontFamily: "inherit",
              fontSize: "1em",
              padding: isBlock ? 0 : "0 0.35ch",
              whiteSpace: isBlock ? "pre-wrap" : "break-spaces",
            }}
          >
            {children}
          </code>
        );
      },
      pre({ children }) {
        return <pre style={codeBlockStyle}>{children}</pre>;
      },
      ul({ children }) {
        return (
          <ul style={{ ...blockStyle, listStylePosition: "outside", listStyleType: "disc", paddingLeft: "3ch" }}>
            {children}
          </ul>
        );
      },
      ol({ children }) {
        return (
          <ol style={{ ...blockStyle, listStylePosition: "outside", listStyleType: "decimal", paddingLeft: "3ch" }}>
            {children}
          </ol>
        );
      },
      li({ children }) {
        return <li style={{ ...blockStyle, paddingLeft: "0.5ch" }}>{children}</li>;
      },
      input({ checked, type }) {
        if (type !== "checkbox") return null;
        return <span style={{ color: props.piTheme.accent }}>{checked ? "[x] " : "[ ] "}</span>;
      },
      blockquote({ children }) {
        return (
          <blockquote
            style={{
              ...terminalBlockStyle,
              borderLeft: `2px solid ${props.piTheme.borderMuted}`,
              color: props.color,
              paddingLeft: "1ch",
            }}
          >
            {children}
          </blockquote>
        );
      },
      a({ children, href, title }) {
        return (
          <a
            href={href}
            rel="noreferrer"
            target="_blank"
            title={title}
            style={{ color: props.isThinking ? props.color : props.piTheme.mdLink, textDecoration: "underline", textDecorationThickness: "1px" }}
          >
            {children}
          </a>
        );
      },
      table({ children }) {
        return (
          <div style={{ maxWidth: "100%", overflowX: "auto" }}>
            <table style={{ ...blockStyle, borderCollapse: "collapse", width: "100%" }}>{children}</table>
          </div>
        );
      },
      th({ children }) {
        return <th style={{ ...tableCellStyle, color: props.isThinking ? props.color : props.piTheme.accent, fontWeight: 700, textAlign: "left" }}>{children}</th>;
      },
      td({ children }) {
        return <td style={tableCellStyle}>{children}</td>;
      },
      hr() {
        return <pre style={{ ...terminalBlockStyle, color: props.color }}>{"─".repeat(80)}</pre>;
      },
      img({ alt, src }) {
        return <span style={{ color: props.color }}>{alt ? `[image: ${alt}]` : src ? `[image: ${src}]` : "[image]"}</span>;
      },
    };
  }, [props.color, props.isThinking, props.piTheme]);

  if (!props.text.trim()) return null;
  return (
    <div
      className={`m-0 min-w-0 break-words text-[1em] ${props.className ?? ""}`}
      style={{ color: props.color, fontFamily: "inherit", fontSize: "1em", lineHeight: TERMINAL_LINE_HEIGHT }}
    >
      <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
        {props.text}
      </ReactMarkdown>
    </div>
  );
}

function PiUserMessage(props: { text: string; piTheme: PiHtmlTheme }) {
  if (!props.text.trim()) return null;
  return (
    <div
      className="relative my-[1.2em] rounded-[0.6em] border px-[1ch] py-[0.8em]"
      style={{
        borderColor: props.piTheme.border,
        backgroundColor: props.piTheme.userMessageBg,
        color: props.piTheme.text,
        lineHeight: TERMINAL_LINE_HEIGHT,
      }}
    >
      <span
        className="absolute left-[1ch] top-0 -translate-y-1/2 px-[0.5ch] text-[1em]"
        style={{ backgroundColor: props.piTheme.terminal.background, color: props.piTheme.border }}
      >
        user
      </span>
      <PiTextBlock text={props.text} color={props.piTheme.text} piTheme={props.piTheme} />
    </div>
  );
}

function stripTrailingReadFilesSection(text: string): string {
  return text
    .replace(/\n?\s*<read-files>[\s\S]*?<\/read-files>\s*$/u, "")
    .replace(/\n?\s*<read-files>[\s\S]*$/u, "")
    .trimEnd();
}

function PiCompactionSummaryCard(props: { text: string; piTheme: PiHtmlTheme }) {
  const text = stripTrailingReadFilesSection(props.text);
  if (!text.trim()) return null;
  return (
    <div
      className="relative my-[1.2em] rounded-[0.6em] border px-[1ch] py-[0.8em]"
      style={{
        borderColor: props.piTheme.compactionBorder,
        backgroundColor: props.piTheme.compactionBg,
        color: props.piTheme.text,
        lineHeight: TERMINAL_LINE_HEIGHT,
      }}
    >
      <span
        className="absolute left-[1ch] top-0 -translate-y-1/2 px-[0.5ch] text-[1em]"
        style={{ backgroundColor: props.piTheme.terminal.background, color: props.piTheme.compactionLabel }}
      >
        compaction
      </span>
      <PiTextBlock text={text} color={props.piTheme.text} piTheme={props.piTheme} />
    </div>
  );
}

function shortenHomePath(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/u, "~");
}

function toolPathFromInput(input: unknown): string | null {
  if (!isRecord(input)) return null;
  const path = firstStringField(input, ["path", "file", "filePath", "file_path"]);
  return path ? shortenHomePath(path) : null;
}

function renderToolCallInline(name: string, input: unknown, piTheme: PiHtmlTheme): ReactNode {
  const normalized = normalizedToolName(name);
  const path = toolPathFromInput(input);
  if (normalized === "bash") {
    const command = isRecord(input) ? firstStringField(input, ["command", "cmd"]) : null;
    return <span style={{ color: piTheme.text, fontWeight: 700 }}>{command ? `$ ${command}` : "$ bash"}</span>;
  }
  if (normalized === "read") {
    return (
      <>
        <span style={{ color: piTheme.text, fontWeight: 700 }}>read</span>
        {path && <span style={{ color: piTheme.accent }}> {path}</span>}
      </>
    );
  }
  if (normalized === "write" || normalized === "edit") {
    return (
      <>
        <span style={{ color: piTheme.text, fontWeight: 700 }}>{name}</span>
        {path && <span style={{ color: piTheme.accent }}> {path}</span>}
      </>
    );
  }
  if (normalized === "questionnaire" && isRecord(input) && Array.isArray(input.questions)) {
    const labels = input.questions.flatMap((question) => {
      if (!isRecord(question)) return [];
      return typeof question.label === "string" && question.label.trim() ? [question.label.trim()] : [];
    });
    return (
      <>
        <span style={{ color: piTheme.text, fontWeight: 700 }}>questionnaire</span>
        <span style={{ color: piTheme.muted }}>{` ${input.questions.length} ${input.questions.length === 1 ? "question" : "questions"}`}</span>
        {labels.length > 0 && <span style={{ color: piTheme.muted }}>{` (${labels.join(", ")})`}</span>}
      </>
    );
  }
  return <span style={{ color: piTheme.text, fontWeight: 700 }}>{formatToolCall(name, input)}</span>;
}

const COLLAPSED_RESULT_TOOLS = new Set([
  "read",
  "ls",
  "grep",
  "find",
  "questionnaire",
  "decisiongate",
  "planreview",
]);

function toolOutputText(parts: readonly PiTranscriptPart[]): string {
  return parts
    .filter((part) => part.type !== "toolCall")
    .map(renderPartText)
    .filter(Boolean)
    .join("\n");
}

function editPreviewFromInput(input: unknown): string | null {
  if (!isRecord(input)) return null;
  const edits = Array.isArray(input.edits) ? input.edits : [input];
  const lines: string[] = [];
  for (const edit of edits) {
    if (!isRecord(edit)) continue;
    const oldText = typeof edit.oldText === "string" ? edit.oldText : null;
    const newText = typeof edit.newText === "string" ? edit.newText : null;
    if (oldText === null || newText === null) continue;
    lines.push(
      ...oldText.split("\n").filter((line) => line.length > 0).map((line, index) => `-${index + 1} ${line}`),
      ...newText.split("\n").filter((line) => line.length > 0).map((line, index) => `+${index + 1} ${line}`),
    );
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

function writePreviewFromInput(input: unknown): string | null {
  if (!isRecord(input)) return null;
  const content = input.content;
  return typeof content === "string" ? content : null;
}

function tailToolOutput(normalizedName: string, output: string): string {
  if (!TAIL_ONLY_TOOL_OUTPUTS.has(normalizedName)) return output;
  const lines = output.replace(/\n$/u, "").split("\n");
  if (lines.length <= MAX_VISIBLE_TOOL_OUTPUT_LINES) return output;
  return `[last ${MAX_VISIBLE_TOOL_OUTPUT_LINES} of ${lines.length} lines]\n${lines.slice(-MAX_VISIBLE_TOOL_OUTPUT_LINES).join("\n")}`;
}

function displayToolOutput(normalizedName: string, input: unknown, fallback: string, isError: boolean): string {
  if (isError) return tailToolOutput(normalizedName, fallback);
  if (normalizedName === "write") return writePreviewFromInput(input) ?? fallback;
  if (normalizedName === "edit") return editPreviewFromInput(input) ?? fallback;
  return tailToolOutput(normalizedName, fallback);
}

function shouldShowToolOutput(name: string, item: PiTranscriptItem): boolean {
  if (item.isError) return true;
  const normalized = normalizedToolName(name);
  if (normalized === "bash") return true;
  return !COLLAPSED_RESULT_TOOLS.has(normalized);
}

function PiToolOutput(props: { output: string; normalizedName: string; piTheme: PiHtmlTheme; isError?: boolean }) {
  if (props.normalizedName !== "edit") {
    return <PiTextBlock text={`\n${props.output}`} color={props.isError ? props.piTheme.error : props.piTheme.muted} piTheme={props.piTheme} />;
  }

  const lines = props.output.split("\n");
  return (
    <pre className="m-0 whitespace-pre-wrap break-words pt-[1em] text-[1em]" style={{ lineHeight: TERMINAL_LINE_HEIGHT }}>
      {lines.map((line, index) => {
        const isRemoval = /^-\d*\s/u.test(line) || (line.startsWith("-") && !line.startsWith("---"));
        const isAddition = /^\+\d*\s/u.test(line) || (line.startsWith("+") && !line.startsWith("+++"));
        return (
          <span key={index} style={{ color: props.isError ? props.piTheme.error : isRemoval ? props.piTheme.error : isAddition ? props.piTheme.success : props.piTheme.muted }}>
            {line}
            {index < lines.length - 1 ? "\n" : ""}
          </span>
        );
      })}
    </pre>
  );
}

function PiToolBlock(props: { item: DisplayTranscriptItem; toolCall?: Extract<PiTranscriptPart, { type: "toolCall" }>; piTheme: PiHtmlTheme; expanded?: boolean }) {
  const name = props.toolCall?.name ?? props.item.toolName ?? "tool";
  const normalizedName = normalizedToolName(name);
  const input = props.toolCall?.input ?? {};
  const output = displayToolOutput(
    normalizedName,
    input,
    props.item.mergedToolOutput ?? toolOutputText(props.item.parts),
    props.item.isError === true,
  );
  const showOutput = output.trim().length > 0 && (props.expanded === true || shouldShowToolOutput(name, props.item));
  const liveState = props.item as PiTranscriptItem & { live?: boolean; pending?: boolean };
  const isPending = liveState.live === true && liveState.pending === true;
  return (
    <div
      className="my-[1.2em] px-[1ch] py-[1.2em]"
      style={{
        backgroundColor: isPending
          ? props.piTheme.toolPendingBg
          : props.item.isError
            ? props.piTheme.toolErrorBg
            : props.piTheme.toolSuccessBg,
        color: props.piTheme.text,
        lineHeight: TERMINAL_LINE_HEIGHT,
      }}
    >
      <pre className="m-0 whitespace-pre-wrap break-words text-[1em]" style={{ lineHeight: TERMINAL_LINE_HEIGHT }}>
        {renderToolCallInline(name, input, props.piTheme)}
      </pre>
      {showOutput && <PiToolOutput output={output} normalizedName={normalizedName} piTheme={props.piTheme} isError={props.item.isError === true} />}
    </div>
  );
}

function shouldHideStandaloneToolResult(item: PiTranscriptItem, toolsExpanded = false): boolean {
  if (toolsExpanded) return false;
  if (item.role !== "toolResult" || item.isError) return false;
  const normalized = normalizedToolName(item.toolName ?? "");
  return COLLAPSED_RESULT_TOOLS.has(normalized);
}

function systemDisplayText(item: PiTranscriptItem, text: string): string {
  if (item.role !== "system") return text;
  const modelMatch = /^([^/\s]+)\/(.+)$/u.exec(text.trim());
  return modelMatch ? `Model scope: ${modelMatch[2]}` : text;
}

function PiTranscriptRow(props: { item: DisplayTranscriptItem; theme: ITheme; piTheme: PiHtmlTheme; toolsExpanded?: boolean; thinkingVisible?: boolean }) {
  const text = systemDisplayText(props.item, itemText(props.item));
  if (!text.trim()) return null;

  if (props.item.role === "user") {
    return <PiUserMessage text={text} piTheme={props.piTheme} />;
  }

  if (props.item.role === "summary" && props.item.summaryKind === "compaction") {
    return <PiCompactionSummaryCard text={text} piTheme={props.piTheme} />;
  }

  if (shouldHideStandaloneToolResult(props.item, props.toolsExpanded)) return null;

  const toolCallParts = props.item.parts.filter(
    (part): part is Extract<PiTranscriptPart, { type: "toolCall" }> => part.type === "toolCall",
  );
  const hasThinkingParts = props.item.parts.some((part) => part.type === "thinking");
  if (toolCallParts.length > 0 || hasThinkingParts) {
    return (
      <>
        {props.item.parts.map((part, index) => {
          if (part.type === "toolCall") {
            return <PiToolBlock key={`${props.item.id}:tool:${index}`} item={props.item} toolCall={part} piTheme={props.piTheme} expanded={props.toolsExpanded === true} />;
          }
          if (part.type === "thinking" && props.thinkingVisible === false) return null;
          const partText = renderPartText(part);
          return (
            <PiTextBlock
              key={`${props.item.id}:part:${index}`}
              text={partText}
              color={part.type === "thinking" ? props.piTheme.muted : (rowStyle(props.item, props.theme).color as string)}
              piTheme={props.piTheme}
              isThinking={part.type === "thinking"}
            />
          );
        })}
      </>
    );
  }

  if (props.item.role === "toolResult" || props.item.role === "bashExecution") {
    return <PiToolBlock item={props.item} piTheme={props.piTheme} expanded={props.toolsExpanded === true} />;
  }

  return <PiTextBlock text={text} color={rowStyle(props.item, props.theme).color as string} piTheme={props.piTheme} />;
}

const MemoizedPiTranscriptRow = memo(PiTranscriptRow);

function findCommandToken(value: string, cursor = value.length): { query: string; start: number; end: number } | null {
  const beforeCursor = value.slice(0, cursor);
  const afterCursor = value.slice(cursor);
  if (!beforeCursor.startsWith("/")) return null;
  if (/\s/u.test(beforeCursor) || /^\S/u.test(afterCursor)) return null;
  return { query: beforeCursor.slice(1).toLowerCase(), start: 0, end: cursor };
}

function findFileToken(value: string, cursor = value.length): { prefix: string; query: string; start: number; end: number } | null {
  const beforeCursor = value.slice(0, cursor);
  const afterCursor = value.slice(cursor);
  if (/^\S/u.test(afterCursor)) return null;
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(beforeCursor);
  if (!match || match.index === undefined) return null;
  const full = match[0] ?? "";
  const query = match[1] ?? "";
  const atOffset = full.indexOf("@");
  const start = match.index + atOffset;
  return { prefix: `@${query}`, query, start, end: cursor };
}

function mergePiCommands(commands: readonly PiCommandSuggestion[]): PiCommandSuggestion[] {
  const byName = new Map<string, PiCommandSuggestion>();
  for (const command of [...PI_HTML_BUILTIN_COMMANDS, ...commands]) {
    const name = command.name.trim();
    if (!name || byName.has(name)) continue;
    byName.set(name, { ...command, name });
  }
  return [...byName.values()];
}

function commandSuggestions(commands: readonly PiCommandSuggestion[], query: string): Suggestion[] {
  return commands
    .filter((command) => command.name.toLowerCase().includes(query))
    .slice(0, MAX_SUGGESTIONS)
    .map((command) => ({
      type: "command" as const,
      value: `/${command.name} `,
      label: `/${command.name}`,
      ...(command.description ? { description: command.description } : {}),
    }));
}

function parseCompactSlashCommand(message: string): string | null {
  const match = /^\/compact(?:\s+([\s\S]*))?$/u.exec(message.trim());
  if (!match) return null;
  return match[1]?.trim() ?? "";
}

function suggestionTokenKey(commandToken: ReturnType<typeof findCommandToken>, fileToken: ReturnType<typeof findFileToken>): string | null {
  if (commandToken) return `command:${commandToken.start}:${commandToken.end}:${commandToken.query}`;
  if (fileToken) return `file:${fileToken.start}:${fileToken.end}:${fileToken.query}`;
  return null;
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, index));
}

function captureTerminalPromptKey(event: ReactKeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

function stopTerminalPromptPropagation(event: ReactKeyboardEvent): void {
  event.stopPropagation();
}

const PI_HTML_DRAFT_STORAGE_PREFIX = "clui:pi-html-draft:";
const LARGE_PASTE_LINE_THRESHOLD = 10;
const LARGE_PASTE_CHAR_THRESHOLD = 1000;
const MAX_PROMPT_HISTORY = 100;
const MAX_EDITOR_UNDO_STACK = 100;
const PASTE_MARKER_REGEX = /\[paste #(\d+)(?: [^\]]+)?\]/gu;
const MAX_VISIBLE_TOOL_OUTPUT_LINES = 10;
const TAIL_ONLY_TOOL_OUTPUTS = new Set(["bash", "functionsbash", "read", "functionsread"]);
const fallbackDraftMemory = new Map<string, string>();

type PasteDrafts = Record<string, string>;

function draftStorageKey(key: string): string {
  return `${PI_HTML_DRAFT_STORAGE_PREFIX}${key}`;
}

function browserSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readPersistentDraft<T>(key: string, fallback: () => T): T {
  const fullKey = draftStorageKey(key);
  const raw = browserSessionStorage()?.getItem(fullKey) ?? fallbackDraftMemory.get(fullKey);
  if (raw === undefined || raw === null) return fallback();
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback();
  }
}

function writePersistentDraft<T>(key: string, value: T): void {
  const fullKey = draftStorageKey(key);
  const serialized = JSON.stringify(value);
  fallbackDraftMemory.set(fullKey, serialized);
  browserSessionStorage()?.setItem(fullKey, serialized);
}

function clearPersistentDraft(key: string): void {
  const fullKey = draftStorageKey(key);
  fallbackDraftMemory.delete(fullKey);
  browserSessionStorage()?.removeItem(fullKey);
}

function usePersistentDraftState<T>(key: string, fallback: () => T): [T, Dispatch<SetStateAction<T>>, () => void] {
  const [value, setValue] = useState<T>(() => readPersistentDraft(key, fallback));
  const setPersistentValue = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      if (typeof action !== "function") {
        writePersistentDraft(key, action);
        setValue(action);
        return;
      }
      setValue((current) => {
        const next = (action as (previous: T) => T)(current);
        writePersistentDraft(key, next);
        return next;
      });
    },
    [key],
  );
  const clear = useCallback(() => clearPersistentDraft(key), [key]);
  return [value, setPersistentValue, clear];
}

function promptHistoryKey(threadId: ThreadId): string {
  return `composerHistory:${threadId}`;
}

function pasteDraftsKey(key: string): string {
  return `${key}:pastes`;
}

function normalizePromptHistory(items: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const item of items) {
    const text = item.trim();
    if (!text || normalized[normalized.length - 1] === text) continue;
    normalized.push(text);
    if (normalized.length >= MAX_PROMPT_HISTORY) break;
  }
  return normalized;
}

function mergePromptHistory(...groups: readonly (readonly string[])[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const rawText of group) {
      const text = rawText.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      merged.push(text);
      if (merged.length >= MAX_PROMPT_HISTORY) return merged;
    }
  }
  return merged;
}

function addPromptHistoryEntry(history: readonly string[], text: string): string[] {
  return normalizePromptHistory([text, ...history.filter((item) => item.trim() !== text.trim())]);
}

function normalizePendingPromptText(text: string): string {
  return text.trim().replace(/\r\n?/gu, "\n");
}

function countTranscriptPromptText(transcriptUserTexts: readonly string[], text: string): number {
  const normalizedText = normalizePendingPromptText(text);
  return transcriptUserTexts.filter((item) => normalizePendingPromptText(item) === normalizedText).length;
}

function transcriptUserTexts(items: readonly PiTranscriptItem[]): string[] {
  return items.flatMap((item) => item.role === "user" ? [itemText(item)] : []);
}

function transcriptPromptHistory(items: readonly PiTranscriptItem[]): string[] {
  const prompts: string[] = [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item?.role !== "user") continue;
    const text = itemText(item).trim();
    if (text) prompts.push(text);
  }
  return normalizePromptHistory(prompts);
}

function clipboardPlainText(data: DataTransfer | null | undefined): string {
  if (!data) return "";
  return data.getData("text/plain") || data.getData("text") || data.getData("Text");
}

function normalizePastedText(text: string): string {
  return text
    .replace(/\x1b\[(\d+);5u/gu, (match, code: string) => {
      const cp = Number(code);
      if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
      if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
      return match;
    })
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "    ")
    .split("")
    .filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
    .join("");
}

function pasteMarkerFor(id: number, text: string): string {
  const lineCount = text.split("\n").length;
  return lineCount > LARGE_PASTE_LINE_THRESHOLD
    ? `[paste #${id} ${lineCount} lines]`
    : `[paste #${id} ${text.length} chars]`;
}

function isLargePaste(text: string): boolean {
  return text.split("\n").length > LARGE_PASTE_LINE_THRESHOLD || text.length > LARGE_PASTE_CHAR_THRESHOLD;
}

function nextPasteId(pastes: PasteDrafts): number {
  return Math.max(0, ...Object.keys(pastes).map((key) => Number(key)).filter(Number.isFinite)) + 1;
}

function expandPasteMarkers(text: string, pastes: PasteDrafts): string {
  return text.replace(PASTE_MARKER_REGEX, (marker, id: string) => pastes[id] ?? marker);
}

function insertTextIntoControlValue(value: string, insert: string, start: number, end: number): { value: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(start, value.length));
  const safeEnd = Math.max(safeStart, Math.min(end, value.length));
  return {
    value: `${value.slice(0, safeStart)}${insert}${value.slice(safeEnd)}`,
    cursor: safeStart + insert.length,
  };
}

function markerBeforeCursor(value: string, cursor: number): RegExpMatchArray | null {
  for (const match of value.matchAll(PASTE_MARKER_REGEX)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (end === cursor) return match;
  }
  return null;
}

function markerAfterCursor(value: string, cursor: number): RegExpMatchArray | null {
  for (const match of value.matchAll(PASTE_MARKER_REGEX)) {
    const start = match.index ?? 0;
    if (start === cursor) return match;
  }
  return null;
}

function markerContainingOffset(value: string, offset: number): { start: number; end: number; text: string } | null {
  for (const match of value.matchAll(PASTE_MARKER_REGEX)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (offset > start && offset < end) return { start, end, text: match[0] };
  }
  return null;
}

function markerIntersectingRange(value: string, start: number, end: number): { start: number; end: number; text: string } | null {
  if (start === end) return markerContainingOffset(value, start);
  for (const match of value.matchAll(PASTE_MARKER_REGEX)) {
    const markerStart = match.index ?? 0;
    const markerEnd = markerStart + match[0].length;
    if (start < markerEnd && end > markerStart && (start > markerStart || end < markerEnd)) {
      return { start: markerStart, end: markerEnd, text: match[0] };
    }
  }
  return null;
}

function selectionFromTextControl(element: TextControlElement): TextSelectionDraft {
  return {
    start: element.selectionStart ?? element.value.length,
    end: element.selectionEnd ?? element.value.length,
    direction: element.selectionDirection ?? "none",
  };
}

function lineStart(value: string, cursor: number): number {
  return value.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
}

function lineEnd(value: string, cursor: number): number {
  const index = value.indexOf("\n", cursor);
  return index === -1 ? value.length : index;
}

function previousWordStart(value: string, cursor: number): number {
  let index = Math.max(0, cursor);
  while (index > 0 && /\s/u.test(value[index - 1] ?? "")) index -= 1;
  while (index > 0 && !/\s/u.test(value[index - 1] ?? "")) index -= 1;
  return index;
}

function nextWordEnd(value: string, cursor: number): number {
  let index = Math.max(0, cursor);
  while (index < value.length && /\s/u.test(value[index] ?? "")) index += 1;
  while (index < value.length && !/\s/u.test(value[index] ?? "")) index += 1;
  return index;
}

function extendSelectionByWord(value: string, selection: TextSelectionDraft, direction: "left" | "right"): TextSelectionDraft {
  const collapsed = selection.start === selection.end;
  const anchor = collapsed
    ? selection.start
    : selection.direction === "backward"
      ? selection.end
      : selection.direction === "forward"
        ? selection.start
        : direction === "left"
          ? selection.end
          : selection.start;
  const focus = collapsed
    ? selection.start
    : selection.direction === "backward"
      ? selection.start
      : selection.direction === "forward"
        ? selection.end
        : direction === "left"
          ? selection.start
          : selection.end;
  const nextFocus = direction === "left" ? previousWordStart(value, focus) : nextWordEnd(value, focus);
  if (nextFocus < anchor) return { start: nextFocus, end: anchor, direction: "backward" };
  if (nextFocus > anchor) return { start: anchor, end: nextFocus, direction: "forward" };
  return { start: anchor, end: anchor, direction: "none" };
}

function clampSelectionForValue(value: string, selection: TextSelectionDraft): TextSelectionDraft {
  const start = Math.max(0, Math.min(value.length, selection.start));
  const end = Math.max(0, Math.min(value.length, selection.end));
  return { start, end, direction: selection.direction ?? "none" };
}

function replaceRange(value: string, start: number, end: number, insert = ""): { value: string; selection: TextSelectionDraft } {
  const safeStart = Math.max(0, Math.min(start, value.length));
  const safeEnd = Math.max(safeStart, Math.min(end, value.length));
  const nextValue = `${value.slice(0, safeStart)}${insert}${value.slice(safeEnd)}`;
  const cursor = safeStart + insert.length;
  return { value: nextValue, selection: { start: cursor, end: cursor, direction: "none" } };
}

function isMacLikePlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/u.test(navigator.platform);
}

function focusElementSoon(getElement: () => HTMLElement | null): () => void {
  let animationFrame: number | null = null;
  let timeout: number | null = null;
  const focus = () => getElement()?.focus({ preventScroll: true });
  animationFrame = window.requestAnimationFrame(focus);
  timeout = window.setTimeout(focus, 40);
  return () => {
    if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    if (timeout !== null) window.clearTimeout(timeout);
  };
}

type TextControlElement = HTMLInputElement | HTMLTextAreaElement;
type TextSelectionDraft = { start: number; end: number; direction?: "forward" | "backward" | "none" };

function textSelectionKey(key: string): string {
  return `${key}:selection`;
}

function clampTextSelection(value: string, selection: unknown): TextSelectionDraft | null {
  if (!isRecord(selection)) return null;
  const rawStart = selection.start;
  const rawEnd = selection.end;
  if (typeof rawStart !== "number" || typeof rawEnd !== "number") return null;
  const max = value.length;
  const start = Math.max(0, Math.min(max, rawStart));
  const end = Math.max(0, Math.min(max, rawEnd));
  const direction = selection.direction === "forward" || selection.direction === "backward" || selection.direction === "none"
    ? selection.direction
    : "none";
  return { start, end, direction };
}

function writeTextSelectionDraft(key: string, selection: TextSelectionDraft): void {
  writePersistentDraft(textSelectionKey(key), selection);
}

function persistTextSelection(key: string, element: TextControlElement): void {
  writeTextSelectionDraft(key, {
    start: element.selectionStart ?? element.value.length,
    end: element.selectionEnd ?? element.value.length,
    direction: element.selectionDirection ?? "none",
  });
}

function readTextSelectionDraft(key: string, value: string): TextSelectionDraft {
  return clampTextSelection(
    value,
    readPersistentDraft<unknown>(textSelectionKey(key), () => null),
  ) ?? { start: value.length, end: value.length, direction: "none" as const };
}

function restoreTextSelection(key: string, element: TextControlElement): void {
  const selection = readTextSelectionDraft(key, element.value);
  element.setSelectionRange(selection.start, selection.end, selection.direction);
  writeTextSelectionDraft(key, selection);
}

function clearTextSelectionDraft(key: string): void {
  clearPersistentDraft(textSelectionKey(key));
}

function focusTextControl(key: string, element: TextControlElement | null): void {
  if (!element) return;
  const selection = readTextSelectionDraft(key, element.value);
  element.focus({ preventScroll: true });
  element.setSelectionRange(selection.start, selection.end, selection.direction);
  writeTextSelectionDraft(key, selection);
}

function focusTextControlSoon(key: string, getElement: () => TextControlElement | null): () => void {
  let animationFrame: number | null = null;
  let timeout: number | null = null;
  const focus = () => focusTextControl(key, getElement());
  animationFrame = window.requestAnimationFrame(focus);
  timeout = window.setTimeout(focus, 40);
  return () => {
    if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    if (timeout !== null) window.clearTimeout(timeout);
  };
}

type ExtensionUiResponse = { value?: string; confirmed?: boolean; cancelled?: boolean };
type QuestionnaireRenderOption = QuestionOption & { isOther?: boolean };
type QuestionnaireEditorMode = "custom-answer" | "note";

async function sendExtensionUiResponse(threadId: ThreadId, id: string, response: ExtensionUiResponse): Promise<void> {
  const api = readNativeApi();
  if (!api) return;
  await api.pi.respondExtensionUi({ threadId, id, ...response });
}

function printableEventText(event: ReactKeyboardEvent): string | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  return event.key.length === 1 ? event.key : null;
}

function promptShellStyle(theme: ITheme): CSSProperties {
  return {
    color: themeText(theme),
    lineHeight: TERMINAL_LINE_HEIGHT,
  };
}

function selectedStyle(theme: ITheme): CSSProperties {
  return {
    backgroundColor: theme.selectionBackground ?? "rgba(255,255,255,0.12)",
    color: theme.selectionForeground ?? themeText(theme),
  };
}

function renderBorder(theme: ITheme): ReactNode {
  return <pre className="m-0 overflow-hidden whitespace-pre" style={{ color: themeAccent(theme), lineHeight: TERMINAL_LINE_HEIGHT }}>{"─".repeat(180)}</pre>;
}

function answerArray(questions: readonly QuestionnaireQuestion[], answers: Record<string, QuestionnaireAnswer>): QuestionnaireAnswer[] {
  return questions.flatMap((question) => {
    const answer = answers[question.id];
    return answer ? [answer] : [];
  });
}

function optionsForQuestion(question: QuestionnaireQuestion): QuestionnaireRenderOption[] {
  const options: QuestionnaireRenderOption[] = [...question.options];
  if (question.allowOther) {
    options.push({ value: "__other__", label: "Type something.", isOther: true });
  }
  return options;
}

function questionOptionIndex(question: QuestionnaireQuestion, answers: Record<string, QuestionnaireAnswer>): number {
  const options = optionsForQuestion(question);
  if (options.length === 0) return 0;
  const answer = answers[question.id];
  if (!answer) return 0;
  if (answer.wasCustom) {
    const customIndex = options.findIndex((option) => option.isOther === true);
    return customIndex >= 0 ? customIndex : 0;
  }
  if (typeof answer.index === "number") return clampIndex(answer.index - 1, options.length);
  const matchingIndex = options.findIndex((option) => option.value === answer.value);
  return matchingIndex >= 0 ? matchingIndex : 0;
}

function PiQuestionnairePrompt(props: {
  threadId: ThreadId;
  request: Extract<ExtensionUiRequest, { method: "questionnaire" }>;
  onDone: (id: string) => void;
  theme: ITheme;
}) {
  const { request, theme } = props;
  const isMulti = request.questions.length > 1;
  const submitTab = request.questions.length;
  const totalTabs = request.questions.length + 1;
  const draftKey = `questionnaire:${props.threadId}:${request.id}`;
  const [currentTab, setCurrentTab, clearCurrentTab] = usePersistentDraftState(`${draftKey}:currentTab`, () => 0);
  const [optionIndex, setOptionIndex, clearOptionIndex] = usePersistentDraftState(`${draftKey}:optionIndex`, () => 0);
  const [answers, setAnswers, clearAnswers] = usePersistentDraftState<Record<string, QuestionnaireAnswer>>(`${draftKey}:answers`, () => ({}));
  const [notes, setNotes, clearNotes] = usePersistentDraftState<Record<string, string>>(`${draftKey}:notes`, () => ({}));
  const [editorMode, setEditorMode, clearEditorMode] = usePersistentDraftState<QuestionnaireEditorMode | null>(`${draftKey}:editorMode`, () => null);
  const [editorQuestionId, setEditorQuestionId, clearEditorQuestionId] = usePersistentDraftState<string | null>(`${draftKey}:editorQuestionId`, () => null);
  const [editorValue, setEditorValue, clearEditorValue] = usePersistentDraftState(`${draftKey}:editorValue`, () => "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promptRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const editorValueKey = `${draftKey}:editorValue`;
  const clearDrafts = useCallback(() => {
    clearCurrentTab();
    clearOptionIndex();
    clearAnswers();
    clearNotes();
    clearEditorMode();
    clearEditorQuestionId();
    clearEditorValue();
    clearTextSelectionDraft(editorValueKey);
  }, [clearAnswers, clearCurrentTab, clearEditorMode, clearEditorQuestionId, clearEditorValue, clearNotes, clearOptionIndex, editorValueKey]);

  useLayoutEffect(() => {
    setSubmitting(false);
    setError(null);
    if (!editorMode) return focusElementSoon(() => promptRef.current);
    return undefined;
  }, [editorMode, request.id]);

  useLayoutEffect(() => {
    if (editorMode) return focusTextControlSoon(editorValueKey, () => editorRef.current);
    return undefined;
  }, [editorMode, editorValueKey]);

  const allAnswered = request.questions.every((question) => answers[question.id]);
  const currentQuestion = currentTab < request.questions.length ? request.questions[currentTab] : undefined;
  const currentOptions = currentQuestion ? optionsForQuestion(currentQuestion) : [];
  const currentNote = currentQuestion ? notes[currentQuestion.id] : undefined;

  const respond = useCallback(
    async (payload: { answers?: QuestionnaireAnswer[]; cancelled?: boolean }) => {
      if (submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        await sendExtensionUiResponse(props.threadId, request.id, {
          value: `${CLUI_RPC_QUESTIONNAIRE_PREFIX}${encodeBase64UrlJson(payload)}`,
        });
        clearDrafts();
        props.onDone(request.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to answer questionnaire.");
        setSubmitting(false);
      }
    },
    [clearDrafts, props, request.id, submitting],
  );

  const selectTab = useCallback(
    (nextTab: number, nextAnswers = answers) => {
      const normalizedTab = ((nextTab % totalTabs) + totalTabs) % totalTabs;
      setCurrentTab(normalizedTab);
      const question = request.questions[normalizedTab];
      if (question) {
        setOptionIndex(questionOptionIndex(question, nextAnswers));
      } else {
        setOptionIndex(0);
      }
    },
    [answers, request.questions, totalTabs],
  );

  const saveAnswer = useCallback(
    (question: QuestionnaireQuestion, option: QuestionnaireRenderOption, index: number, customValue?: string) => {
      const trimmedCustom = customValue?.trim();
      const answer: QuestionnaireAnswer = option.isOther
        ? {
            id: question.id,
            value: trimmedCustom || "(no response)",
            label: trimmedCustom || "(no response)",
            wasCustom: true,
            ...(notes[question.id] ? { note: notes[question.id] } : {}),
          }
        : {
            id: question.id,
            value: option.value,
            label: option.label,
            wasCustom: false,
            index: index + 1,
            ...(notes[question.id] ? { note: notes[question.id] } : {}),
          };
      const nextAnswers = { ...answers, [question.id]: answer };
      setAnswers(nextAnswers);
      if (!isMulti) {
        void respond({ answers: answerArray(request.questions, nextAnswers), cancelled: false });
        return;
      }
      if (currentTab < request.questions.length - 1) selectTab(currentTab + 1, nextAnswers);
      else selectTab(submitTab, nextAnswers);
    },
    [answers, currentTab, isMulti, notes, request.questions, respond, selectTab, submitTab],
  );

  const openEditor = useCallback((mode: QuestionnaireEditorMode, question: QuestionnaireQuestion) => {
    setEditorMode(mode);
    setEditorQuestionId(question.id);
    const existingAnswer = answers[question.id];
    setEditorValue(mode === "note" ? (notes[question.id] ?? "") : (existingAnswer?.wasCustom ? existingAnswer.value : ""));
  }, [answers, notes]);

  const closeEditor = useCallback(() => {
    setEditorMode(null);
    setEditorQuestionId(null);
    setEditorValue("");
    requestAnimationFrame(() => promptRef.current?.focus({ preventScroll: true }));
  }, []);

  const saveEditor = useCallback(() => {
    if (!editorQuestionId || !editorMode) return;
    const question = request.questions.find((entry) => entry.id === editorQuestionId);
    if (!question) return;
    if (editorMode === "custom-answer") {
      const options = optionsForQuestion(question);
      const customIndex = options.findIndex((option) => option.isOther === true);
      saveAnswer(question, options[customIndex] ?? { value: "__other__", label: "Type something.", isOther: true }, Math.max(0, customIndex), editorValue);
      closeEditor();
      return;
    }
    const trimmed = editorValue.trim();
    setNotes((current) => {
      const next = { ...current };
      if (trimmed) next[editorQuestionId] = trimmed;
      else delete next[editorQuestionId];
      return next;
    });
    setAnswers((current) => {
      const existing = current[editorQuestionId];
      if (!existing) return current;
      const nextAnswer = { ...existing };
      if (trimmed) nextAnswer.note = trimmed;
      else delete nextAnswer.note;
      return { ...current, [editorQuestionId]: nextAnswer };
    });
    closeEditor();
  }, [closeEditor, editorMode, editorQuestionId, editorValue, request.questions, saveAnswer]);

  const handleEditorKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Escape") {
        captureTerminalPromptKey(event);
        closeEditor();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
        captureTerminalPromptKey(event);
        saveEditor();
        return;
      }
      stopTerminalPromptPropagation(event);
    },
    [closeEditor, saveEditor],
  );

  const handlePromptKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (submitting) {
        captureTerminalPromptKey(event);
        return;
      }
      if (isMulti && (event.key === "Tab" || event.key === "ArrowRight")) {
        captureTerminalPromptKey(event);
        selectTab(currentTab + (event.shiftKey ? -1 : 1));
        return;
      }
      if (isMulti && event.key === "ArrowLeft") {
        captureTerminalPromptKey(event);
        selectTab(currentTab - 1);
        return;
      }
      if (currentTab === submitTab) {
        if (event.key === "Enter") {
          captureTerminalPromptKey(event);
          if (allAnswered) void respond({ answers: answerArray(request.questions, answers), cancelled: false });
          return;
        }
        if (event.key === "Escape") {
          captureTerminalPromptKey(event);
          void respond({ cancelled: true });
        }
        return;
      }
      if (!currentQuestion) return;
      if (event.key === "ArrowUp") {
        captureTerminalPromptKey(event);
        setOptionIndex((index) => clampIndex(index - 1, currentOptions.length));
        return;
      }
      if (event.key === "ArrowDown") {
        captureTerminalPromptKey(event);
        setOptionIndex((index) => clampIndex(index + 1, currentOptions.length));
        return;
      }
      if (event.key === "n" || event.key === "N") {
        captureTerminalPromptKey(event);
        openEditor("note", currentQuestion);
        return;
      }
      if (event.key === "Enter") {
        captureTerminalPromptKey(event);
        const option = currentOptions[clampIndex(optionIndex, currentOptions.length)];
        if (!option) return;
        if (option.isOther) openEditor("custom-answer", currentQuestion);
        else saveAnswer(currentQuestion, option, clampIndex(optionIndex, currentOptions.length));
        return;
      }
      if (event.key === "Escape") {
        captureTerminalPromptKey(event);
        void respond({ cancelled: true });
      }
    },
    [allAnswered, answers, currentOptions, currentQuestion, currentTab, isMulti, openEditor, optionIndex, request.questions, respond, saveAnswer, selectTab, submitTab, submitting],
  );

  return (
    <div className="shrink-0" style={promptShellStyle(theme)}>
      {renderBorder(theme)}
      {isMulti && (
        <pre className="m-0 whitespace-pre-wrap" style={{ color: themeMuted(theme), lineHeight: TERMINAL_LINE_HEIGHT }}>
          <span> ← </span>
          {request.questions.map((question, index) => {
            const active = index === currentTab;
            const answered = answers[question.id] !== undefined;
            return (
              <span key={question.id} style={active ? selectedStyle(theme) : { color: answered ? theme.green ?? themeText(theme) : themeMuted(theme) }}>
                {` ${answered ? "■" : "□"} ${question.label} `}
              </span>
            );
          })}
          <span style={currentTab === submitTab ? selectedStyle(theme) : { color: allAnswered ? theme.green ?? themeText(theme) : themeDim(theme) }}> ✓ Submit </span>
          <span> →</span>
        </pre>
      )}
      {editorMode && currentQuestion ? (
        <div>
          <pre className="m-0 whitespace-pre-wrap" style={{ color: themeText(theme), lineHeight: TERMINAL_LINE_HEIGHT }}>{currentQuestion.prompt}</pre>
          {currentQuestion.context && <pre className="m-0 whitespace-pre-wrap" style={{ color: themeMuted(theme), lineHeight: TERMINAL_LINE_HEIGHT }}>{currentQuestion.context}</pre>}
          <pre className="m-0" style={{ color: themeMuted(theme), lineHeight: TERMINAL_LINE_HEIGHT }}>{editorMode === "note" ? " Additional note:" : " Your answer:"}</pre>
          <textarea
            ref={editorRef}
            value={editorValue}
            onChange={(event) => {
              setEditorValue(event.target.value);
              persistTextSelection(editorValueKey, event.currentTarget);
            }}
            onSelect={(event) => persistTextSelection(editorValueKey, event.currentTarget)}
            onKeyUp={(event) => persistTextSelection(editorValueKey, event.currentTarget)}
            onMouseUp={(event) => persistTextSelection(editorValueKey, event.currentTarget)}
            onBlur={(event) => persistTextSelection(editorValueKey, event.currentTarget)}
            onKeyDown={handleEditorKeyDown}
            rows={1}
            spellCheck={false}
            className="w-full resize-none border-0 bg-transparent p-0 outline-none"
            style={{ color: themeText(theme), caretColor: theme.cursor ?? themeText(theme), lineHeight: TERMINAL_LINE_HEIGHT }}
          />
          <pre className="m-0" style={{ color: themeDim(theme), lineHeight: TERMINAL_LINE_HEIGHT }}>{editorMode === "note" ? " Enter to save note • Esc to cancel" : " Enter to submit • Esc to cancel"}</pre>
        </div>
      ) : currentTab === submitTab ? (
        <div ref={promptRef} tabIndex={0} onKeyDown={handlePromptKeyDown} className="outline-none">
          <pre className="m-0" style={{ color: themeAccent(theme), lineHeight: TERMINAL_LINE_HEIGHT }}> Ready to submit</pre>
          {request.questions.map((question) => {
            const answer = answers[question.id];
            if (!answer) return null;
            return (
              <div key={question.id}>
                <pre className="m-0 whitespace-pre-wrap" style={{ lineHeight: TERMINAL_LINE_HEIGHT }}><span style={{ color: themeMuted(theme) }}>{` ${question.label}: `}</span>{answer.wasCustom ? `(wrote) ${answer.label}` : answer.label}</pre>
                {answer.note && <pre className="m-0 whitespace-pre-wrap" style={{ color: themeMuted(theme), lineHeight: TERMINAL_LINE_HEIGHT }}>{`   note: ${answer.note}`}</pre>}
              </div>
            );
          })}
          <pre className="m-0" style={{ color: allAnswered ? theme.green ?? themeText(theme) : theme.yellow ?? themeText(theme), lineHeight: TERMINAL_LINE_HEIGHT }}>{allAnswered ? " Press Enter to submit" : ` Unanswered: ${request.questions.filter((question) => !answers[question.id]).map((question) => question.label).join(", ")}`}</pre>
        </div>
      ) : currentQuestion ? (
        <div ref={promptRef} tabIndex={0} onKeyDown={handlePromptKeyDown} className="outline-none">
          <pre className="m-0 whitespace-pre-wrap" style={{ color: themeText(theme), lineHeight: TERMINAL_LINE_HEIGHT }}> {currentQuestion.prompt}</pre>
          {currentQuestion.context && <pre className="m-0 whitespace-pre-wrap" style={{ color: themeMuted(theme), lineHeight: TERMINAL_LINE_HEIGHT }}> {currentQuestion.context}</pre>}
          {currentOptions.map((option, index) => {
            const selected = index === clampIndex(optionIndex, currentOptions.length);
            return (
              <div key={`${option.value}:${index}`}>
                <pre className="m-0 whitespace-pre-wrap" style={{ color: selected ? themeAccent(theme) : themeText(theme), lineHeight: TERMINAL_LINE_HEIGHT }}>{`${selected ? "> " : "  "}${index + 1}. ${option.label}`}</pre>
                {option.description && <pre className="m-0 whitespace-pre-wrap" style={{ color: themeMuted(theme), lineHeight: TERMINAL_LINE_HEIGHT }}>{`     ${option.description}`}</pre>}
              </div>
            );
          })}
          {currentNote && <pre className="m-0 whitespace-pre-wrap" style={{ lineHeight: TERMINAL_LINE_HEIGHT }}><span style={{ color: theme.green ?? themeText(theme) }}> Note: </span><span style={{ color: themeMuted(theme) }}>{currentNote}</span></pre>}
        </div>
      ) : null}
      {!editorMode && <pre className="m-0" style={{ color: themeDim(theme), lineHeight: TERMINAL_LINE_HEIGHT }}>{isMulti ? " Tab/←→ navigate • ↑↓ select • Enter confirm • n note • Esc cancel" : " ↑↓ navigate • Enter select • n note • Esc cancel"}</pre>}
      {error && <pre className="m-0" style={{ color: theme.red ?? themeText(theme), lineHeight: TERMINAL_LINE_HEIGHT }}>{error}</pre>}
      {renderBorder(theme)}
    </div>
  );
}

function buildLineNotes(planLines: readonly string[], notes: Record<number, string>): LineNote[] {
  return Object.entries(notes)
    .map(([lineIndex, note]) => ({ lineIndex: Number(lineIndex), note }))
    .filter((entry) => Number.isFinite(entry.lineIndex) && entry.note.trim().length > 0)
    .sort((left, right) => left.lineIndex - right.lineIndex)
    .map(({ lineIndex, note }) => ({ lineNumber: lineIndex + 1, lineText: planLines[lineIndex] ?? "", note }));
}

function annotatePlan(planLines: readonly string[], notes: Record<number, string>): string {
  const annotated: string[] = [];
  for (let index = 0; index < planLines.length; index++) {
    annotated.push(planLines[index] ?? "");
    const note = notes[index]?.trim();
    if (note) annotated.push(`  note: ${note}`);
  }
  return annotated.join("\n");
}

function formatLineNoteFeedback(lineNotes: readonly LineNote[]): string {
  if (lineNotes.length === 0) return "";
  const lines = ["Line notes:"];
  for (const lineNote of lineNotes) {
    lines.push(`L${lineNote.lineNumber}: ${lineNote.lineText}`);
    lines.push(`note: ${lineNote.note}`);
  }
  return lines.join("\n");
}

function PiPlanReviewPrompt(props: {
  threadId: ThreadId;
  request: Extract<ExtensionUiRequest, { method: "planReview" }>;
  onDone: (id: string) => void;
  theme: ITheme;
}) {
  const { request, theme } = props;
  const planLines = useMemo(() => (request.plan.length > 0 ? request.plan.split("\n") : [""]), [request.plan]);
  const draftKey = `planReview:${props.threadId}:${request.id}`;
  const [selectedLine, setSelectedLine, clearSelectedLine] = usePersistentDraftState(`${draftKey}:selectedLine`, () => 0);
  const [notes, setNotes, clearNotes] = usePersistentDraftState<Record<number, string>>(`${draftKey}:notes`, () => ({}));
  const [noteLine, setNoteLine, clearNoteLine] = usePersistentDraftState<number | null>(`${draftKey}:noteLine`, () => null);
  const [noteDraft, setNoteDraft, clearNoteDraft] = usePersistentDraftState(`${draftKey}:noteDraft`, () => "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promptRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const noteDraftKey = `${draftKey}:noteDraft`;
  const clearDrafts = useCallback(() => {
    clearSelectedLine();
    clearNotes();
    clearNoteLine();
    clearNoteDraft();
    clearTextSelectionDraft(noteDraftKey);
  }, [clearNoteDraft, clearNoteLine, clearNotes, clearSelectedLine, noteDraftKey]);

  useLayoutEffect(() => {
    setSubmitting(false);
    setError(null);
    if (noteLine === null) return focusElementSoon(() => promptRef.current);
    return undefined;
  }, [noteLine, request.id]);

  useLayoutEffect(() => {
    if (noteLine !== null) return focusTextControlSoon(noteDraftKey, () => inputRef.current);
    return undefined;
  }, [noteDraftKey, noteLine]);

  const moveSelection = useCallback((delta: number) => {
    setSelectedLine((line) => clampIndex(line + delta, planLines.length));
  }, [planLines.length]);

  const saveNote = useCallback(() => {
    if (noteLine === null) return;
    const line = noteLine;
    const trimmed = noteDraft.trim();
    setNotes((current) => {
      const next = { ...current };
      if (trimmed) next[line] = trimmed;
      else delete next[line];
      return next;
    });
    setNoteLine(null);
    setNoteDraft("");
    requestAnimationFrame(() => promptRef.current?.focus({ preventScroll: true }));
  }, [noteDraft, noteLine]);

  const respond = useCallback(
    async (action: "approved" | "revise" | "rejected", nextNotes = notes) => {
      if (submitting) return;
      setSubmitting(true);
      setError(null);
      const lineNotes = buildLineNotes(planLines, nextNotes);
      const reviewedText = lineNotes.length > 0 ? annotatePlan(planLines, nextNotes) : request.plan;
      try {
        await sendExtensionUiResponse(props.threadId, request.id, {
          value: `${CLUI_RPC_PLAN_REVIEW_PREFIX}${encodeBase64UrlJson({
            action,
            reviewedText,
            feedback: action === "revise" ? formatLineNoteFeedback(lineNotes) : undefined,
            changed: lineNotes.length > 0,
            notes: lineNotes,
          })}`,
        });
        clearDrafts();
        props.onDone(request.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to answer plan review.");
        setSubmitting(false);
      }
    },
    [clearDrafts, notes, planLines, props, request.id, request.plan, submitting],
  );

  const startNote = useCallback((text: string) => {
    setNoteLine(selectedLine);
    setNoteDraft(`${notes[selectedLine] ?? ""}${text}`);
  }, [notes, selectedLine]);

  const saveNoteAndMove = useCallback((delta: number) => {
    if (noteLine === null) return;
    const line = noteLine;
    const trimmed = noteDraft.trim();
    setNotes((current) => {
      const next = { ...current };
      if (trimmed) next[line] = trimmed;
      else delete next[line];
      return next;
    });
    setNoteLine(null);
    setNoteDraft("");
    moveSelection(delta);
    requestAnimationFrame(() => promptRef.current?.focus({ preventScroll: true }));
  }, [moveSelection, noteDraft, noteLine]);

  const handleNoteKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape" || (event.ctrlKey && event.key.toLowerCase() === "c")) {
        captureTerminalPromptKey(event);
        void respond("rejected");
        return;
      }
      if (event.key === "Enter") {
        captureTerminalPromptKey(event);
        saveNote();
        return;
      }
      if (event.key === "ArrowUp") {
        captureTerminalPromptKey(event);
        saveNoteAndMove(-1);
        return;
      }
      if (event.key === "ArrowDown") {
        captureTerminalPromptKey(event);
        saveNoteAndMove(1);
        return;
      }
      stopTerminalPromptPropagation(event);
    },
    [respond, saveNote, saveNoteAndMove],
  );

  const handlePromptKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (submitting) {
        captureTerminalPromptKey(event);
        return;
      }
      if (event.key === "Escape" || (event.ctrlKey && event.key.toLowerCase() === "c")) {
        captureTerminalPromptKey(event);
        void respond("rejected");
        return;
      }
      if (event.key === "ArrowUp") {
        captureTerminalPromptKey(event);
        moveSelection(-1);
        return;
      }
      if (event.key === "ArrowDown") {
        captureTerminalPromptKey(event);
        moveSelection(1);
        return;
      }
      if (event.key === "PageUp") {
        captureTerminalPromptKey(event);
        moveSelection(-8);
        return;
      }
      if (event.key === "PageDown") {
        captureTerminalPromptKey(event);
        moveSelection(8);
        return;
      }
      if (event.key === "Enter") {
        captureTerminalPromptKey(event);
        void respond(Object.keys(notes).length > 0 ? "revise" : "approved");
        return;
      }
      const text = printableEventText(event);
      if (text) {
        captureTerminalPromptKey(event);
        startNote(text);
      }
    },
    [moveSelection, notes, respond, startNote, submitting],
  );

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaY < 0 ? -1 : 1;
      if (noteLine !== null) saveNoteAndMove(delta);
      else moveSelection(delta);
    },
    [moveSelection, noteLine, saveNoteAndMove],
  );

  const hasNotes = Object.values(notes).some((note) => note.trim().length > 0);
  const visibleStart = Math.max(0, Math.min(selectedLine - 8, Math.max(0, planLines.length - 18)));
  const visibleLines = planLines.slice(visibleStart, visibleStart + 18);

  return (
    <div ref={promptRef} tabIndex={0} onKeyDown={handlePromptKeyDown} onWheel={handleWheel} className="shrink-0 outline-none" style={promptShellStyle(theme)}>
      {renderBorder(theme)}
      <pre className="m-0 whitespace-pre-wrap" style={{ color: themeAccent(theme), fontWeight: 700, lineHeight: TERMINAL_LINE_HEIGHT }}> {request.title}</pre>
      {visibleStart > 0 && <pre className="m-0" style={{ color: themeDim(theme), lineHeight: TERMINAL_LINE_HEIGHT }}>  …</pre>}
      {visibleLines.map((line, offset) => {
        const index = visibleStart + offset;
        const selected = index === selectedLine;
        const savedNote = notes[index];
        return (
          <div key={index}>
            <pre className="m-0 whitespace-pre-wrap" style={{ lineHeight: TERMINAL_LINE_HEIGHT }}>
              <span style={{ color: selected ? themeAccent(theme) : themeText(theme) }}>{selected ? "> " : "  "}</span>
              <span style={selected ? selectedStyle(theme) : { color: themeText(theme) }}>{line || " "}</span>
            </pre>
            {savedNote && noteLine !== index && <pre className="m-0 whitespace-pre-wrap" style={{ lineHeight: TERMINAL_LINE_HEIGHT }}><span style={{ color: themeAccent(theme) }}>  note: </span><span style={{ color: themeMuted(theme) }}>{savedNote}</span></pre>}
            {noteLine === index && (
              <div className="flex items-center">
                <pre className="m-0" style={{ color: themeAccent(theme), lineHeight: TERMINAL_LINE_HEIGHT }}>  note: </pre>
                <input
                  ref={inputRef}
                  value={noteDraft}
                  onChange={(event) => {
                    setNoteDraft(event.target.value);
                    persistTextSelection(noteDraftKey, event.currentTarget);
                  }}
                  onSelect={(event) => persistTextSelection(noteDraftKey, event.currentTarget)}
                  onKeyUp={(event) => persistTextSelection(noteDraftKey, event.currentTarget)}
                  onMouseUp={(event) => persistTextSelection(noteDraftKey, event.currentTarget)}
                  onBlur={(event) => persistTextSelection(noteDraftKey, event.currentTarget)}
                  onKeyDown={handleNoteKeyDown}
                  spellCheck={false}
                  className="min-w-0 flex-1 border-0 bg-transparent p-0 outline-none"
                  style={{ color: themeText(theme), caretColor: theme.cursor ?? themeText(theme), lineHeight: TERMINAL_LINE_HEIGHT }}
                />
              </div>
            )}
          </div>
        );
      })}
      {visibleStart + visibleLines.length < planLines.length && <pre className="m-0" style={{ color: themeDim(theme), lineHeight: TERMINAL_LINE_HEIGHT }}>  …</pre>}
      <pre className="m-0" style={{ color: themeDim(theme), lineHeight: TERMINAL_LINE_HEIGHT }}>{noteLine !== null ? ` wheel/↑↓ save+move • Enter save • Backspace edit • Esc reject • line ${selectedLine + 1}/${planLines.length}` : hasNotes ? ` wheel/↑↓ move • type note • Enter revise • Esc reject • line ${selectedLine + 1}/${planLines.length}` : ` wheel/↑↓ move • type note • Enter approve • Esc reject • line ${selectedLine + 1}/${planLines.length}`}</pre>
      {error && <pre className="m-0" style={{ color: theme.red ?? themeText(theme), lineHeight: TERMINAL_LINE_HEIGHT }}>{error}</pre>}
      {renderBorder(theme)}
    </div>
  );
}

function PiGenericExtensionUiPrompt(props: {
  threadId: ThreadId;
  request: GenericExtensionUiRequest;
  onDone: (id: string) => void;
  theme: ITheme;
}) {
  const draftKey = `genericPrompt:${props.threadId}:${props.request.id}`;
  const [value, setValue, clearValue] = usePersistentDraftState(`${draftKey}:value`, () => props.request.prefill ?? "");
  const [selectedIndex, setSelectedIndex, clearSelectedIndex] = usePersistentDraftState(`${draftKey}:selectedIndex`, () => 0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promptRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const valueKey = `${draftKey}:value`;
  const clearDrafts = useCallback(() => {
    clearValue();
    clearSelectedIndex();
    clearTextSelectionDraft(valueKey);
  }, [clearSelectedIndex, clearValue, valueKey]);

  useLayoutEffect(() => {
    setError(null);
    setSubmitting(false);
    if (props.request.method === "input" || props.request.method === "editor") {
      return focusTextControlSoon(valueKey, () => inputRef.current);
    }
    return focusElementSoon(() => promptRef.current);
  }, [props.request.id, props.request.method, valueKey]);

  const respond = useCallback(
    async (response: ExtensionUiResponse) => {
      if (submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        await sendExtensionUiResponse(props.threadId, props.request.id, response);
        clearDrafts();
        props.onDone(props.request.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to answer prompt.");
        setSubmitting(false);
      }
    },
    [clearDrafts, props, submitting],
  );

  const title = props.request.title ?? props.request.method;
  const optionValues = props.request.method === "confirm" ? ["yes", "no"] : (props.request.options ?? []);
  const safeSelectedIndex = clampIndex(selectedIndex, optionValues.length);

  const submitSelected = useCallback(() => {
    if (props.request.method === "confirm") {
      void respond({ confirmed: safeSelectedIndex === 0 });
      return;
    }
    const option = optionValues[safeSelectedIndex];
    if (option !== undefined) void respond({ value: option });
  }, [optionValues, props.request.method, respond, safeSelectedIndex]);

  const handleChoiceKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (submitting) {
        captureTerminalPromptKey(event);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowRight" || (event.key === "Tab" && !event.shiftKey)) {
        captureTerminalPromptKey(event);
        setSelectedIndex((index) => clampIndex(index + 1, optionValues.length));
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowLeft" || (event.key === "Tab" && event.shiftKey)) {
        captureTerminalPromptKey(event);
        setSelectedIndex((index) => clampIndex(index - 1, optionValues.length));
        return;
      }
      if (event.key === "Enter") {
        captureTerminalPromptKey(event);
        submitSelected();
        return;
      }
      if (event.key === "Escape") {
        captureTerminalPromptKey(event);
        void respond({ cancelled: true });
      }
    },
    [optionValues.length, respond, submitSelected, submitting],
  );

  const handleInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Escape") {
        captureTerminalPromptKey(event);
        void respond({ cancelled: true });
        return;
      }
      if (event.key === "Enter" && props.request.method === "input" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
        captureTerminalPromptKey(event);
        void respond({ value });
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        captureTerminalPromptKey(event);
        void respond({ value });
        return;
      }
      stopTerminalPromptPropagation(event);
    },
    [props.request.method, respond, value],
  );

  return (
    <div className="shrink-0" style={promptShellStyle(props.theme)}>
      <pre className="m-0 whitespace-pre-wrap" style={{ color: themeText(props.theme), lineHeight: TERMINAL_LINE_HEIGHT }}>{title}</pre>
      {props.request.message && <pre className="m-0 whitespace-pre-wrap" style={{ color: themeMuted(props.theme), lineHeight: TERMINAL_LINE_HEIGHT }}>{props.request.message}</pre>}
      {(props.request.method === "select" || props.request.method === "confirm") && (
        <div ref={promptRef} tabIndex={0} role="listbox" onKeyDown={handleChoiceKeyDown} className="outline-none">
          {optionValues.map((option, index) => {
            const selected = index === safeSelectedIndex;
            return (
              <pre key={`${props.request.id}:${option}`} className="m-0 whitespace-pre-wrap" style={{ color: selected ? themeAccent(props.theme) : themeText(props.theme), lineHeight: TERMINAL_LINE_HEIGHT }} onMouseDown={(event) => event.preventDefault()} onClick={() => { setSelectedIndex(index); if (props.request.method === "confirm") void respond({ confirmed: index === 0 }); else void respond({ value: option }); }}>
                {selected ? "> " : "  "}{index + 1}. {option}
              </pre>
            );
          })}
        </div>
      )}
      {(props.request.method === "input" || props.request.method === "editor") && (
        <div className="flex items-start gap-2">
          <pre className="m-0" style={{ color: themeDim(props.theme), lineHeight: TERMINAL_LINE_HEIGHT }}>›</pre>
          <textarea
            ref={inputRef}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              persistTextSelection(valueKey, event.currentTarget);
            }}
            onSelect={(event) => persistTextSelection(valueKey, event.currentTarget)}
            onKeyUp={(event) => persistTextSelection(valueKey, event.currentTarget)}
            onMouseUp={(event) => persistTextSelection(valueKey, event.currentTarget)}
            onBlur={(event) => persistTextSelection(valueKey, event.currentTarget)}
            onKeyDown={handleInputKeyDown}
            rows={props.request.method === "editor" ? 5 : 1}
            placeholder={props.request.placeholder}
            spellCheck={false}
            className="min-h-[1.2em] flex-1 resize-none border-0 bg-transparent p-0 outline-none"
            style={{ color: themeText(props.theme), caretColor: props.theme.cursor ?? themeText(props.theme), lineHeight: TERMINAL_LINE_HEIGHT }}
          />
        </div>
      )}
      <pre className="m-0" style={{ color: themeDim(props.theme), lineHeight: TERMINAL_LINE_HEIGHT }}>{props.request.method === "editor" ? "ctrl+enter submit · esc cancel" : "enter submit · esc cancel"}</pre>
      {error && <pre className="m-0" style={{ color: props.theme.red ?? themeText(props.theme), lineHeight: TERMINAL_LINE_HEIGHT }}>{error}</pre>}
    </div>
  );
}

function PiExtensionUiPrompt(props: {
  threadId: ThreadId;
  request: ExtensionUiRequest;
  onDone: (id: string) => void;
  theme: ITheme;
}) {
  switch (props.request.method) {
    case "questionnaire":
      return <PiQuestionnairePrompt threadId={props.threadId} request={props.request} onDone={props.onDone} theme={props.theme} />;
    case "planReview":
      return <PiPlanReviewPrompt threadId={props.threadId} request={props.request} onDone={props.onDone} theme={props.theme} />;
    default:
      return <PiGenericExtensionUiPrompt threadId={props.threadId} request={props.request} onDone={props.onDone} theme={props.theme} />;
  }
}

function PiExtensionWidgets(props: {
  widgets: readonly PiExtensionUiWidget[];
  placement: PiExtensionUiWidget["placement"];
  theme: ITheme;
}) {
  const widgets = props.widgets.filter((widget) => widget.placement === props.placement && widget.lines.length > 0);
  if (widgets.length === 0) return null;
  const defaultColor = themeText(props.theme);
  return (
    <div className="shrink-0">
      {widgets.map((widget) => (
        <div key={widget.key}>
          {widget.lines.map((line, index) => (
            <pre key={`${widget.key}:${index}`} className="m-0 whitespace-pre-wrap" style={{ color: defaultColor, lineHeight: TERMINAL_LINE_HEIGHT }}>
              {renderAnsiText(line, defaultColor, `${widget.key}:${index}`)}
            </pre>
          ))}
        </div>
      ))}
    </div>
  );
}

function isHTMLElement(value: unknown): value is HTMLElement {
  return value instanceof HTMLElement;
}

function isEditableTarget(element: HTMLElement | null): boolean {
  if (!element) return false;
  const tagName = element.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || element.isContentEditable;
}

const INTERACTIVE_TARGET_SELECTOR = [
  "a[href]",
  "button",
  "details",
  "iframe",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
  "[role='application']",
  "[role='button']",
  "[role='checkbox']",
  "[role='combobox']",
  "[role='grid']",
  "[role='link']",
  "[role='listbox']",
  "[role='menu']",
  "[role='menuitem']",
  "[role='option']",
  "[role='radio']",
  "[role='searchbox']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='switch']",
  "[role='tab']",
  "[role='textbox']",
  "[role='tree']",
  "[role='treeitem']",
].join(",");

function isInteractiveTarget(element: HTMLElement | null): boolean {
  return Boolean(element?.closest(INTERACTIVE_TARGET_SELECTOR));
}

function isInsideKeyboardOwner(element: HTMLElement | null): boolean {
  return Boolean(element?.closest(".xterm, [role='dialog'], [aria-modal='true'], [data-radix-dialog-content]"));
}

function usePiBusyFrame(active: boolean): string {
  const [frameIndex, setFrameIndex] = useState(0);
  useEffect(() => {
    if (!active) {
      setFrameIndex(0);
      return undefined;
    }
    const intervalId = window.setInterval(() => {
      setFrameIndex((index) => (index + 1) % PI_HTML_BUSY_FRAMES.length);
    }, 120);
    return () => window.clearInterval(intervalId);
  }, [active]);
  return PI_HTML_BUSY_FRAMES[frameIndex] ?? PI_HTML_BUSY_FRAMES[0];
}

function PiThinkingPlaceholder(props: { active: boolean; piTheme: PiHtmlTheme }) {
  const busyFrame = usePiBusyFrame(props.active);
  if (!props.active) return null;
  return (
    <pre className="m-0 whitespace-pre-wrap" style={{ color: props.piTheme.muted, fontStyle: "italic", lineHeight: TERMINAL_LINE_HEIGHT }}>
      {`${busyFrame} thinking…`}
    </pre>
  );
}

function PiQueuedPromptPreview(props: { prompts: readonly PendingPromptPreview[]; theme: ITheme; piTheme: PiHtmlTheme }) {
  const latest = props.prompts[props.prompts.length - 1];
  if (!latest) return null;
  return (
    <div
      className="m-0 overflow-hidden px-[1ch] text-[1em]"
      title={latest.text}
      style={{
        color: themeText(props.theme),
        display: "-webkit-box",
        lineHeight: TERMINAL_LINE_HEIGHT,
        WebkitBoxOrient: "vertical",
        WebkitLineClamp: 2,
        whiteSpace: "pre-wrap",
      }}
    >
      <span style={{ color: props.piTheme.accent }}>{props.prompts.length > 1 ? `queued (${props.prompts.length}): ` : "queued: "}</span>
      {latest.text}
    </div>
  );
}

function PiHtmlFooterStatus(props: {
  threadId: ThreadId;
  theme: ITheme;
  piTheme: PiHtmlTheme;
  extensionUiState: PiExtensionUiState;
  usageStats: PiSessionUsageStats | null;
}) {
  const thread = useStore((s) => s.threads.find((t) => t.id === props.threadId));
  const project = useStore((s) => s.projects.find((p) => p.id === thread?.projectId));
  const cwd = thread?.worktreePath ?? project?.cwd ?? null;
  const statusEntries = Object.values(props.extensionUiState.statuses).filter((status) => status.trim().length > 0);
  const hasCodexStatus = statusEntries.some((status) => cleanTranscriptText(status).includes("Codex"));
  const usageSummary = formatPiUsageStats(props.usageStats, hasCodexStatus);
  const isWorking = thread?.hookStatus === "working";
  const busyFrame = usePiBusyFrame(isWorking);
  const workingLabel = thread?.activityStatus ? AGENT_ACTIVITY_LABELS[thread.activityStatus] : "Working";
  const statusSegments = useMemo(() => {
    const segments: Array<{ kind: "ansi" | "text"; text: string }> = statusEntries.map((status) => ({ kind: "ansi", text: status }));
    if (isWorking) segments.unshift({ kind: "text" as const, text: `${busyFrame} ${workingLabel}` });
    if (!usageSummary) return segments;
    const codexIndex = segments.findIndex((segment) => cleanTranscriptText(segment.text).includes("Codex"));
    const insertIndex = codexIndex >= 0 ? codexIndex + 1 : segments.length;
    return [
      ...segments.slice(0, insertIndex),
      { kind: "text" as const, text: usageSummary },
      ...segments.slice(insertIndex),
    ];
  }, [busyFrame, isWorking, statusEntries, usageSummary, workingLabel]);

  if (!cwd && statusSegments.length === 0) return null;
  return (
    <pre className="m-0 whitespace-pre-wrap" style={{ color: props.piTheme.muted, lineHeight: TERMINAL_LINE_HEIGHT }}>
      {cwd ? `${shortenHomePath(cwd)}${thread?.branch ? ` (${thread.branch})` : ""}` : ""}
      {statusSegments.length > 0 && cwd ? "  " : ""}
      {statusSegments.map((status, index) => (
        <span key={`${status.kind}:${index}`}>
          {index > 0 ? " • " : ""}
          {status.kind === "ansi" ? renderAnsiText(status.text, props.piTheme.muted, `status:${index}`) : status.text}
        </span>
      ))}
    </pre>
  );
}

function PiHtmlComposer(props: {
  threadId: ThreadId;
  theme: ITheme;
  piTheme: PiHtmlTheme;
  extensionUiState: PiExtensionUiState;
  usageStats: PiSessionUsageStats | null;
  history: readonly string[];
  transcriptUserTexts: readonly string[];
  editorTextRequest: EditorTextRequest | null;
  autoFocusEnabled: boolean;
  registerFocus: (focus: (() => void) | null) => void;
  onLocalNotice: (text: string, options?: { isError?: boolean }) => void;
}) {
  const composerDraftKey = `composer:${props.threadId}`;
  const [draftValue, setDraftValue, clearDraftValue] = usePersistentDraftState(composerDraftKey, () => "");
  const [value, setValue] = useState(draftValue);
  const [pastes, setPastes, clearPastes] = usePersistentDraftState<PasteDrafts>(pasteDraftsKey(composerDraftKey), () => ({}));
  const [localHistory, setLocalHistory] = usePersistentDraftState<string[]>(promptHistoryKey(props.threadId), () => []);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historyDraftRef = useRef<{ value: string; selection: TextSelectionDraft } | null>(null);
  const [commands, setCommands] = useState<PiCommandSuggestion[]>(() => mergePiCommands([]));
  const [fileSuggestions, setFileSuggestions] = useState<Suggestion[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const [dismissedSuggestionToken, setDismissedSuggestionToken] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<PiModelOption[]>([]);
  const [modelSelectOpen, setModelSelectOpen] = useState(false);
  const [selectedModelIndex, setSelectedModelIndex] = useState(0);
  const [thinkingLevel, setThinkingLevel] = useState<PiThinkingLevel | null>(null);
  const [pendingPrompts, setPendingPrompts] = useState<PendingPromptPreview[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composerVisualRows, setComposerVisualRows] = useState(1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const valueRef = useRef(value);
  const undoStackRef = useRef<Array<{ value: string; selection: TextSelectionDraft }>>([]);
  const killRingRef = useRef<string[]>([]);
  const lastYankRef = useRef<{ start: number; end: number; ringIndex: number } | null>(null);
  const lastClearShortcutAtRef = useRef(0);
  const lastPasteHandledAtRef = useRef(0);
  const pendingPromptIdRef = useRef(0);
  const thread = useStore((s) => s.threads.find((t) => t.id === props.threadId));
  const project = useStore((s) => s.projects.find((p) => p.id === thread?.projectId));
  const hookStatus = thread?.hookStatus ?? null;
  const cwd = thread?.worktreePath ?? project?.cwd ?? null;
  const isBusy = hookStatus === "working";
  const tokenCursor = textareaRef.current?.selectionStart ?? readTextSelectionDraft(composerDraftKey, value).end;
  const commandToken = useMemo(() => findCommandToken(value, tokenCursor), [tokenCursor, value]);
  const fileToken = useMemo(() => findFileToken(value, tokenCursor), [tokenCursor, value]);
  const activeSuggestionToken = suggestionTokenKey(commandToken, fileToken);
  const rawSuggestions = commandToken
    ? commandSuggestions(commands, commandToken.query)
    : fileToken
      ? fileSuggestions
      : [];
  const suggestions = activeSuggestionToken && activeSuggestionToken === dismissedSuggestionToken ? [] : rawSuggestions;
  const history = useMemo(() => mergePromptHistory(localHistory, props.history), [localHistory, props.history]);
  const thinkingLevelLabel = formatThinkingLevel(thinkingLevel);
  const composerRuleColor = thinkingBorderColor(thinkingLevel, props.piTheme);

  useEffect(() => {
    setPendingPrompts((current) =>
      current.filter((prompt) => countTranscriptPromptText(props.transcriptUserTexts, prompt.text) <= prompt.transcriptBaselineCount),
    );
  }, [props.transcriptUserTexts]);

  const autosizeComposer = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const computedStyle = window.getComputedStyle(textarea);
    const parsedLineHeight = Number.parseFloat(computedStyle.lineHeight);
    const fontSize = Number.parseFloat(computedStyle.fontSize);
    const lineHeightPx = Number.isFinite(parsedLineHeight)
      ? parsedLineHeight
      : (Number.isFinite(fontSize) ? fontSize * TERMINAL_LINE_HEIGHT : 18);
    const minHeight = lineHeightPx;
    const maxHeight = lineHeightPx * PI_HTML_COMPOSER_MAX_ROWS;

    textarea.style.height = "auto";
    const nextHeight = Math.min(maxHeight, Math.max(minHeight, textarea.scrollHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight + 1 ? "auto" : "hidden";
    setComposerVisualRows(Math.max(1, Math.round(nextHeight / lineHeightPx)));
  }, []);

  useLayoutEffect(() => {
    autosizeComposer();
  }, [autosizeComposer, value]);

  useEffect(() => {
    const textarea = textareaRef.current;
    const parent = textarea?.parentElement;
    if (!parent) return undefined;
    let animationFrame: number | null = null;
    const scheduleAutosize = () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        autosizeComposer();
      });
    };
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(scheduleAutosize) : null;
    resizeObserver?.observe(parent);
    window.addEventListener("resize", scheduleAutosize);
    scheduleAutosize();
    return () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleAutosize);
    };
  }, [autosizeComposer]);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    setValue(draftValue);
    valueRef.current = draftValue;
    setHistoryIndex(-1);
    historyDraftRef.current = null;
    undoStackRef.current = [];
    lastYankRef.current = null;
  }, [composerDraftKey, draftValue]);

  const pushUndoSnapshot = useCallback(
    (snapshotValue = valueRef.current, selection?: TextSelectionDraft) => {
      const snapshot = {
        value: snapshotValue,
        selection: selection ?? (textareaRef.current ? selectionFromTextControl(textareaRef.current) : readTextSelectionDraft(composerDraftKey, snapshotValue)),
      };
      const previous = undoStackRef.current[undoStackRef.current.length - 1];
      if (previous?.value === snapshot.value && previous.selection.start === snapshot.selection.start && previous.selection.end === snapshot.selection.end) return;
      undoStackRef.current = [...undoStackRef.current.slice(-(MAX_EDITOR_UNDO_STACK - 1)), snapshot];
    },
    [composerDraftKey],
  );

  const updateDraftValue = useCallback(
    (nextValue: string, selection?: TextSelectionDraft, options?: { recordUndo?: boolean }) => {
      const previousValue = valueRef.current;
      if (options?.recordUndo !== false && previousValue !== nextValue) pushUndoSnapshot(previousValue);
      setHistoryIndex(-1);
      historyDraftRef.current = null;
      lastYankRef.current = null;
      valueRef.current = nextValue;
      setValue(nextValue);
      setDraftValue(nextValue);
      if (selection) writeTextSelectionDraft(composerDraftKey, clampSelectionForValue(nextValue, selection));
    },
    [composerDraftKey, pushUndoSnapshot, setDraftValue],
  );

  useEffect(() => {
    const focusComposer = () => {
      if (props.autoFocusEnabled) focusTextControl(composerDraftKey, textareaRef.current);
    };
    props.registerFocus(focusComposer);
    return () => props.registerFocus(null);
  }, [composerDraftKey, props.autoFocusEnabled, props.registerFocus]);

  useLayoutEffect(() => {
    if (props.autoFocusEnabled) return focusTextControlSoon(composerDraftKey, () => textareaRef.current);
    return undefined;
  }, [composerDraftKey, props.autoFocusEnabled]);

  useEffect(() => {
    if (!props.editorTextRequest) return;
    const text = props.editorTextRequest.text;
    updateDraftValue(text, { start: text.length, end: text.length, direction: "none" });
    requestAnimationFrame(() => focusTextControl(composerDraftKey, textareaRef.current));
  }, [composerDraftKey, props.editorTextRequest, updateDraftValue]);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    void api.pi
      .getCommands({ threadId: props.threadId })
      .then((result) => setCommands(mergePiCommands(result.commands)))
      .catch(() => setCommands(mergePiCommands([])));
  }, [props.threadId]);

  useEffect(() => {
    setSelectedSuggestionIndex(0);
  }, [activeSuggestionToken]);

  useEffect(() => {
    if (activeSuggestionToken !== dismissedSuggestionToken) return;
    if (rawSuggestions.length === 0) setDismissedSuggestionToken(null);
  }, [activeSuggestionToken, dismissedSuggestionToken, rawSuggestions.length]);

  useEffect(() => {
    const api = readNativeApi();
    if (!api || !cwd || !fileToken) {
      setFileSuggestions([]);
      return;
    }
    const query = fileToken.query.trim();
    if (!query) {
      setFileSuggestions([]);
      return;
    }
    let disposed = false;
    const timeout = window.setTimeout(() => {
      void api.projects
        .searchEntries({ cwd, query, limit: MAX_SUGGESTIONS })
        .then((result) => {
          if (disposed) return;
          setFileSuggestions(
            result.entries.map((entry) => ({
              type: "file" as const,
              value: `@${entry.path}${entry.kind === "directory" ? "/" : ""}`,
              label: `@${entry.path}${entry.kind === "directory" ? "/" : ""}`,
              description: entry.kind,
            })),
          );
        })
        .catch(() => {
          if (!disposed) setFileSuggestions([]);
        });
    }, 80);
    return () => {
      disposed = true;
      window.clearTimeout(timeout);
    };
  }, [cwd, fileToken]);

  const applySuggestion = useCallback(
    (suggestion: Suggestion) => {
      setDismissedSuggestionToken(null);
      const currentValue = valueRef.current;
      const cursorPosition = textareaRef.current?.selectionStart ?? currentValue.length;
      if (suggestion.type === "command") {
        const token = findCommandToken(currentValue, cursorPosition);
        const next = token
          ? `${currentValue.slice(0, token.start)}${suggestion.value}${currentValue.slice(token.end)}`
          : suggestion.value;
        const cursor = (token?.start ?? 0) + suggestion.value.length;
        updateDraftValue(next, { start: cursor, end: cursor, direction: "none" });
        requestAnimationFrame(() => focusTextControl(composerDraftKey, textareaRef.current));
        return;
      }
      const currentFileToken = findFileToken(currentValue, cursorPosition);
      if (!currentFileToken) return;
      const next = `${currentValue.slice(0, currentFileToken.start)}${suggestion.value}${currentValue.slice(
        currentFileToken.end,
      )}`;
      const cursor = currentFileToken.start + suggestion.value.length;
      updateDraftValue(next, { start: cursor, end: cursor, direction: "none" });
      requestAnimationFrame(() => focusTextControl(composerDraftKey, textareaRef.current));
    },
    [composerDraftKey, updateDraftValue],
  );

  const submit = useCallback(async (overrideValue?: string, streamingBehavior?: "steer" | "followUp") => {
    const sourceValue = overrideValue ?? valueRef.current;
    const message = expandPasteMarkers(sourceValue, pastes).trim();
    if (!message || submitting) return;
    const api = readNativeApi();
    if (!api) return;
    const compactInstructions = parseCompactSlashCommand(message);
    if (compactInstructions !== null) {
      setSubmitting(true);
      setError(null);
      try {
        await api.pi.rpcCommand({
          threadId: props.threadId,
          commandType: "compact",
          ...(compactInstructions ? { payload: { customInstructions: compactInstructions } } : {}),
        });
        setLocalHistory((current) => addPromptHistoryEntry(current, message));
        clearDraftValue();
        clearPastes();
        clearTextSelectionDraft(composerDraftKey);
        undoStackRef.current = [];
        historyDraftRef.current = null;
        lastYankRef.current = null;
        setHistoryIndex(-1);
        valueRef.current = "";
        setValue("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to compact context.");
      } finally {
        setSubmitting(false);
        requestAnimationFrame(() => focusTextControl(composerDraftKey, textareaRef.current));
      }
      return;
    }
    const behavior = streamingBehavior ?? (isBusy ? "steer" as const : undefined);
    const pendingPromptId = ++pendingPromptIdRef.current;
    setPendingPrompts((current) => [
      ...current,
      {
        id: pendingPromptId,
        text: message,
        transcriptBaselineCount: countTranscriptPromptText(props.transcriptUserTexts, message)
          + current.filter((prompt) => normalizePendingPromptText(prompt.text) === normalizePendingPromptText(message)).length,
      },
    ]);
    setSubmitting(true);
    setError(null);
    try {
      await api.pi.prompt({
        threadId: props.threadId,
        message,
        ...(behavior ? { streamingBehavior: behavior } : {}),
      });
      setLocalHistory((current) => addPromptHistoryEntry(current, message));
      clearDraftValue();
      clearPastes();
      clearTextSelectionDraft(composerDraftKey);
      undoStackRef.current = [];
      historyDraftRef.current = null;
      lastYankRef.current = null;
      setHistoryIndex(-1);
      valueRef.current = "";
      setValue("");
    } catch (err) {
      setPendingPrompts((current) => current.filter((prompt) => prompt.id !== pendingPromptId));
      setError(err instanceof Error ? err.message : "Failed to send prompt.");
    } finally {
      setSubmitting(false);
      requestAnimationFrame(() => focusTextControl(composerDraftKey, textareaRef.current));
    }
  }, [clearDraftValue, clearPastes, composerDraftKey, isBusy, pastes, props.threadId, props.transcriptUserTexts, setLocalHistory, submitting]);

  const abort = useCallback(async () => {
    const api = readNativeApi();
    if (!api) return;
    props.onLocalNotice("Interrupted.", { isError: true });
    try {
      await api.pi.abort({ threadId: props.threadId });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to abort.");
    }
  }, [props.onLocalNotice, props.threadId]);

  const replaceSelection = useCallback(
    (insert: string, selectionStart?: number, selectionEnd?: number) => {
      const textarea = textareaRef.current;
      const current = valueRef.current;
      const start = selectionStart ?? textarea?.selectionStart ?? current.length;
      const end = selectionEnd ?? textarea?.selectionEnd ?? start;
      const next = insertTextIntoControlValue(current, insert, start, end);
      updateDraftValue(next.value, { start: next.cursor, end: next.cursor, direction: "none" });
      requestAnimationFrame(() => focusTextControl(composerDraftKey, textareaRef.current));
    },
    [composerDraftKey, updateDraftValue],
  );

  const insertPastedText = useCallback(
    (text: string) => {
      const normalized = normalizePastedText(text);
      if (!normalized) return false;
      lastPasteHandledAtRef.current = Date.now();
      if (isLargePaste(normalized)) {
        const pasteId = nextPasteId(pastes);
        setPastes({ ...pastes, [String(pasteId)]: normalized });
        replaceSelection(pasteMarkerFor(pasteId, normalized));
        return true;
      }
      replaceSelection(normalized);
      return true;
    },
    [pastes, replaceSelection, setPastes],
  );

  useEffect(
    () =>
      addPiHtmlComposerInsertListener((detail) => {
        if (detail.threadId !== props.threadId || !detail.text) return;
        if (detail.source === "paste") {
          insertPastedText(detail.text);
          return;
        }
        replaceSelection(detail.text);
      }),
    [insertPastedText, props.threadId, replaceSelection],
  );

  const handlePaste = useCallback(
    (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
      if (event.defaultPrevented) return;
      const imageFiles = clipboardImageFiles(event.clipboardData?.items);
      if (imageFiles.length > 0) {
        event.preventDefault();
        const api = readNativeApi();
        if (!api) {
          setError("Image paste unavailable.");
          return;
        }
        const selectionStart = event.currentTarget.selectionStart ?? valueRef.current.length;
        const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
        setError(null);
        void (async () => {
          try {
            const filePaths: string[] = [];
            for (const file of imageFiles) {
              const dataUrl = await readFileAsDataUrl(file);
              const result = await api.server.writeTempImage({
                threadId: props.threadId,
                name: file.name.trim() || "clipboard-image.png",
                mimeType: file.type || "image/png",
                sizeBytes: file.size,
                dataUrl,
              });
              filePaths.push(result.filePath);
            }
            replaceSelection(filePaths.join("\n"), selectionStart, selectionEnd);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to paste image.");
          }
        })();
        return;
      }

      const text = clipboardPlainText(event.clipboardData);
      if (!text) return;
      event.preventDefault();
      insertPastedText(text);
    },
    [insertPastedText, props.threadId, replaceSelection],
  );

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return undefined;
    const handleNativePaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented) return;
      if (clipboardImageFiles(event.clipboardData?.items).length > 0) return;
      const text = clipboardPlainText(event.clipboardData);
      if (!text) return;
      event.preventDefault();
      insertPastedText(text);
    };
    textarea.addEventListener("paste", handleNativePaste, true);
    return () => textarea.removeEventListener("paste", handleNativePaste, true);
  }, [insertPastedText]);

  useEffect(() => {
    const handleDocumentPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented) return;
      const target = isHTMLElement(event.target) ? event.target : null;
      if (target === textareaRef.current) return;
      if (isEditableTarget(target)) return;
      if (clipboardImageFiles(event.clipboardData?.items).length > 0) return;
      const text = clipboardPlainText(event.clipboardData);
      if (!text) return;
      event.preventDefault();
      insertPastedText(text);
    };

    const handlePasteShortcutFallback = (event: globalThis.KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key !== "v" || event.altKey || event.shiftKey || (!event.metaKey && !event.ctrlKey)) return;
      const target = isHTMLElement(event.target) ? event.target : null;
      if (target !== textareaRef.current) {
        if (isEditableTarget(target)) return;
        focusTextControl(composerDraftKey, textareaRef.current);
      }
      const readText = navigator.clipboard?.readText;
      if (!readText) return;
      const requestedAt = Date.now();
      void readText.call(navigator.clipboard).then((text) => {
        window.setTimeout(() => {
          if (!text || lastPasteHandledAtRef.current >= requestedAt) return;
          insertPastedText(text);
        }, 120);
      }).catch(() => {
        window.setTimeout(() => {
          if (lastPasteHandledAtRef.current >= requestedAt) return;
          setError("Clipboard read denied. Click the input and paste again.");
        }, 120);
      });
    };

    document.addEventListener("paste", handleDocumentPaste, true);
    document.addEventListener("keydown", handlePasteShortcutFallback, true);
    return () => {
      document.removeEventListener("paste", handleDocumentPaste, true);
      document.removeEventListener("keydown", handlePasteShortcutFallback, true);
    };
  }, [composerDraftKey, insertPastedText]);

  const navigateHistory = useCallback(
    (direction: -1 | 1) => {
      if (history.length === 0) return false;
      const nextIndex = historyIndex - direction;
      if (nextIndex < -1 || nextIndex >= history.length) return false;

      if (historyIndex === -1 && nextIndex >= 0) {
        const textarea = textareaRef.current;
        const currentValue = valueRef.current;
        historyDraftRef.current = {
          value: currentValue,
          selection: textarea ? selectionFromTextControl(textarea) : readTextSelectionDraft(composerDraftKey, currentValue),
        };
      }

      setHistoryIndex(nextIndex);
      if (nextIndex === -1) {
        const draft = historyDraftRef.current;
        historyDraftRef.current = null;
        const nextValue = draft?.value ?? draftValue;
        const selection = draft?.selection ?? readTextSelectionDraft(composerDraftKey, nextValue);
        valueRef.current = nextValue;
        setValue(nextValue);
        setDraftValue(nextValue);
        writeTextSelectionDraft(composerDraftKey, selection);
      } else {
        const nextValue = history[nextIndex] ?? "";
        const cursor = direction === -1 ? 0 : nextValue.length;
        valueRef.current = nextValue;
        setValue(nextValue);
        requestAnimationFrame(() => {
          const textarea = textareaRef.current;
          if (!textarea) return;
          textarea.focus({ preventScroll: true });
          textarea.setSelectionRange(cursor, cursor, "none");
        });
        return true;
      }
      requestAnimationFrame(() => focusTextControl(composerDraftKey, textareaRef.current));
      return true;
    },
    [composerDraftKey, draftValue, history, historyIndex, setDraftValue],
  );

  const setComposerSelection = useCallback(
    (selection: TextSelectionDraft) => {
      const nextSelection = clampSelectionForValue(valueRef.current, selection);
      writeTextSelectionDraft(composerDraftKey, nextSelection);
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus({ preventScroll: true });
        textarea.setSelectionRange(nextSelection.start, nextSelection.end, nextSelection.direction ?? "none");
      });
    },
    [composerDraftKey],
  );

  const applyEditorValue = useCallback(
    (nextValue: string, selection: TextSelectionDraft, options?: { recordUndo?: boolean }) => {
      updateDraftValue(nextValue, selection, options);
      requestAnimationFrame(() => focusTextControl(composerDraftKey, textareaRef.current));
    },
    [composerDraftKey, updateDraftValue],
  );

  const addKillRingText = useCallback((text: string) => {
    if (!text) return;
    killRingRef.current = [text, ...killRingRef.current.filter((entry) => entry !== text)].slice(0, 20);
  }, []);

  const snapSelectionAwayFromPasteMarker = useCallback(
    (element: HTMLTextAreaElement): boolean => {
      const current = valueRef.current;
      const selection = selectionFromTextControl(element);
      if (selection.start !== selection.end) {
        const intersecting = markerIntersectingRange(current, selection.start, selection.end);
        if (!intersecting) return false;
        const nextSelection = {
          start: Math.min(selection.start, intersecting.start),
          end: Math.max(selection.end, intersecting.end),
          direction: selection.direction ?? "none",
        };
        element.setSelectionRange(nextSelection.start, nextSelection.end, nextSelection.direction);
        writeTextSelectionDraft(composerDraftKey, nextSelection);
        return true;
      }
      const marker = markerContainingOffset(current, selection.start);
      if (!marker) return false;
      const cursor = selection.start - marker.start < marker.end - selection.start ? marker.start : marker.end;
      element.setSelectionRange(cursor, cursor, "none");
      writeTextSelectionDraft(composerDraftKey, { start: cursor, end: cursor, direction: "none" });
      return true;
    },
    [composerDraftKey],
  );

  const handlePasteMarkerBeforeInput = useCallback(
    (event: ReactFormEvent<HTMLTextAreaElement>): boolean => {
      const nativeEvent = event.nativeEvent as InputEvent & { dataTransfer?: DataTransfer | null };
      if (nativeEvent.isComposing) return false;
      const inputType = nativeEvent.inputType;
      if (inputType === "insertFromPaste" || inputType === "insertFromDrop") {
        const text = clipboardPlainText(nativeEvent.dataTransfer) || nativeEvent.data || "";
        if (text) {
          event.preventDefault();
          return insertPastedText(text);
        }
      }
      if (!inputType.startsWith("insert") && !inputType.startsWith("delete")) return false;
      const textarea = event.currentTarget;
      const current = valueRef.current;
      const selection = selectionFromTextControl(textarea);
      const marker = markerIntersectingRange(current, selection.start, selection.end);
      if (!marker) return false;
      event.preventDefault();
      const insert = inputType.startsWith("insert") ? (nativeEvent.data ?? "") : "";
      if (inputType.startsWith("insert") && selection.start === selection.end) {
        const atEnd = selection.start - marker.start >= marker.end - selection.start;
        const cursor = atEnd ? marker.end : marker.start;
        const next = replaceRange(current, cursor, cursor, insert);
        applyEditorValue(next.value, next.selection);
        return true;
      }
      const next = replaceRange(current, marker.start, marker.end, insert);
      applyEditorValue(next.value, next.selection);
      return true;
    },
    [applyEditorValue, insertPastedText],
  );

  const handlePasteMarkerKey = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
      const textarea = event.currentTarget;
      const current = valueRef.current;
      const start = textarea.selectionStart ?? current.length;
      const end = textarea.selectionEnd ?? start;
      const intersecting = markerIntersectingRange(current, start, end);
      if (intersecting && start !== end && (event.key === "Backspace" || event.key === "Delete")) {
        event.preventDefault();
        const next = replaceRange(current, intersecting.start, intersecting.end);
        applyEditorValue(next.value, next.selection);
        return true;
      }
      if (start !== end) return false;

      const plainArrowLeft = event.key === "ArrowLeft" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
      const plainArrowRight = event.key === "ArrowRight" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
      const inside = markerContainingOffset(current, start);
      if (inside && (plainArrowLeft || plainArrowRight || event.key === "Backspace" || event.key === "Delete")) {
        event.preventDefault();
        const cursor = plainArrowLeft || event.key === "Backspace" ? inside.start : inside.end;
        setComposerSelection({ start: cursor, end: cursor, direction: "none" });
        return true;
      }

      const before = markerBeforeCursor(current, start);
      const after = markerAfterCursor(current, start);
      if (plainArrowLeft && before) {
        event.preventDefault();
        setComposerSelection({ start: before.index ?? 0, end: before.index ?? 0, direction: "none" });
        return true;
      }
      if (plainArrowRight && after) {
        event.preventDefault();
        const cursor = (after.index ?? 0) + after[0].length;
        setComposerSelection({ start: cursor, end: cursor, direction: "none" });
        return true;
      }
      if (event.key === "Backspace" && before) {
        event.preventDefault();
        const cursor = before.index ?? 0;
        const next = replaceRange(current, cursor, start);
        applyEditorValue(next.value, next.selection);
        return true;
      }
      if (event.key === "Delete" && after) {
        event.preventDefault();
        const markerStart = after.index ?? 0;
        const next = replaceRange(current, markerStart, markerStart + after[0].length);
        applyEditorValue(next.value, { start, end: start, direction: "none" });
        return true;
      }
      return false;
    },
    [applyEditorValue, setComposerSelection],
  );

  const persistComposerSelection = useCallback(
    (element: HTMLTextAreaElement) => {
      snapSelectionAwayFromPasteMarker(element);
      if (historyIndex === -1) persistTextSelection(composerDraftKey, element);
    },
    [composerDraftKey, historyIndex, snapSelectionAwayFromPasteMarker],
  );

  const undoEditor = useCallback((): boolean => {
    const snapshot = undoStackRef.current.pop();
    if (!snapshot) return false;
    applyEditorValue(snapshot.value, snapshot.selection, { recordUndo: false });
    return true;
  }, [applyEditorValue]);

  const deleteSelectionOrRange = useCallback(
    (start: number, end: number, kill = false): boolean => {
      const current = valueRef.current;
      if (start === end) return false;
      if (kill) addKillRingText(current.slice(start, end));
      const next = replaceRange(current, start, end);
      applyEditorValue(next.value, next.selection);
      return true;
    },
    [addKillRingText, applyEditorValue],
  );

  const insertAtSelection = useCallback(
    (insert: string): boolean => {
      const textarea = textareaRef.current;
      const current = valueRef.current;
      const selection = textarea ? selectionFromTextControl(textarea) : readTextSelectionDraft(composerDraftKey, current);
      const next = replaceRange(current, selection.start, selection.end, insert);
      applyEditorValue(next.value, next.selection);
      return true;
    },
    [applyEditorValue, composerDraftKey],
  );

  const yank = useCallback((): boolean => {
    const text = killRingRef.current[0];
    if (!text) return false;
    const textarea = textareaRef.current;
    const current = valueRef.current;
    const selection = textarea ? selectionFromTextControl(textarea) : readTextSelectionDraft(composerDraftKey, current);
    const next = replaceRange(current, selection.start, selection.end, text);
    applyEditorValue(next.value, next.selection);
    lastYankRef.current = { start: next.selection.start - text.length, end: next.selection.start, ringIndex: 0 };
    return true;
  }, [applyEditorValue, composerDraftKey]);

  const yankPop = useCallback((): boolean => {
    const lastYank = lastYankRef.current;
    if (!lastYank || killRingRef.current.length < 2) return false;
    const nextRingIndex = (lastYank.ringIndex + 1) % killRingRef.current.length;
    const text = killRingRef.current[nextRingIndex] ?? "";
    const current = valueRef.current;
    const next = replaceRange(current, lastYank.start, lastYank.end, text);
    applyEditorValue(next.value, next.selection);
    lastYankRef.current = { start: next.selection.start - text.length, end: next.selection.start, ringIndex: nextRingIndex };
    return true;
  }, [applyEditorValue]);

  const shutdownHtmlSession = useCallback(async () => {
    const api = readNativeApi();
    if (!api) return;
    try {
      await api.pi.hibernate({ threadId: props.threadId });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to exit session.");
    }
  }, [props.threadId]);

  const runPiRpcCommand = useCallback(
    async (commandType: string, payload?: Record<string, unknown>): Promise<unknown> => {
      const api = readNativeApi();
      if (!api) return null;
      const result = await api.pi.rpcCommand({ threadId: props.threadId, commandType, ...(payload ? { payload } : {}) });
      return result.data;
    },
    [props.threadId],
  );

  const refreshPiSessionState = useCallback(async () => {
    try {
      const state = await runPiRpcCommand("get_state");
      setThinkingLevel(thinkingLevelFromState(state));
    } catch {
      // Best-effort status only.
    }
  }, [runPiRpcCommand]);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      if (disposed) return;
      await refreshPiSessionState();
    };
    void refresh();
    const intervalId = window.setInterval(() => void refresh(), 5_000);
    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [refreshPiSessionState]);

  const cycleModel = useCallback(
    async (direction: 1 | -1) => {
      try {
        const state = await runPiRpcCommand("get_state");
        const modelsResponse = await runPiRpcCommand("get_available_models");
        const models = isRecord(modelsResponse) && Array.isArray(modelsResponse.models)
          ? modelsResponse.models.flatMap((model) => {
              const option = modelOptionFromUnknown(model);
              return option ? [option] : [];
            })
          : [];
        if (models.length === 0) return;
        const currentModel = isRecord(state) ? modelOptionFromUnknown(state.model) : null;
        const currentIndex = currentModel ? models.findIndex((model) => model.provider === currentModel.provider && model.id === currentModel.id) : -1;
        const next = models[(currentIndex + direction + models.length) % models.length] ?? models[0];
        if (!next) return;
        await runPiRpcCommand("set_model", { provider: next.provider, modelId: next.id });
        await refreshPiSessionState();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to cycle model.");
      }
    },
    [refreshPiSessionState, runPiRpcCommand],
  );

  const cycleThinkingLevel = useCallback(async () => {
    try {
      const result = await runPiRpcCommand("cycle_thinking_level");
      if (isRecord(result) && typeof result.level === "string") {
        setThinkingLevel(normalizeThinkingLevel(result.level));
      } else {
        await refreshPiSessionState();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cycle thinking level.");
    }
  }, [refreshPiSessionState, runPiRpcCommand]);

  const openModelSelector = useCallback(async () => {
    try {
      const state = await runPiRpcCommand("get_state");
      const modelsResponse = await runPiRpcCommand("get_available_models");
      const models = isRecord(modelsResponse) && Array.isArray(modelsResponse.models)
        ? modelsResponse.models.flatMap((model) => {
            const option = modelOptionFromUnknown(model);
            return option ? [option] : [];
          })
        : [];
      const currentModel = isRecord(state) ? modelOptionFromUnknown(state.model) : null;
      const selectedIndex = currentModel ? models.findIndex((model) => model.provider === currentModel.provider && model.id === currentModel.id) : -1;
      setModelOptions(models);
      setSelectedModelIndex(Math.max(0, selectedIndex));
      setModelSelectOpen(models.length > 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load models.");
    }
  }, [runPiRpcCommand]);

  const selectModel = useCallback(
    async (model: PiModelOption) => {
      try {
        await runPiRpcCommand("set_model", { provider: model.provider, modelId: model.id });
        await refreshPiSessionState();
        setModelSelectOpen(false);
        requestAnimationFrame(() => focusTextControl(composerDraftKey, textareaRef.current));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to set model.");
      }
    },
    [composerDraftKey, refreshPiSessionState, runPiRpcCommand],
  );

  const handleEditorKeymap = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
      const current = valueRef.current;
      const selection = selectionFromTextControl(event.currentTarget);
      const hasSelection = selection.start !== selection.end;
      const key = event.key;
      const lowerKey = key.toLowerCase();
      const mac = isMacLikePlatform();
      const wordLeft = (mac ? event.altKey && !event.metaKey && !event.ctrlKey : event.ctrlKey && !event.altKey && !event.metaKey) && lowerKey === "arrowleft";
      const wordRight = (mac ? event.altKey && !event.metaKey && !event.ctrlKey : event.ctrlKey && !event.altKey && !event.metaKey) && lowerKey === "arrowright";
      const lineLeft = (mac ? event.metaKey && !event.altKey && !event.ctrlKey && lowerKey === "arrowleft" : event.key === "Home") && !event.shiftKey;
      const lineRight = (mac ? event.metaKey && !event.altKey && !event.ctrlKey && lowerKey === "arrowright" : event.key === "End") && !event.shiftKey;

      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (key === "-" || key === "_")) {
        event.preventDefault();
        return undoEditor();
      }
      if (event.key === "Tab" && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        void cycleThinkingLevel();
        return true;
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && lowerKey === "p") {
        event.preventDefault();
        void cycleModel(event.shiftKey ? -1 : 1);
        return true;
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && lowerKey === "l") {
        event.preventDefault();
        void openModelSelector();
        return true;
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && lowerKey === "a") {
        event.preventDefault();
        setComposerSelection({ start: lineStart(current, selection.start), end: lineStart(current, selection.start), direction: "none" });
        return true;
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && lowerKey === "e") {
        event.preventDefault();
        const cursor = lineEnd(current, selection.end);
        setComposerSelection({ start: cursor, end: cursor, direction: "none" });
        return true;
      }
      if (lineLeft) {
        event.preventDefault();
        const cursor = lineStart(current, selection.start);
        setComposerSelection({ start: cursor, end: cursor, direction: "none" });
        return true;
      }
      if (lineRight) {
        event.preventDefault();
        const cursor = lineEnd(current, selection.end);
        setComposerSelection({ start: cursor, end: cursor, direction: "none" });
        return true;
      }
      if (wordLeft) {
        event.preventDefault();
        if (event.shiftKey) {
          setComposerSelection(extendSelectionByWord(current, selection, "left"));
          return true;
        }
        const cursor = previousWordStart(current, selection.start);
        setComposerSelection({ start: cursor, end: cursor, direction: "none" });
        return true;
      }
      if (wordRight) {
        event.preventDefault();
        if (event.shiftKey) {
          setComposerSelection(extendSelectionByWord(current, selection, "right"));
          return true;
        }
        const cursor = nextWordEnd(current, selection.end);
        setComposerSelection({ start: cursor, end: cursor, direction: "none" });
        return true;
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && lowerKey === "k") {
        event.preventDefault();
        const end = lineEnd(current, selection.end);
        if (deleteSelectionOrRange(selection.start, end, true)) return true;
        if (end < current.length) return deleteSelectionOrRange(selection.start, end + 1, true);
        return true;
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && lowerKey === "u") {
        event.preventDefault();
        return deleteSelectionOrRange(lineStart(current, selection.start), selection.end, true) || true;
      }
      if ((event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && lowerKey === "w") || (event.altKey && !event.metaKey && !event.ctrlKey && key === "Backspace")) {
        event.preventDefault();
        return hasSelection
          ? deleteSelectionOrRange(selection.start, selection.end, true)
          : deleteSelectionOrRange(previousWordStart(current, selection.start), selection.start, true) || true;
      }
      if (event.altKey && !event.metaKey && !event.ctrlKey && (lowerKey === "d" || key === "Delete")) {
        event.preventDefault();
        return hasSelection
          ? deleteSelectionOrRange(selection.start, selection.end, true)
          : deleteSelectionOrRange(selection.start, nextWordEnd(current, selection.start), true) || true;
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && lowerKey === "y") {
        event.preventDefault();
        return yank();
      }
      if (event.altKey && !event.metaKey && !event.ctrlKey && lowerKey === "y") {
        event.preventDefault();
        return yankPop();
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && lowerKey === "d") {
        event.preventDefault();
        if (current.length === 0) {
          void shutdownHtmlSession();
          return true;
        }
        return hasSelection
          ? deleteSelectionOrRange(selection.start, selection.end)
          : deleteSelectionOrRange(selection.start, Math.min(current.length, selection.start + 1)) || true;
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && lowerKey === "c" && !hasSelection) {
        event.preventDefault();
        const now = Date.now();
        if (now - lastClearShortcutAtRef.current < 500 && current.length === 0) {
          void shutdownHtmlSession();
          return true;
        }
        lastClearShortcutAtRef.current = now;
        applyEditorValue("", { start: 0, end: 0, direction: "none" });
        return true;
      }
      if (event.key === "PageUp" || event.key === "PageDown") {
        return false;
      }
      return false;
    },
    [applyEditorValue, cycleModel, cycleThinkingLevel, deleteSelectionOrRange, openModelSelector, setComposerSelection, shutdownHtmlSession, undoEditor, yank, yankPop],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (modelSelectOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          setModelSelectOpen(false);
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSelectedModelIndex((index) => (index + 1) % Math.max(1, modelOptions.length));
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setSelectedModelIndex((index) => (index - 1 + Math.max(1, modelOptions.length)) % Math.max(1, modelOptions.length));
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          const model = modelOptions[selectedModelIndex] ?? modelOptions[0];
          if (model) void selectModel(model);
          return;
        }
      }
      if (handlePasteMarkerKey(event)) return;
      if (suggestions.length > 0) {
        if (event.key === "Escape" || (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "c")) {
          event.preventDefault();
          setDismissedSuggestionToken(activeSuggestionToken);
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSelectedSuggestionIndex((index) => (index + 1) % suggestions.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setSelectedSuggestionIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
          return;
        }
        if (event.key === "PageDown") {
          event.preventDefault();
          setSelectedSuggestionIndex((index) => Math.min(suggestions.length - 1, index + MAX_SUGGESTIONS));
          return;
        }
        if (event.key === "PageUp") {
          event.preventDefault();
          setSelectedSuggestionIndex((index) => Math.max(0, index - MAX_SUGGESTIONS));
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          applySuggestion(suggestions[selectedSuggestionIndex] ?? suggestions[0]!);
          return;
        }
        if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          const selected = suggestions[selectedSuggestionIndex] ?? suggestions[0]!;
          if (selected.type === "command") {
            void submit(selected.value.trim());
          } else {
            applySuggestion(selected);
          }
          return;
        }
      } else if (event.key === "Tab" && rawSuggestions.length > 0 && activeSuggestionToken) {
        event.preventDefault();
        setDismissedSuggestionToken(null);
        setSelectedSuggestionIndex(0);
        return;
      }

      if (isBusy && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "c") {
        const start = event.currentTarget.selectionStart ?? value.length;
        const end = event.currentTarget.selectionEnd ?? start;
        if (start === end) {
          event.preventDefault();
          void abort();
          return;
        }
      }

      if (handleEditorKeymap(event)) return;

      if (!event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const start = event.currentTarget.selectionStart ?? value.length;
        const end = event.currentTarget.selectionEnd ?? start;
        const collapsed = start === end;
        if (event.key === "ArrowUp" && collapsed && (historyIndex > -1 || start === 0 || value.length === 0)) {
          if (navigateHistory(-1)) {
            event.preventDefault();
            return;
          }
        }
        if (event.key === "ArrowDown" && collapsed && historyIndex > -1 && value.indexOf("\n", end) === -1) {
          if (navigateHistory(1)) {
            event.preventDefault();
            return;
          }
        }
      }

      if (event.key === "Enter" && (event.shiftKey || event.altKey) && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        if (event.altKey) {
          void submit(undefined, isBusy ? "followUp" : undefined);
          return;
        }
        insertAtSelection("\n");
        return;
      }

      if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        const textarea = event.currentTarget;
        const cursor = textarea.selectionStart ?? value.length;
        if (cursor > 0 && value[cursor - 1] === "\\") {
          const next = replaceRange(value, cursor - 1, cursor, "\n");
          applyEditorValue(next.value, next.selection);
          return;
        }
        void submit();
        return;
      }

      if (event.key === "Escape" && isBusy) {
        event.preventDefault();
        void abort();
      }
    },
    [abort, activeSuggestionToken, applyEditorValue, applySuggestion, handleEditorKeymap, handlePasteMarkerKey, historyIndex, insertAtSelection, isBusy, modelOptions, modelSelectOpen, navigateHistory, rawSuggestions.length, selectModel, selectedModelIndex, selectedSuggestionIndex, submit, suggestions, value],
  );

  return (
    <div
      className="relative shrink-0 px-0 py-0"
      style={{
        backgroundColor: props.theme.background,
        color: themeText(props.theme),
        lineHeight: TERMINAL_LINE_HEIGHT,
      }}
    >
      {modelSelectOpen && (
        <div
          className="absolute bottom-full left-0 right-0 z-30 max-h-64 overflow-y-auto border shadow-2xl"
          style={{
            borderColor: props.piTheme.borderMuted,
            backgroundColor: props.theme.background,
            color: themeText(props.theme),
          }}
        >
          {modelOptions.map((model, index) => (
            <button
              key={model.label}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void selectModel(model)}
              className="flex w-full items-center gap-3 px-[1ch] py-0 text-left text-[1em]"
              style={index === selectedModelIndex ? selectedStyle(props.theme) : { color: themeText(props.theme) }}
            >
              <span className="min-w-0 flex-1 truncate">{model.label}</span>
            </button>
          ))}
        </div>
      )}
      {suggestions.length > 0 && !modelSelectOpen && (
        <div
          className="absolute bottom-full left-0 right-0 z-20 max-h-64 overflow-y-auto border shadow-2xl"
          style={{
            borderColor: props.piTheme.borderMuted,
            backgroundColor: props.theme.background,
            color: themeText(props.theme),
          }}
        >
          {suggestions.map((suggestion, index) => (
            <button
              key={`${suggestion.type}:${suggestion.value}`}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => applySuggestion(suggestion)}
              className="flex w-full items-center gap-3 px-[1ch] py-0 text-left text-[1em]"
              style={index === selectedSuggestionIndex ? selectedStyle(props.theme) : { color: themeText(props.theme) }}
            >
              <span className="min-w-0 flex-1 truncate">{suggestion.label}</span>
              {suggestion.description && (
                <span className="max-w-[50%] truncate" style={{ color: themeMuted(props.theme) }}>{suggestion.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
      <PiQueuedPromptPreview prompts={pendingPrompts} theme={props.theme} piTheme={props.piTheme} />
      <div className="relative">
        <pre className="m-0 overflow-hidden whitespace-pre" style={{ color: composerRuleColor, lineHeight: TERMINAL_LINE_HEIGHT }}>{"─".repeat(180)}</pre>
        {thinkingLevelLabel && (
          <span
            className="absolute right-0 top-0 px-[0.5ch] text-[1em]"
            style={{ backgroundColor: props.theme.background, color: composerRuleColor, lineHeight: TERMINAL_LINE_HEIGHT }}
          >
            {thinkingLevelLabel}
          </span>
        )}
      </div>
      <div className={`flex px-0 ${composerVisualRows === 1 ? "items-center" : "items-start"}`}>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => {
            const selection = {
              start: event.currentTarget.selectionStart ?? event.currentTarget.value.length,
              end: event.currentTarget.selectionEnd ?? event.currentTarget.value.length,
              direction: event.currentTarget.selectionDirection ?? "none" as const,
            };
            updateDraftValue(event.target.value, selection);
          }}
          onSelect={(event) => persistComposerSelection(event.currentTarget)}
          onKeyUp={(event) => persistComposerSelection(event.currentTarget)}
          onMouseUp={(event) => persistComposerSelection(event.currentTarget)}
          onBlur={(event) => persistComposerSelection(event.currentTarget)}
          onBeforeInput={handlePasteMarkerBeforeInput}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          rows={1}
          spellCheck={false}
          aria-label="message pi"
          className="flex-1 resize-none overflow-hidden border-0 bg-transparent p-0 text-[1em] outline-none"
          style={{
            color: themeText(props.theme),
            caretColor: props.theme.cursor ?? themeText(props.theme),
            lineHeight: TERMINAL_LINE_HEIGHT,
          }}
        />
      </div>
      <pre className="m-0 overflow-hidden whitespace-pre" style={{ color: composerRuleColor, lineHeight: TERMINAL_LINE_HEIGHT }}>{"─".repeat(180)}</pre>
      <PiHtmlFooterStatus
        threadId={props.threadId}
        theme={props.theme}
        piTheme={props.piTheme}
        extensionUiState={props.extensionUiState}
        usageStats={props.usageStats}
      />
      {submitting && <pre className="m-0" style={{ color: props.piTheme.muted, lineHeight: TERMINAL_LINE_HEIGHT }}>sending…</pre>}
      {error && <pre className="m-0" style={{ color: props.theme.red ?? themeText(props.theme), lineHeight: TERMINAL_LINE_HEIGHT }}>{error}</pre>}
    </div>
  );
}

export default function PiHtmlThreadView(props: PiHtmlThreadViewProps) {
  const { items, liveItems, uiRequest, extensionUiState, editorTextRequest, usageStats, clearUiRequest, loadState, error } = usePiTranscript(props.threadId);
  const { settings } = useAppSettings();
  const thread = useStore((s) => s.threads.find((t) => t.id === props.threadId));
  const baseTerminalTheme = terminalThemeFromApp();
  const piTheme = piHtmlThemeFromApp(baseTerminalTheme);
  const terminalTheme = piTheme.terminal;
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerFocusRef = useRef<(() => void) | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number; target: HTMLElement | null } | null>(null);
  const atBottomRef = useRef(true);
  const previousVisibleCountRef = useRef(0);
  const localNoticeIdRef = useRef(0);
  const [showNewOutput, setShowNewOutput] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [thinkingVisible, setThinkingVisible] = useState(true);
  const [localNotices, setLocalNotices] = useState<PiLocalNotice[]>([]);
  const visibleLiveItems = useMemo(() => {
    if (liveItems.length === 0) return [];
    const persistedSignatures = new Set(items.map(transcriptSignature));
    return liveItems.filter((item) => !persistedSignatures.has(transcriptSignature(item)));
  }, [items, liveItems]);
  const localNoticeItems = useMemo<PiTranscriptItem[]>(() => localNotices.map((notice) => ({
    id: `local-notice:${notice.id}`,
    role: "system",
    text: notice.text,
    parts: [{ type: "text", text: notice.text }],
    createdAt: notice.createdAt,
    ...(notice.isError ? { isError: true } : {}),
  })), [localNotices]);
  const visibleItems = useMemo(() => mergeToolResultsForDisplay([...items, ...visibleLiveItems, ...localNoticeItems]), [items, localNoticeItems, visibleLiveItems]);
  const showThinkingPlaceholder = thinkingVisible && thread?.hookStatus === "working" && visibleLiveItems.length === 0;
  const promptHistory = useMemo(() => transcriptPromptHistory(items), [items]);
  const promptTranscriptUserTexts = useMemo(() => transcriptUserTexts(items), [items]);
  const searchMatches = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    return visibleItems.flatMap((item, index) => itemText(item).toLowerCase().includes(query) ? [index] : []);
  }, [searchQuery, visibleItems]);
  const activeSearchRowIndex = searchMatches.length > 0 ? (searchMatches[searchIndex % searchMatches.length] ?? null) : null;
  const virtualRows = useMemo<PiVirtualTranscriptRow[]>(() => {
    const rows = visibleItems.map<PiVirtualTranscriptRow>((item, index) => ({ type: "item", key: `item:${item.id}`, item, itemIndex: index }));
    if (showThinkingPlaceholder) rows.push({ type: "thinking", key: "thinking-placeholder" });
    if (error) rows.push({ type: "error", key: "transcript-error", text: error });
    return rows;
  }, [error, showThinkingPlaceholder, visibleItems]);
  const transcriptVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: virtualRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimatePiTranscriptRowHeight(virtualRows[index], settings.terminalFontSize),
    getItemKey: (index) => virtualRows[index]?.key ?? index,
    overscan: PI_HTML_TRANSCRIPT_OVERSCAN,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: PI_HTML_SCROLL_END_THRESHOLD_PX,
  });
  const virtualItems = transcriptVirtualizer.getVirtualItems();

  useEffect(() => {
    setLocalNotices([]);
    localNoticeIdRef.current = 0;
  }, [props.threadId]);

  useEffect(() => {
    transcriptVirtualizer.measure();
  }, [settings.terminalFontSize, thinkingVisible, toolsExpanded, transcriptVirtualizer]);

  useLayoutEffect(() => {
    const previousCount = previousVisibleCountRef.current;
    previousVisibleCountRef.current = visibleItems.length;
    if (atBottomRef.current) {
      transcriptVirtualizer.scrollToEnd({ behavior: "auto" });
      setShowNewOutput(false);
      return;
    }
    if (visibleItems.length > previousCount) setShowNewOutput(true);
  }, [showThinkingPlaceholder, transcriptVirtualizer, visibleItems.length, virtualRows.length]);

  useEffect(() => {
    if (!searchOpen || activeSearchRowIndex === null) return;
    transcriptVirtualizer.scrollToIndex(activeSearchRowIndex, { align: "center", behavior: "auto" });
  }, [activeSearchRowIndex, searchOpen, transcriptVirtualizer]);

  const onScroll = useCallback(() => {
    const isAtEnd = transcriptVirtualizer.isAtEnd(PI_HTML_SCROLL_END_THRESHOLD_PX);
    atBottomRef.current = isAtEnd;
    if (isAtEnd) setShowNewOutput(false);
  }, [transcriptVirtualizer]);

  const registerComposerFocus = useCallback((focus: (() => void) | null) => {
    composerFocusRef.current = focus;
  }, []);

  const addLocalNotice = useCallback((text: string, options?: { isError?: boolean }) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = ++localNoticeIdRef.current;
    setLocalNotices((current) => [
      ...current,
      { id, text: trimmed, isError: options?.isError === true, createdAt: new Date().toISOString() },
    ]);
  }, []);

  const goToSearchMatch = useCallback((direction: -1 | 1) => {
    if (searchMatches.length === 0) return;
    setSearchIndex((index) => (index + direction + searchMatches.length) % searchMatches.length);
  }, [searchMatches.length]);

  const scrollToBottom = useCallback(() => {
    transcriptVirtualizer.scrollToEnd({ behavior: "auto" });
    atBottomRef.current = true;
    setShowNewOutput(false);
  }, [transcriptVirtualizer]);

  const handleRootKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const key = event.key.toLowerCase();
      const searchShortcut = key === "f" && !event.altKey && !event.shiftKey && (isMacLikePlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
      if (searchShortcut) {
        event.preventDefault();
        event.stopPropagation();
        setSearchOpen(true);
        setSearchIndex(0);
        return;
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && key === "o") {
        event.preventDefault();
        event.stopPropagation();
        setToolsExpanded((expanded) => !expanded);
        return;
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && key === "t") {
        event.preventDefault();
        event.stopPropagation();
        setThinkingVisible((visible) => !visible);
        return;
      }
      if (searchOpen && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setSearchOpen(false);
        requestAnimationFrame(() => composerFocusRef.current?.());
      }
    },
    [searchOpen],
  );

  const showComposer = props.showComposer === true;
  const showInputComposer = showComposer && !uiRequest;

  const handleRootPasteCapture = useCallback(
    (event: ReactClipboardEvent<HTMLDivElement>) => {
      if (!showInputComposer || event.defaultPrevented) return;
      const target = isHTMLElement(event.target) ? event.target : null;
      if (isEditableTarget(target) || isInteractiveTarget(target) || isInsideKeyboardOwner(target)) return;
      const text = clipboardPlainText(event.clipboardData);
      if (!text) return;
      event.preventDefault();
      event.stopPropagation();
      dispatchPiHtmlComposerInsert({ threadId: props.threadId, text, source: "paste" });
    },
    [props.threadId, showInputComposer],
  );

  const handleRootPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    pointerStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      target: isHTMLElement(event.target) ? event.target : null,
    };
  }, []);

  const handleRootPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!showInputComposer) return;
      const start = pointerStartRef.current;
      pointerStartRef.current = null;
      const target = isHTMLElement(event.target) ? event.target : null;
      const originalTarget = start?.target ?? target;
      if (isEditableTarget(originalTarget) || isInteractiveTarget(originalTarget) || isInsideKeyboardOwner(originalTarget)) return;
      if (Math.abs(event.clientX - (start?.x ?? event.clientX)) > 4 || Math.abs(event.clientY - (start?.y ?? event.clientY)) > 4) return;
      if (window.getSelection()?.toString()) return;
      requestAnimationFrame(() => composerFocusRef.current?.());
    },
    [showInputComposer],
  );

  return (
    <div
      ref={rootRef}
      onPointerDownCapture={handleRootPointerDown}
      onPointerUpCapture={handleRootPointerUp}
      onPasteCapture={handleRootPasteCapture}
      onKeyDownCapture={handleRootKeyDown}
      className="flex h-full min-h-0 flex-col"
      style={{
        backgroundColor: terminalTheme.background,
        color: terminalTheme.foreground,
        fontFamily: settings.terminalFontFamily,
        fontSize: `${settings.terminalFontSize}px`,
        lineHeight: TERMINAL_LINE_HEIGHT,
      }}
    >
      {searchOpen && (
        <div
          className="flex shrink-0 items-center gap-[1ch] border-b px-[1ch] py-0"
          style={{ borderColor: piTheme.borderMuted, backgroundColor: terminalTheme.background, color: themeText(terminalTheme) }}
        >
          <span style={{ color: piTheme.accent }}>find</span>
          <input
            autoFocus
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setSearchIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                goToSearchMatch(event.shiftKey ? -1 : 1);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setSearchOpen(false);
                requestAnimationFrame(() => composerFocusRef.current?.());
              }
            }}
            className="min-w-0 flex-1 border-0 bg-transparent p-0 outline-none"
            style={{ color: themeText(terminalTheme), caretColor: terminalTheme.cursor ?? themeText(terminalTheme) }}
          />
          <button type="button" onClick={() => goToSearchMatch(-1)} style={{ color: themeText(terminalTheme) }}>↑</button>
          <button type="button" onClick={() => goToSearchMatch(1)} style={{ color: themeText(terminalTheme) }}>↓</button>
          <span style={{ color: themeMuted(terminalTheme) }}>{searchMatches.length === 0 ? "0/0" : `${searchIndex + 1}/${searchMatches.length}`}</span>
          <button type="button" onClick={() => setSearchOpen(false)} style={{ color: themeText(terminalTheme) }}>×</button>
        </div>
      )}
      <div ref={scrollRef} role="log" aria-live="polite" onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto">
        {virtualRows.length === 0 && loadState !== "error" && (
          <pre className="m-0" style={{ color: themeMuted(terminalTheme), lineHeight: TERMINAL_LINE_HEIGHT }}>{loadState === "loading" ? "Loading transcript…" : ""}</pre>
        )}
        <div className="relative w-full" style={{ height: `${transcriptVirtualizer.getTotalSize()}px` }}>
          {virtualItems.map((virtualItem) => {
            const row = virtualRows[virtualItem.index];
            if (!row) return null;
            const isActiveSearchRow = row.type === "item" && row.itemIndex === activeSearchRowIndex;
            const rowMarginEm = piVirtualRowOuterMarginEm(row, toolsExpanded);
            const previousRowMarginEm = piVirtualRowOuterMarginEm(virtualRows[virtualItem.index - 1], toolsExpanded);
            const gapBeforeEm = virtualItem.index === 0 ? rowMarginEm : Math.max(previousRowMarginEm, rowMarginEm);
            const gapAfterEm = virtualItem.index === virtualRows.length - 1 ? rowMarginEm : 0;
            return (
              <div
                key={String(virtualItem.key)}
                ref={transcriptVirtualizer.measureElement}
                data-index={virtualItem.index}
                data-pi-row-index={row.type === "item" ? row.itemIndex : undefined}
                className="absolute left-0 top-0 flow-root w-full [&>:first-child]:mt-0 [&>:last-child]:mb-0"
                style={{
                  paddingTop: gapBeforeEm ? `${gapBeforeEm}em` : undefined,
                  paddingBottom: gapAfterEm ? `${gapAfterEm}em` : undefined,
                  transform: `translateY(${virtualItem.start}px)`,
                  ...(isActiveSearchRow ? { outline: `1px solid ${piTheme.borderAccent}`, outlineOffset: "-1px" } : {}),
                }}
              >
                {row.type === "item" ? (
                  <MemoizedPiTranscriptRow item={row.item} theme={terminalTheme} piTheme={piTheme} toolsExpanded={toolsExpanded} thinkingVisible={thinkingVisible} />
                ) : row.type === "thinking" ? (
                  <PiThinkingPlaceholder active piTheme={piTheme} />
                ) : (
                  <pre className="m-0" style={{ color: terminalTheme.red ?? themeText(terminalTheme), lineHeight: TERMINAL_LINE_HEIGHT }}>{row.text}</pre>
                )}
              </div>
            );
          })}
        </div>
        {showNewOutput && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="sticky bottom-0 left-1/2 z-10 block border px-[1ch] py-0 text-[1em]"
            style={{ borderColor: piTheme.borderMuted, backgroundColor: terminalTheme.background, color: piTheme.accent, lineHeight: TERMINAL_LINE_HEIGHT }}
          >
            new output ↓
          </button>
        )}
      </div>
      <PiExtensionWidgets widgets={extensionUiState.widgets} placement="aboveEditor" theme={terminalTheme} />
      {uiRequest && <PiExtensionUiPrompt key={`${props.threadId}:${uiRequest.id}`} threadId={props.threadId} request={uiRequest} onDone={clearUiRequest} theme={terminalTheme} />}
      {showInputComposer ? (
        <PiHtmlComposer
          key={props.threadId}
          threadId={props.threadId}
          theme={terminalTheme}
          piTheme={piTheme}
          extensionUiState={extensionUiState}
          usageStats={usageStats}
          history={promptHistory}
          transcriptUserTexts={promptTranscriptUserTexts}
          editorTextRequest={editorTextRequest}
          autoFocusEnabled
          registerFocus={registerComposerFocus}
          onLocalNotice={addLocalNotice}
        />
      ) : showComposer ? (
        <PiHtmlFooterStatus
          threadId={props.threadId}
          theme={terminalTheme}
          piTheme={piTheme}
          extensionUiState={extensionUiState}
          usageStats={usageStats}
        />
      ) : null}
      <PiExtensionWidgets widgets={extensionUiState.widgets} placement="belowEditor" theme={terminalTheme} />
      {props.footer}
    </div>
  );
}
