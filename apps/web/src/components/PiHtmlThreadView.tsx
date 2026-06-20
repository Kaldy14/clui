import type {
  PiCommandSuggestion,
  PiExtensionUiState,
  PiExtensionUiWidget,
  PiSessionUsageStats,
  PiTranscriptItem,
  PiTranscriptPart,
  ThreadId,
} from "@clui/contracts";
import type { ITheme } from "@xterm/xterm";
import type {
  CSSProperties,
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  SetStateAction,
  WheelEvent as ReactWheelEvent,
} from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAppSettings } from "../appSettings";
import { registerHarnessOutputSubscription } from "../lib/harnessOutputSubscriptions";
import { TERMINAL_LINE_HEIGHT } from "../lib/terminalSurfaceTheme";
import { terminalThemeFromApp } from "../lib/terminalTheme";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";

const TRANSCRIPT_REFRESH_DELAY_MS = 120;
const MAX_SUGGESTIONS = 9;
const CLUI_RPC_QUESTIONNAIRE_PREFIX = "__clui_rpc_questionnaire_v1__:";
const CLUI_RPC_PLAN_REVIEW_PREFIX = "__clui_rpc_plan_review_v1__:";

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
  mdCode: "#8abeb7",
  mdCodeBlock: "#b5bd68",
  mdHeading: "#f0c674",
  mdLink: "#81a2be",
  thinkingHigh: "#b294bb",
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
  mdCode: "#5a8080",
  mdCodeBlock: "#588458",
  mdHeading: "#9a7326",
  mdLink: "#547da7",
  thinkingHigh: "#875f87",
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
type Suggestion =
  | { type: "command"; value: string; label: string; description?: string }
  | { type: "file"; value: string; label: string; description?: string };

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
        const handledExtensionUi = applyExtensionUiRequest(setExtensionUiState, event.event);
        if (handledExtensionUi) return;
        const liveItem = liveItemFromRpcEvent(event.event);
        if (liveItem) setLiveItems((current) => mergeLiveItem(current, liveItem));
        scheduleAppend();
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

  return { items, liveItems, uiRequest, extensionUiState, usageStats, clearUiRequest, loadState, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  return event.method === "notify" || event.method === "setTitle" || event.method === "set_editor_text";
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

function liveItemFromRpcEvent(event: unknown): LiveTranscriptItem | null {
  if (!isRecord(event)) return null;
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

type MarkdownSegment =
  | { type: "text"; text: string }
  | { type: "code"; text: string; language?: string };

function markdownSegments(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const fencePattern = /```([^\n`]*)\n?([\s\S]*?)```/gu;
  let lastIndex = 0;
  for (const match of text.matchAll(fencePattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) segments.push({ type: "text", text: text.slice(lastIndex, index) });
    segments.push({
      type: "code",
      text: (match[2] ?? "").replace(/\n$/u, ""),
      ...(match[1]?.trim() ? { language: match[1]?.trim() } : {}),
    });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) segments.push({ type: "text", text: text.slice(lastIndex) });
  return segments.length > 0 ? segments : [{ type: "text", text }];
}

function PiTextBlock(props: {
  text: string;
  color: string;
  piTheme: PiHtmlTheme;
  className?: string;
}) {
  if (!props.text.trim()) return null;
  return (
    <>
      {markdownSegments(props.text).map((segment, index) => (
        <pre
          key={index}
          className={`m-0 whitespace-pre-wrap break-words text-[1em] ${props.className ?? ""}`}
          style={{
            color: segment.type === "code" ? props.piTheme.mdCodeBlock : props.color,
            lineHeight: TERMINAL_LINE_HEIGHT,
          }}
        >
          {segment.text}
        </pre>
      ))}
    </>
  );
}

function PiUserMessage(props: { text: string; piTheme: PiHtmlTheme }) {
  if (!props.text.trim()) return null;
  return (
    <div
      className="relative my-[1.2em] border px-[1ch] py-[1.2em]"
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

function displayToolOutput(normalizedName: string, input: unknown, fallback: string, isError: boolean): string {
  if (isError) return fallback;
  if (normalizedName === "write") return writePreviewFromInput(input) ?? fallback;
  if (normalizedName === "edit") return editPreviewFromInput(input) ?? fallback;
  return fallback;
}

function shouldShowToolOutput(name: string, item: PiTranscriptItem): boolean {
  if (item.isError) return true;
  const normalized = normalizedToolName(name);
  if (normalized === "bash") return true;
  return !COLLAPSED_RESULT_TOOLS.has(normalized);
}

function PiToolOutput(props: { output: string; normalizedName: string; piTheme: PiHtmlTheme }) {
  if (props.normalizedName !== "edit") {
    return <PiTextBlock text={`\n${props.output}`} color={props.piTheme.muted} piTheme={props.piTheme} />;
  }

  const lines = props.output.split("\n");
  return (
    <pre className="m-0 whitespace-pre-wrap break-words pt-[1em] text-[1em]" style={{ lineHeight: TERMINAL_LINE_HEIGHT }}>
      {lines.map((line, index) => {
        const isRemoval = /^-\d*\s/u.test(line) || (line.startsWith("-") && !line.startsWith("---"));
        const isAddition = /^\+\d*\s/u.test(line) || (line.startsWith("+") && !line.startsWith("+++"));
        return (
          <span key={index} style={{ color: isRemoval ? props.piTheme.error : isAddition ? props.piTheme.success : props.piTheme.muted }}>
            {line}
            {index < lines.length - 1 ? "\n" : ""}
          </span>
        );
      })}
    </pre>
  );
}

function PiToolBlock(props: { item: DisplayTranscriptItem; toolCall?: Extract<PiTranscriptPart, { type: "toolCall" }>; piTheme: PiHtmlTheme }) {
  const name = props.toolCall?.name ?? props.item.toolName ?? "tool";
  const normalizedName = normalizedToolName(name);
  const input = props.toolCall?.input ?? {};
  const output = displayToolOutput(
    normalizedName,
    input,
    props.item.mergedToolOutput ?? toolOutputText(props.item.parts),
    props.item.isError === true,
  );
  const showOutput = output.trim().length > 0 && shouldShowToolOutput(name, props.item);
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
      {showOutput && <PiToolOutput output={output} normalizedName={normalizedName} piTheme={props.piTheme} />}
    </div>
  );
}

function shouldHideStandaloneToolResult(item: PiTranscriptItem): boolean {
  if (item.role !== "toolResult" || item.isError) return false;
  const normalized = normalizedToolName(item.toolName ?? "");
  return COLLAPSED_RESULT_TOOLS.has(normalized);
}

function systemDisplayText(item: PiTranscriptItem, text: string): string {
  if (item.role !== "system") return text;
  const modelMatch = /^([^/\s]+)\/(.+)$/u.exec(text.trim());
  return modelMatch ? `Model scope: ${modelMatch[2]}` : text;
}

function PiTranscriptRow(props: { item: DisplayTranscriptItem; theme: ITheme; piTheme: PiHtmlTheme }) {
  const text = systemDisplayText(props.item, itemText(props.item));
  if (!text.trim()) return null;

  if (props.item.role === "user") {
    return <PiUserMessage text={text} piTheme={props.piTheme} />;
  }

  if (shouldHideStandaloneToolResult(props.item)) return null;

  const toolCallParts = props.item.parts.filter(
    (part): part is Extract<PiTranscriptPart, { type: "toolCall" }> => part.type === "toolCall",
  );
  if (toolCallParts.length > 0) {
    return (
      <>
        {props.item.parts.map((part, index) => {
          if (part.type === "toolCall") {
            return <PiToolBlock key={`${props.item.id}:tool:${index}`} item={props.item} toolCall={part} piTheme={props.piTheme} />;
          }
          const partText = renderPartText(part);
          return (
            <PiTextBlock
              key={`${props.item.id}:part:${index}`}
              text={partText}
              color={part.type === "thinking" ? props.piTheme.muted : (rowStyle(props.item, props.theme).color as string)}
              piTheme={props.piTheme}
            />
          );
        })}
      </>
    );
  }

  if (props.item.role === "toolResult" || props.item.role === "bashExecution") {
    return <PiToolBlock item={props.item} piTheme={props.piTheme} />;
  }

  return <PiTextBlock text={text} color={rowStyle(props.item, props.theme).color as string} piTheme={props.piTheme} />;
}

function findCommandToken(value: string): { query: string } | null {
  const beforeCursor = value;
  if (!beforeCursor.startsWith("/")) return null;
  if (/\s/u.test(beforeCursor)) return null;
  return { query: beforeCursor.slice(1).toLowerCase() };
}

function findFileToken(value: string): { prefix: string; query: string; start: number; end: number } | null {
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(value);
  if (!match || match.index === undefined) return null;
  const full = match[0] ?? "";
  const query = match[1] ?? "";
  const atOffset = full.indexOf("@");
  const start = match.index + atOffset;
  return { prefix: `@${query}`, query, start, end: value.length };
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
const fallbackDraftMemory = new Map<string, string>();

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
  const statusSegments = useMemo(() => {
    const segments = statusEntries.map((status) => ({ kind: "ansi" as const, text: status }));
    if (!usageSummary) return segments;
    const codexIndex = segments.findIndex((segment) => cleanTranscriptText(segment.text).includes("Codex"));
    const insertIndex = codexIndex >= 0 ? codexIndex + 1 : segments.length;
    return [
      ...segments.slice(0, insertIndex),
      { kind: "text" as const, text: usageSummary },
      ...segments.slice(insertIndex),
    ];
  }, [statusEntries, usageSummary]);

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
  autoFocusEnabled: boolean;
  registerFocus: (focus: (() => void) | null) => void;
}) {
  const composerDraftKey = `composer:${props.threadId}`;
  const [value, setValue, clearValue] = usePersistentDraftState(composerDraftKey, () => "");
  const [commands, setCommands] = useState<PiCommandSuggestion[]>([]);
  const [fileSuggestions, setFileSuggestions] = useState<Suggestion[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const thread = useStore((s) => s.threads.find((t) => t.id === props.threadId));
  const project = useStore((s) => s.projects.find((p) => p.id === thread?.projectId));
  const hookStatus = thread?.hookStatus ?? null;
  const cwd = thread?.worktreePath ?? project?.cwd ?? null;
  const isBusy = hookStatus === "working";
  const commandToken = useMemo(() => findCommandToken(value), [value]);
  const fileToken = useMemo(() => findFileToken(value), [value]);
  const suggestions = commandToken
    ? commandSuggestions(commands, commandToken.query)
    : fileToken
      ? fileSuggestions
      : [];
  const lineCount = Math.min(6, Math.max(1, value.split("\n").length));

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
    const api = readNativeApi();
    if (!api) return;
    void api.pi
      .getCommands({ threadId: props.threadId })
      .then((result) => setCommands([...result.commands]))
      .catch(() => undefined);
  }, [props.threadId]);

  useEffect(() => {
    setSelectedSuggestionIndex(0);
  }, [commandToken?.query, fileToken?.query]);

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
      if (suggestion.type === "command") {
        const cursor = suggestion.value.length;
        setValue(suggestion.value);
        writeTextSelectionDraft(composerDraftKey, { start: cursor, end: cursor, direction: "none" });
        requestAnimationFrame(() => focusTextControl(composerDraftKey, textareaRef.current));
        return;
      }
      const currentFileToken = findFileToken(value);
      if (!currentFileToken) return;
      const next = `${value.slice(0, currentFileToken.start)}${suggestion.value}${value.slice(
        currentFileToken.end,
      )}`;
      const cursor = currentFileToken.start + suggestion.value.length;
      setValue(next);
      writeTextSelectionDraft(composerDraftKey, { start: cursor, end: cursor, direction: "none" });
      requestAnimationFrame(() => focusTextControl(composerDraftKey, textareaRef.current));
    },
    [composerDraftKey, setValue, value],
  );

  const submit = useCallback(async () => {
    const message = value.trim();
    if (!message || submitting) return;
    const api = readNativeApi();
    if (!api) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.pi.prompt({
        threadId: props.threadId,
        message,
        ...(isBusy ? { streamingBehavior: "steer" as const } : {}),
      });
      clearValue();
      clearTextSelectionDraft(composerDraftKey);
      setValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send prompt.");
    } finally {
      setSubmitting(false);
      requestAnimationFrame(() => focusTextControl(composerDraftKey, textareaRef.current));
    }
  }, [clearValue, composerDraftKey, isBusy, props.threadId, setValue, submitting, value]);

  const abort = useCallback(async () => {
    const api = readNativeApi();
    if (!api) return;
    try {
      await api.pi.abort({ threadId: props.threadId });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to abort.");
    }
  }, [props.threadId]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (suggestions.length > 0) {
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
        if (event.key === "Tab") {
          event.preventDefault();
          applySuggestion(suggestions[selectedSuggestionIndex] ?? suggestions[0]!);
          return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          applySuggestion(suggestions[selectedSuggestionIndex] ?? suggestions[0]!);
          return;
        }
      }

      if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        void submit();
        return;
      }

      if (event.key === "Escape" && value.length === 0 && isBusy) {
        event.preventDefault();
        void abort();
      }
    },
    [abort, applySuggestion, isBusy, selectedSuggestionIndex, submit, suggestions, value.length],
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
      {suggestions.length > 0 && (
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
      <pre className="m-0 overflow-hidden whitespace-pre" style={{ color: props.piTheme.thinkingHigh, lineHeight: TERMINAL_LINE_HEIGHT }}>{"─".repeat(180)}</pre>
      <div className={`flex px-0 ${lineCount === 1 ? "items-center" : "items-start"}`}>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            persistTextSelection(composerDraftKey, event.currentTarget);
          }}
          onSelect={(event) => persistTextSelection(composerDraftKey, event.currentTarget)}
          onKeyUp={(event) => persistTextSelection(composerDraftKey, event.currentTarget)}
          onMouseUp={(event) => persistTextSelection(composerDraftKey, event.currentTarget)}
          onBlur={(event) => persistTextSelection(composerDraftKey, event.currentTarget)}
          onKeyDown={handleKeyDown}
          rows={lineCount}
          spellCheck={false}
          aria-label="message pi"
          className="flex-1 resize-none overflow-y-auto border-0 bg-transparent p-0 text-[1em] outline-none"
          style={{
            color: themeText(props.theme),
            caretColor: props.theme.cursor ?? themeText(props.theme),
            height: `${lineCount * TERMINAL_LINE_HEIGHT}em`,
            lineHeight: TERMINAL_LINE_HEIGHT,
          }}
        />
      </div>
      <pre className="m-0 overflow-hidden whitespace-pre" style={{ color: props.piTheme.thinkingHigh, lineHeight: TERMINAL_LINE_HEIGHT }}>{"─".repeat(180)}</pre>
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
  const { items, liveItems, uiRequest, extensionUiState, usageStats, clearUiRequest, loadState, error } = usePiTranscript(props.threadId);
  const { settings } = useAppSettings();
  const baseTerminalTheme = terminalThemeFromApp();
  const piTheme = piHtmlThemeFromApp(baseTerminalTheme);
  const terminalTheme = piTheme.terminal;
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerFocusRef = useRef<(() => void) | null>(null);
  const atBottomRef = useRef(true);
  const visibleItems = useMemo(() => {
    if (liveItems.length === 0) return mergeToolResultsForDisplay(items);
    const persistedSignatures = new Set(items.map(transcriptSignature));
    const visibleLiveItems = liveItems.filter((item) => !persistedSignatures.has(transcriptSignature(item)));
    return mergeToolResultsForDisplay([...items, ...visibleLiveItems]);
  }, [items, liveItems]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !atBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [visibleItems.length]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const registerComposerFocus = useCallback((focus: (() => void) | null) => {
    composerFocusRef.current = focus;
  }, []);

  const showComposer = props.showComposer === true;
  const showInputComposer = showComposer && !uiRequest;

  const handleRootPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!showInputComposer) return;
      const target = isHTMLElement(event.target) ? event.target : null;
      if (isEditableTarget(target) || isInteractiveTarget(target) || isInsideKeyboardOwner(target)) return;
      requestAnimationFrame(() => composerFocusRef.current?.());
    },
    [showInputComposer],
  );

  return (
    <div
      ref={rootRef}
      onPointerDownCapture={handleRootPointerDown}
      className="flex h-full min-h-0 flex-col"
      style={{
        backgroundColor: terminalTheme.background,
        color: terminalTheme.foreground,
        fontFamily: settings.terminalFontFamily,
        fontSize: `${settings.terminalFontSize}px`,
        lineHeight: TERMINAL_LINE_HEIGHT,
      }}
    >
      <div ref={scrollRef} role="log" aria-live="polite" onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        {visibleItems.length === 0 && loadState !== "error" && (
          <pre className="m-0" style={{ color: themeMuted(terminalTheme), lineHeight: TERMINAL_LINE_HEIGHT }}>{loadState === "loading" ? "Loading transcript…" : ""}</pre>
        )}
        {visibleItems.map((item) => (
          <PiTranscriptRow key={item.id} item={item} theme={terminalTheme} piTheme={piTheme} />
        ))}
        {error && <pre className="m-0" style={{ color: terminalTheme.red ?? themeText(terminalTheme), lineHeight: TERMINAL_LINE_HEIGHT }}>{error}</pre>}
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
          autoFocusEnabled
          registerFocus={registerComposerFocus}
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
