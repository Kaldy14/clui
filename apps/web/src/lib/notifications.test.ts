import { describe, expect, it } from "vitest";

import { buildHookAttentionNotification } from "./notifications";

describe("buildHookAttentionNotification", () => {
  it("describes input and approval states", () => {
    expect(buildHookAttentionNotification("needsInput", "Fix issue")).toEqual({
      title: "Input requested",
      body: "Fix issue",
    });
    expect(buildHookAttentionNotification("pendingApproval", "Ship release")).toEqual({
      title: "Approval needed",
      body: "Ship release",
    });
  });

  it("ignores statuses that do not require attention", () => {
    expect(buildHookAttentionNotification("working", "Thread")).toBeNull();
    expect(buildHookAttentionNotification("completed", "Thread")).toBeNull();
    expect(buildHookAttentionNotification("error", "Thread")).toBeNull();
  });
});
