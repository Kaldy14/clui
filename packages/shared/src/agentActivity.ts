import type { AgentActivityStatus } from "@clui/contracts";

export const AGENT_ACTIVITY_LABELS: Record<AgentActivityStatus, string> = {
  thinking: "Thinking",
  planning: "Planning",
  reading: "Reading",
  searching: "Searching",
  researching: "Researching",
  scouting: "Scouting",
  designing: "Designing",
  delegating: "Delegating",
  contextBuilding: "Building Context",
  coding: "Coding",
  debugging: "Debugging",
  testing: "Testing",
  linting: "Linting",
  checking: "Checking",
  building: "Building",
  installing: "Installing",
  committing: "Committing",
  pushing: "Pushing",
  gitting: "Gitting",
  reviewing: "Reviewing",
  translating: "Translating",
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

const AGENT_ACTIVITY_BY_NAME: ReadonlyMap<string, AgentActivityStatus> = new Map([
  ["scout", "scouting"],
  ["planner", "planning"],
  ["reviewer", "reviewing"],
  ["multimodelreviewer", "reviewing"],
  ["researcher", "researching"],
  ["worker", "delegating"],
  ["delegate", "delegating"],
  ["frontenddesigner", "designing"],
  ["contextbuilder", "contextBuilding"],
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
  ["scout", "scouting"],
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
  [/\b(lint|linting|eslint|oxlint)\b|\bbiome\s+lint\b/u, "linting"],
  [/\b(typecheck|type check|format|formatting|compile|checking)\b/u, "checking"],
  [/\b(build|bundle|package)\b/u, "building"],
  [/\b(scout|scouting)\b/u, "scouting"],
  [/\b(review|audit|inspect|critique)\b/u, "reviewing"],
  [/\b(research|investigate|explore|find out|look into|analy[sz]e)\b/u, "researching"],
  [/\b(plan|design|architect|proposal|approach|strategy)\b/u, "planning"],
  [/\b(implement|code|add|create|update|refactor|change|edit|fix|write)\b/u, "coding"],
];

const PACKAGE_MANAGER_WITH_OPTIONAL_FLAGS =
  "(?:bun|npm|pnpm|yarn)(?:\\s+(?:--[\\w.-]+|-c|-f|-w)(?:=\\S+|\\s+\\S+)?)*";
const PACKAGE_MANAGER_TEST_RE = new RegExp(
  `\\b${PACKAGE_MANAGER_WITH_OPTIONAL_FLAGS}\\s+(?:run\\s+)?(?:test|vitest|jest|playwright|cypress)\\b`,
  "u",
);
const PACKAGE_MANAGER_LINT_RE = new RegExp(
  `\\b${PACKAGE_MANAGER_WITH_OPTIONAL_FLAGS}\\s+(?:run\\s+)?(?:lint|eslint|oxlint)\\b`,
  "u",
);
const PACKAGE_MANAGER_CHECK_RE = new RegExp(
  `\\b${PACKAGE_MANAGER_WITH_OPTIONAL_FLAGS}\\s+(?:run\\s+)?(?:typecheck|check|format)\\b`,
  "u",
);
const PACKAGE_MANAGER_BUILD_RE = new RegExp(
  `\\b${PACKAGE_MANAGER_WITH_OPTIONAL_FLAGS}\\s+(?:run\\s+)?(?:build|bundle|compile)\\b`,
  "u",
);

const BASH_PATTERNS: ReadonlyArray<readonly [RegExp, AgentActivityStatus]> = [
  [/\b(?:subagent|agent)\s+(?:run\s+)?scout\b|\bscout\b/u, "scouting"],
  [/\b(?:git\s+commit|git\s+add\b[\s\S]*\bgit\s+commit)\b/u, "committing"],
  [/\b(?:git\s+push|gh\s+pr\s+(?:create|merge|ready|edit))\b/u, "pushing"],
  [/\b(?:git|gh)(?:\s+|$)/u, "gitting"],
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update)\b/u, "installing"],
  [PACKAGE_MANAGER_TEST_RE, "testing"],
  [/\b(?:vitest|jest|pytest|go\s+test|cargo\s+test|swift\s+test|xcodebuild\b[\s\S]*\btest)\b/u, "testing"],
  [PACKAGE_MANAGER_LINT_RE, "linting"],
  [/\b(?:eslint|oxlint)\b|\bbiome\s+lint\b|\bruff\s+check\b/u, "linting"],
  [PACKAGE_MANAGER_CHECK_RE, "checking"],
  [/\b(?:tsc\b|biome\b|prettier\b|mypy\b|cargo\s+check)\b/u, "checking"],
  [PACKAGE_MANAGER_BUILD_RE, "building"],
  [/\b(?:vite\s+build|next\s+build|webpack\b|rollup\b|esbuild\b|cargo\s+build|go\s+build)\b/u, "building"],
  [/\b(?:rg|grep|fd|find|ag)\b/u, "searching"],
  [/\b(?:cat|sed|awk|head|tail|less|ls|tree)\b/u, "reading"],
  [/\b(?:apply_patch|mkdir|touch|mv|cp|rm)\b/u, "coding"],
];

