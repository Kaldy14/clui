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
  });

  it("classifies common tool names", () => {
    expect(classifyAgentActivityFromTool({ toolName: "TodoWrite" })).toBe("planning");
    expect(classifyAgentActivityFromTool({ toolName: "Edit" })).toBe("coding");
    expect(classifyAgentActivityFromTool({ toolName: "Grep" })).toBe("searching");
    expect(classifyAgentActivityFromTool({ toolName: "AskUserQuestion" })).toBeNull();
  });

  it("classifies bash commands", () => {
    expect(classifyAgentActivityFromBashCommand("git commit -m test")).toBe("committing");
    expect(classifyAgentActivityFromBashCommand("bun run typecheck")).toBe("checking");
    expect(classifyAgentActivityFromBashCommand("bun run test -- Sidebar.logic.test.ts")).toBe(
      "testing",
    );
    expect(classifyAgentActivityFromBashCommand("rg \"foo\" apps packages")).toBe("searching");
  });

  it("classifies pi sync reasons with command context", () => {
    expect(
      classifyAgentActivityFromPiReason({
        reason: "tool_call:Bash",
        toolName: "Bash",
        command: "git push origin feature/statuses",
      }),
    ).toBe("pushing");
    expect(classifyAgentActivityFromPiReason({ reason: "agent_start" })).toBe("planning");
    expect(classifyAgentActivityFromPiReason({ reason: "agent_end" })).toBeNull();
  });
});
