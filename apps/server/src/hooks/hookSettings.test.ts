import { describe, expect, it } from "vitest";
import { buildCodexHookConfigOverrides, buildHookSettingsJson } from "./hookSettings";

describe("buildHookSettingsJson", () => {
  it("returns a valid JSON string", () => {
    const json = buildHookSettingsJson(4100, "thread-1", "session-abc");
    const parsed = JSON.parse(json);
    expect(parsed.hooks).toBeDefined();
  });

  it("generates all hook events", () => {
    const parsed = JSON.parse(buildHookSettingsJson(4100, "t", "s"));
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PermissionRequest).toHaveLength(1);
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.hooks.Notification).toHaveLength(1);
    expect(parsed.hooks.SessionStart).toBeUndefined();
  });

  it("includes thread and session in hook command URLs", () => {
    const parsed = JSON.parse(buildHookSettingsJson(4100, "t-123", "s-456"));
    const cmd = parsed.hooks.UserPromptSubmit[0].hooks[0].command;
    expect(cmd).toContain("thread=t-123");
    expect(cmd).toContain("session=s-456");
    expect(cmd).toContain("127.0.0.1:4100");
    expect(cmd).toContain("/hooks/user-prompt-submit");
  });

  it("uses correct hook endpoint paths", () => {
    const parsed = JSON.parse(buildHookSettingsJson(3000, "t", "s"));
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toContain(
      "/hooks/user-prompt-submit",
    );
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toContain("/hooks/pre-tool-use");
    expect(parsed.hooks.PermissionRequest[0].hooks[0].command).toContain(
      "/hooks/permission-request",
    );
    expect(parsed.hooks.PostToolUse[0].hooks[0].command).toContain("/hooks/post-tool-use");
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain("/hooks/stop");
    expect(parsed.hooks.Notification[0].hooks[0].command).toContain("/hooks/notification");
  });

  it("sets timeout to 10 seconds", () => {
    const parsed = JSON.parse(buildHookSettingsJson(3000, "t", "s"));
    for (const event of [
      "UserPromptSubmit",
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "Stop",
      "Notification",
    ]) {
      expect(parsed.hooks[event][0].hooks[0].timeout).toBe(10);
    }
  });

  it("sets type to command", () => {
    const parsed = JSON.parse(buildHookSettingsJson(3000, "t", "s"));
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].type).toBe("command");
  });

  it("uses empty matcher (matches all events like cmux)", () => {
    const parsed = JSON.parse(buildHookSettingsJson(3000, "t", "s"));
    expect(parsed.hooks.UserPromptSubmit[0].matcher).toBe("");
  });

  it("URL-encodes special characters in thread and session IDs", () => {
    const json = buildHookSettingsJson(4100, "thread with spaces", "session/slash");
    const parsed = JSON.parse(json);
    const cmd = parsed.hooks.UserPromptSubmit[0].hooks[0].command;
    expect(cmd).toContain("thread=thread%20with%20spaces");
    expect(cmd).toContain("session=session%2Fslash");
  });

  it("uses curl with stdin pipe (-d @-) to forward hook payload", () => {
    const parsed = JSON.parse(buildHookSettingsJson(4100, "t", "s"));
    const cmd = parsed.hooks.UserPromptSubmit[0].hooks[0].command;
    expect(cmd).toContain("curl -s -X POST");
    expect(cmd).toContain("-d @-");
    expect(cmd).toContain("Content-Type: application/json");
  });
});

describe("buildCodexHookConfigOverrides", () => {
  it("configures session capture and lifecycle callbacks", () => {
    const overrides = buildCodexHookConfigOverrides(4100, "thread-1");

    expect(overrides).toHaveLength(6);
    expect(overrides[0]).toContain("hooks.SessionStart");
    expect(overrides[0]).toContain("startup|resume");
    expect(overrides).toEqual(
      expect.arrayContaining([
        expect.stringContaining("hooks.UserPromptSubmit"),
        expect.stringContaining("hooks.PreToolUse"),
        expect.stringContaining("hooks.PermissionRequest"),
        expect.stringContaining("hooks.PostToolUse"),
        expect.stringContaining("hooks.Stop"),
      ]),
    );
  });

  it("posts hook JSON to the thread-scoped Clui endpoint without writing output", () => {
    const overrides = buildCodexHookConfigOverrides(4200, "thread with spaces");

    for (const override of overrides) {
      expect(override).toContain("127.0.0.1:4200");
      expect(override).toContain("thread=thread%20with%20spaces");
      expect(override).toContain("-o /dev/null");
      expect(override).toContain("-d @-");
    }
  });
});
