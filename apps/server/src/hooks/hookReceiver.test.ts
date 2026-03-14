import { describe, expect, it } from "vitest";
import {
  parseHookInput,
  summarizeNotification,
  buildUserPromptSubmitEvents,
  buildPermissionRequestEvents,
  buildPostToolUseEvents,
  buildStopEvents,
  buildNotificationEvents,
} from "./hookReceiver";

describe("parseHookInput", () => {
  it("returns nulls for empty input", () => {
    const result = parseHookInput("");
    expect(result.sessionId).toBeNull();
    expect(result.cwd).toBeNull();
    expect(result.rawObject).toBeNull();
  });

  it("returns nulls for invalid JSON", () => {
    const result = parseHookInput("not json");
    expect(result.sessionId).toBeNull();
    expect(result.rawObject).toBeNull();
  });

  it("extracts session_id from root", () => {
    const result = parseHookInput(JSON.stringify({ session_id: "abc-123" }));
    expect(result.sessionId).toBe("abc-123");
  });

  it("extracts sessionId (camelCase) from root", () => {
    const result = parseHookInput(JSON.stringify({ sessionId: "def-456" }));
    expect(result.sessionId).toBe("def-456");
  });

  it("extracts session_id from nested notification object", () => {
    const result = parseHookInput(
      JSON.stringify({ notification: { session_id: "nested-1" } }),
    );
    expect(result.sessionId).toBe("nested-1");
  });

  it("extracts cwd from root", () => {
    const result = parseHookInput(JSON.stringify({ cwd: "/home/user/project" }));
    expect(result.cwd).toBe("/home/user/project");
  });

  it("extracts working_directory from root", () => {
    const result = parseHookInput(
      JSON.stringify({ working_directory: "/tmp/work" }),
    );
    expect(result.cwd).toBe("/tmp/work");
  });
});

describe("summarizeNotification", () => {
  it("classifies permission notifications", () => {
    const result = summarizeNotification(
      JSON.stringify({ type: "permission", message: "Allow file access?" }),
    );
    expect(result.category).toBe("permission");
    expect(result.subtitle).toBe("Permission");
    expect(result.body).toBe("Allow file access?");
  });

  it("classifies error notifications", () => {
    const result = summarizeNotification(
      JSON.stringify({ type: "error", message: "API call failed" }),
    );
    expect(result.category).toBe("error");
    expect(result.subtitle).toBe("Error");
    expect(result.body).toBe("API call failed");
  });

  it("classifies waiting/input notifications", () => {
    const result = summarizeNotification(
      JSON.stringify({ type: "idle", message: "Waiting for user input" }),
    );
    expect(result.category).toBe("waiting");
    expect(result.subtitle).toBe("Waiting");
  });

  it("defaults to attention for unknown types", () => {
    const result = summarizeNotification(
      JSON.stringify({ type: "unknown", message: "Something happened" }),
    );
    expect(result.category).toBe("attention");
    expect(result.subtitle).toBe("Attention");
  });

  it("truncates long body to 180 chars", () => {
    const longMessage = "x".repeat(300);
    const result = summarizeNotification(
      JSON.stringify({ message: longMessage }),
    );
    expect(result.body.length).toBeLessThanOrEqual(180);
    expect(result.body.endsWith("\u2026")).toBe(true);
  });

  it("handles empty input gracefully", () => {
    const result = summarizeNotification("");
    expect(result.category).toBe("attention");
    expect(result.subtitle).toBe("Attention");
  });

  it("handles non-JSON input", () => {
    const result = summarizeNotification("plain text error message");
    expect(result.category).toBe("error");
    expect(result.body).toContain("plain text error message");
  });

  it("extracts message from nested notification object", () => {
    const result = summarizeNotification(
      JSON.stringify({
        notification: { type: "approval", message: "Approve tool use?" },
      }),
    );
    expect(result.category).toBe("permission");
  });
});

describe("buildUserPromptSubmitEvents", () => {
  it("returns a hookStatus working event", () => {
    const events = buildUserPromptSubmitEvents("thread-1");
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("hookStatus");
    expect(events[0]!.threadId).toBe("thread-1");
    if (events[0]!.type === "hookStatus") {
      expect(events[0]!.hookStatus).toBe("working");
    }
  });
});

describe("buildPermissionRequestEvents", () => {
  it("returns a hookStatus pendingApproval event for regular tools", () => {
    const events = buildPermissionRequestEvents("thread-1", JSON.stringify({ tool_name: "Bash" }));
    expect(events).toHaveLength(1);
    if (events[0]!.type === "hookStatus") {
      expect(events[0]!.hookStatus).toBe("pendingApproval");
    }
  });

  it("returns pendingApproval when body is empty", () => {
    const events = buildPermissionRequestEvents("thread-1", "");
    expect(events).toHaveLength(1);
    if (events[0]!.type === "hookStatus") {
      expect(events[0]!.hookStatus).toBe("pendingApproval");
    }
  });

  it("returns needsInput for AskUserQuestion tool", () => {
    const events = buildPermissionRequestEvents("thread-1", JSON.stringify({ tool_name: "AskUserQuestion" }));
    expect(events).toHaveLength(1);
    if (events[0]!.type === "hookStatus") {
      expect(events[0]!.hookStatus).toBe("needsInput");
    }
  });

  it("returns needsInput for AskFollowupQuestion tool", () => {
    const events = buildPermissionRequestEvents("thread-1", JSON.stringify({ tool_name: "AskFollowupQuestion" }));
    expect(events).toHaveLength(1);
    if (events[0]!.type === "hookStatus") {
      expect(events[0]!.hookStatus).toBe("needsInput");
    }
  });
});

describe("buildPostToolUseEvents", () => {
  it("returns a hookStatus working event (clears pending approval)", () => {
    const events = buildPostToolUseEvents("thread-1");
    expect(events).toHaveLength(1);
    if (events[0]!.type === "hookStatus") {
      expect(events[0]!.hookStatus).toBe("working");
    }
  });
});

describe("buildStopEvents", () => {
  it("returns a hookStatus completed event", () => {
    const events = buildStopEvents("thread-2");
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("hookStatus");
    if (events[0]!.type === "hookStatus") {
      expect(events[0]!.hookStatus).toBe("completed");
    }
  });
});

describe("buildNotificationEvents", () => {
  it("returns hookStatus + hookNotification events", () => {
    const events = buildNotificationEvents(
      "thread-3",
      JSON.stringify({ type: "permission", message: "Approve?" }),
    );
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("hookStatus");
    if (events[0]!.type === "hookStatus") {
      expect(events[0]!.hookStatus).toBe("pendingApproval");
    }
    expect(events[1]!.type).toBe("hookNotification");
    if (events[1]!.type === "hookNotification") {
      expect(events[1]!.category).toBe("permission");
      expect(events[1]!.body).toBe("Approve?");
    }
  });

  it("maps error notifications to error hookStatus", () => {
    const events = buildNotificationEvents(
      "thread-4",
      JSON.stringify({ message: "Exception occurred" }),
    );
    expect(events[0]!.type).toBe("hookStatus");
    if (events[0]!.type === "hookStatus") {
      expect(events[0]!.hookStatus).toBe("error");
    }
  });

  it("maps waiting notifications to needsInput hookStatus", () => {
    const events = buildNotificationEvents(
      "thread-5",
      JSON.stringify({ type: "idle" }),
    );
    expect(events[0]!.type).toBe("hookStatus");
    if (events[0]!.type === "hookStatus") {
      expect(events[0]!.hookStatus).toBe("needsInput");
    }
  });
});
