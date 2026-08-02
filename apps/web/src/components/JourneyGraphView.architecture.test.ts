import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("JourneyGraphView orchestration boundary", () => {
  it("does not launch or poll legacy terminal sessions", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./JourneyGraphView.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).not.toContain("api.pi.start");
    expect(source).not.toContain("api.claude.start");
    expect(source).not.toContain("getTranscript");
    expect(source).not.toContain("getScrollback");
    expect(source).not.toContain("setTimeout(resolve");
    expect(source).not.toContain('type: "thread.journey.update"');
    expect(source).toContain("subscribeJourneyProjection");
    expect(source).toContain("journeyRootStartCommand");
    expect(source).toContain('type: "journey.steering.enqueue"');
    expect(source).toContain("journeySteeringRemoveCommand");
    expect(source).toContain("journeyInteractionSubmitCommand");
    expect(source).toContain("Waiting for the authoritative proposal revision before approval.");
    expect(source).toContain("setLayoutDirection(layoutDirection)");
  });

  it("uses selected-fence output push lifecycle without polling", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../lib/journeyRunOutputSubscription.ts", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("orchestration.subscribeJourneyRunOutput");
    expect(source).toContain("orchestration.onJourneyRunOutput");
    expect(source).toContain("unsubscribeJourneyRunOutput");
    expect(source).not.toContain("setInterval");
    expect(source).not.toContain("pollIntervalMs");
  });
});
