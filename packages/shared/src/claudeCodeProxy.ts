import { DEFAULT_CLAUDE_CODE_PROXY_MODEL, type ClaudeCodeProxyModel } from "@clui/contracts";

export const CLAUDE_CODE_PROXY_MODEL_OPTIONS: ReadonlyArray<{
  readonly value: ClaudeCodeProxyModel;
  readonly label: string;
}> = [
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
];

const CLAUDE_CODE_PROXY_MODELS = new Set(
  CLAUDE_CODE_PROXY_MODEL_OPTIONS.map((option) => option.value),
);

export function isClaudeCodeProxyModel(model: string): model is ClaudeCodeProxyModel {
  return CLAUDE_CODE_PROXY_MODELS.has(model as ClaudeCodeProxyModel);
}

export function resolveClaudeCodeProxyModel(model: string): ClaudeCodeProxyModel {
  const normalized = model.trim().replace(/\[1m\]$/, "");
  return isClaudeCodeProxyModel(normalized) ? normalized : DEFAULT_CLAUDE_CODE_PROXY_MODEL;
}
