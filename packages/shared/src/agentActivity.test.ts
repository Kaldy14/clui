import { describe, expect, it } from "vitest";

import {
  classifyAgentActivityFromBashCommand,
  classifyAgentActivityFromPiReason,
  classifyAgentActivityFromPrompt,
  classifyAgentActivityFromTool,
} from "./agentActivity";

describe("agent activity classification", () => {
  it("classifies prompt intent", () => {
    expect(classifyAgentActivityFromPrompt("translate the login page to Spanish")).toBe(
      "translating",
    );
    expect(classifyAgentActivityFromPrompt("plan the migration")).toBe("planning");
    expect(classifyAgentActivityFromPrompt("fix the failing tests")).toBe("debugging");
    expect(classifyAgentActivityFromPrompt("scout the codebase first")).toBe("scouting");
    expect(classifyAgentActivityFromPrompt("use the frontend-designer agent")).toBe("designing");
    expect(classifyAgentActivityFromPrompt("what do you think?")).toBe("thinking");
  });

  it("classifies common tool names", () => {
    expect(classifyAgentActivityFromTool({ toolName: "TodoWrite" })).toBe("planning");
    expect(classifyAgentActivityFromTool({ toolName: "Edit" })).toBe("coding");
    expect(classifyAgentActivityFromTool({ toolName: "Grep" })).toBe("searching");
    expect(
      classifyAgentActivityFromTool({ toolName: "Subagent", description: "running scout" }),
    ).toBe("scouting");
    expect(classifyAgentActivityFromTool({ toolName: "Subagent", agentName: "planner" })).toBe(
      "planning",
    );
    expect(classifyAgentActivityFromTool({ toolName: "Subagent", agentName: "reviewer" })).toBe(
      "reviewing",
    );
    expect(
      classifyAgentActivityFromTool({ toolName: "Subagent", agentName: "multi-model-reviewer" }),
    ).toBe("reviewing");
    expect(classifyAgentActivityFromTool({ toolName: "Subagent", agentName: "researcher" })).toBe(
      "researching",
    );
    expect(classifyAgentActivityFromTool({ toolName: "Subagent", agentName: "worker" })).toBe(
      "delegating",
    );
    expect(
      classifyAgentActivityFromTool({ toolName: "Subagent", agentName: "frontend-designer" }),
    ).toBe("designing");
    expect(
      classifyAgentActivityFromTool({ toolName: "Subagent", agentName: "context-builder" }),
    ).toBe("contextBuilding");
    expect(classifyAgentActivityFromTool({ toolName: "AskUserQuestion" })).toBeNull();
  });

  it("classifies bash commands", () => {
    expect(classifyAgentActivityFromBashCommand("git commit -m test")).toBe("committing");
    expect(classifyAgentActivityFromBashCommand("git push origin main")).toBe("pushing");
    expect(classifyAgentActivityFromBashCommand("git status --short")).toBe("gitting");
    expect(classifyAgentActivityFromBashCommand("git diff --stat")).toBe("gitting");
    expect(classifyAgentActivityFromBashCommand("gh pr view 42")).toBe("gitting");
    expect(classifyAgentActivityFromBashCommand("pnpm --dir apps/core-hub run test")).toBe(
      "testing",
    );
    expect(classifyAgentActivityFromBashCommand("pnpm -C apps/core-hub run lint")).toBe(
      "linting",
    );
    expect(classifyAgentActivityFromBashCommand("eslint apps/core-hub/src")).toBe("linting");
    expect(classifyAgentActivityFromBashCommand("vitest run agentActivity.test.ts")).toBe(
      "testing",
    );
    expect(classifyAgentActivityFromBashCommand("bun run typecheck")).toBe("checking");
    expect(classifyAgentActivityFromBashCommand("bun run test -- Sidebar.logic.test.ts")).toBe(
      "testing",
    );
    expect(classifyAgentActivityFromBashCommand("rg \"foo\" apps packages")).toBe("searching");
    expect(classifyAgentActivityFromBashCommand("subagent scout investigate websocket state")).toBe(
      "scouting",
    );
    expect(classifyAgentActivityFromBashCommand("subagent reviewer inspect this diff")).toBe(
      "reviewing",
    );
    expect(classifyAgentActivityFromBashCommand("printf hello")).toBeNull();
  });

  it("classifies pi sync reasons with command context", () => {
    expect(
      classifyAgentActivityFromPiReason({
        reason: "tool_call:Bash",
        toolName: "Bash",
        command: "git push origin feature/statuses",
      }),
    ).toBe("pushing");
    expect(classifyAgentActivityFromPiReason({ reason: "agent_start" })).toBe("thinking");
    expect(classifyAgentActivityFromPiReason({ reason: "provider_request" })).toBe("thinking");
    expect(
      classifyAgentActivityFromPiReason({
        reason: "tool_input_resolved:questionnaire",
        toolName: "questionnaire",
      }),
    ).toBe("thinking");
    expect(classifyAgentActivityFromPiReason({ reason: "agent_end" })).toBeNull();
  });
});
