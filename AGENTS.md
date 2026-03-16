# AGENTS.md

## Task Completion Requirements

- Both `bun lint` and `bun typecheck` must pass before considering tasks completed.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).
- After completing work, always update `docs/CHANGELOG-DEV.md` with the problem, root cause, fix, and affected files.

## Project Snapshot

Clui is a project-organized, thread-based terminal multiplexer for Claude Code CLI. The CLI with a UI.

Fork of t3code — kept the sidebar, project/thread organization, branch/worktree management, and git workflow. Replaced the Agent SDK chat interface with embedded xterm.js terminals running Claude Code CLI directly.

See PLAN.md for the full implementation plan.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there are shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Tech Stack

- **Runtime/Package Manager**: Bun
- **Monorepo**: Turbo
- **Backend**: Node.js + Effect (functional effects runtime) + WebSocket (`ws`)
- **Frontend**: React 19 + Vite + TanStack (Router, Query, Virtual) + Zustand + Tailwind CSS v4
- **Terminal**: xterm.js + node-pty
- **Contracts**: Effect Schema (runtime-validated types shared between server and web)
- **Database**: SQLite via `@effect/sql-sqlite-bun`
- **Testing**: Vitest + MSW (mocking) + Playwright (browser)
- **Linting/Formatting**: oxlint + oxfmt

## Package Roles

- `apps/server`: Node.js WebSocket server. Manages terminal sessions, serves the React web app, and streams terminal I/O to the browser.
- `apps/web`: React/Vite UI. Owns sidebar, thread management, terminal rendering, and client-side state. Connects to the server via WebSocket.
- `apps/desktop`: Electron shell.
- `packages/contracts`: Shared Effect/Schema schemas and TypeScript contracts for WebSocket protocol, thread/project types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@clui/shared/git`) — no barrel index.

## WebSocket Protocol

### RPC Methods (client → server)

- `orchestration.*` — getSnapshot, dispatchCommand
- `projects.*` — list, add, remove, searchEntries, writeFile
- `git.*` — pull, status, listBranches, createBranch, checkout, etc.
- `terminal.*` — start, write, resize, hibernate, getScrollback
- `server.*` — getConfig, upsertKeybinding

### Push Channels (server → client)

- `terminal.output` — terminal I/O per thread
- `terminal.status` — thread terminal state changes
- `server.welcome` — initial connection payload
- `server.configUpdated` — config changes

## Terminal Instance Management

Two-tier terminal management: server-side PTY processes and client-side xterm.js instances.

### Server-side (PTY processes) — `ClaudeSessionManager`
- LRU eviction: max 10 active PTYs (configurable). Over cap → oldest hibernated (scrollback saved to SQLite, PTY killed).
- Graceful shutdown: `hibernateAll()` with 5s timeout, SIGTERM → 1s → SIGKILL.
- Thread locks prevent concurrent start/hibernate race conditions.

### Client-side (xterm.js instances) — `claudeTerminalCache.ts`
- **LRU cap:** 50 cached instances. Over cap → oldest detached non-busy terminals disposed.
- **Idle sweep:** Every 5 min, detached terminals untouched for 2+ hours are disposed.
- **WebGL on detach:** GPU context disposed on detach, re-created on attach (only active terminal holds a context).
- **Busy thread protection:** Threads with `terminalStatus === "active"` or `hookStatus` of `"working"` / `"needsInput"` / `"pendingApproval"` are never evicted.
- **Eviction guard:** Registered in `_chat.tsx` via `setEvictionGuard()`, reads store state without subscribing to re-renders.

## Development

```bash
bun dev              # Server + web together
bun dev:server       # Server only
bun dev:web          # Web only (port 5733)
bun build            # Build all
bun typecheck        # Type-check all packages
bun lint             # oxlint
bun run test         # Vitest (NEVER use `bun test`)
bun fmt              # oxfmt
```

### Key Environment Variables

- `CLUI_PORT` — server port (default 4100)
- `CLUI_MODE` — "web" or "desktop"
- `CLUI_STATE_DIR` — state persistence directory
- `VITE_WS_URL` — WebSocket URL for web dev mode