function normalizeToolName(toolName: unknown): string {
  return String(toolName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function classifyKnownAgentName(agentName: unknown): AgentActivityStatus | null {
  const normalized = normalizeToolName(agentName);
  return AGENT_ACTIVITY_BY_NAME.get(normalized) ?? null;
}

function classifyKnownAgentActivityFromText(text: string): AgentActivityStatus | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;

  const agentPatterns = [
    /\b(?:subagent|agent)\s+(?:run\s+)?([a-z][\w.-]*)\b/u,
    /\brunning\s+([a-z][\w.-]*)\b/u,
    /\buse\s+(?:the\s+)?([a-z][\w.-]*)\s+(?:agent|subagent)\b/u,
  ];
  for (const pattern of agentPatterns) {
    const match = pattern.exec(normalized);
    const activity = classifyKnownAgentName(match?.[1]);
    if (activity) return activity;
  }

  const compact = normalized.replace(/[^a-z0-9]+/g, "");
  for (const [agentName, activity] of AGENT_ACTIVITY_BY_NAME) {
    if ((agentName === "worker" || agentName === "delegate") && !normalized.includes("subagent")) {
      continue;
    }
    if (compact.includes(agentName)) return activity;
  }

  return null;
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

function extractAgentName(toolInput: unknown, explicitAgentName?: unknown): string | null {
  if (typeof explicitAgentName === "string" && explicitAgentName.trim().length > 0) {
    return explicitAgentName.trim();
  }
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return null;
  const record = toolInput as Record<string, unknown>;
  return recordString(record, "agent") ?? recordString(record, "agentName") ?? null;
}

function classifyAgentActivityFromText(
  text: string,
  fallback?: AgentActivityStatus,
): AgentActivityStatus | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;
  const agentActivity = classifyKnownAgentActivityFromText(normalized);
  if (agentActivity) return agentActivity;
  for (const [pattern, activity] of PROMPT_PATTERNS) {
    if (pattern.test(normalized)) return activity;
  }
  return fallback ?? null;
}

export function classifyAgentActivityFromPrompt(promptText: string): AgentActivityStatus | null {
  return classifyAgentActivityFromText(promptText, "thinking");
}

export function classifyAgentActivityFromBashCommand(
  command: string,
  description?: string | null,
): AgentActivityStatus | null {
  const normalized = `${command}\n${description ?? ""}`.trim().toLowerCase();
  if (!normalized) return null;
  const agentActivity = classifyKnownAgentActivityFromText(normalized);
  if (agentActivity) return agentActivity;
  for (const [pattern, activity] of BASH_PATTERNS) {
    if (pattern.test(normalized)) return activity;
  }
  return null;
}

export function classifyAgentActivityFromTool(input: {
  readonly toolName: unknown;
  readonly toolInput?: unknown;
  readonly command?: unknown;
  readonly description?: unknown;
  readonly agentName?: unknown;
}): AgentActivityStatus | null {
  const toolName = normalizeToolName(input.toolName);
  if (!toolName || USER_INPUT_TOOL_NAMES.has(toolName)) return null;
  if (toolName === "bash") {
    const command = extractCommand(input.toolInput, input.command);
    const description = extractDescription(input.toolInput, input.description);
    return command ? classifyAgentActivityFromBashCommand(command, description) : null;
  }

  const agentName = extractAgentName(input.toolInput, input.agentName);
  const byAgentName = classifyKnownAgentName(agentName);
  if (byAgentName) return byAgentName;

  const description = extractDescription(input.toolInput, input.description);
  if ((toolName === "task" || toolName === "subagent") && description) {
    const byDescription = classifyAgentActivityFromText(description);
    if (byDescription) return byDescription;
  }

  return TOOL_ACTIVITY_BY_NAME.get(toolName) ?? null;
}

export function classifyAgentActivityFromPiReason(input: {
  readonly reason?: string | undefined;
  readonly toolName?: unknown;
  readonly command?: unknown;
  readonly description?: unknown;
  readonly agentName?: unknown;
}): AgentActivityStatus | null {
  const reason = input.reason ?? "";
  if (reason === "initial_prompt" || reason === "agent_start" || reason === "provider_request") {
    return "thinking";
  }
  if (reason === "agent_end") return null;

  const toolMatch = /^(tool_start|tool_call|tool_input|tool_input_resolved):(.+)$/u.exec(reason);
  if (toolMatch?.[1] === "tool_input_resolved") return "thinking";

  const explicitToolName = input.toolName;
  if (typeof explicitToolName === "string" && explicitToolName.trim().length > 0) {
    return classifyAgentActivityFromTool({
      toolName: explicitToolName,
      command: input.command,
      description: input.description,
      agentName: input.agentName,
    });
  }

  if (!toolMatch) return null;
  return classifyAgentActivityFromTool({
    toolName: toolMatch[2],
    command: input.command,
    description: input.description,
    agentName: input.agentName,
  });
}
