import { ThreadId, type JourneyAttemptFence } from "@clui/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  JourneyAgentOutputView,
  journeyAgentOutputWaitingMessage,
} from "./JourneyAgentOutputView";

describe("JourneyAgentOutputView", () => {
  it("does not fall back to thread-wide output for a projected node without a fence", () => {
    const threadId = ThreadId.makeUnsafe("journey-output-no-fence");
    const html = renderToStaticMarkup(
      <JourneyAgentOutputView threadId={threadId} harness="codexCli" fence={null} />,
    );

    expect(html).toContain("No output yet.");
    expect(html).not.toContain("Waiting for Codex output");
  });

  it("selects the fenced attempt output surface when a physical fence is provided", () => {
    const threadId = ThreadId.makeUnsafe("journey-output-view");
    const fence: JourneyAttemptFence = {
      threadId,
      runId: "selected-run",
      nodeId: "selected-node",
      attempt: 2,
    };
    const html = renderToStaticMarkup(
      <JourneyAgentOutputView threadId={threadId} harness="codexCli" fence={fence} />,
    );
    expect(html).toContain("Starting Codex");
    expect(html).toContain('role="log"');
  });

  it("keeps visible feedback while Codex has emitted only non-displayable startup output", () => {
    expect(
      journeyAgentOutputWaitingMessage({
        harness: "codexCli",
        output: "Reading additional input from stdin…\n2026-08-03 WARN startup",
        codexEntryCount: 0,
      }),
    ).toBe("Codex is working… Waiting for the first displayable update.");
  });

  it("clears the waiting feedback after Codex emits a displayable entry", () => {
    expect(
      journeyAgentOutputWaitingMessage({
        harness: "codexCli",
        output: '{"type":"item.completed"}',
        codexEntryCount: 1,
      }),
    ).toBeNull();
  });
});
