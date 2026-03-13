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

### Phase 1: Delete Agent SDK Layer ✅ COMPLETE
Removed all provider/agent SDK code. Content area shows placeholder.

**Deleted (40+ files):**
- `apps/server/src/provider/` — entire directory (24 files)
- `packages/contracts/src/provider.ts` — SDK session types
- `apps/web/src/components/ChatView.tsx`, `ChatView.browser.tsx`, `ComposerPromptEditor.tsx`
- `apps/web/src/composerDraftStore.ts`, `composer-logic.ts`, and their tests
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` + test
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` + test
- `apps/server/src/orchestration/Services/ProviderCommandReactor.ts`
- `apps/server/src/orchestration/Services/ProviderRuntimeIngestion.ts`
- `apps/server/src/persistence/Layers/ProviderSessionRuntime.ts`
- `apps/server/src/codexAppServerManager.ts` + test
- `apps/server/integration/` — provider test harness and integration tests
- `apps/server/src/poc-mcp-api.ts`, `scripts/poc-elicitation-probe.mts`

**Modified:**
- `apps/server/package.json` — removed `@anthropic-ai/claude-agent-sdk` dependency
- `apps/server/src/serverLayers.ts` — removed `makeServerProviderLayer()`, simplified layer composition
- `apps/server/src/main.ts` — removed ProviderHealthLive layer
- `apps/server/src/wsServer.ts` — removed ProviderService/ProviderHealth, stubbed slash commands and MCP routes
- `apps/server/src/orchestration/Layers/OrchestrationReactor.ts` — simplified to only CheckpointReactor
- `apps/server/src/orchestration/Layers/CheckpointReactor.ts` — removed ProviderService dependency
- `packages/contracts/src/index.ts` — removed `provider` export
- `apps/web/src/routes/_chat.$threadId.tsx` — replaced ChatView with placeholder div
- `apps/web/src/components/Sidebar.tsx` — removed composerDraftStore usage
- `apps/web/src/components/BranchToolbar.tsx` — removed composerDraftStore usage
- `apps/web/src/components/useBranchToolbar.ts` — removed composerDraftStore usage
- `apps/web/src/routes/__root.tsx` — removed composerDraftStore usage

**Kept (intentionally):**
- `ProviderKind` and related schemas in `orchestration.ts` — still referenced broadly, clean later
- `providerRuntime.ts` contracts — types still referenced by some modules
- Orchestration engine (event sourcing, projections) — needed for thread/project management
- Checkpoint store and diff query — needed for git diffs
- Terminal infrastructure (`apps/server/src/terminal/`) — reused in Phase 3

**Checkpoint verified:** `bun typecheck` 7/7 pass, `bun lint` 0 errors, `bun run build` 5/5 pass, zero SDK refs in source.

### Post-Phase 1: Cleanup
- [x] Deleted `apps/marketing/` — t3code Astro landing page, irrelevant to Clui
- [x] Removed marketing scripts from root `package.json` (`dev:marketing`, `start:marketing`, `build:marketing`)
- [x] Fixed unused imports in `Sidebar.tsx` (`GripVerticalIcon`, `threadStatusPill`)
- [x] Typecheck now 6/6 (was 7/7 with marketing)

**Known cleanup for later (post-MVP):**
- `scripts/` package: t3code-specific files (`cursor-acp-probe.mjs`, `test-elicitation-server.mts`, `sync-vscode-icons.mjs`)
- `ProviderKind` and related types in `orchestration.ts` — still referenced broadly by web frontend, clean when terminal lifecycle replaces provider concept
- Old `OrchestrationThread` fields (`session`, `proposedPlans`, `activities`, `checkpoints`) — deeply wired into projector/snapshot/events, clean when terminal UI fully replaces session logic
- Service tag prefix `"t3/"` on 30+ Effect services — rename to `"clui/"` in a batch follow-up

**Principle:** After each phase, check for newly-orphaned code and delete it. Don't leave dead weight.

### Phase 2: Database Schema Changes ✅ COMPLETE

**Migration created:** `apps/server/src/persistence/Migrations/016_TerminalSessions.ts`
- Added `claude_session_id TEXT` column to `projection_threads`
- Added `terminal_status TEXT NOT NULL DEFAULT 'new'` column to `projection_threads`
- Migration is idempotent (PRAGMA table_info guards) — safe to re-run after partial failure

**Contracts updated:** `packages/contracts/src/orchestration.ts`
- Added `TerminalStatus` schema: `"new" | "active" | "dormant"`
- Added `claudeSessionId: Schema.NullOr(Schema.String)` to `OrchestrationThread` (with decoding default `null`)
- Added `terminalStatus: TerminalStatus` to `OrchestrationThread` (with decoding default `"new"`)

**Persistence updated:**
- `apps/server/src/persistence/Services/ProjectionThreads.ts` — added `claudeSessionId`, `terminalStatus` to `ProjectionThread` schema
- `apps/server/src/persistence/Layers/ProjectionThreads.ts` — updated INSERT/SELECT queries with new columns
- `apps/server/src/persistence/Migrations.ts` — registered migration 016

**Orchestration updated:**
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` — thread SELECT includes new columns, thread assembly maps them
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` — `thread.created` handler sets `claudeSessionId: null`, `terminalStatus: "new"`
- `apps/server/src/orchestration/projector.ts` — in-memory `thread.created` projector includes new fields

