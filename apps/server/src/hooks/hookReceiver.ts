/**
 * Hook receiver — HTTP handlers for Claude Code hook callbacks.
 *
 * Receives POST requests from curl commands injected via --settings hooks.
 * Parses the JSON body, classifies notifications, and returns typed events.
 *
 * @module hookReceiver
 */
import type { ClaudeHookNotificationCategory, ClaudeSessionEvent } from "@clui/contracts";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_NOTIFICATION_BODY_LENGTH = 180;

// ── Input parsing ─────────────────────────────────────────────────────

interface ParsedHookInput {
  sessionId: string | null;
  cwd: string | null;
  rawObject: Record<string, unknown> | null;
}

function firstString(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function extractSessionId(obj: Record<string, unknown>): string | null {
  const direct = firstString(obj, ["session_id", "sessionId"]);
  if (direct) return direct;
  // Check nested objects (notification, data, session, context)
  for (const nestedKey of ["notification", "data", "session", "context"]) {
    const nested = obj[nestedKey];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const found = firstString(nested as Record<string, unknown>, ["session_id", "sessionId", "id"]);
      if (found) return found;
    }
  }
  return null;
}

function extractCwd(obj: Record<string, unknown>): string | null {
  const direct = firstString(obj, ["cwd", "working_directory", "workingDirectory", "project_dir", "projectDir"]);
  if (direct) return direct;
  for (const nestedKey of ["notification", "data", "context"]) {
    const nested = obj[nestedKey];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const found = firstString(nested as Record<string, unknown>, ["cwd", "working_directory", "workingDirectory"]);
      if (found) return found;
    }
  }
  return null;
}

export function parseHookInput(rawBody: string): ParsedHookInput {
  const trimmed = rawBody.trim();
  if (!trimmed) return { sessionId: null, cwd: null, rawObject: null };

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { sessionId: null, cwd: null, rawObject: null };
    }
    const obj = parsed as Record<string, unknown>;
    return {
      sessionId: extractSessionId(obj),
      cwd: extractCwd(obj),
      rawObject: obj,
    };
  } catch {
    return { sessionId: null, cwd: null, rawObject: null };
  }
}

// ── Notification classification ───────────────────────────────────────

