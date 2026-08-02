import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import path from "node:path";

import type {
  AgentActivityStatus,
  ClaudeHookStatus,
  PiExtensionUiState,
  PiSessionEvent,
  PiSessionUsageStats,
  TerminalStatus,
} from "@clui/contracts";
import {
  AGENT_ACTIVITY_LABELS,
  classifyAgentActivityFromPiReason,
} from "@clui/shared/agentActivity";
import { encodePiTuiPrompt } from "@clui/shared/piTuiInput";
import { hasPiWorkingStatusOutput, stripPiTerminalControls } from "@clui/shared/piTerminalStatus";
import { USER_INPUT_TOOL_NAMES } from "@clui/shared/userInputTools";
import { Effect, Layer } from "effect";

import { createLogger } from "../../logger";
import { ServerConfig } from "../../config";
import { loadServerSettings } from "../../serverSettings";
import { PiSessionJsonlHookWatcher } from "../../PiSessionJsonlHook";
import {
  PtyAdapter,
  type PtyAdapterShape,
  type PtyExitEvent,
  type PtyProcess,
} from "../Services/PTY";
import {
  PiSessionError,
  PiSessionManager,
  type PiSessionManagerShape,
  type PiSessionState,
} from "../Services/PiSession";
import {
  assertValidCwd,
  BoundedLineBuffer,
  createSpawnEnv,
  runWithThreadLock,
} from "../terminalUtils";
import {
  CLUI_SESSION_PROCESS_REGISTRY_DIR_ENV,
  CLUI_SESSION_PROCESS_REGISTRY_OWNER_PID_ENV,
  getSessionProcessRegistryDir,
  removeSessionProcessRegistryEntry,
  writeSessionProcessRegistryEntry,
} from "../sessionProcessRegistry";
import {
  CLUI_JOURNEY_TOOL_ENDPOINT_ENV,
  CLUI_JOURNEY_TOOL_THREAD_ID_ENV,
  CLUI_JOURNEY_TOOL_TOKEN_ENV,
  JOURNEY_GET_INPUT_SCHEMA,
  JOURNEY_UPDATE_INPUT_SCHEMA,
} from "../journeyMcpServer";

const DEFAULT_HISTORY_LINE_LIMIT = 200_000;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_ACTIVE_SESSIONS = 10;
const DEFAULT_INITIAL_PROMPT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_RPC_REQUEST_TIMEOUT_MS = 30_000;
const TERMINAL_READY_POLL_MS = 50;
const CLUI_PI_THREAD_ID_ENV = "CLUI_PI_THREAD_ID";
const CLUI_PI_SESSION_SYNC_DIR_ENV = "CLUI_PI_SESSION_SYNC_DIR";
const CLUI_PI_SESSION_SYNC_NONCE_ENV = "CLUI_PI_SESSION_SYNC_NONCE";
const CLUI_PI_FAST_MODE_ENV = "CLUI_PI_FAST_MODE";
const PI_RUNTIME_AGENT_DIR_NAME = "pi-agent";
const PI_LEGACY_THREAD_SESSION_DIR_NAME = "pi-sessions";
const PI_SESSION_SYNC_DIR_NAME = "pi-session-sync";
const PI_SESSION_SYNC_ARTIFACT_FILENAME_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json(?:\.tmp)?$/u;
const PI_RUNTIME_EXTENSION_DIR_NAME = "pi-runtime";
const PI_SESSION_SYNC_EXTENSION_FILENAME = "clui-pi-session-sync.js";
const PI_HOOK_STATUSES = new Set<ClaudeHookStatus>([
  "working",
  "needsInput",
  "pendingApproval",
  "error",
  "completed",
]);
const PI_ACTIVITY_STATUSES = new Set<AgentActivityStatus>(
  Object.keys(AGENT_ACTIVITY_LABELS) as AgentActivityStatus[],
);
// Fallback only: pi's TUI rewrites its status line with carriage returns while
// the runtime extension / JSONL watcher provide the authoritative status.
const PI_STATUS_DETECTION_TAIL_LENGTH = 160;

interface PiSessionSyncPayload {
  readonly threadId: string;
  readonly sessionSyncNonce: string;
  readonly sessionFile: string | null;
  readonly timestamp: string;
  readonly reason?: string;
  readonly hookStatus?: ClaudeHookStatus | null;
  readonly toolName?: string;
  readonly toolInputCommand?: string;
  readonly toolInputDescription?: string;
  readonly toolInputAgent?: string;
  readonly activityStatus?: AgentActivityStatus | null;
}

interface TerminalReadinessWaiter {
  readonly process: PtyProcess;
  readonly sessionSyncNonce: string;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timeoutTimer: ReturnType<typeof setTimeout>;
  readonly pollTimer: ReturnType<typeof setInterval>;
  pollInFlight: boolean;
}

interface PendingTerminalPrompt {
  readonly entry: PiSessionEntry;
  readonly process: PtyProcess;
  readonly sessionSyncNonce: string;
  readonly data: string;
}

interface SessionStartResult {
  readonly initialPromptReady: Promise<void> | null;
  readonly pendingInitialPrompt: PendingTerminalPrompt | null;
}

interface RpcPendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutTimer: ReturnType<typeof setTimeout>;
}

type ExtensionWidgetPlacement = "aboveEditor" | "belowEditor";

type MutableExtensionUiState = {
  statuses: Map<string, string>;
  widgets: Map<string, { key: string; lines: string[]; placement: ExtensionWidgetPlacement }>;
};

interface PiSessionEntry extends PiSessionState {
  scrollbackBuffer: BoundedLineBuffer;
  mode: "terminal" | "rpc";
  process: PtyProcess | null;
  rpcProcess: ChildProcessWithoutNullStreams | null;
  rpcLineCarry: string;
  rpcRequestSeq: number;
  rpcPendingRequests: Map<string, RpcPendingRequest>;
  pendingExtensionUiRequest: Record<string, unknown> | null;
  extensionUiState: MutableExtensionUiState;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hookStatus: ClaudeHookStatus | null;
  activityStatus: AgentActivityStatus | null;
  /** Absolute per-cwd pi session directory used for /resume current-folder. */
  sessionDir: string | null;
  /** Absolute path to the active pi session JSONL file for this Clui thread. */
  activeSessionFile: string | null;
  jsonlHookWatcher: PiSessionJsonlHookWatcher | null;
  syncFilePath: string | null;
  sessionSyncNonce: string | null;
  syncWatcher: FSWatcher | null;
  syncDebounceTimer: ReturnType<typeof setTimeout> | null;
  terminalReadinessWaiter: TerminalReadinessWaiter | null;
  pendingInitialPromptProcess: PtyProcess | null;
  statusDetectionTail: string;
}

interface PiSessionManagerEvents {
  event: [event: PiSessionEvent];
}

interface PiSessionManagerOptions {
  ptyAdapter: PtyAdapterShape;
  stateDir: string;
  processKillGraceMs?: number;
  historyLineLimit?: number;
  maxActiveSessions?: number;
  initialPromptReadyTimeoutMs?: number;
  rpcRequestTimeoutMs?: number;
}

export function normalizeRpcProcessExit(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): PtyExitEvent {
  const signalNumber = signal === null ? null : (osConstants.signals[signal] ?? null);
  return {
    exitCode: exitCode ?? (signalNumber === null ? 1 : 128 + signalNumber),
    signal: signalNumber,
  };
}

function encodePiSessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function buildPiSessionSyncExtensionSource(): string {
  return `
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const syncDir = process.env.${CLUI_PI_SESSION_SYNC_DIR_ENV};
const threadId = process.env.${CLUI_PI_THREAD_ID_ENV};
const sessionSyncNonce = process.env.${CLUI_PI_SESSION_SYNC_NONCE_ENV};
const fastModeEnabled = process.env.${CLUI_PI_FAST_MODE_ENV} === "1";
const journeyToolEndpoint = process.env.${CLUI_JOURNEY_TOOL_ENDPOINT_ENV};
const journeyToolToken = process.env.${CLUI_JOURNEY_TOOL_TOKEN_ENV};
const processRegistryDir = process.env.${CLUI_SESSION_PROCESS_REGISTRY_DIR_ENV};
const processRegistryOwnerPid = Number(process.env.${CLUI_SESSION_PROCESS_REGISTRY_OWNER_PID_ENV} ?? 0);
const userInputToolNames = new Set(${JSON.stringify(USER_INPUT_TOOL_NAMES)});
const pendingUserInputToolCallIds = new Set();
let lastHookStatus;

function normalizeToolName(toolName) {
  return String(toolName ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isUserInputTool(toolName) {
  return userInputToolNames.has(normalizeToolName(toolName));
}

const FAST_STATUS_ID = "clui-openai-fast";
const FAST_PROVIDER_ID = "openai-codex";
const FAST_API_ID = "openai-codex-responses";
const FAST_SERVICE_TIER = "priority";
const FAST_SUPPORTED_MODELS = new Set(["gpt-5.4", "gpt-5.5"]);

function isPayloadRecord(payload) {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

function isFastEligible(ctx) {
  const model = ctx.model;
  if (!model) return false;
  if (model.provider !== FAST_PROVIDER_ID) return false;
  if (model.api !== FAST_API_ID) return false;
  if (!FAST_SUPPORTED_MODELS.has(model.id)) return false;
  return ctx.modelRegistry?.isUsingOAuth?.(model) === true;
}

function updateFastModeStatus(ctx) {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(FAST_STATUS_ID, fastModeEnabled && isFastEligible(ctx) ? "fast" : undefined);
}

function maybeInjectFastServiceTier(payload, ctx) {
  if (!fastModeEnabled) return undefined;
  if (!isFastEligible(ctx)) return undefined;
  if (!isPayloadRecord(payload)) return undefined;
  if (payload.model !== ctx.model?.id) return undefined;
  if ("service_tier" in payload) return undefined;
  return { ...payload, service_tier: FAST_SERVICE_TIER };
}

function writePayload(ctx, reason, hookStatus, metadata) {
  if (!syncDir || !threadId || !sessionSyncNonce) return;
  mkdirSync(syncDir, { recursive: true });
  const payload = {
    threadId,
    sessionSyncNonce,
    sessionFile: ctx.sessionManager.getSessionFile() ?? null,
    timestamp: new Date().toISOString(),
    reason,
  };
  if (hookStatus !== undefined) {
    payload.hookStatus = hookStatus;
  }
  if (metadata && typeof metadata.toolName === "string" && metadata.toolName.length > 0) {
    payload.toolName = metadata.toolName;
  }
  if (metadata && typeof metadata.toolInputCommand === "string" && metadata.toolInputCommand.length > 0) {
    payload.toolInputCommand = metadata.toolInputCommand;
  }
  if (metadata && typeof metadata.toolInputDescription === "string" && metadata.toolInputDescription.length > 0) {
    payload.toolInputDescription = metadata.toolInputDescription;
  }
  if (metadata && typeof metadata.toolInputAgent === "string" && metadata.toolInputAgent.length > 0) {
    payload.toolInputAgent = metadata.toolInputAgent;
  }
  const target = path.join(syncDir, sessionSyncNonce + ".json");
  const tmp = target + ".tmp";
  writeFileSync(tmp, JSON.stringify(payload));
  renameSync(tmp, target);
}

function buildToolMetadata(event) {
  const input = event && typeof event.input === "object" && event.input !== null ? event.input : undefined;
  return {
    toolName: typeof event?.toolName === "string" ? event.toolName : undefined,
    toolInputCommand: typeof input?.command === "string" ? input.command : undefined,
    toolInputDescription: typeof input?.description === "string" ? input.description : undefined,
    toolInputAgent: typeof input?.agent === "string" ? input.agent : undefined,
  };
}

function setHookStatus(ctx, hookStatus, reason, metadata) {
  if (lastHookStatus === hookStatus) {
    writePayload(ctx, reason, undefined, metadata);
    return;
  }
  lastHookStatus = hookStatus;
  writePayload(ctx, reason, hookStatus, metadata);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProtectedSessionPids() {
  if (!processRegistryDir) return new Set();
  let files;
  try {
    files = readdirSync(processRegistryDir, { encoding: "utf8" });
  } catch {
    return new Set();
  }

  const pids = new Set();
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(readFileSync(path.join(processRegistryDir, file), "utf8"));
      if (
        typeof entry?.pid === "number" &&
        Number.isSafeInteger(entry.pid) &&
        entry.pid > 0 &&
        typeof entry?.ownerPid === "number" &&
        Number.isSafeInteger(entry.ownerPid) &&
        entry.ownerPid === processRegistryOwnerPid &&
        entry.pid !== process.pid &&
        isProcessAlive(entry.pid) &&
        typeof entry?.threadId === "string" &&
        entry.threadId !== threadId
      ) {
        pids.add(entry.pid);
      }
    } catch {
      // Ignore malformed or concurrently replaced files.
    }
  }
  return pids;
}

function extractNumericKillTargets(command) {
  const targets = [];
  const killPattern = /(?:^|[\\s;&|()])(?:command\\s+|builtin\\s+|env\\s+)?(?:\\/(?:usr\\/)?bin\\/)?kill(?:\\s+|$)([^;&|()]*)/g;
  let match;
  while ((match = killPattern.exec(command)) !== null) {
    const args = match[1] ?? "";
    const pidMatches = args.matchAll(/\\b\\d{2,}\\b/g);
    for (const pidMatch of pidMatches) {
      const pid = Number(pidMatch[0]);
      if (Number.isSafeInteger(pid) && pid > 0) targets.push(pid);
    }
  }
  return targets;
}

function isBroadSessionKillCommand(command) {
  const lowered = command.toLowerCase();
  const referencesHarnessProcess = /\\b(clui|claude|pi|pty-host|node-pty)\\b/.test(lowered);
  if (!referencesHarnessProcess) return false;
  if (/(?:^|[\\s;&|()])(?:command\\s+|env\\s+)?(?:pkill|killall)\\b/.test(lowered)) return true;
  return /\\bxargs\\b[\\s\\S]*\\bkill\\b/.test(lowered);
}

function protectedSessionKillReason(command) {
  const protectedPids = readProtectedSessionPids();
  if (protectedPids.size === 0) return null;

  const targetedPids = extractNumericKillTargets(command).filter((pid) => protectedPids.has(pid));
  if (targetedPids.length > 0) {
    return "Blocked: command would kill other Clui-managed session process(es): " + targetedPids.join(", ");
  }

  if (isBroadSessionKillCommand(command)) {
    return "Blocked: broad process kill may terminate other Clui-managed sessions.";
  }

  return null;
}

export default function (pi) {
  if (journeyToolEndpoint && journeyToolToken && threadId) {
    const requestJourney = async (path, init = {}) => {
      const response = await fetch(
        journeyToolEndpoint + path + "?thread=" + encodeURIComponent(threadId),
        {
          ...init,
          headers: {
            Authorization: "Bearer " + journeyToolToken,
            ...(init.body ? { "Content-Type": "application/json" } : {}),
          },
        },
      );
      const text = await response.text();
      if (!response.ok) {
        throw new Error(text || "Clui Journey request failed with status " + response.status);
      }
      return text ? JSON.parse(text) : {};
    };

    pi.registerTool({
      name: "journey_get",
      label: "Read Journey",
      description: "Read the latest durable Clui Journey graph before deciding the next mutation.",
      promptSnippet: "Read the current Clui Journey graph",
      promptGuidelines: [
        "Use journey_get when the current Journey graph may have changed since the prompt was created.",
      ],
      parameters: ${JSON.stringify(JOURNEY_GET_INPUT_SCHEMA)},
      async execute() {
        const result = await requestJourney("/snapshot");
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    });

    pi.registerTool({
      name: "journey_update",
      label: "Update Journey",
      description: "Immediately create, update, or remove Journey nodes and edges while real work is happening. Never create future placeholder nodes: start concrete work as running, then record its result or real blocker.",
      promptSnippet: "Update the visible Clui Journey graph while work progresses",
      promptGuidelines: [
        "Use journey_update before starting concrete work so the corresponding running node appears immediately, and call it again as soon as that work completes or becomes blocked.",
        "Do not create draft or ready roadmap placeholders. Continue non-HITL work autonomously and pause only for a real user interaction or external blocker.",
      ],
      parameters: ${JSON.stringify(JOURNEY_UPDATE_INPUT_SCHEMA)},
      async execute(_toolCallId, params) {
        const result = await requestJourney("/update", {
          method: "POST",
          body: JSON.stringify(params),
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    });
  }

  pi.on("session_start", async (event, ctx) => {
    pendingUserInputToolCallIds.clear();
    lastHookStatus = undefined;
    writePayload(ctx, event.reason);
    updateFastModeStatus(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    updateFastModeStatus(ctx);
  });

  pi.on("before_provider_request", (event, ctx) => {
    writePayload(ctx, "provider_request");
    const nextPayload = maybeInjectFastServiceTier(event.payload, ctx);
    updateFastModeStatus(ctx);
    return nextPayload;
  });

  pi.on("agent_start", async (_event, ctx) => {
    pendingUserInputToolCallIds.clear();
    setHookStatus(ctx, "working", "agent_start");
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    const metadata = buildToolMetadata(event);
    if (isUserInputTool(event.toolName)) {
      pendingUserInputToolCallIds.add(event.toolCallId);
      setHookStatus(ctx, "needsInput", "tool_input:" + event.toolName, metadata);
      return;
    }
    if (pendingUserInputToolCallIds.size === 0) {
      setHookStatus(ctx, "working", "tool_start:" + event.toolName, metadata);
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const metadata = buildToolMetadata(event);
    writePayload(ctx, "tool_call:" + event.toolName, undefined, metadata);

    if (normalizeToolName(event.toolName) === "bash") {
      const command = typeof event.input?.command === "string" ? event.input.command : "";
      const reason = protectedSessionKillReason(command);
      if (reason) return { block: true, reason };
    }

    if (!isUserInputTool(event.toolName)) return;
    pendingUserInputToolCallIds.add(event.toolCallId);
    setHookStatus(ctx, "needsInput", "tool_call:" + event.toolName, metadata);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    const wasUserInputTool = pendingUserInputToolCallIds.delete(event.toolCallId);
    if (wasUserInputTool && pendingUserInputToolCallIds.size === 0) {
      setHookStatus(ctx, "working", "tool_input_resolved:" + event.toolName, buildToolMetadata(event));
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    pendingUserInputToolCallIds.clear();
    setHookStatus(ctx, "completed", "agent_end");
  });
}
`.trimStart();
}

function parsePiHookStatus(value: unknown): ClaudeHookStatus | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  return PI_HOOK_STATUSES.has(value as ClaudeHookStatus) ? (value as ClaudeHookStatus) : undefined;
}

function parsePiActivityStatus(value: unknown): AgentActivityStatus | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  return PI_ACTIVITY_STATUSES.has(value as AgentActivityStatus)
    ? (value as AgentActivityStatus)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createEmptyExtensionUiState(): MutableExtensionUiState {
  return { statuses: new Map(), widgets: new Map() };
}

function snapshotExtensionUiState(state: MutableExtensionUiState): PiExtensionUiState {
  return {
    statuses: Object.fromEntries(state.statuses),
    widgets: [...state.widgets.values()].map((widget) => ({
      key: widget.key,
      lines: [...widget.lines],
      placement: widget.placement,
    })),
  };
}

function isExtensionDialogMethod(
  method: unknown,
): method is "select" | "confirm" | "input" | "editor" {
  return method === "select" || method === "confirm" || method === "input" || method === "editor";
}

function extensionWidgetPlacement(value: unknown): ExtensionWidgetPlacement {
  return value === "belowEditor" ? "belowEditor" : "aboveEditor";
}

function normalizeStringArray(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return [];
  return value.filter((line): line is string => typeof line === "string");
}

function normalizeStringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : finiteNumber(value);
}