**Tests fixed (including 2 pre-existing failures):**
- `apps/server/src/orchestration/projector.test.ts` — added new fields to expected thread output
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts` — added new fields + fixed pre-existing `latestTurn` token/cost fields
- `apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts` — fixed pre-existing `terminalTarget` field in scripts JSON
- `apps/server/src/orchestration/commandInvariants.test.ts` — added new fields to mock threads
- `apps/server/src/checkpointing/Layers/CheckpointDiffQuery.test.ts` — added new fields to mock thread
- `apps/web/src/store.test.ts` — added new fields to mock thread helper

**Decision: old fields kept.** `session`, `proposedPlans`, `activities`, `checkpoints` remain on `OrchestrationThread` — deeply wired into projector, snapshot query, and event handling. Removing them is cleanup for when terminal UI replaces session logic.

**Checkpoint verified:** `bun typecheck` 6/6 pass, `bun lint` 0 errors, `bun run test` 301/301 pass (zero failures).

### Post-Phase 2: Architecture Review Fixes ✅ COMPLETE

Comprehensive backend review of Phase 0–2 changes identified P0/P1/P2 issues. All P0 and key P1 items fixed.

**P0 — Type safety in persistence layer:**
- `apps/server/src/persistence/Services/ProjectionThreads.ts` — changed `terminalStatus: Schema.String` to `terminalStatus: TerminalStatus` (imported from `@clui/contracts`). Raw `Schema.String` allowed any value through persistence unchecked.
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` — removed unsafe `as "new" | "active" | "dormant"` cast. Persistence schema now validates the type, so the cast was unnecessary.

**P1 — Dead code removal:**
- Deleted `packages/contracts/src/providerRuntime.ts` (~1000 lines) and its test — dead Agent SDK runtime event types with no consumer after Phase 1
- Deleted `apps/server/src/persistence/Services/ProviderSessionRuntime.ts` — orphaned service (its Layer was deleted in Phase 1 but this Service file remained)
- Removed `ProviderSessionRuntimeStatus` from `orchestration.ts` — dead code
- Removed `ProviderSessionRuntimeRepositoryError` from `persistence/Errors.ts` — only consumer was the deleted service
- Relocated `UserInputQuestion` and `UserInputQuestionOption` from deleted `providerRuntime.ts` into `orchestration.ts` — still actively used by `apps/web/src/pendingUserInput.ts` and `apps/web/src/session-logic.ts`

**P1 — Migration hardening:**
- Rewrote `016_TerminalSessions.ts` — made fully idempotent with PRAGMA table_info guards
- Removed YAGNI columns: `scrollback_snapshot TEXT` (no code reads/writes it, add in Phase 3) and `terminal_settings` table + seed (no consumer, add in Phase 5)

**P1 — Test coverage:**
- Added 5 contract tests in `packages/contracts/src/orchestration.test.ts` — validates `OrchestrationThread` terminal field defaults (`claudeSessionId` → `null`, `terminalStatus` → `"new"`), explicit values (`"active"`, `"dormant"`), and rejection of invalid values (`"bogus"`)
- Added snapshot query round-trip test in `ProjectionSnapshotQuery.test.ts` — inserts thread with `claude_session_id = 'sess-abc-123'` and `terminal_status = 'active'`, verifies hydration through the full query pipeline

**Checkpoint verified:** `bun typecheck` 6/6 pass, `bun lint` 0 errors, `bun run test` 302/302 pass (+6 new tests, −5 deleted providerRuntime tests).

**P2 items tracked (post-MVP):**
- Add `@deprecated` JSDoc to dead provider types in `orchestration.ts` (ProviderKind, etc.)
- Rename `"t3/"` service tag prefix to `"clui/"` on 30+ Effect services
- Extract hardcoded `"gpt-5-codex"` default model to a named constant
- Validate `projectsWriteFile` `cwd` against registered project roots (security)
- Add `GET /health` endpoint
- Add snapshot query timing instrumentation
- Add TODO comments for Phase 3 event types (terminal state transitions)

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

## Key Files for Next Session

| File | Purpose |
|------|---------|
| `PLAN.md` | Full implementation plan with file-level detail |
| `AGENTS.md` | Build instructions, tech stack, project snapshot (symlinked as CLAUDE.md) |
| `packages/contracts/src/orchestration.ts` | `TerminalStatus`, `OrchestrationThread` with terminal fields |
| `apps/server/src/terminal/` | **TO REUSE** — Existing PTY infrastructure for Phase 3 |
| `apps/server/src/wsServer.ts` | **TO MODIFY** — Add terminal WebSocket messages (Phase 3) |
| `apps/web/src/routes/_chat.$threadId.tsx` | **TO MODIFY** — Replace placeholder with terminal view (Phase 4) |
| `apps/web/package.json` | Already has `@xterm/xterm` and `@xterm/addon-fit` |
| `apps/server/package.json` | Already has `node-pty` |

## How to Continue

1. Read this file and `PLAN.md`
2. Start Phase 3: TerminalSessionManager (server-side PTY management)
3. Then Phase 4: Terminal UI (client-side xterm.js)
4. Follow the checkpoint at end of each phase before moving to the next