function classifyNotification(signal: string, message: string): { subtitle: string; body: string; category: ClaudeHookNotificationCategory } {
  const lower = `${signal} ${message}`.toLowerCase();

  if (lower.includes("permission") || lower.includes("approve") || lower.includes("approval")) {
    return {
      subtitle: "Permission",
      body: message || "Approval needed",
      category: "permission",
    };
  }

  if (lower.includes("error") || lower.includes("failed") || lower.includes("exception")) {
    return {
      subtitle: "Error",
      body: message || "Claude reported an error",
      category: "error",
    };
  }

  if (lower.includes("idle") || lower.includes("wait") || lower.includes("input") || lower.includes("prompt") || lower.includes("question")) {
    return {
      subtitle: "Waiting",
      body: message || "Claude is waiting for your input",
      category: "waiting",
    };
  }

  return {
    subtitle: "Attention",
    body: message || "Claude needs your input",
    category: "attention",
  };
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}\u2026`;
}

export function summarizeNotification(rawBody: string): { title: string; subtitle: string; body: string; category: ClaudeHookNotificationCategory } {
  const { rawObject } = parseHookInput(rawBody);
  const title = "Claude Code";

  if (!rawObject) {
    const fallback = truncate(normalizeWhitespace(rawBody), MAX_NOTIFICATION_BODY_LENGTH);
    const classified = classifyNotification(fallback, fallback);
    return { title, ...classified };
  }

  // Extract signal parts (event type, kind, reason)
  const nested = (rawObject.notification as Record<string, unknown>) ??
    (rawObject.data as Record<string, unknown>) ?? {};

  const signalParts = [
    firstString(rawObject, ["event", "event_name", "hook_event_name", "type", "kind"]),
    firstString(rawObject, ["notification_type", "matcher", "reason"]),
    typeof nested === "object" && nested !== null ? firstString(nested as Record<string, unknown>, ["type", "kind", "reason"]) : null,
  ].filter(Boolean);

  // Extract message
  const messageCandidates = [
    firstString(rawObject, ["message", "body", "text", "prompt", "error", "description"]),
    typeof nested === "object" && nested !== null
      ? firstString(nested as Record<string, unknown>, ["message", "body", "text", "prompt", "error", "description"])
      : null,
  ].filter(Boolean);

  const message = messageCandidates[0] ?? "Claude needs your input";
  const normalizedMessage = normalizeWhitespace(message);
  const signal = signalParts.join(" ");
  const classified = classifyNotification(signal, normalizedMessage);
  classified.body = truncate(classified.body, MAX_NOTIFICATION_BODY_LENGTH);

  return { title, ...classified };
}

// ── Event builders ────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

export function buildUserPromptSubmitEvents(threadId: string): ClaudeSessionEvent[] {
  // User sent a message — Claude is about to start processing
  return [
    { type: "hookStatus", threadId, createdAt: now(), hookStatus: "working" },
  ];
}

/**
 * Tool names that represent Claude asking the user a question rather than
 * requesting permission for a side-effecting operation.
 */
const ASK_TOOL_NAMES = new Set([
  "askuserquestion",
  "askfollowupquestion",
  "askquestion",
  "ask",
  "askuser",
]);

function isAskTool(rawBody: string): boolean {
  const { rawObject } = parseHookInput(rawBody);
  if (!rawObject) return false;

  // Claude Code sends tool_name / toolName in the PermissionRequest body
  const toolName = firstString(rawObject, ["tool_name", "toolName", "tool", "name"]);
  if (!toolName) return false;

  return ASK_TOOL_NAMES.has(toolName.toLowerCase().replace(/[_-]/g, ""));
}

export function buildPermissionRequestEvents(threadId: string, rawBody: string): ClaudeSessionEvent[] {
  if (isAskTool(rawBody)) {
    // Ask tools are not permission requests — they're questions to the user
    return [
      { type: "hookStatus", threadId, createdAt: now(), hookStatus: "needsInput" },
    ];
  }
  return [
    { type: "hookStatus", threadId, createdAt: now(), hookStatus: "pendingApproval" },
  ];
}

export function buildPostToolUseEvents(threadId: string): ClaudeSessionEvent[] {
  // A tool completed — Claude is continuing to work.
  // This clears "Pending Approval" after the user grants permission.
  return [
    { type: "hookStatus", threadId, createdAt: now(), hookStatus: "working" },
  ];
}

export function buildStopEvents(threadId: string): ClaudeSessionEvent[] {
  // Claude finished responding — clear status.
  // Matches cmux's clearClaudeStatus() on stop.
  return [
    { type: "hookStatus", threadId, createdAt: now(), hookStatus: "completed" },
  ];
}

export function buildNotificationEvents(threadId: string, rawBody: string): ClaudeSessionEvent[] {
  const summary = summarizeNotification(rawBody);
  const events: ClaudeSessionEvent[] = [];

  // Map notification category to hook status
  const statusMap: Record<ClaudeHookNotificationCategory, "needsInput" | "pendingApproval" | "error" | "needsInput"> = {
    permission: "pendingApproval",
    error: "error",
    waiting: "needsInput",
    attention: "needsInput",
  };

  events.push({
    type: "hookStatus",
    threadId,
    createdAt: now(),
    hookStatus: statusMap[summary.category],
  });

  events.push({
    type: "hookNotification",
    threadId,
    createdAt: now(),
    title: summary.title,
    subtitle: summary.subtitle,
    body: summary.body,
    category: summary.category,
  });

  return events;
}

// ── HTTP body reader ──────────────────────────────────────────────────

export function readRequestBody(req: { on: (event: string, cb: (...args: unknown[]) => void) => void }): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk: unknown) => {
      const buf = chunk instanceof Buffer ? chunk : Buffer.from(String(chunk));
      totalBytes += buf.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
  });
}
