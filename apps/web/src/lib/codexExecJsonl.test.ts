import { describe, expect, it } from "vitest";

import {
  codexExecOutputEntries,
  latestCodexExecAgentMessage,
  parseCodexExecJsonl,
} from "./codexExecJsonl";

describe("Codex exec JSONL", () => {
  it("ignores incomplete lines while preserving complete events", () => {
    const output = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "message-1", type: "agent_message", text: "done" },
      }),
      '{"type":"item.started"',
    ].join("\n");

    expect(parseCodexExecJsonl(output)).toHaveLength(2);
    expect(latestCodexExecAgentMessage(output)).toBe("done");
  });

  it("keeps the latest state for each streamed item", () => {
    const output = [
      JSON.stringify({
        type: "item.started",
        item: { id: "command-1", type: "command_execution", command: "bun typecheck" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "command-1",
          type: "command_execution",
          command: "bun typecheck",
          aggregated_output: "Tasks: 6 successful",
          status: "completed",
        },
      }),
    ].join("\n");

    expect(codexExecOutputEntries(output)).toEqual([
      {
        id: "command-1",
        kind: "command",
        title: "bun typecheck",
        detail: "Tasks: 6 successful",
        status: "completed",
      },
    ]);
  });
});
