import type { AgentActivityStatus } from "@clui/contracts";

export const AGENT_ACTIVITY_LABELS: Record<AgentActivityStatus, string> = {
  planning: "Planning",
  reading: "Reading",
  searching: "Searching",
  researching: "Researching",
  coding: "Coding",
  debugging: "Debugging",
  testing: "Testing",
  checking: "Checking",
  building: "Building",
  installing: "Installing",
  committing: "Committing",
  pushing: "Pushing",
  reviewing: "Reviewing",
  translating: "Translating",
  running: "Running",
};

const USER_INPUT_TOOL_NAMES = new Set([
  "ask",
  "askfollowupquestion",
  "askquestion",
  "askuser",
  "askuserquestion",
  "planreview",
  "question",
  "questionnaire",
]);

const TOOL_ACTIVITY_BY_NAME: ReadonlyMap<string, AgentActivityStatus> = new Map([
  ["todowrite", "planning"],
  ["exitplanmode", "planning"],
  ["read", "reading"],
  ["ls", "reading"],
  ["notebookread", "reading"],
  ["grep", "searching"],
  ["glob", "searching"],
  ["websearch", "researching"],
  ["webfetch", "researching"],
  ["task", "researching"],
  ["edit", "coding"],
  ["multiedit", "coding"],
  ["write", "coding"],
  ["notebookedit", "coding"],
]);

const PROMPT_PATTERNS: ReadonlyArray<readonly [RegExp, AgentActivityStatus]> = [
  [/\b(translat(?:e|ing|ion)|locali[sz](?:e|ing|ation)|i18n|l10n)\b/u, "translating"],
  [/\b(commit|committing)\b/u, "committing"],
  [/\b(push|publish|pull request|pr)\b/u, "pushing"],
  [/\b(debug|diagnos(?:e|ing)|bug|error|failing|failure|crash|broken)\b/u, "debugging"],
  [/\b(test|tests|spec|coverage|vitest|jest|playwright)\b/u, "testing"],
  [/\b(typecheck|type check|lint|linting|format|formatting|compile|checking)\b/u, "checking"],
  [/\b(build|bundle|package)\b/u, "building"],
  [/\b(review|audit|inspect|critique)\b/u, "reviewing"],
  [/\b(research|investigate|explore|find out|look into|analy[sz]e)\b/u, "researching"],
  [/\b(plan|design|architect|proposal|approach|strategy)\b/u, "planning"],
  [/\b(implement|code|add|create|update|refactor|change|edit|fix|write)\b/u, "coding"],
];

const BASH_PATTERNS: ReadonlyArray<readonly [RegExp, AgentActivityStatus]> = [
  [/\b(?:git\s+commit|git\s+add\b[\s\S]*\bgit\s+commit)\b/u, "committing"],
  [/\b(?:git\s+push|gh\s+pr\s+(?:create|merge|ready|edit))\b/u, "pushing"],
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update)\b/u, "installing"],
  [/\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:test|vitest|jest|playwright|cypress)\b/u, "testing"],
  [/\b(?:vitest|jest|pytest|go\s+test|cargo\s+test|swift\s+test|xcodebuild\b[\s\S]*\btest)\b/u, "testing"],
  [/\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:lint|typecheck|check|format)\b/u, "checking"],
  [/\b(?:tsc\b|eslint\b|oxlint\b|biome\b|prettier\b|ruff\b|mypy\b|cargo\s+check)\b/u, "checking"],
  [/\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:build|bundle|compile)\b/u, "building"],
  [/\b(?:vite\s+build|next\s+build|webpack\b|rollup\b|esbuild\b|cargo\s+build|go\s+build)\b/u, "building"],
  [/\b(?:git\s+(?:status|diff|log|show)|gh\s+pr\s+(?:view|diff|checks|list))\b/u, "reviewing"],
  [/\b(?:rg|grep|fd|find|ag)\b/u, "searching"],
  [/\b(?:cat|sed|awk|head|tail|less|ls|tree)\b/u, "reading"],
  [/\b(?:apply_patch|mkdir|touch|mv|cp|rm)\b/u, "coding"],
];

function normalizeToolName(toolName: unknown): string {
  return String(toolName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function recordString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function extractCommand(toolInput: unknown, explicitCommand?: unknown): string | null {
  if (typeof explicitCommand === "string" && explicitCommand.trim().length > 0) {
    return explicitCommand.trim();
  }
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return null;
  const record = toolInput as Record<string, unknown>;
  return recordString(record, "command") ?? recordString(record, "cmd") ?? null;
}

function extractDescription(toolInput: unknown, explicitDescription?: unknown): string | null {
  if (typeof explicitDescription === "string" && explicitDescription.trim().length > 0) {
    return explicitDescription.trim();
  }
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return null;
  const record = toolInput as Record<string, unknown>;
  return recordString(record, "description") ?? recordString(record, "summary") ?? null;
}

export function classifyAgentActivityFromPrompt(promptText: string): AgentActivityStatus | null {
  const normalized = promptText.trim().toLowerCase();
  if (!normalized) return null;
  for (const [pattern, activity] of PROMPT_PATTERNS) {
    if (pattern.test(normalized)) return activity;
  }
  return "planning";
}

export function classifyAgentActivityFromBashCommand(
  command: string,
  description?: string | null,
): AgentActivityStatus | null {
  const normalized = `${command}\n${description ?? ""}`.trim().toLowerCase();
  if (!normalized) return null;
  for (const [pattern, activity] of BASH_PATTERNS) {
    if (pattern.test(normalized)) return activity;
  }
  return "running";
}

export function classifyAgentActivityFromTool(input: {
  readonly toolName: unknown;
  readonly toolInput?: unknown;
  readonly command?: unknown;
  readonly description?: unknown;
}): AgentActivityStatus | null {
  const toolName = normalizeToolName(input.toolName);
  if (!toolName || USER_INPUT_TOOL_NAMES.has(toolName)) return null;
  if (toolName === "bash") {
    const command = extractCommand(input.toolInput, input.command);
    const description = extractDescription(input.toolInput, input.description);
    return command ? classifyAgentActivityFromBashCommand(command, description) : "running";
  }
  return TOOL_ACTIVITY_BY_NAME.get(toolName) ?? "running";
}

export function classifyAgentActivityFromPiReason(input: {
  readonly reason?: string | undefined;
  readonly toolName?: unknown;
  readonly command?: unknown;
  readonly description?: unknown;
}): AgentActivityStatus | null {
  const explicitToolName = input.toolName;
  if (typeof explicitToolName === "string" && explicitToolName.trim().length > 0) {
    return classifyAgentActivityFromTool({
      toolName: explicitToolName,
      command: input.command,
      description: input.description,
    });
  }

  const reason = input.reason ?? "";
  if (reason === "initial_prompt" || reason === "agent_start") return "planning";
  if (reason === "agent_end") return null;

  const toolMatch = /^(?:tool_start|tool_call|tool_input|tool_input_resolved):(.+)$/u.exec(reason);
  if (!toolMatch) return null;
  return classifyAgentActivityFromTool({
    toolName: toolMatch[1],
    command: input.command,
    description: input.description,
  });
}
