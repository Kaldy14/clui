# Clui

> **The CLI with a UI.** Project-organized, thread-based terminal multiplexer for Claude Code CLI.

## What is this?

Clui wraps Claude Code CLI in a proper desktop app with project organization, conversation threads, and git workflow — without replacing the CLI itself. Every thread is a real terminal running `claude`, so you get the full CLI experience with a UI layer on top.

- **Projects with threads** — organize Claude conversations by project. Each thread gets its own branch/worktree.
- **Real terminal, not a chat UI** — xterm.js + node-pty. What you see is what Claude Code actually outputs.
- **Resume anywhere** — dormant threads save scrollback to SQLite and resume via `claude --resume`.
- **Git workflow built in** — branch management, commit, push, and PR creation from the sidebar.
- **Smart resource management** — configurable cap on active terminals with LRU hibernation. Hundreds of dormant threads, near-zero resource cost.
- **Auto-update** — the app checks for updates and lets you download + install from within the sidebar.

## Status

**Super alpha.** This works, but expect bugs, rough edges, and breaking changes. If this inspires someone to build a proper polished product from the idea — that would be great.

## Downloads

Grab the latest release from the [Releases page](https://github.com/Kaldy14/clui/releases).

| Platform | Format |
|----------|--------|
| macOS (Apple Silicon) | `.dmg` |
| macOS (Intel) | `.dmg` |
| Linux | `.AppImage` |
| Windows | `.exe` (NSIS installer) |

## Acknowledgments

Clui wouldn't exist without these projects:

- **[t3code](https://github.com/pingdotgg/t3code)** — Clui is a fork of t3code. The project sidebar, thread organization, branch/worktree management, and git workflow all originate from their work. Huge thanks to the Ping team for building such a solid foundation.
- **[cmux](https://github.com/alanxoc3/cmux)** — inspiration for the terminal multiplexer approach to managing multiple Claude sessions.

The core idea: t3code's project management UI is excellent, but the Agent SDK chat interface misses many features the CLI has natively. Rather than bridging the gap with abstraction layers, Clui runs Claude Code CLI directly — it already handles conversation history, tool use, context management, and everything else out of the box.

## Tech Stack

- Electron + React 19 + Vite
- xterm.js + node-pty (terminal rendering)
- SQLite (persistence via `@effect/sql-sqlite-bun`)
- Effect (server framework)
- TanStack Router/Query, Zustand, Tailwind CSS v4
- WebSocket protocol between server and renderer

## Development

```bash
bun install
bun dev          # starts server + web together
```

See [CLAUDE.md](./CLAUDE.md) for architecture details and development commands.

## Future

Post-MVP, Clui aims to support multiple CLI agents — Codex CLI, GitHub Copilot CLI, etc. The terminal-first architecture makes this straightforward since every CLI tool works in a terminal.

## Disclaimer

Clui is an independent, free, open-source project built for fun and personal use. It is not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, or any of the AI/CLI tool providers it wraps. All product names and trademarks are the property of their respective owners.

## License

[MIT](./LICENSE)
