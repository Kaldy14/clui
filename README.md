# Clui

> **The CLI with a UI.** Project-organized, thread-based terminal multiplexer for Claude Code and pi.

## What is this?

Clui wraps terminal-native coding agents in a proper desktop app with project organization, conversation threads, and git workflow — without replacing the CLI itself. Each thread is a real terminal running its selected coding harness, currently `claude` or `pi`.

- **Projects with threads** — organize coding sessions by project. Each thread gets its own branch/worktree.
- **Selectable coding harnesses** — every thread persists its harness (`claudeCode` or `pi`), and Settings can choose the default for new threads.
- **Real terminal, not a chat UI** — xterm.js + node-pty. What you see is what the underlying CLI actually outputs.
- **Resume anywhere** — dormant threads save scrollback to SQLite. Claude threads resume via `claude --resume`; pi threads now use a pi-compatible shared session store under Clui state, so native pi `/resume` works while each Clui thread still reopens its own saved session file.
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

The core idea: t3code's project management UI is excellent, but the Agent SDK chat interface misses many features terminal-native agents already have. Rather than bridging the gap with abstraction layers, Clui runs the real CLIs directly inside thread terminals.

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

Clui has started that multi-harness path with Claude Code and pi. Post-MVP, it aims to broaden support further — Codex CLI, GitHub Copilot CLI, Aider, and other terminal-native agents.

## Disclaimer

Clui is an independent, free, open-source project built for fun and personal use. It is not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, or any of the AI/CLI tool providers it wraps. All product names and trademarks are the property of their respective owners.

## License

[MIT](./LICENSE)