function normalizeSessionUsageStats(data: unknown): PiSessionUsageStats | null {
  if (!isRecord(data) || !isRecord(data.tokens)) return null;
  const input = finiteNumber(data.tokens.input);
  const output = finiteNumber(data.tokens.output);
  const cacheRead = finiteNumber(data.tokens.cacheRead);
  const cacheWrite = finiteNumber(data.tokens.cacheWrite);
  const total =
    finiteNumber(data.tokens.total) ??
    (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  const cost = finiteNumber(data.cost) ?? 0;
  if (input === null || output === null || cacheRead === null || cacheWrite === null) return null;

  let contextUsage: PiSessionUsageStats["contextUsage"] = null;
  if (isRecord(data.contextUsage)) {
    const contextWindow = finiteNumber(data.contextUsage.contextWindow);
    if (contextWindow !== null) {
      contextUsage = {
        tokens: normalizeNullableNumber(data.contextUsage.tokens),
        contextWindow,
        percent: normalizeNullableNumber(data.contextUsage.percent),
      };
    }
  }

  return {
    tokens: { input, output, cacheRead, cacheWrite, total },
    cost,
    contextUsage,
  };
}

function normalizeInitialPrompt(prompt: string | undefined): string | null {
  if (prompt === undefined) return null;
  const withoutTrailingSubmitChars = prompt.replace(/[\r\n]+$/u, "");
  return withoutTrailingSubmitChars.trim().length > 0 ? withoutTrailingSubmitChars : null;
}

export class PiSessionManagerRuntime extends EventEmitter<PiSessionManagerEvents> {
  private readonly sessions = new Map<string, PiSessionEntry>();
  private readonly threadLocks = new Map<string, Promise<void>>();
  private readonly killEscalationTimers = new Map<PtyProcess, ReturnType<typeof setTimeout>>();
  private readonly rpcKillEscalationTimers = new Map<
    ChildProcessWithoutNullStreams,
    ReturnType<typeof setTimeout>
  >();
  private readonly ptyAdapter: PtyAdapterShape;
  private readonly processKillGraceMs: number;
  private readonly historyLineLimit: number;
  private readonly initialPromptReadyTimeoutMs: number;
  private readonly rpcRequestTimeoutMs: number;
  private maxActiveSessions: number;
  private readonly agentRootDir: string;
  private readonly sessionsRootDir: string;
  private readonly legacySessionsRootDir: string;
  private readonly sessionSyncDir: string;
  private readonly processRegistryDir: string;
  private readonly extensionFilePath: string;
  private runtimeFilesPromise: Promise<void> | null = null;
  private readonly logger = createLogger("pi-session");

  constructor(options: PiSessionManagerOptions) {
    super();
    this.ptyAdapter = options.ptyAdapter;
    this.processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
    this.historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
    this.initialPromptReadyTimeoutMs =
      options.initialPromptReadyTimeoutMs ?? DEFAULT_INITIAL_PROMPT_READY_TIMEOUT_MS;
    this.rpcRequestTimeoutMs = options.rpcRequestTimeoutMs ?? DEFAULT_RPC_REQUEST_TIMEOUT_MS;
    this.maxActiveSessions = options.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS;
    this.agentRootDir = path.join(options.stateDir, PI_RUNTIME_AGENT_DIR_NAME);
    this.sessionsRootDir = path.join(this.agentRootDir, "sessions");
    this.legacySessionsRootDir = path.join(options.stateDir, PI_LEGACY_THREAD_SESSION_DIR_NAME);
    this.sessionSyncDir = path.join(options.stateDir, PI_SESSION_SYNC_DIR_NAME);
    this.processRegistryDir = getSessionProcessRegistryDir(options.stateDir);
    this.extensionFilePath = path.join(
      options.stateDir,
      PI_RUNTIME_EXTENSION_DIR_NAME,
      PI_SESSION_SYNC_EXTENSION_FILENAME,
    );
  }

  async startSession(input: {
    threadId: string;
    cwd: string;
    cols: number;
    rows: number;
    fresh?: boolean;
    resumeSessionFile?: string;
    initialPrompt?: string;
    fastMode?: boolean;
    htmlMode?: boolean;
    journeyTools?: { endpoint: string; token: string };
  }): Promise<void> {
    const sessionStart = await this.runWithThreadLock(
      input.threadId,
      async (): Promise<SessionStartResult> => {
        await this.ensureRuntimeFiles();

        const existing = this.sessions.get(input.threadId);
        if (existing?.process || existing?.rpcProcess) {
          this.stopProcess(
            existing,
            new Error("pi session replaced before its initial prompt was submitted"),
          );
        }

        const entry: PiSessionEntry = existing ?? {
          threadId: input.threadId,
          lastInteractedAt: Date.now(),
          scrollbackBuffer: new BoundedLineBuffer(this.historyLineLimit),
          cols: input.cols,
          rows: input.rows,
          status: "active" as TerminalStatus,
          mode: input.htmlMode === true ? "rpc" : "terminal",
          process: null,
          rpcProcess: null,
          rpcLineCarry: "",
          rpcRequestSeq: 0,
          rpcPendingRequests: new Map(),
          pendingExtensionUiRequest: null,
          extensionUiState: createEmptyExtensionUiState(),
          unsubscribeData: null,
          unsubscribeExit: null,
          hookStatus: null,
          activityStatus: null,
          sessionDir: null,
          activeSessionFile: null,
          jsonlHookWatcher: null,
          syncFilePath: null,
          sessionSyncNonce: null,
          syncWatcher: null,
          syncDebounceTimer: null,
          terminalReadinessWaiter: null,
          pendingInitialPromptProcess: null,
          statusDetectionTail: "",
        };

        entry.cols = input.cols;
        entry.rows = input.rows;
        entry.mode = input.htmlMode === true ? "rpc" : "terminal";
        entry.status = "active";
        entry.lastInteractedAt = Date.now();
        if (existing) {
          entry.scrollbackBuffer.clear();
          entry.statusDetectionTail = "";
          this.resetHookStatus(entry);
        }
        this.sessions.set(input.threadId, entry);

        const sessionDir = this.getSessionDirForCwd(input.cwd);
        entry.sessionDir = sessionDir;
        await mkdir(sessionDir, { recursive: true });

        const preferredSessionFile =
          input.resumeSessionFile ?? entry.activeSessionFile ?? undefined;
        const resolvedSessionFile = input.fresh
          ? null
          : await this.resolveStartSessionFile(input.threadId, input.cwd, preferredSessionFile);
        entry.activeSessionFile = resolvedSessionFile;

        const args: string[] = ["--session-dir", sessionDir, "--extension", this.extensionFilePath];
        if (resolvedSessionFile) {
          args.push("--session", resolvedSessionFile);
        }
        const normalizedInitialPrompt = normalizeInitialPrompt(input.initialPrompt);
        const sessionSyncNonce = randomUUID();

        try {
          await assertValidCwd(input.cwd);
          await this.startSessionSyncWatcher(entry, sessionSyncNonce);
          this.startJsonlHookWatcher(entry, entry.activeSessionFile);

          const spawnEnv = createSpawnEnv(process.env);
          spawnEnv[CLUI_PI_THREAD_ID_ENV] = input.threadId;
          spawnEnv[CLUI_PI_SESSION_SYNC_DIR_ENV] = this.sessionSyncDir;
          spawnEnv[CLUI_PI_SESSION_SYNC_NONCE_ENV] = sessionSyncNonce;
          if (input.fastMode === true) {
            spawnEnv[CLUI_PI_FAST_MODE_ENV] = "1";
          }
          if (input.journeyTools) {
            spawnEnv[CLUI_JOURNEY_TOOL_ENDPOINT_ENV] = input.journeyTools.endpoint;
            spawnEnv[CLUI_JOURNEY_TOOL_THREAD_ID_ENV] = input.threadId;
            spawnEnv[CLUI_JOURNEY_TOOL_TOKEN_ENV] = input.journeyTools.token;
          }
          spawnEnv[CLUI_SESSION_PROCESS_REGISTRY_DIR_ENV] = this.processRegistryDir;
          spawnEnv[CLUI_SESSION_PROCESS_REGISTRY_OWNER_PID_ENV] = String(process.pid);

          let terminalPrompt: PendingTerminalPrompt | null = null;
          let initialPromptReady: Promise<void> | null = null;
          if (entry.mode === "rpc") {
            await this.startRpcProcess(entry, {
              args,
              cwd: input.cwd,
              env: spawnEnv,
              initialPrompt: normalizedInitialPrompt,
              resumed: resolvedSessionFile != null,
              sessionDir,
            });
          } else {
            const terminalStart = await this.startTerminalProcess(entry, {
              args,
              cwd: input.cwd,
              cols: input.cols,
              rows: input.rows,
              env: spawnEnv,
              awaitReadiness: normalizedInitialPrompt !== null,
              sessionSyncNonce,
              resumed: resolvedSessionFile != null,
              sessionDir,
            });
            if (normalizedInitialPrompt !== null && terminalStart.readiness) {
              initialPromptReady = terminalStart.readiness;
              terminalPrompt = {
                entry,
                process: terminalStart.process,
                sessionSyncNonce,
                data: encodePiTuiPrompt(normalizedInitialPrompt),
              };
            }
          }

          const refreshTimer = setTimeout(() => {
            void this.runWithThreadLock(input.threadId, async () => {
              const current = this.sessions.get(input.threadId);
              if (!current) return;
              await this.refreshSessionSyncFile(current);
            });
          }, 150);
          refreshTimer.unref?.();

          void this.reconcileActiveSessions(this.maxActiveSessions);
          return { initialPromptReady, pendingInitialPrompt: terminalPrompt };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to start pi session";
          if (entry.process || entry.rpcProcess) {
            this.stopProcess(entry, new Error(message));
          } else {
            this.unregisterProcess(entry);
            this.rejectRpcPendingRequests(entry, new Error("Failed to start pi session"));
            entry.rpcLineCarry = "";
            entry.pendingExtensionUiRequest = null;
            entry.extensionUiState = createEmptyExtensionUiState();
            this.stopSessionSyncWatcher(entry);
          }
          entry.status = "new";
          this.logger.error("failed to start pi session", {
            threadId: input.threadId,
            error: message,
          });
          this.emitEvent({
            type: "error",
            threadId: input.threadId,
            createdAt: new Date().toISOString(),
            message,
          });
          throw new Error(message, { cause: error });
        }
      },
    );

    const pendingPrompt = sessionStart.pendingInitialPrompt;
    if (!sessionStart.initialPromptReady || !pendingPrompt) return;

    try {
      // Keep the per-thread lock available so lifecycle operations can reject the
      // process-bound waiter instead of deadlocking behind pi startup.
      await sessionStart.initialPromptReady;
      await this.runWithThreadLock(input.threadId, async () => {
        const current = this.sessions.get(input.threadId);
        if (
          current !== pendingPrompt.entry ||
          current.process !== pendingPrompt.process ||
          current.sessionSyncNonce !== pendingPrompt.sessionSyncNonce ||
          current.status !== "active"
        ) {
          throw new Error("pi session changed before its initial prompt was submitted");
        }
        pendingPrompt.process.write(pendingPrompt.data);
        current.pendingInitialPromptProcess = null;
        current.lastInteractedAt = Date.now();
        this.applyAuthoritativeHookStatusIfChanged(current, "working");
        this.emitTerminalStarted(current);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to submit initial pi prompt";
      const cleanedUp = await this.runWithThreadLock(input.threadId, async () => {
        const current = this.sessions.get(input.threadId);
        if (
          current !== pendingPrompt.entry ||
          current.process !== pendingPrompt.process ||
          current.sessionSyncNonce !== pendingPrompt.sessionSyncNonce
        ) {
          return false;
        }
        this.stopProcess(current, new Error(message));
        current.status = "new";
        return true;
      });
      if (cleanedUp) {
        this.logger.error("failed to submit initial pi prompt", {
          threadId: input.threadId,
          error: message,
        });
        this.emitEvent({
          type: "error",
          threadId: input.threadId,
          createdAt: new Date().toISOString(),
          message,
        });
      }
      throw new Error(message, { cause: error });
    }
  }

  async hibernateSession(threadId: string): Promise<void> {
    return this.runWithThreadLock(threadId, async () => {
      const entry = this.sessions.get(threadId);
      if (!entry) {
        throw new Error(`No session found for thread: ${threadId}`);
      }

      this.stopProcess(
        entry,
        new Error("pi session hibernated before its initial prompt was submitted"),
      );
      entry.status = "dormant";

      this.logger.info("pi session hibernated", {
        threadId,
        activeSessionFile: entry.activeSessionFile,
      });
      this.emitEvent({ type: "hibernated", threadId, createdAt: new Date().toISOString() });
    });
  }

  getScrollback(
    threadId: string,
    sinceOffset?: number,
  ): { scrollback: string | null; offset: number; reset: boolean } {
    const entry = this.sessions.get(threadId);
    if (!entry) return { scrollback: null, offset: 0, reset: false };
    const offset = entry.scrollbackBuffer.offset;
    if (sinceOffset != null) {
      const delta = entry.scrollbackBuffer.materializeSince(sinceOffset);
      if (delta != null) return { scrollback: delta, offset, reset: false };
      return { scrollback: entry.scrollbackBuffer.materialize(), offset, reset: true };
    }
    return { scrollback: entry.scrollbackBuffer.materialize(), offset, reset: false };
  }

  async promptSession(
    threadId: string,
    message: string,
    streamingBehavior?: "steer" | "followUp",
  ): Promise<void> {
    const entry = this.sessions.get(threadId);
    if (!entry || entry.mode !== "rpc" || !entry.rpcProcess || entry.status !== "active") {
      throw new Error(`No active html pi session for thread: ${threadId}`);
    }

    await this.sendRpcCommand(entry, {
      type: "prompt",
      message,
      ...(streamingBehavior ? { streamingBehavior } : {}),
    });
    entry.lastInteractedAt = Date.now();
  }

  async abortSession(threadId: string): Promise<void> {
    const entry = this.sessions.get(threadId);
    if (!entry || entry.mode !== "rpc" || !entry.rpcProcess || entry.status !== "active") {
      throw new Error(`No active html pi session for thread: ${threadId}`);
    }
    await this.sendRpcCommand(entry, { type: "abort" });
    entry.lastInteractedAt = Date.now();
  }

  async respondExtensionUi(
    threadId: string,
    response: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean },
  ): Promise<void> {
    const entry = this.sessions.get(threadId);
    if (!entry || entry.mode !== "rpc" || !entry.rpcProcess || entry.status !== "active") {
      throw new Error(`No active html pi session for thread: ${threadId}`);
    }
    if (entry.pendingExtensionUiRequest?.id === response.id) {
      entry.pendingExtensionUiRequest = null;
      this.applyAuthoritativeHookStatusIfChanged(entry, "working");
    }
    this.sendRpcNotification(entry, { type: "extension_ui_response", ...response });
    entry.lastInteractedAt = Date.now();
  }

  async getCommands(
    threadId: string,
  ): Promise<ReadonlyArray<{ name: string; description?: string; source?: string }>> {
    const entry = this.sessions.get(threadId);
    if (!entry || entry.mode !== "rpc" || !entry.rpcProcess || entry.status !== "active") {
      return [];
    }
    const response = await this.sendRpcCommand(entry, { type: "get_commands" });
    if (!isRecord(response)) return [];
    const data = response.data;
    if (!isRecord(data) || !Array.isArray(data.commands)) return [];
    return data.commands.flatMap((candidate) => {
      if (!isRecord(candidate) || typeof candidate.name !== "string") return [];
      return [
        {
          name: candidate.name,
          ...(typeof candidate.description === "string"
            ? { description: candidate.description }
            : {}),
          ...(typeof candidate.source === "string" ? { source: candidate.source } : {}),
        },
      ];
    });
  }

  async getSessionUsageStats(threadId: string): Promise<PiSessionUsageStats | null> {
    const entry = this.sessions.get(threadId);
    if (!entry || entry.mode !== "rpc" || !entry.rpcProcess || entry.status !== "active") {
      return null;
    }
    const response = await this.sendRpcCommand(entry, { type: "get_session_stats" });
    if (!isRecord(response) || response.success === false) return null;
    return normalizeSessionUsageStats(response.data);
  }

  async sendRpcSessionCommand(
    threadId: string,
    commandType: string,
    payload?: Record<string, unknown>,
  ): Promise<unknown> {
    const entry = this.sessions.get(threadId);
    if (!entry || entry.mode !== "rpc" || !entry.rpcProcess || entry.status !== "active") {
      throw new Error(`No active html pi session for thread: ${threadId}`);
    }
    const response = await this.sendRpcCommand(entry, { type: commandType, ...(payload ?? {}) });
    if (!isRecord(response)) return null;
    if (response.success === false) {
      throw new Error(
        typeof response.error === "string"
          ? response.error
          : `Pi RPC command failed: ${commandType}`,
      );
    }
    return response.data ?? null;
  }

  writeToSession(threadId: string, data: string): void {
    const entry = this.sessions.get(threadId);
    if (!entry || !entry.process || entry.status !== "active") {
      throw new Error(`No active terminal pi session for thread: ${threadId}`);
    }

    if (entry.pendingInitialPromptProcess === entry.process) {
      throw new Error(`Initial pi prompt is still pending for thread: ${threadId}`);
    }

    entry.process.write(data);
    entry.lastInteractedAt = Date.now();
  }

  /**
   * Called when the web client has sent a non-empty first line ending in newline
   * (see `advancePiWritePromptBuffer`). Covers pi's on-disk deferral of the first
   * user message until the first assistant response exists.
   */
  async notifyPromptSubmitted(threadId: string): Promise<void> {
    await this.runWithThreadLock(threadId, async () => {
      const entry = this.sessions.get(threadId);
      if (!entry?.process || entry.status !== "active") return;
      this.applyAuthoritativeHookStatusIfChanged(entry, "working");
    });
  }

  resizeSession(threadId: string, cols: number, rows: number): void {
    const entry = this.sessions.get(threadId);
    if (!entry || entry.status !== "active" || (!entry.process && !entry.rpcProcess)) {
      throw new Error(`No active session for thread: ${threadId}`);
    }
    const sizeChanged = entry.cols !== cols || entry.rows !== rows;
    entry.cols = cols;
    entry.rows = rows;
    entry.lastInteractedAt = Date.now();
    if (sizeChanged) {
      entry.process?.resize(cols, rows);
    }
  }

  getSessionStatus(threadId: string): TerminalStatus {
    const entry = this.sessions.get(threadId);
    return entry?.status ?? "new";
  }

  getSessionFile(threadId: string): string | null {
    const entry = this.sessions.get(threadId);
    return entry?.activeSessionFile ?? null;
  }

  getSessionHookStatus(threadId: string): ClaudeHookStatus | null {
    const entry = this.sessions.get(threadId);
    return entry?.hookStatus ?? null;
  }

  getSessionActivityStatus(threadId: string): AgentActivityStatus | null {
    const entry = this.sessions.get(threadId);
    return entry?.activityStatus ?? null;
  }

  getPendingExtensionUiRequest(threadId: string): Record<string, unknown> | null {
    const entry = this.sessions.get(threadId);
    return entry?.pendingExtensionUiRequest ?? null;
  }

  getExtensionUiState(threadId: string): PiExtensionUiState {
    const entry = this.sessions.get(threadId);
    return snapshotExtensionUiState(entry?.extensionUiState ?? createEmptyExtensionUiState());
  }

  async reconcileActiveSessions(maxActive: number): Promise<void> {
    const activeSessions = [...this.sessions.values()].filter(
      (entry) => entry.status === "active" && (entry.process !== null || entry.rpcProcess !== null),
    );
    if (activeSessions.length <= maxActive) return;
    const sorted = activeSessions.toSorted((a, b) => a.lastInteractedAt - b.lastInteractedAt);
    const toHibernate = sorted.slice(0, sorted.length - maxActive);
    for (const entry of toHibernate) {
      await this.hibernateSession(entry.threadId);
    }
  }

  async setMaxActiveSessions(maxActive: number): Promise<void> {
    this.maxActiveSessions = maxActive;
    await this.reconcileActiveSessions(maxActive);
  }

  async hibernateAll(): Promise<void> {
    const activeSessions = [...this.sessions.values()].filter(
      (entry) => entry.status === "active" && (entry.process !== null || entry.rpcProcess !== null),
    );
    const TIMEOUT_MS = 5_000;
    const results = await Promise.race([
      Promise.allSettled(activeSessions.map((entry) => this.hibernateSession(entry.threadId))),
      new Promise<PromiseSettledResult<string>[]>((resolve) =>
        setTimeout(() => {
          for (const entry of activeSessions) {
            if (entry.process || entry.rpcProcess) this.stopProcess(entry);
          }
          resolve(
            activeSessions.map(() => ({
              status: "rejected" as const,
              reason: new Error("timeout"),
            })),
          );
        }, TIMEOUT_MS),
      ),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        this.logger.warn("failed to hibernate pi session during hibernateAll", {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  }

  async hibernateActiveSessions(excludeThreadIds: ReadonlySet<string>): Promise<string[]> {
    const candidates = [...this.sessions.values()]
      .filter(
        (entry) =>
          !excludeThreadIds.has(entry.threadId) &&
          entry.status === "active" &&
          (entry.process !== null || entry.rpcProcess !== null),
      )
      .toSorted((left, right) => left.lastInteractedAt - right.lastInteractedAt)
      .map((entry) => entry.threadId);

    const hibernated: string[] = [];
    for (const threadId of candidates) {
      try {
        await this.hibernateSession(threadId);
        hibernated.push(threadId);
      } catch (error) {
        this.logger.warn("failed to hibernate pi session during bulk hibernate", {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return hibernated;
  }

  async destroySession(threadId: string): Promise<void> {
    await this.runWithThreadLock(threadId, async () => {
      const entry = this.sessions.get(threadId);
      if (!entry) return;
      this.stopProcess(
        entry,
        new Error("pi session destroyed before its initial prompt was submitted"),
      );
      this.sessions.delete(threadId);
    });
  }

  async purgeInactiveSessions(excludeThreadIds: ReadonlySet<string>): Promise<number> {
    const candidates = [...this.sessions.entries()]
      .filter(([id, e]) => !excludeThreadIds.has(id) && e.status !== "active")
      .map(([id]) => id);
    let killed = 0;
    for (const threadId of candidates) {
      await this.runWithThreadLock(threadId, async () => {
        const current = this.sessions.get(threadId);
        if (!current || current.status === "active") return;
        this.stopProcess(current);
        this.sessions.delete(threadId);
        killed++;
      });
    }
    return killed;
  }

  dispose(): void {
    for (const entry of this.sessions.values()) {
      this.stopSessionSyncWatcher(entry);
      this.stopJsonlHookWatcher(entry);
      this.stopProcess(
        entry,
        new Error("pi session disposed before its initial prompt was submitted"),
      );
    }
    this.sessions.clear();
    for (const timer of this.killEscalationTimers.values()) clearTimeout(timer);
    this.killEscalationTimers.clear();
    for (const timer of this.rpcKillEscalationTimers.values()) clearTimeout(timer);
    this.rpcKillEscalationTimers.clear();
    this.threadLocks.clear();
  }

  private async ensureRuntimeFiles(): Promise<void> {
    if (!this.runtimeFilesPromise) {
      this.runtimeFilesPromise = (async () => {
        await mkdir(this.sessionsRootDir, { recursive: true });
        await mkdir(this.sessionSyncDir, { recursive: true });
        await this.cleanupStaleSessionSyncArtifacts();
        await mkdir(path.dirname(this.extensionFilePath), { recursive: true });
        await writeFile(this.extensionFilePath, buildPiSessionSyncExtensionSource(), "utf8");
      })();
    }
    await this.runtimeFilesPromise;
  }

  private async cleanupStaleSessionSyncArtifacts(): Promise<void> {
    const activeNonces = new Set(
      [...this.sessions.values()].flatMap((entry) =>
        entry.sessionSyncNonce ? [entry.sessionSyncNonce] : [],
      ),
    );
    let fileNames: string[];
    try {
      fileNames = await readdir(this.sessionSyncDir, { encoding: "utf8" });
    } catch (error) {
      this.logger.warn("failed to list stale pi session sync artifacts", {
        syncDir: this.sessionSyncDir,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    for (const fileName of fileNames) {
      const nonce = fileName.match(PI_SESSION_SYNC_ARTIFACT_FILENAME_RE)?.[1];
      if (!nonce || activeNonces.has(nonce)) continue;
      try {
        await rm(path.join(this.sessionSyncDir, fileName), { force: true });
      } catch (error) {
        this.logger.warn("failed to remove stale pi session sync artifact", {
          fileName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async startTerminalProcess(
    entry: PiSessionEntry,
    input: {
      args: string[];
      cwd: string;
      cols: number;
      rows: number;
      env: NodeJS.ProcessEnv;
      awaitReadiness: boolean;
      sessionSyncNonce: string;
      resumed: boolean;
      sessionDir: string;
    },
  ): Promise<{ process: PtyProcess; readiness: Promise<void> | null }> {
    const ptyProcess = await Effect.runPromise(
      this.ptyAdapter.spawn({
        shell: "pi",
        args: input.args,
        cwd: input.cwd,
        cols: input.cols,
        rows: input.rows,
        env: input.env,
      }),
    );

    entry.process = ptyProcess;
    entry.pendingInitialPromptProcess = input.awaitReadiness ? ptyProcess : null;
    const readiness = input.awaitReadiness
      ? this.createTerminalReadinessWaiter(entry, ptyProcess, input.sessionSyncNonce)
      : null;
    this.registerProcess(entry, ptyProcess);
    const registerProcessTimer = setTimeout(() => {
      this.registerProcess(entry, ptyProcess);
    }, 100);
    registerProcessTimer.unref?.();

    entry.unsubscribeData = ptyProcess.onData((data) => {
      this.onProcessData(entry, data);
    });
    const expectedProcess = ptyProcess;
    entry.unsubscribeExit = ptyProcess.onExit((event) => {
      if (entry.process !== expectedProcess) return;
      this.onProcessExit(entry, event);
    });

    this.logger.info("pi terminal session started", {
      threadId: entry.threadId,
      pid: ptyProcess.pid,
      resumed: input.resumed,
      sessionDir: input.sessionDir,
      activeSessionFile: entry.activeSessionFile,
    });

    if (!input.awaitReadiness) {
      this.emitTerminalStarted(entry);
    }

    return { process: ptyProcess, readiness };
  }

  private async startRpcProcess(
    entry: PiSessionEntry,
    input: {
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
      initialPrompt: string | null;
      resumed: boolean;
      sessionDir: string;
    },
  ): Promise<void> {
    const args = ["--mode", "rpc", ...input.args];
    const child = spawn("pi", args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    entry.rpcProcess = child;
    entry.rpcLineCarry = "";
    entry.pendingExtensionUiRequest = null;
    entry.extensionUiState = createEmptyExtensionUiState();
    entry.rpcPendingRequests.clear();
    this.registerRpcProcess(entry, child);
    const registerProcessTimer = setTimeout(() => {
      this.registerRpcProcess(entry, child);
    }, 100);
    registerProcessTimer.unref?.();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (entry.rpcProcess !== child) return;
      this.onRpcStdout(entry, chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (entry.rpcProcess !== child) return;
      this.onRpcStderr(entry, chunk);
    });
    child.on("exit", (exitCode, signal) => {
      this.clearRpcKillEscalationTimer(child);
      if (entry.rpcProcess !== child) return;
      this.onRpcProcessExit(entry, normalizeRpcProcessExit(exitCode, signal));
    });
    child.on("error", (error) => {
      if (entry.rpcProcess !== child) return;
      this.emitEvent({
        type: "error",
        threadId: entry.threadId,
        createdAt: new Date().toISOString(),
        message: error.message,
      });
    });

    this.logger.info("pi rpc session started", {
      threadId: entry.threadId,
      pid: child.pid,
      resumed: input.resumed,
      sessionDir: input.sessionDir,
      activeSessionFile: entry.activeSessionFile,
    });

    this.emitEvent({
      type: "started",
      threadId: entry.threadId,
      createdAt: new Date().toISOString(),
    });

    if (input.initialPrompt) {
      await this.sendRpcCommand(entry, { type: "prompt", message: input.initialPrompt });
    }
  }

  private getSessionDirForCwd(cwd: string): string {
    return path.join(this.sessionsRootDir, encodePiSessionDirName(cwd));
  }

  private async resolveStartSessionFile(
    threadId: string,
    cwd: string,
    explicitSessionFile?: string,
  ): Promise<string | null> {
    if (explicitSessionFile) {
      const resolved = path.resolve(explicitSessionFile);
      if (existsSync(resolved)) {
        return resolved;
      }
      this.logger.warn("pi session resume file missing; falling back", {
        threadId,
        sessionFile: resolved,
      });
    }

    const migrated = await this.migrateLegacyThreadSessions(threadId, cwd);
    if (migrated) {
      return migrated;
    }

    return null;
  }

  private async migrateLegacyThreadSessions(threadId: string, cwd: string): Promise<string | null> {
    const legacyDir = path.join(this.legacySessionsRootDir, threadId);
    if (!existsSync(legacyDir)) return null;

    const targetDir = this.getSessionDirForCwd(cwd);
    await mkdir(targetDir, { recursive: true });

    const legacyFiles = await this.listJsonlFilesRecursive(legacyDir);
    let migratedCount = 0;
    let mostRecent: { file: string; mtimeMs: number } | null = null;

    for (const legacyFile of legacyFiles) {
      const header = await this.readSessionHeader(legacyFile);
      if (!header || header.cwd !== cwd) continue;

      const targetFile = path.join(targetDir, path.basename(legacyFile));
      if (!existsSync(targetFile)) {
        try {
          await copyFile(legacyFile, targetFile);
          migratedCount++;
        } catch {
          // ignore individual copy failures; fallback continues best-effort
        }
      }

      const candidateFile = existsSync(targetFile) ? targetFile : legacyFile;
      try {
        const candidateStat = await stat(candidateFile);
        if (!mostRecent || candidateStat.mtimeMs >= mostRecent.mtimeMs) {
          mostRecent = { file: candidateFile, mtimeMs: candidateStat.mtimeMs };
        }
      } catch {
        // ignore stat failures
      }
    }

    if (migratedCount > 0) {
      this.logger.info("migrated legacy pi sessions into shared per-cwd store", {
        threadId,
        cwd,
        migratedCount,
        targetDir,
      });
    }

    return mostRecent?.file ?? null;
  }

  private async listJsonlFilesRecursive(rootDir: string): Promise<string[]> {
    const results: string[] = [];
    const stack = [rootDir];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true, encoding: "utf8" });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          results.push(fullPath);
        }
      }
    }
    return results;
  }

  private async readSessionHeader(filePath: string): Promise<{ cwd: string } | null> {
    try {
      const content = await readFile(filePath, "utf8");
      const firstLine = content.split("\n", 1)[0]?.trim();
      if (!firstLine) return null;
      const parsed = JSON.parse(firstLine) as Record<string, unknown>;
      if (parsed.type !== "session" || typeof parsed.cwd !== "string") {
        return null;
      }
      return { cwd: parsed.cwd };
    } catch {
      return null;
    }
  }

  private sendRpcCommand(
    entry: PiSessionEntry,
    command: Record<string, unknown>,
  ): Promise<unknown> {
    const child = entry.rpcProcess;
    if (!child || !child.stdin.writable) {
      return Promise.reject(new Error(`No active html pi session for thread: ${entry.threadId}`));
    }

    const id = `clui-${++entry.rpcRequestSeq}`;
    const payload = JSON.stringify({ id, ...command });
    return new Promise((resolve, reject) => {
      const timeoutTimer = setTimeout(() => {
        if (!entry.rpcPendingRequests.delete(id)) return;
        reject(
          new Error(
            `Pi RPC command timed out after ${this.rpcRequestTimeoutMs}ms: ${String(command.type ?? "unknown")}`,
          ),
        );
      }, this.rpcRequestTimeoutMs);
      timeoutTimer.unref?.();
      entry.rpcPendingRequests.set(id, { resolve, reject, timeoutTimer });
      child.stdin.write(`${payload}\n`, (error) => {
        if (!error) return;
        const pending = entry.rpcPendingRequests.get(id);
        if (!pending) return;
        entry.rpcPendingRequests.delete(id);
        clearTimeout(pending.timeoutTimer);
        reject(error);
      });
    });
  }

  private sendRpcNotification(entry: PiSessionEntry, command: Record<string, unknown>): void {
    const child = entry.rpcProcess;
    if (!child || !child.stdin.writable) {
      throw new Error(`No active html pi session for thread: ${entry.threadId}`);
    }
    child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private onRpcStdout(entry: PiSessionEntry, chunk: string): void {
    const combined = entry.rpcLineCarry + chunk;
    const lines = combined.split("\n");
    entry.rpcLineCarry = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!trimmed.trim()) continue;
      this.handleRpcLine(entry, trimmed);
    }
  }

  private onRpcStderr(entry: PiSessionEntry, chunk: string): void {
    entry.scrollbackBuffer.append(chunk);
    const createdAt = new Date().toISOString();
    const text = chunk.toString().trim();
    if (text) {
      this.emitEvent({
        type: "rpcEvent",
        threadId: entry.threadId,
        createdAt,
        event: { type: "stderr", text },
      });
    }
    this.emitEvent({
      type: "output",
      threadId: entry.threadId,
      createdAt,
      data: "",
      offset: entry.scrollbackBuffer.offset,
    });
  }

  private handleRpcLine(entry: PiSessionEntry, line: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(line) as unknown;
    } catch {
      this.logger.warn("pi rpc emitted non-json line", { threadId: entry.threadId, line });
      return;
    }
    if (!isRecord(payload)) return;

    if (payload.type === "response" && typeof payload.id === "string") {
      const pending = entry.rpcPendingRequests.get(payload.id);
      if (pending) {
        entry.rpcPendingRequests.delete(payload.id);
        clearTimeout(pending.timeoutTimer);
        if (payload.success === false) {
          pending.reject(
            new Error(typeof payload.error === "string" ? payload.error : "pi command failed"),
          );
        } else {
          pending.resolve(payload);
        }
      }
      return;
    }

    this.handleRpcEvent(entry, payload);
  }

  private handleRpcEvent(entry: PiSessionEntry, event: Record<string, unknown>): void {
    switch (event.type) {
      case "agent_start":
      case "turn_start":
      case "message_update":
      case "tool_execution_start":
      case "tool_execution_update":
        if (entry.pendingExtensionUiRequest === null) {
          this.applyAuthoritativeHookStatusIfChanged(entry, "working");
        }
        break;
      case "agent_end":
        entry.pendingExtensionUiRequest = null;
        this.applyAuthoritativeHookStatusIfChanged(entry, "completed");
        break;
      case "extension_error":
        entry.pendingExtensionUiRequest = null;
        this.applyAuthoritativeHookStatusIfChanged(entry, "error");
        break;
      case "extension_ui_request":
        if (isExtensionDialogMethod(event.method)) {
          entry.pendingExtensionUiRequest = event;
          this.applyAuthoritativeHookStatusIfChanged(entry, "needsInput");
        } else {
          this.applyExtensionUiRequest(entry, event);
        }
        break;
    }

    const renderableEvent = this.renderableRpcEvent(event);
    if (renderableEvent) {
      this.emitEvent({
        type: "rpcEvent",
        threadId: entry.threadId,
        createdAt: new Date().toISOString(),
        event: renderableEvent,
      });
    }

    this.emitEvent({
      type: "output",
      threadId: entry.threadId,
      createdAt: new Date().toISOString(),
      data: "",
      offset: entry.scrollbackBuffer.offset,
    });
  }

  private applyExtensionUiRequest(entry: PiSessionEntry, event: Record<string, unknown>): void {
    switch (event.method) {
      case "setStatus": {
        const key = normalizeStringValue(event.statusKey);
        if (!key) return;
        const text = normalizeStringValue(event.statusText);
        if (text === null) {
          entry.extensionUiState.statuses.delete(key);
        } else {
          entry.extensionUiState.statuses.set(key, text);
        }
        return;
      }
      case "setWidget": {
        const key = normalizeStringValue(event.widgetKey);
        if (!key) return;
        const lines = normalizeStringArray(event.widgetLines);
        if (lines === null) {
          entry.extensionUiState.widgets.delete(key);
        } else {
          entry.extensionUiState.widgets.set(key, {
            key,
            lines,
            placement: extensionWidgetPlacement(event.widgetPlacement),
          });
        }
        return;
      }
    }
  }

  private renderableRpcEvent(event: Record<string, unknown>): Record<string, unknown> | null {
    switch (event.type) {
      case "agent_start":
      case "agent_end":
        return { type: event.type };
      case "message_start":
      case "message_update":
      case "message_end":
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
      case "extension_ui_request":
      case "extension_error":
      case "compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        return event;
      default:
        return null;
    }
  }

  private onProcessData(entry: PiSessionEntry, data: string): void {
    entry.scrollbackBuffer.append(data);
    this.applyOutputInferredHookStatus(entry, data);
    this.emitEvent({
      type: "output",
      threadId: entry.threadId,
      createdAt: new Date().toISOString(),
      data,
      offset: entry.scrollbackBuffer.offset,
    });
  }

  private applyOutputInferredHookStatus(entry: PiSessionEntry, data: string): void {
    const visibleText = stripPiTerminalControls(data);
    if (!visibleText) return;

    const statusSample = `${entry.statusDetectionTail}${visibleText}`;
    entry.statusDetectionTail = statusSample.slice(-PI_STATUS_DETECTION_TAIL_LENGTH);

    if (entry.status !== "active" || !hasPiWorkingStatusOutput(statusSample)) return;
    if (entry.hookStatus !== null) return;
    this.applyHookStatusIfChanged(entry, "working");
  }

  private applyAuthoritativeHookStatusIfChanged(
    entry: PiSessionEntry,
    status: ClaudeHookStatus | null,
  ): void {
    entry.statusDetectionTail = "";
    this.applyHookStatusIfChanged(entry, status);
  }

  private applyHookStatusIfChanged(entry: PiSessionEntry, status: ClaudeHookStatus | null): void {
    if (entry.hookStatus === status) return;
    entry.hookStatus = status;
    this.emitEvent({
      type: "hookStatus",
      threadId: entry.threadId,
      createdAt: new Date().toISOString(),
      hookStatus: status,
    });
  }

  private applyActivityStatusIfChanged(
    entry: PiSessionEntry,
    status: AgentActivityStatus | null,
  ): void {
    if (entry.activityStatus === status) return;
    entry.activityStatus = status;
    this.emitEvent({
      type: "activityStatus",
      threadId: entry.threadId,
      createdAt: new Date().toISOString(),
      activityStatus: status,
    });
  }

  private startJsonlHookWatcher(entry: PiSessionEntry, sessionFile: string | null): void {
    if (!entry.jsonlHookWatcher) {
      entry.jsonlHookWatcher = new PiSessionJsonlHookWatcher({
        threadId: entry.threadId,
        logger: this.logger,
        emitHookStatus: (event) => {
          if (event.type !== "hookStatus" || event.hookStatus == null) return;
          const current = this.sessions.get(event.threadId);
          if (!current) return;
          this.applyAuthoritativeHookStatusIfChanged(current, event.hookStatus);
        },
      });
    }
    entry.jsonlHookWatcher.start(sessionFile);
  }

  private stopJsonlHookWatcher(entry: PiSessionEntry): void {
    entry.jsonlHookWatcher?.stop();
  }

  private createTerminalReadinessWaiter(
    entry: PiSessionEntry,
    expectedProcess: PtyProcess,
    sessionSyncNonce: string,
  ): Promise<void> {
    this.rejectTerminalReadiness(entry, new Error("pi terminal readiness waiter was replaced"));

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    // Lifecycle cancellation may reject before startSession reaches its await.
    void promise.catch(() => undefined);

    const syncFilePath = entry.syncFilePath;
    let waiter!: TerminalReadinessWaiter;
    const timeoutTimer = setTimeout(() => {
      this.rejectTerminalReadiness(
        entry,
        new Error("Timed out waiting for pi terminal readiness"),
        expectedProcess,
        sessionSyncNonce,
      );
    }, this.initialPromptReadyTimeoutMs);
    timeoutTimer.unref?.();

    const pollTimer = setInterval(() => {
      if (!syncFilePath || waiter.pollInFlight) return;
      waiter.pollInFlight = true;
      void this.runWithThreadLock(entry.threadId, async () => {
        const current = this.sessions.get(entry.threadId);
        if (
          current !== entry ||
          current.terminalReadinessWaiter !== waiter ||
          current.process !== expectedProcess ||
          current.syncFilePath !== syncFilePath
        ) {
          return;
        }
        await this.refreshSessionSyncFile(current, syncFilePath);
      })
        .finally(() => {
          waiter.pollInFlight = false;
        })
        .catch(() => undefined);
    }, TERMINAL_READY_POLL_MS);
    pollTimer.unref?.();

    waiter = {
      process: expectedProcess,
      sessionSyncNonce,
      promise,
      resolve,
      reject,
      timeoutTimer,
      pollTimer,
      pollInFlight: false,
    };
    entry.terminalReadinessWaiter = waiter;
    return waiter.promise;
  }

  private resolveTerminalReadiness(entry: PiSessionEntry, sessionSyncNonce: string): void {
    const waiter = entry.terminalReadinessWaiter;
    if (!waiter || waiter.sessionSyncNonce !== sessionSyncNonce || waiter.process !== entry.process)
      return;
    entry.terminalReadinessWaiter = null;
    clearTimeout(waiter.timeoutTimer);
    clearInterval(waiter.pollTimer);
    waiter.resolve();
  }

  private rejectTerminalReadiness(
    entry: PiSessionEntry,
    error: Error,
    expectedProcess?: PtyProcess,
    expectedSessionSyncNonce?: string,
  ): void {
    const waiter = entry.terminalReadinessWaiter;
    if (
      !waiter ||
      (expectedProcess &&
        (waiter.process !== expectedProcess || entry.process !== expectedProcess)) ||
      (expectedSessionSyncNonce &&
        (waiter.sessionSyncNonce !== expectedSessionSyncNonce ||
          entry.sessionSyncNonce !== expectedSessionSyncNonce))
    ) {
      return;
    }
    entry.terminalReadinessWaiter = null;
    clearTimeout(waiter.timeoutTimer);
    clearInterval(waiter.pollTimer);
    waiter.reject(error);
  }

  private async startSessionSyncWatcher(
    entry: PiSessionEntry,
    sessionSyncNonce: string,
  ): Promise<void> {
    this.stopSessionSyncWatcher(entry);
    const syncFilePath = path.join(this.sessionSyncDir, `${sessionSyncNonce}.json`);
    entry.syncFilePath = syncFilePath;
    entry.sessionSyncNonce = sessionSyncNonce;
    try {
      await rm(syncFilePath, { force: true });
    } catch {
      // ignore stale file cleanup failures
    }
    try {
      entry.syncWatcher = watch(
        this.sessionSyncDir,
        { persistent: false },
        (_eventType, fileName) => {
          if (entry.syncFilePath !== syncFilePath) return;
          if (fileName && fileName.toString() !== path.basename(syncFilePath)) return;
          this.scheduleSessionSyncRefresh(entry, syncFilePath);
        },
      );
    } catch (error) {
      this.logger.warn("failed to watch pi session sync dir", {
        threadId: entry.threadId,
        syncDir: this.sessionSyncDir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private stopSessionSyncWatcher(entry: PiSessionEntry): void {
    if (entry.syncDebounceTimer) {
      clearTimeout(entry.syncDebounceTimer);
      entry.syncDebounceTimer = null;
    }
    entry.syncWatcher?.close();
    entry.syncWatcher = null;
    const syncFilePath = entry.syncFilePath;
    entry.syncFilePath = null;
    entry.sessionSyncNonce = null;
    if (syncFilePath) {
      this.removeSessionSyncFiles(syncFilePath);
      const finalCleanupTimer = setTimeout(() => {
        this.removeSessionSyncFiles(syncFilePath);
      }, this.processKillGraceMs + 100);
      finalCleanupTimer.unref?.();
    }
  }

  private removeSessionSyncFiles(syncFilePath: string): void {
    void rm(syncFilePath, { force: true }).catch(() => undefined);
    void rm(`${syncFilePath}.tmp`, { force: true }).catch(() => undefined);
  }

  private scheduleSessionSyncRefresh(entry: PiSessionEntry, syncFilePath: string): void {
    if (entry.syncDebounceTimer) clearTimeout(entry.syncDebounceTimer);
    entry.syncDebounceTimer = setTimeout(() => {
      entry.syncDebounceTimer = null;
      void this.runWithThreadLock(entry.threadId, async () => {
        const current = this.sessions.get(entry.threadId);
        if (current !== entry || current.syncFilePath !== syncFilePath) return;
        await this.refreshSessionSyncFile(current, syncFilePath);
      });
    }, 80);
    entry.syncDebounceTimer.unref?.();
  }

  private async refreshSessionSyncFile(
    entry: PiSessionEntry,
    expectedSyncFilePath = entry.syncFilePath,
  ): Promise<void> {
    if (
      !expectedSyncFilePath ||
      entry.syncFilePath !== expectedSyncFilePath ||
      !existsSync(expectedSyncFilePath)
    ) {
      return;
    }

    let payload: PiSessionSyncPayload;
    try {
      const raw = await readFile(expectedSyncFilePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (
        parsed.threadId !== entry.threadId ||
        typeof parsed.sessionSyncNonce !== "string" ||
        parsed.sessionSyncNonce !== entry.sessionSyncNonce
      ) {
        return;
      }
      const hookStatus = parsePiHookStatus(parsed.hookStatus);
      const explicitActivityStatus = parsePiActivityStatus(parsed.activityStatus);
      const reason = nonEmptyString(parsed.reason);
      const toolName = nonEmptyString(parsed.toolName);
      const toolInputCommand = nonEmptyString(parsed.toolInputCommand);
      const toolInputDescription = nonEmptyString(parsed.toolInputDescription);
      const toolInputAgent = nonEmptyString(parsed.toolInputAgent);
      const activityStatus =
        explicitActivityStatus !== undefined
          ? explicitActivityStatus
          : reason || toolName || toolInputCommand || toolInputDescription || toolInputAgent
            ? classifyAgentActivityFromPiReason({
                reason,
                toolName,
                command: toolInputCommand,
                description: toolInputDescription,
                agentName: toolInputAgent,
              })
            : undefined;
      payload = {
        threadId: entry.threadId,
        sessionSyncNonce: parsed.sessionSyncNonce,
        sessionFile: typeof parsed.sessionFile === "string" ? parsed.sessionFile : null,
        timestamp:
          typeof parsed.timestamp === "string" ? parsed.timestamp : new Date().toISOString(),
        ...(reason ? { reason } : {}),
        ...(hookStatus !== undefined ? { hookStatus } : {}),
        ...(toolName ? { toolName } : {}),
        ...(toolInputCommand ? { toolInputCommand } : {}),
        ...(toolInputDescription ? { toolInputDescription } : {}),
        ...(toolInputAgent ? { toolInputAgent } : {}),
        ...(activityStatus !== undefined ? { activityStatus } : {}),
      };
    } catch (error) {
      this.logger.warn("failed to parse pi session sync file", {
        threadId: entry.threadId,
        syncFilePath: expectedSyncFilePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    this.resolveTerminalReadiness(entry, payload.sessionSyncNonce);

    const nextSessionFile = payload.sessionFile ? path.resolve(payload.sessionFile) : null;
    if (nextSessionFile !== entry.activeSessionFile) {
      entry.activeSessionFile = nextSessionFile;
      if (entry.jsonlHookWatcher) {
        entry.jsonlHookWatcher.setSessionFile(nextSessionFile);
      } else {
        this.startJsonlHookWatcher(entry, nextSessionFile);
      }

      this.logger.info("pi session file updated", {
        threadId: entry.threadId,
        sessionFile: nextSessionFile,
        reason: payload.reason,
      });

      this.emitEvent({
        type: "sessionFile",
        threadId: entry.threadId,
        createdAt: payload.timestamp,
        sessionFile: nextSessionFile,
      });
    }

    if ("activityStatus" in payload) {
      this.applyActivityStatusIfChanged(entry, payload.activityStatus ?? null);
    }

    if ("hookStatus" in payload) {
      this.applyAuthoritativeHookStatusIfChanged(entry, payload.hookStatus ?? null);
    }
  }

  private resetHookStatus(entry: PiSessionEntry): void {
    this.stopJsonlHookWatcher(entry);
    entry.hookStatus = null;
    entry.activityStatus = null;
    entry.statusDetectionTail = "";
  }

  private onProcessExit(entry: PiSessionEntry, event: PtyExitEvent): void {
    const expectedProcess = entry.process;
    if (expectedProcess) {
      this.rejectTerminalReadiness(
        entry,
        new Error("pi terminal exited before its initial prompt was submitted"),
        expectedProcess,
        entry.sessionSyncNonce ?? undefined,
      );
    }
    this.unregisterProcess(entry);
    this.cleanupProcessHandles(entry);
    this.clearKillEscalationTimer(expectedProcess);
    entry.pendingInitialPromptProcess = null;
    entry.process = null;
    entry.status = "dormant";
    this.stopSessionSyncWatcher(entry);
    this.resetHookStatus(entry);

    this.logger.info("pi session exited", {
      threadId: entry.threadId,
      exitCode: event.exitCode,
      signal: event.signal,
      activeSessionFile: entry.activeSessionFile,
    });

    this.emitEvent({
      type: "exited",
      threadId: entry.threadId,
      createdAt: new Date().toISOString(),
      exitCode: Number.isInteger(event.exitCode) ? event.exitCode : null,
    });
  }

  private onRpcProcessExit(entry: PiSessionEntry, event: PtyExitEvent): void {
    this.unregisterProcess(entry);
    this.rejectRpcPendingRequests(entry, new Error("pi rpc session exited"));
    entry.rpcProcess = null;
    entry.rpcLineCarry = "";
    entry.pendingExtensionUiRequest = null;
    entry.extensionUiState = createEmptyExtensionUiState();
    entry.status = "dormant";
    this.stopSessionSyncWatcher(entry);
    this.resetHookStatus(entry);

    this.logger.info("pi rpc session exited", {
      threadId: entry.threadId,
      exitCode: event.exitCode,
      signal: event.signal,
      activeSessionFile: entry.activeSessionFile,
    });

    this.emitEvent({
      type: "exited",
      threadId: entry.threadId,
      createdAt: new Date().toISOString(),
      exitCode: Number.isInteger(event.exitCode) ? event.exitCode : null,
    });
  }

  private stopProcess(
    entry: PiSessionEntry,
    readinessError = new Error("pi session stopped before its initial prompt was submitted"),
  ): void {
    this.rejectTerminalReadiness(
      entry,
      readinessError,
      entry.process ?? undefined,
      entry.sessionSyncNonce ?? undefined,
    );
    this.stopSessionSyncWatcher(entry);
    this.stopJsonlHookWatcher(entry);
    this.unregisterProcess(entry);
    const ptyProcess = entry.process;
    const rpcProcess = entry.rpcProcess;
    this.cleanupProcessHandles(entry);
    entry.pendingInitialPromptProcess = null;
    entry.process = null;
    entry.rpcProcess = null;
    entry.rpcLineCarry = "";
    entry.pendingExtensionUiRequest = null;
    entry.extensionUiState = createEmptyExtensionUiState();
    this.rejectRpcPendingRequests(entry, new Error("pi session stopped"));
    this.resetHookStatus(entry);
    if (ptyProcess) {
      this.killProcessWithEscalation(ptyProcess, entry.threadId);
    }
    if (rpcProcess) {
      this.killRpcProcess(rpcProcess, entry.threadId);
    }
  }

  private cleanupProcessHandles(entry: PiSessionEntry): void {
    entry.unsubscribeData?.();
    entry.unsubscribeData = null;
    entry.unsubscribeExit?.();
    entry.unsubscribeExit = null;
  }

  private registerProcess(entry: PiSessionEntry, expectedProcess: PtyProcess): void {
    if (entry.process !== expectedProcess || entry.status !== "active") return;
    this.writeProcessRegistryEntry(entry, expectedProcess.pid);
  }

  private registerRpcProcess(
    entry: PiSessionEntry,
    expectedProcess: ChildProcessWithoutNullStreams,
  ): void {
    if (entry.rpcProcess !== expectedProcess || entry.status !== "active" || !expectedProcess.pid)
      return;
    this.writeProcessRegistryEntry(entry, expectedProcess.pid);
  }

  private writeProcessRegistryEntry(entry: PiSessionEntry, pid: number): void {
    try {
      writeSessionProcessRegistryEntry(this.processRegistryDir, {
        harness: "pi",
        threadId: entry.threadId,
        pid,
      });
    } catch (error) {
      this.logger.warn("failed to register pi session process", {
        threadId: entry.threadId,
        pid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private unregisterProcess(entry: PiSessionEntry): void {
    try {
      removeSessionProcessRegistryEntry(this.processRegistryDir, "pi", entry.threadId);
    } catch (error) {
      this.logger.warn("failed to unregister pi session process", {
        threadId: entry.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private clearKillEscalationTimer(process: PtyProcess | null): void {
    if (!process) return;
    const timer = this.killEscalationTimers.get(process);
    if (!timer) return;
    clearTimeout(timer);
    this.killEscalationTimers.delete(process);
  }

  private rejectRpcPendingRequests(entry: PiSessionEntry, error: Error): void {
    for (const pending of entry.rpcPendingRequests.values()) {
      clearTimeout(pending.timeoutTimer);
      pending.reject(error);
    }
    entry.rpcPendingRequests.clear();
  }

  private clearRpcKillEscalationTimer(process: ChildProcessWithoutNullStreams): void {
    const timer = this.rpcKillEscalationTimers.get(process);
    if (!timer) return;
    clearTimeout(timer);
    this.rpcKillEscalationTimers.delete(process);
  }

  private killRpcProcess(rpcProcess: ChildProcessWithoutNullStreams, threadId: string): void {
    this.clearRpcKillEscalationTimer(rpcProcess);
    try {
      rpcProcess.kill("SIGTERM");
    } catch (error) {
      this.logger.warn("failed to kill pi rpc process", {
        threadId,
        signal: "SIGTERM",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const timer = setTimeout(() => {
      this.rpcKillEscalationTimers.delete(rpcProcess);
      if (rpcProcess.exitCode !== null || rpcProcess.signalCode !== null) return;
      try {
        rpcProcess.kill("SIGKILL");
      } catch (error) {
        this.logger.warn("failed to force-kill pi rpc process", {
          threadId,
          signal: "SIGKILL",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, this.processKillGraceMs);
    timer.unref?.();
    this.rpcKillEscalationTimers.set(rpcProcess, timer);
  }

  private killProcessWithEscalation(ptyProcess: PtyProcess, threadId: string): void {
    this.clearKillEscalationTimer(ptyProcess);
    try {
      ptyProcess.kill("SIGTERM");
    } catch (error) {
      this.logger.warn("failed to kill pi process", {
        threadId,
        signal: "SIGTERM",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const timer = setTimeout(() => {
      this.killEscalationTimers.delete(ptyProcess);
      try {
        ptyProcess.kill("SIGKILL");
      } catch (error) {
        this.logger.warn("failed to force-kill pi process", {
          threadId,
          signal: "SIGKILL",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, this.processKillGraceMs);
    timer.unref?.();
    this.killEscalationTimers.set(ptyProcess, timer);
  }

  private emitTerminalStarted(entry: PiSessionEntry): void {
    this.emitEvent({
      type: "started",
      threadId: entry.threadId,
      createdAt: new Date().toISOString(),
    });
  }

  private emitEvent(event: PiSessionEvent): void {
    this.emit("event", event);
  }

  private runWithThreadLock<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    return runWithThreadLock(this.threadLocks, threadId, task);
  }
}

export const PiSessionManagerLive = Layer.effect(
  PiSessionManager,
  Effect.gen(function* () {
    const ptyAdapter = yield* PtyAdapter;
    const serverConfig = yield* ServerConfig;
    const settings = yield* Effect.promise(() => loadServerSettings(serverConfig.stateDir));

    const runtime = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new PiSessionManagerRuntime({
            ptyAdapter,
            stateDir: serverConfig.stateDir,
            maxActiveSessions: settings.maxActiveHarnessSessions,
          }),
      ),
      (r) => Effect.sync(() => r.dispose()),
    );

    return {
      startSession: (input) =>
        Effect.tryPromise({
          try: () => runtime.startSession(input),
          catch: (cause) => new PiSessionError({ message: "Failed to start pi session", cause }),
        }),
      hibernateSession: (threadId) =>
        Effect.tryPromise({
          try: () => runtime.hibernateSession(threadId),
          catch: (cause) =>
            new PiSessionError({ message: "Failed to hibernate pi session", cause }),
        }),
      getScrollback: (threadId, sinceOffset) =>
        Effect.sync(() => runtime.getScrollback(threadId, sinceOffset)),
      promptSession: (threadId, message, streamingBehavior) =>
        Effect.tryPromise({
          try: () => runtime.promptSession(threadId, message, streamingBehavior),
          catch: (cause) => new PiSessionError({ message: "Failed to send pi prompt", cause }),
        }),
      abortSession: (threadId) =>
        Effect.tryPromise({
          try: () => runtime.abortSession(threadId),
          catch: (cause) => new PiSessionError({ message: "Failed to abort pi session", cause }),
        }),
      respondExtensionUi: (threadId, response) =>
        Effect.tryPromise({
          try: () => runtime.respondExtensionUi(threadId, response),
          catch: (cause) => new PiSessionError({ message: "Failed to answer pi UI prompt", cause }),
        }),
      getCommands: (threadId) =>
        Effect.tryPromise({
          try: () => runtime.getCommands(threadId),
          catch: (cause) => new PiSessionError({ message: "Failed to list pi commands", cause }),
        }),
      sendRpcSessionCommand: (threadId, commandType, payload) =>
        Effect.tryPromise({
          try: () => runtime.sendRpcSessionCommand(threadId, commandType, payload),
          catch: (cause) => new PiSessionError({ message: "Failed to run pi RPC command", cause }),
        }),
      writeToSession: (threadId, data) =>
        Effect.try({
          try: () => runtime.writeToSession(threadId, data),
          catch: (cause) => new PiSessionError({ message: "Failed to write to pi session", cause }),
        }),
      notifyPromptSubmitted: (threadId) =>
        Effect.tryPromise({
          try: () => runtime.notifyPromptSubmitted(threadId),
          catch: (cause) =>
            new PiSessionError({ message: "Failed to record pi prompt submit", cause }),
        }),
      resizeSession: (threadId, cols, rows) =>
        Effect.try({
          try: () => runtime.resizeSession(threadId, cols, rows),
          catch: (cause) => new PiSessionError({ message: "Failed to resize pi session", cause }),
        }),
      getSessionStatus: (threadId) => Effect.sync(() => runtime.getSessionStatus(threadId)),
      getSessionFile: (threadId) => Effect.sync(() => runtime.getSessionFile(threadId)),
      getSessionHookStatus: (threadId) => Effect.sync(() => runtime.getSessionHookStatus(threadId)),
      getSessionActivityStatus: (threadId) =>
        Effect.sync(() => runtime.getSessionActivityStatus(threadId)),
      getPendingExtensionUiRequest: (threadId) =>
        Effect.sync(() => runtime.getPendingExtensionUiRequest(threadId)),
      getExtensionUiState: (threadId) => Effect.sync(() => runtime.getExtensionUiState(threadId)),
      getSessionUsageStats: (threadId) =>
        Effect.tryPromise({
          try: () => runtime.getSessionUsageStats(threadId),
          catch: (cause) => new PiSessionError({ message: "Failed to get pi usage stats", cause }),
        }),
      reconcileActiveSessions: (maxActive) =>
        Effect.promise(() => runtime.reconcileActiveSessions(maxActive)),
      setMaxActiveSessions: (maxActive) =>
        Effect.promise(() => runtime.setMaxActiveSessions(maxActive)),
      hibernateAll: () => Effect.promise(() => runtime.hibernateAll()),
      hibernateActiveSessions: (excludeThreadIds) =>
        Effect.promise(() => runtime.hibernateActiveSessions(excludeThreadIds)),
      subscribe: (listener) =>
        Effect.sync(() => {
          runtime.on("event", listener);
          return () => {
            runtime.off("event", listener);
          };
        }),
      destroySession: (threadId) => Effect.promise(() => runtime.destroySession(threadId)),
      purgeInactiveSessions: (excludeThreadIds) =>
        Effect.promise(() => runtime.purgeInactiveSessions(excludeThreadIds)),
      dispose: Effect.sync(() => runtime.dispose()),
    } satisfies PiSessionManagerShape;
  }),
);
