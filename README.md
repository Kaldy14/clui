# Clui

> **The CLI with a UI.** Project-organized, thread-based terminal multiplexer for Claude Code CLI.

## What is this?

Clui gives you a project sidebar with organized conversation threads — each one running Claude Code CLI in a real terminal. Think of it as [t3code](https://github.com/pingdotgg/t3code)'s project management UI married to the raw power of Claude Code's CLI.

**What you get:**
- **Projects with threads** — organize your Claude conversations by project, each thread is its own branch/worktree
- **Real terminal, not a chat UI** — each thread runs `claude` CLI via xterm.js + node-pty
- **Resume anywhere** — dormant threads save their scrollback and resume via `claude --resume`
- **Git workflow built in** — branch management, commit, push, and PR creation from the sidebar
- **Smart resource management** — only N terminals stay alive (configurable), the rest hibernate with saved scrollback

## Origin

This is a fork of [t3code](https://github.com/pingdotgg/t3code) (`kaldy/claude-session` branch). We kept the excellent sidebar, project/thread organization, branch/worktree management, and git workflow. We're replacing the Agent SDK chat interface with embedded terminals running Claude Code CLI directly.

**Why fork?** t3code's project organization and git workflow are great, but the Agent SDK integration adds complexity and fragility. Claude Code CLI already handles conversation history, tool use, and context management — we just need a terminal to run it in.

See [PLAN.md](./PLAN.md) for the full implementation plan.

## Status

**Work in progress.** The t3code source has been imported and packages renamed from `@t3tools/*` to `@clui/*`. The Agent SDK has not been removed yet — that's Phase 1.

## Tech Stack

- Electron + React 19 + Vite 8
- xterm.js + node-pty (terminal rendering)
- SQLite (persistence)
- Effect (server framework)
- TanStack Router/Query, Zustand, Tailwind CSS v4

## Development

```bash
bun install
bun run dev
```

## Future

Post-MVP, Clui aims to support multiple CLI agents — Codex CLI, GitHub Copilot CLI, Aider, etc. The terminal-first architecture makes this possible since every CLI tool works in a terminal.

## License

[MIT](./LICENSE)
