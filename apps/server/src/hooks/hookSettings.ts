/**
 * Hook settings generation for Claude Code CLI.
 *
 * Generates per-session hook settings JSON strings passed inline to
 * `claude --settings <json>`. Claude Code merges --settings additively
 * with the user's own settings.json.
 *
 * @module hookSettings
 */

/**
 * Build the hook settings JSON string for a given session.
 *
 * Returns a compact JSON string (not a file path) suitable for passing
 * directly to `claude --settings <json>`. This matches how cmux injects
 * hooks — inline JSON avoids temp file management and race conditions.
 *
 * The JSON defines three hooks (SessionStart, Stop, Notification) that POST
 * the hook payload (received on stdin) back to the Clui server via curl.
 */
export function buildHookSettingsJson(serverPort: number, threadId: string, sessionId: string): string {
  const baseUrl = `http://127.0.0.1:${serverPort}/hooks`;
  const qs = `thread=${encodeURIComponent(threadId)}&session=${encodeURIComponent(sessionId)}`;

  const makeHookEntry = (event: string) => [
    {
      matcher: "",
      hooks: [
        {
          type: "command",
          command: `curl -s -X POST '${baseUrl}/${event}?${qs}' -H 'Content-Type: application/json' -d @-`,
          timeout: 10,
        },
      ],
    },
  ];

  const settings = {
    hooks: {
      UserPromptSubmit: makeHookEntry("user-prompt-submit"),
      PermissionRequest: makeHookEntry("permission-request"),
      PostToolUse: makeHookEntry("post-tool-use"),
      Stop: makeHookEntry("stop"),
      Notification: makeHookEntry("notification"),
    },
  };

  return JSON.stringify(settings);
}
