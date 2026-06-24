import type { PiTranscriptItem, PiTranscriptPart } from "@clui/contracts";

export interface PiTranscriptReadResult {
  readonly items: PiTranscriptItem[];
  readonly offset: number;
  readonly reset: boolean;
}

function isoTimestampFromValue(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactText(parts: readonly PiTranscriptPart[]): string {
  return parts
    .map((part) => {
      switch (part.type) {
        case "text":
        case "thinking":
          return part.text;
        case "toolCall":
          return part.name;
        case "image":
          return part.mimeType ? `[image: ${part.mimeType}]` : "[image]";
      }
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function contentParts(content: unknown): PiTranscriptPart[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }

  if (!Array.isArray(content)) return [];

  const parts: PiTranscriptPart[] = [];
  for (const rawPart of content) {
    if (!isRecord(rawPart)) continue;
    const type = rawPart.type;
    if (type === "text" && typeof rawPart.text === "string") {
      parts.push({ type: "text", text: rawPart.text });
      continue;
    }
    if (type === "thinking" && typeof rawPart.thinking === "string") {
      parts.push({ type: "thinking", text: rawPart.thinking });
      continue;
    }
    if (type === "toolCall") {
      const name = typeof rawPart.name === "string" && rawPart.name.length > 0 ? rawPart.name : "tool";
      parts.push({
        type: "toolCall",
        name,
        input: rawPart.arguments ?? rawPart.input ?? {},
        ...(typeof rawPart.id === "string" ? { id: rawPart.id } : {}),
      });
      continue;
    }
    if (type === "image") {
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

function parseMessageEntry(entry: Record<string, unknown>, id: string): PiTranscriptItem | null {
  const message = entry.message;
  if (!isRecord(message)) return null;

  const createdAt = isoTimestampFromValue(entry.timestamp) ?? isoTimestampFromValue(message.timestamp);
  const role = message.role;
  const parts = contentParts(message.content);
  const text = compactText(parts);

  if (role === "user") {
    return { id, role: "user", text, parts, createdAt };
  }

  if (role === "assistant") {
    return { id, role: "assistant", text, parts, createdAt };
  }

  if (role === "toolResult") {
    const toolName = typeof message.toolName === "string" ? message.toolName : undefined;
    const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
    return {
      id,
      role: "toolResult",
      text,
      parts,
      createdAt,
      ...(toolName !== undefined ? { toolName } : {}),
      ...(toolCallId !== undefined ? { toolCallId } : {}),
      ...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
    };
  }

  if (role === "bashExecution") {
    const command = typeof message.command === "string" ? message.command : "";
    const output = typeof message.output === "string" ? message.output : "";
    const bashParts: PiTranscriptPart[] = [
      ...(command ? [{ type: "text" as const, text: `$ ${command}` }] : []),
      ...(output ? [{ type: "text" as const, text: output }] : []),
    ];
    return {
      id,
      role: "bashExecution",
      text: compactText(bashParts),
      parts: bashParts,
      createdAt,
      ...(typeof message.exitCode === "number" && message.exitCode !== 0 ? { isError: true } : {}),
    };
  }

  if (role === "custom") {
    return { id, role: "custom", text, parts, createdAt };
  }

  if (role === "branchSummary" || role === "compactionSummary") {
    const summary =
      typeof message.summary === "string" ? message.summary : text;
    const summaryParts: PiTranscriptPart[] = summary ? [{ type: "text", text: summary }] : [];
    return {
      id,
      role: "summary",
      text: summary,
      parts: summaryParts,
      createdAt,
      summaryKind: role === "compactionSummary" ? "compaction" : "branch",
    };
  }

  return null;
}

function parseEntryLine(line: string, id: string): PiTranscriptItem | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  if (parsed.type === "message") {
    return parseMessageEntry(parsed, id);
  }

  if (parsed.type === "custom_message") {
    const content = parsed.content;
    const parts = contentParts(content);
    const text = compactText(parts);
    return {
      id,
      role: "custom",
      text,
      parts,
      createdAt: isoTimestampFromValue(parsed.timestamp),
    };
  }

  if (parsed.type === "compaction" || parsed.type === "branch_summary") {
    const summary = typeof parsed.summary === "string" ? parsed.summary : "";
    const parts: PiTranscriptPart[] = summary ? [{ type: "text", text: summary }] : [];
    return {
      id,
      role: "summary",
      text: summary,
      parts,
      createdAt: isoTimestampFromValue(parsed.timestamp),
      summaryKind: parsed.type === "compaction" ? "compaction" : "branch",
    };
  }

  if (parsed.type === "model_change") {
    const provider = typeof parsed.provider === "string" ? parsed.provider : "";
    const modelId = typeof parsed.modelId === "string" ? parsed.modelId : "";
    const text = [provider, modelId].filter(Boolean).join("/");
    const parts: PiTranscriptPart[] = text ? [{ type: "text", text }] : [];
    return {
      id,
      role: "system",
      text,
      parts,
      createdAt: isoTimestampFromValue(parsed.timestamp),
    };
  }

  return null;
}

export function parsePiTranscriptBuffer(buffer: Buffer, sinceOffset?: number): PiTranscriptReadResult {
  const totalOffset = buffer.length;
  const startOffset =
    sinceOffset != null && sinceOffset >= 0 && sinceOffset <= totalOffset ? sinceOffset : 0;
  const reset = sinceOffset != null && startOffset !== sinceOffset;
  const slice = buffer.subarray(startOffset);
  const text = slice.toString("utf8");
  const lines = text.split(/\n/u);
  const items: PiTranscriptItem[] = [];
  let relativeOffset = 0;

  for (const line of lines) {
    if (line.length === 0) {
      relativeOffset += 1;
      continue;
    }
    const lineWithoutCr = line.endsWith("\r") ? line.slice(0, -1) : line;
    const lineByteLength = Buffer.byteLength(line, "utf8") + 1;
    const id = String(startOffset + relativeOffset);
    const item = parseEntryLine(lineWithoutCr, id);
    if (item) items.push(item);
    relativeOffset += lineByteLength;
  }

  return { items, offset: totalOffset, reset };
}
