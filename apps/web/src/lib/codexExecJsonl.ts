type JsonRecord = Record<string, unknown>;

export type CodexExecOutputEntryKind =
  | "agent"
  | "reasoning"
  | "command"
  | "fileChange"
  | "tool"
  | "search"
  | "plan"
  | "error";

export interface CodexExecOutputEntry {
  readonly id: string;
  readonly kind: CodexExecOutputEntryKind;
  readonly title: string;
  readonly detail: string;
  readonly status: string | null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: JsonRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function stringifyDetail(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function parseCodexExecJsonl(output: string): JsonRecord[] {
  const events: JsonRecord[] = [];
  for (const line of output.split(/\r?\n/gu)) {
    const candidate = line.trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isRecord(parsed)) events.push(parsed);
    } catch {
      // A partial final line is expected while a JSONL event is streaming.
    }
  }
  return events;
}

export function latestCodexExecAgentMessage(output: string): string | null {
  const events = parseCodexExecJsonl(output);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (readString(event, "type") !== "item.completed" || !isRecord(event.item)) continue;
    if (readString(event.item, "type") !== "agent_message") continue;
    const text = readString(event.item, "text");
    if (text?.trim()) return text;
  }
  return null;
}

function outputEntryFromItem(item: JsonRecord, fallbackId: string): CodexExecOutputEntry | null {
  const id = readString(item, "id") ?? fallbackId;
  const type = readString(item, "type") ?? "unknown";
  const status = readString(item, "status");

  if (type === "agent_message") {
    return {
      id,
      kind: "agent",
      title: "Codex",
      detail: readString(item, "text") ?? "",
      status,
    };
  }
  if (type === "reasoning") {
    return {
      id,
      kind: "reasoning",
      title: "Reasoning",
      detail: readString(item, "text") ?? stringifyDetail(item.summary),
      status,
    };
  }
  if (type === "command_execution") {
    return {
      id,
      kind: "command",
      title: readString(item, "command") ?? "Command",
      detail:
        readString(item, "aggregated_output") ?? readString(item, "output") ?? "Running command…",
      status,
    };
  }
  if (type === "file_change") {
    return {
      id,
      kind: "fileChange",
      title: "File changes",
      detail: stringifyDetail(item.changes ?? item.files),
      status,
    };
  }
  if (type === "mcp_tool_call") {
    const server = readString(item, "server");
    const tool = readString(item, "tool");
    return {
      id,
      kind: "tool",
      title: [server, tool].filter(Boolean).join(" · ") || "Tool call",
      detail: stringifyDetail(item.result ?? item.error ?? item.arguments),
      status,
    };
  }
  if (type === "web_search") {
    return {
      id,
      kind: "search",
      title: "Web search",
      detail: readString(item, "query") ?? stringifyDetail(item),
      status,
    };
  }
  if (type === "plan_update") {
    return {
      id,
      kind: "plan",
      title: "Plan",
      detail: stringifyDetail(item.plan ?? item.text),
      status,
    };
  }
  return null;
}

export function codexExecOutputEntries(output: string): CodexExecOutputEntry[] {
  const entries = new Map<string, CodexExecOutputEntry>();
  let anonymousId = 0;

  for (const event of parseCodexExecJsonl(output)) {
    const eventType = readString(event, "type") ?? "";
    if (eventType.startsWith("item.") && isRecord(event.item)) {
      anonymousId += 1;
      const entry = outputEntryFromItem(event.item, `item-${anonymousId}`);
      if (entry) entries.set(entry.id, entry);
      continue;
    }
    if (eventType === "turn.failed" || eventType === "error") {
      anonymousId += 1;
      const detail = stringifyDetail(event.error ?? event.message ?? event);
      entries.set(`error-${anonymousId}`, {
        id: `error-${anonymousId}`,
        kind: "error",
        title: "Codex error",
        detail,
        status: "failed",
      });
    }
  }

  return [...entries.values()];
}
