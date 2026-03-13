# Clui — Session Handoff

> **The CLI with a UI.** Project-organized, thread-based terminal multiplexer for Claude Code CLI.

## What is Clui?

A fork of [t3code](https://github.com/pingdotgg/t3code) that replaces the Agent SDK chat interface with embedded xterm.js terminals running Claude Code CLI directly. We keep t3code's excellent project/thread sidebar, branch/worktree management, and git workflow — but instead of a chat UI built on the Agent SDK, each thread is a real terminal running `claude` CLI.

**Why?** The chat UI built on the Agent SDK is missing many features that the CLI has natively. Rather than writing abstraction layers to bridge the gap, it's better to use Claude Code CLI directly.

**Future vision:** Post-MVP, support multiple CLI agents (Codex CLI, GitHub Copilot CLI, Aider, etc.) — the terminal-first architecture makes this trivial since every CLI tool works in a terminal.

## Repository

- **Location:** `/Users/kaldy/Data/Repos/clui`
- **Origin:** Forked from t3code, packages renamed from `@t3tools/*` to `@clui/*`
- **Tech stack:** Electron + React 19 + Vite 8 + xterm.js + node-pty + SQLite + Effect + TanStack + Zustand + Tailwind v4
- **Package manager:** Bun 1.3.9
- **Build:** `bun install && bun run build` (verified working)
- **CLAUDE.md** symlinks to **AGENTS.md** (already updated for Clui)

## Key Design Decisions

### Thread Lifecycle — 3 States

| State | Terminal alive? | What user sees |
|-------|----------------|----------------|
| **New** | No | "Start Conversation" prompt |
| **Active** | Yes, PTY running | Live xterm.js terminal |
| **Dormant** | No | Saved scrollback (read-only) + "Resume" button |

### Terminal Management

- **Max active terminals:** Configurable cap (default 12)
- **LRU eviction:** When cap exceeded, least-recently-interacted terminal hibernates (scrollback saved, PTY killed)
- **App startup:** Zero PTYs spawn. All threads render as dormant with saved scrollback. Resume on-demand.
- **Resume:** `claude --resume <session_id>` — Claude CLI handles conversation continuity natively
- **Session ID capture:** Parse from PTY output or read from `~/.claude/projects/` after session starts

### xterm.js Instance Management

- Keep `Map<ThreadId, Terminal>` in a Zustand store
- Switching threads: detach old Terminal from DOM (don't dispose), attach new one
- Switching back: reattach — instant, no re-render
- Only dispose on hibernation or thread deletion
- Uses WebGL renderer addon for GPU acceleration

### Architecture

```
Electron Shell → React UI (sidebar + terminal content area)
    ↕ WebSocket
Node.js Server → TerminalSessionManager → node-pty → claude CLI
    ↕ SQLite (threads, scrollback, session IDs)
```

## Source Repos Analyzed

Both repos were deeply analyzed to inform the architecture:

### t3code (`/Users/kaldy/Data/Repos/t3code`)
- Electron + React + Vite + WebSocket server
- xterm.js + node-pty already in dependencies
- Agent SDK via `@anthropic-ai/claude-agent-sdk` (being removed)
- Thread SQLite schema: `projection_threads` (thread_id, project_id, title, model, branch, worktree_path, etc.)
- Provider session runtime: `provider_session_runtime` (thread_id, resume_cursor_json, etc.)
- Multiple sessions can be "live" simultaneously (Map<ThreadId, SessionContext>)
- Switching threads does NOT stop previous session
- Existing terminal subsystem at `apps/server/src/terminal/` (PTY.ts, Manager.ts, NodePtyAdapter.ts)

### cmux (`/Users/kaldy/Data/Repos/cmux`)
- Native macOS app (Swift/AppKit/SwiftUI)
- Terminal via libghostty (Metal GPU-accelerated) — NOT usable in Electron
- Sidebar: workspaces (flat, each is a terminal session)
- Claude integration via env vars + shell hooks (no SDK)
- Socket-based CLI automation (`/tmp/cmux.sock`)

### Why xterm.js over libghostty?

libghostty renders via Metal into NSView (AppKit). Electron renders via Chromium. Can't embed a Metal surface in a browser DOM. xterm.js with WebGL addon is the pragmatic choice — same tech VS Code uses, proven at scale, already a t3code dependency.

## Implementation Plan — 7 Phases

Full plan in `PLAN.md`. Summary:

### Phase 0: Fork & Setup ✅ COMPLETE
- [x] Forked t3code source into repo
- [x] Renamed all packages `@t3tools/*` → `@clui/*`
- [x] Regenerated bun.lock
- [x] Rewrote README.md
- [x] Verified build passes (5/5 turbo tasks)
- [x] Cleaned up old t3code plans (.plans/), docs (.docs/), TODO, CONTRIBUTING, REMOTE, KEYBINDINGS
- [x] Rewrote AGENTS.md for Clui

### Phase 1: Delete Agent SDK Layer ⬜ NOT STARTED
Remove all provider/agent SDK code. App won't have working content area yet.

**Delete these files/directories:**
- `apps/server/src/provider/` (entire directory — ClaudeCodeAdapter, CodexAdapter, ProviderService, ProviderAdapterRegistry, etc.)
- `apps/web/src/components/ChatView.tsx` and `ChatView.browser.tsx`
- `apps/web/src/components/Composer*.tsx`
- `apps/web/src/composerDraftStore.ts`
- `apps/web/src/components/Message*.tsx` (chat message renderers)
- `packages/contracts/src/provider.ts`

**Modify:**
- `apps/server/package.json` — remove `@anthropic-ai/claude-agent-sdk` dependency
- `packages/contracts/src/orchestration.ts` — remove `ProviderKind`, `DEFAULT_PROVIDER_KIND`, provider-specific commands
- `apps/web/src/routes/_chat.$threadId.tsx` — replace ChatView with placeholder

**Checkpoint:** App builds, sidebar works, clicking thread shows placeholder.

### Phase 2: Database Schema Changes ⬜ NOT STARTED
- New migration: add `claude_session_id`, `scrollback_snapshot`, `terminal_status` columns to `projection_threads`
- Update `OrchestrationThread` contract type
- Update projection queries in SQLite layer

### Phase 3: TerminalSessionManager (Server) ⬜ NOT STARTED
- Create `TerminalSessionManager` Effect service managing PTY processes
- Methods: startSession, hibernateSession, getScrollback, writeToSession, onSessionOutput, reconcileActiveSessions, hibernateAll
- Wire into WebSocket server (terminal.start, terminal.write, terminal.output, terminal.resize, terminal.hibernate)
- Session ID capture from claude CLI
- Reuse existing `apps/server/src/terminal/` infrastructure (NodePtyAdapter)

### Phase 4: Terminal UI (Client) ⬜ NOT STARTED
- `ThreadTerminalView` — three-state renderer (new/active/dormant)
- `ActiveTerminalView` — live xterm.js ↔ WebSocket ↔ PTY
- `DormantTerminalView` — saved scrollback + "Resume" button
- `NewThreadView` — "Start Conversation" prompt
- xterm.js instance cache in Zustand store
- Update sidebar status pills
- Add xterm addons: `@xterm/addon-webgl`, `@xterm/addon-search`, `@xterm/addon-web-links`

### Phase 5: Lifecycle Management ⬜ NOT STARTED
- LRU eviction when exceeding max active terminals
- Graceful shutdown (hibernateAll on SIGTERM/SIGINT, Electron before-quit)
- Startup: all active → dormant, zero PTYs
- Thread deletion cleanup

### Phase 6: Polish & Integration ⬜ NOT STARTED
- Terminal theming
- Keyboard shortcuts (Cmd+N, Cmd+T, Cmd+W, Cmd+1-9, etc.)
- Terminal toolbar (title, branch, status, hibernate/restart buttons)
- Git integration verification
- Settings page (max terminals, font, colors)

### Phase 7: Testing & Hardening ⬜ NOT STARTED
- Unit tests: TerminalSessionManager, session ID capture, scrollback buffer
- Integration tests: WebSocket terminal flow, thread lifecycle, LRU eviction
- E2E tests: Playwright happy path, multi-thread, persistence, resume

## Git History

```
1038d62  Remove old t3code plans/docs, rewrite AGENTS.md for Clui
0d568e7  Update README motivation: CLI has more features than chat UI
b0c30db  Remove branch reference from README
4f3b65a  Remove VS Code comparison from README
3edf931  Phase 0: Rename @t3tools to @clui, rewrite README
a07ae35  Import t3code source as baseline for Clui
3012c3b  gitignore
ca2f4b9  Initial commit
```

## Key Files for Next Session

| File | Purpose |
|------|---------|
| `PLAN.md` | Full implementation plan with file-level detail |
| `AGENTS.md` | Build instructions, tech stack, project snapshot (symlinked as CLAUDE.md) |
| `README.md` | Project description |
| `apps/server/src/provider/` | **TO DELETE** — Agent SDK adapters |
| `apps/web/src/components/ChatView.tsx` | **TO DELETE** — Chat renderer |
| `apps/web/src/routes/_chat.$threadId.tsx` | **TO MODIFY** — Thread route (ChatView → terminal) |
| `packages/contracts/src/orchestration.ts` | **TO MODIFY** — Thread types, commands |
| `apps/server/src/terminal/` | **TO REUSE** — Existing PTY infrastructure |
| `apps/server/src/wsServer.ts` | **TO MODIFY** — Add terminal WebSocket messages |
| `apps/web/package.json` | Already has `@xterm/xterm` and `@xterm/addon-fit` |
| `apps/server/package.json` | Already has `node-pty` |

## How to Continue

1. Read this file and `PLAN.md`
2. Start Phase 1: delete the Agent SDK layer (see Phase 1 section above for exact files)
3. Follow the checkpoint at end of each phase before moving to the next
4. Use `/team` for multi-phase execution if desired
