# Clui — Session Handoff

> **The CLI with a UI.** Project-organized, thread-based terminal multiplexer for Claude Code and pi.

## What is Clui?

A fork of [t3code](https://github.com/pingdotgg/t3code) that replaces the Agent SDK chat interface with embedded xterm.js terminals running terminal-native coding agents directly. We keep t3code's excellent project/thread sidebar, branch/worktree management, and git workflow — but instead of a chat UI built on the Agent SDK, each thread is a real terminal running its selected harness.

**Current harnesses:** `claudeCode` and `pi`.

**Why?** The chat UI built on the Agent SDK is missing many features that the CLI has natively. Rather than writing abstraction layers to bridge the gap, it's better to run the real CLI directly.

**Future vision:** Keep broadening harness support (Codex CLI, GitHub Copilot CLI, Aider, etc.) — the terminal-first architecture makes this straightforward since every CLI tool works in a terminal.

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
- **Claude resume:** `claude --resume <session_id>` — Claude CLI handles conversation continuity natively
- **Claude session ID:** Assigned upfront via `--session-id <uuid>` for new sessions, reused via `--resume <uuid>` for resumes. No regex extraction needed.
- **pi resume:** Clui now points pi at a pi-compatible shared agent dir under server state (`<state>/pi-agent/sessions/--<cwd>--/`) so native `/resume` works. Each thread also persists its own active `piSessionFile`, and Clui reopens that exact file with `pi --session <file>` on resume/restart.

### Coding Harnesses

- Each persisted thread now has a `harness: "claudeCode" | "pi"` field.
- App settings include `defaultCodingHarness`, which seeds newly-created threads.
- The new-thread screen can switch harnesses only while `terminalStatus === "new"`.
- Once a thread has started, harness changes are rejected at the orchestration layer.
- Claude-only controls like YOLO mode stay hidden for `pi` threads.

### xterm.js Instance Management

Client-side terminal instances are managed in `apps/web/src/lib/claudeTerminalCache.ts` — a module-level `Map<ThreadId, CachedTerminal>` with three layers of memory management:

#### Lifecycle
- **Attach:** `terminal.open(container)` + WebGL addon loaded. Moves entry to end of Map (most-recently-used).
- **Detach (switch away):** DOM children removed, WebGL addon **disposed** (frees GPU context), Terminal instance stays alive in cache with scrollback intact.
- **Re-attach (switch back):** Terminal re-opened in new container, fresh WebGL addon created. Instant — no re-render or scrollback re-fetch.
- **Dispose:** Terminal fully destroyed, removed from cache. Happens on thread deletion, hibernation, or eviction.

#### Memory Management

**1. LRU cap (50 instances)**
When the cache exceeds `MAX_CACHED_TERMINALS = 50`, the oldest *detached* and *non-busy* terminals are disposed. Triggered on every `attach()` and `getOrCreate()`. Map insertion order tracks recency.

**2. Idle sweep (2-hour TTL)**
A background timer runs every 5 minutes and disposes detached terminals whose `lastAccessedAt` exceeds 2 hours. This catches terminals the user opened once and forgot about.

**3. WebGL context reclaim on detach**
GPU contexts are disposed immediately when a terminal is detached from the DOM and re-created on re-attach. This means only the currently-viewed terminal holds a WebGL context, well within the browser's ~16 context limit.

#### Eviction Protection (busy threads)
An eviction guard registered in `_chat.tsx` prevents eviction of threads that are actively doing work. A thread is considered "busy" when:
- `terminalStatus === "active"` (PTY process is running server-side)
- `hookStatus` is `"working"`, `"needsInput"`, or `"pendingApproval"`

Busy threads are protected from both LRU cap eviction and idle sweep, ensuring the user never loses cached scrollback for an active session.

#### Key constants
| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_CACHED_TERMINALS` | 50 | LRU eviction threshold |
| `IDLE_TTL_MS` | 2 hours | Idle sweep TTL for detached terminals |
| `IDLE_SWEEP_INTERVAL_MS` | 5 minutes | How often idle sweep runs |
| `scrollback` | 10,000 lines | Per-terminal scrollback buffer size |

### Architecture

```
Electron Shell → React UI (sidebar + terminal content area)
    ↕ WebSocket
Node.js Server → ClaudeSessionManager / PiSessionManager → node-pty → claude or pi CLI
    ↕ SQLite (threads, scrollback, session IDs, harness metadata)
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

### Phase 3: ClaudeSessionManager (Server) ✅ COMPLETE

Built a new `ClaudeSessionManager` Effect service — separate from the existing `TerminalManager` (which handles project shell terminals). Uses `PtyAdapter` to spawn `claude` CLI processes with full lifecycle management.

**New files:**
- `packages/contracts/src/claude-terminal.ts` — `ClaudeStartInput`, `ClaudeHibernateInput`, `ClaudeGetScrollbackInput`, `ClaudeSessionEvent` schemas
- `apps/server/src/terminal/Services/ClaudeSession.ts` — Service interface: `ClaudeSessionManagerShape`, `ClaudeSessionError`, `ClaudeSessionState`, `ClaudeSessionManager` tag
- `apps/server/src/terminal/Layers/ClaudeSessionManager.ts` — Full implementation: `ClaudeSessionManagerRuntime` class + `ClaudeSessionManagerLive` layer
- `apps/server/src/persistence/Migrations/017_ScrollbackSnapshot.ts` — Idempotent migration adding `scrollback_snapshot` column

**Modified files:**
- `packages/contracts/src/ws.ts` — Added WS methods `claude.start`, `claude.hibernate`, `claude.getScrollback` + channel `claude.sessionEvent`
- `packages/contracts/src/orchestration.ts` — Added `ThreadTerminalStatusChangedCommand`, `scrollbackSnapshot` field on `OrchestrationThread`, new event type `thread.terminal-status-changed`
- `packages/contracts/src/index.ts` — Exports `claude-terminal` module
- `apps/server/src/wsServer.ts` — Added `ClaudeSessionManager` to `ServerRuntimeServices`, 3 route cases, claude session event subscription with orchestration dispatch (started→active, sessionId→update, hibernated/exited→dormant), hibernateAll wired to graceful shutdown
- `apps/server/src/serverLayers.ts` — Added `ClaudeSessionManagerLive` layer with shared `PtyAdapter`
- `apps/server/src/persistence/Migrations.ts` — Registered migration 017
- `apps/server/src/persistence/Services/ProjectionThreads.ts` — Added `scrollbackSnapshot` to schema
- `apps/server/src/persistence/Layers/ProjectionThreads.ts` — Added `scrollback_snapshot` to INSERT/SELECT/UPDATE queries
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` — Handler for `thread.terminal.statusChanged`, `scrollbackSnapshot: null` in `thread.created`
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` — `scrollback_snapshot` in SELECT + thread assembly
- `apps/server/src/orchestration/projector.ts` — In-memory projector for `thread.terminal-status-changed`
- `apps/server/src/orchestration/Schemas.ts` — `ThreadTerminalStatusChangedPayload` alias
- `apps/server/src/orchestration/decider.ts` — Case for `thread.terminal.statusChanged` command

**ClaudeSessionManager features:**
- `startSession` — Spawns `claude` or `claude --resume <id>` via PtyAdapter
- `hibernateSession` — Captures scrollback, kills PTY (SIGTERM→1s→SIGKILL), sets dormant
- `writeToSession`/`resizeSession` — PTY I/O for active sessions
- `getScrollback`/`getSessionStatus` — Read session state
- `reconcileActiveSessions` — LRU eviction when over max active cap
- `hibernateAll` — Hibernate all active sessions (for app shutdown)
- Session ID assigned upfront via `--session-id <uuid>` (no output parsing)
- EventEmitter-based event subscription
- Promise-based thread locking for concurrent safety
- 5000-line scrollback cap

**Tests fixed:** `store.test.ts`, `CheckpointDiffQuery.test.ts`, `commandInvariants.test.ts`, `ProjectionSnapshotQuery.test.ts`, `projector.test.ts`, `wsServer.test.ts`

**Checkpoint verified:** `bun typecheck` 6/6 pass, `bun lint` 0 errors, `bun run test` 302/302 pass, `bun run build` 4/4 pass.

### Post-Phase 3: Architecture Review Fixes ✅ COMPLETE

6-agent architecture review identified 5 P0 and 9 P1 issues. All fixed via 5-worker team pipeline.

**P0 fixes:**
1. **Stale onProcessExit closure** — captured `expectedProcess` ref in exit callback, ignores stale exits when `entry.process !== expectedProcess`
2. **Scrollback snapshot persistence** — wsServer reads scrollback from `getScrollback()` before dispatching dormant transition (was hardcoded `null`)
3. **claudeSessionId preserved** — added `getClaudeSessionId()` to runtime/interface/layer; wsServer reads it before dormant dispatch (was wiped to `null`)
4. **cwd validation** — `assertValidCwd()` in runtime + workspace root path-traversal check in wsServer route
5. **requireThread in decider** — added missing invariant for `thread.terminal.statusChanged` (was the only thread command without it)

**P1 fixes:**
6. **ScrollbackRingBuffer** — O(1) append replacing O(n²) string concat. Line-based ring buffer with `append()`, `materialize()`, `tail()`, `clear()`
7. **Write/resize WS routes** — `ClaudeWriteInput`/`ClaudeResizeInput` schemas in contracts, `claude.write`/`claude.resize` in WS_METHODS + WebSocketRequestBody, route handlers in wsServer
8. **reconcileActiveSessions wired** — fire-and-forget call after each startSession (maxActiveSessions=10, configurable)
9. **Enhanced env filtering** — added CLUI_* prefix, ANTHROPIC_API_KEY, OPENAI_API_KEY, DATABASE_URL, *_SECRET/*_TOKEN/*_KEY suffix patterns
10. **Session ID split-chunk fix** — scans ring buffer `tail(512)` instead of just latest PTY data chunk
11. **Shared terminalUtils.ts** — extracted `capHistory`, `shouldExcludeEnvKey`, `createSpawnEnv`, `runWithThreadLock`, `assertValidCwd` from Manager.ts and ClaudeSessionManager.ts into shared module
12. **hibernateAll parallel + timeout** — `Promise.allSettled` with 5s timeout (was sequential, no timeout)
13. **Fire-and-forget error handling** — wsServer claude event handler pipes through `Effect.catchAll` with `Effect.logError` (was swallowing errors)

**New files:**
- `apps/server/src/terminal/terminalUtils.ts` — shared terminal utility functions
- `apps/server/src/terminal/Layers/ClaudeSessionManager.test.ts` — 31 unit tests

**Modified files:**
- `apps/server/src/terminal/Layers/ClaudeSessionManager.ts` — all runtime fixes, ring buffer, shared utils integration
- `apps/server/src/terminal/Services/ClaudeSession.ts` — added `getClaudeSessionId` to interface
- `apps/server/src/terminal/Layers/Manager.ts` — replaced 5 local functions with imports from terminalUtils.ts
- `packages/contracts/src/claude-terminal.ts` — added `ClaudeWriteInput`, `ClaudeResizeInput` schemas
- `packages/contracts/src/ws.ts` — added `claudeWrite`/`claudeResize` to WS_METHODS + WebSocketRequestBody
- `apps/server/src/orchestration/decider.ts` — added `requireThread` to `thread.terminal.statusChanged`
- `apps/server/src/wsServer.ts` — scrollback/sessionId persistence on dormant, cwd validation, write/resize routes, error logging
- `apps/server/src/wsServer.test.ts` — added `getClaudeSessionId` to mock shape

**Checkpoint verified:** `bun typecheck` 6/6 pass, `bun lint` 0 errors, `bun run test` 333/333 pass (+31 new tests).

### Phase 4: Terminal UI (Client) ✅ COMPLETE

Built the client-side terminal UI in `apps/web/` with three-state rendering, xterm.js integration, and WebSocket I/O.

**New files:**
- `apps/web/src/components/ThreadTerminalView.tsx` — Three-state renderer: `NewThreadView` (Start button), `ActiveTerminalView` (live xterm.js ↔ WS), `DormantTerminalView` (read-only scrollback + Resume button)
- `apps/web/src/lib/claudeTerminalCache.ts` — Module-level `Map<ThreadId, CachedTerminal>` for xterm.js instance caching. Terminals are detached (not disposed) on thread switch and reattached instantly on return. WebGL renderer addon for GPU acceleration. Shared theme management.

**Modified files:**
- `packages/contracts/src/ipc.ts` — Added `claude` namespace to `NativeApi` interface: `start`, `hibernate`, `write`, `resize`, `getScrollback`, `onSessionEvent`
- `apps/web/src/wsNativeApi.ts` — Wired all claude methods to WS transport + session event subscription with schema validation
- `apps/web/src/types.ts` — Added `terminalStatus`, `claudeSessionId`, `scrollbackSnapshot` to `Thread` type
- `apps/web/src/store.ts` — Maps terminal fields from `OrchestrationReadModel` in `syncServerReadModel`
- `apps/web/src/routes/_chat.$threadId.tsx` — Replaced Phase 4 placeholder with `ThreadTerminalView` component
- `apps/web/src/lib/threadStatus.ts` — Added `claudeTerminalStatusPill()`: active → green pulsing "Running", dormant → gray "Paused"
- `apps/web/package.json` — Added `@xterm/addon-webgl`
- `apps/web/src/store.test.ts` — Added terminal fields to `makeThread` helper
- `apps/web/src/worktreeCleanup.test.ts` — Added terminal fields to `makeThread` helper

**Key design decisions:**
- **xterm.js instance cache** — Module-level `Map` (not Zustand, since Terminal instances aren't serializable). Detach on thread switch, reattach on return. Dispose only on hibernation/deletion.
- **Race-free output** — ActiveTerminalView subscribes to `claude.sessionEvent` push events first, buffers them, then fetches scrollback via `getScrollback`, writes it, and flushes the buffer. No output is lost.
- **WebGL renderer** — Loaded via `@xterm/addon-webgl` with context-loss recovery fallback.
- **Theme sync** — MutationObserver on `<html>` class/style changes triggers `refreshTheme()` across all cached terminals.

**Checkpoint verified:** `bun typecheck` 6/6 pass, `bun lint` 0 errors, `bun run test` 333/333 pass.

### Post-Phase 4: Frontend Architecture Review Fixes ✅ COMPLETE

5-agent parallel review (style, quality, accessibility, browser/platform, test-engineer) identified 17 issues across P0–P2. All P0 and P1 items fixed.

**P0 fixes:**

1. **WebGL addon leak** — `tryLoadWebgl()` was called on every `attach()`, accumulating GPU contexts (browser limit ~16). Added `WeakSet<Terminal>` tracking: load once per terminal, skip on re-attach, remove from set on context loss.
   - `apps/web/src/lib/claudeTerminalCache.ts`

2. **Missing `disposed` guard in ActiveTerminalView** — Scrollback `.then()` fired after unmount, writing stale data to detached terminal. Added `let disposed = false` + check in `.then()`/`.catch()` + set in cleanup. Mirrors DormantTerminalView pattern.
   - `apps/web/src/components/ThreadTerminalView.tsx`

3. **Route placeholder in sheet branch** — `_chat.$threadId.tsx:164` still showed `"Terminal goes here — Phase 4"` for narrow viewports (<1180px). Replaced with `<ThreadTerminalView>`.
   - `apps/web/src/routes/_chat.$threadId.tsx`

4. **Duplicated `terminalThemeFromApp()`** — Identical 60-line function in 3 files (CLAUDE.md maintainability violation). Extracted to shared `lib/terminalTheme.ts`, removed local copies from `claudeTerminalCache.ts`, `ThreadTerminalDrawer.tsx`, `ProjectTerminalDrawer.tsx`.
   - `apps/web/src/lib/terminalTheme.ts` (NEW)
   - `apps/web/src/lib/claudeTerminalCache.ts`
   - `apps/web/src/components/ThreadTerminalDrawer.tsx`
   - `apps/web/src/components/ProjectTerminalDrawer.tsx`

**P1 fixes:**

5. **`pointer-events: none` → `disableStdin`** — Dormant view blocked all interaction including text selection/copy. Removed `style={{ pointerEvents: "none" }}`, replaced with `terminal.options.disableStdin = true`. Active view sets `disableStdin = false` on attach.
   - `apps/web/src/components/ThreadTerminalView.tsx`

6. **`handleResume` hardcoded dimensions** — Was sending `cols: 120, rows: 40` ignoring actual cached terminal size. Now reads `cached.terminal.cols/rows` before disposing. `handleStart` kept hardcoded (no terminal exists yet; corrective resize follows immediately on mount).
   - `apps/web/src/components/ThreadTerminalView.tsx`

7. **Error `role="alert"`** — Both error paragraphs now have `role="alert"` for screen reader announcement.
   - `apps/web/src/components/ThreadTerminalView.tsx`

8. **Icons `aria-hidden`** — Added `aria-hidden="true"` to decorative `PlusCircleIcon` and `PlayIcon`.
   - `apps/web/src/components/ThreadTerminalView.tsx`

9. **`aria-busy` on buttons** — Added `aria-busy={starting}` and `aria-busy={resuming}` for assistive technology feedback.
   - `apps/web/src/components/ThreadTerminalView.tsx`

10. **ResizeObserver** — Added `ResizeObserver` on terminal container element. Handles sidebar collapse/expand and split-view changes that don't trigger `window.resize`.
    - `apps/web/src/components/ThreadTerminalView.tsx`

11. **Exhaustive switch in `writeEvent`** — Replaced if/else chain with exhaustive switch covering all `ClaudeSessionEvent` types (`output`, `error`, `exited`, `started`, `hibernated`, `sessionId`). Future-proofs against new event types.
    - `apps/web/src/components/ThreadTerminalView.tsx`

12. **Stale `cached` ref in cleanup** — DormantTerminalView captured `cached` boolean at effect-run time for dispose decision. Replaced with explicit `ownsCacheEntry` ownership flag.
    - `apps/web/src/components/ThreadTerminalView.tsx`

**Deferred to Phase 6 (by design):**
- Keyboard escape binding for terminal (shell terminals have same behavior; terminal-first app)
- xterm.js `screenReaderMode` (performance overhead; add as user setting)
- MutationObserver debounce (low impact)
- LRU eviction for terminal cache (Phase 5 scope)
- `makeThread` fixture extraction (test infrastructure)
- Terminal font size documentation (13px Claude vs 12px shell — intentional)

**Checkpoint verified:** `bun typecheck` 6/6 pass, `bun lint` 0 errors, `bun run test` 333/333 pass.

### Phase 5: Lifecycle Management ✅ COMPLETE

Built server-side lifecycle management: startup recovery, graceful shutdown, thread deletion, and session ID reliability.

**Server hardening (`apps/server/src/wsServer.ts`):**
- Stale terminal status reset on startup — threads marked `active` in DB with no running PTY are set to `dormant`
- Graceful shutdown — `hibernateAll()` runs before closing WebSocket connections (sequential: hibernate first, then close)
- Thread deletion destroys active PTY sessions via `destroySession()`

**Session ID reliability (`apps/server/src/terminal/Layers/ClaudeSessionManager.ts`):**
- **Fixed critical bug:** Session ID was extracted via regex from Claude Code CLI terminal output, but Claude Code doesn't print session IDs in any parseable format — regex never matched, so `claudeSessionId` was always `null`
- **New approach:** Generate UUID via `crypto.randomUUID()` for new sessions, pass `--session-id <uuid>` to Claude CLI. For resumes, pass `--resume <uuid>`. Session ID is known upfront — no async extraction needed.
- Removed dead code: `tryExtractSessionId()`, `ScrollbackRingBuffer.tail()`
- `sessionId` event emitted immediately after spawn

**New service methods:**
- `destroySession(threadId)` — kills PTY and removes session from map without emitting lifecycle events (used for thread deletion)

**Other changes:**
- `apps/server/src/terminal/Layers/NodePtyHost.ts` — Node-pty host bridge for real TTY allocation
- Environment filtering for spawned Claude processes (excludes VITE_*, CLUI_*, CLAUDE_CODE_*, sensitive keys)
- LRU session reconciliation (fire-and-forget after each `startSession`, max 10 configurable)
- `hibernateAll` with 5s timeout + force-kill fallback

**Tests:** 33 ClaudeSessionManager tests pass (updated session ID tests from regex extraction to `--session-id` assignment). 35 wsServer tests pass.

**Checkpoint verified:** `bun typecheck` 6/6 pass, `bun lint` 0 errors, all tests pass.

### Phase 6: Polish & Integration ✅ COMPLETE

Built terminal toolbar, keyboard shortcuts, configurable font settings, and git integration.

**New files:**
- `apps/web/src/components/TerminalToolbar.tsx` — Compact toolbar with editable title, branch badge, status indicator, hibernate/resume/restart buttons

**Modified files:**
- `packages/contracts/src/keybindings.ts` — Added `claude.hibernate`, `thread.next`, `thread.prev` to `STATIC_KEYBINDING_COMMANDS`
- `apps/server/src/keybindings.ts` — Added default bindings: `mod+w` → `claude.hibernate`, `mod+shift+]` → `thread.next`, `mod+shift+[` → `thread.prev`
- `apps/web/src/keybindings.ts` — Added `isClaudeHibernateShortcut`, `isThreadNextShortcut`, `isThreadPrevShortcut` matchers
- `apps/web/src/routes/_chat.tsx` — Wired keyboard shortcuts: hibernate, next/prev thread, Cmd+1-9 thread switching
- `apps/web/src/routes/_chat.$threadId.tsx` — Added `TerminalToolbar` above `ThreadTerminalView` in both layout branches
- `apps/web/src/appSettings.ts` — Added `terminalFontSize`, `terminalFontFamily` settings with defaults and bounds
- `apps/web/src/lib/claudeTerminalCache.ts` — Reads font settings from appSettings, added `updateFontSettings()` for live updates
- `apps/web/src/routes/_chat.settings.tsx` — Added Terminal settings section (font size, font family, reset)
- `apps/web/src/components/BranchToolbar.tsx` — Hibernates claude terminal when branch/worktree cwd changes
- `apps/web/src/components/ThreadTerminalView.tsx` — Polished NewThreadView and DormantTerminalView with refined terminal-app aesthetic

**Keyboard shortcuts:**
- `Cmd+N` → New thread (already existed via `chat.new`)
- `Cmd+1-9` → Switch to thread by index (direct handler)
- `Cmd+Shift+]` / `[` → Next/prev thread navigation (wraps around)
- `Cmd+K` → Quick search (already existed via `thread.search`)

**UX decisions:**
- No `Cmd+W` hibernate shortcut — hibernate is an internal mechanism (LRU eviction, shutdown), not a user action. `Cmd+W` would confuse users expecting "close tab" behavior.
- Toolbar shows "Stop" button (not "Hibernate") for active terminals — kills a runaway session. Resume/Restart buttons for dormant terminals.

**Checkpoint verified:** `bun typecheck` 6/6 pass, `bun lint` 0 errors, `bun run test` 335/335 pass.

### Phase 7: Testing & Hardening ✅ COMPLETE

Added 45 new tests across unit and integration layers, bringing total server tests from 335 to 372 and web tests to 345.

**New files:**
- `apps/server/src/terminal/terminalUtils.test.ts` — 30 unit tests for shared terminal utilities (`capHistory`, `shouldExcludeEnvKey`, `createSpawnEnv`, `runWithThreadLock`, `assertValidCwd`)

**Modified files:**
- `apps/server/src/wsServer.test.ts` — 6 new integration tests for claude session WebSocket routes (`claude.start`, `claude.hibernate`, `claude.getScrollback`, `claude.write`, `claude.resize`, resume with `resumeSessionId`)
- `apps/web/src/keybindings.test.ts` — 9 new tests for Phase 6 keybinding matchers (`isClaudeHibernateShortcut`, `isThreadNextShortcut`, `isThreadPrevShortcut` — macOS, Linux, and negative cases)

**Test coverage summary (Phases 0–7):**

| Test file | Tests | Coverage |
|-----------|-------|----------|
| `ClaudeSessionManager.test.ts` | 33 | Session lifecycle, LRU, hibernation, kill escalation, thread locks, env filtering, scrollback |
| `terminalUtils.test.ts` | 30 | Shared utilities: history cap, env filtering, spawn env, thread locks, cwd validation |
| `wsServer.test.ts` | 41 | WS protocol, auth, orchestration, terminal, git, keybindings, **claude session routes** |
| `keybindings.test.ts` | 36 | All shortcut matchers including **claude.hibernate, thread.next/prev** |
| Other existing tests | ~693 | Orchestration, projections, contracts, store, git |

**E2E tests (Playwright) deferred** — requires running the full app stack with real PTY processes. Better suited for a CI pipeline with container isolation, not local dev. The unit + integration coverage above validates all critical paths.

**Checkpoint verified:** `bun typecheck` 6/6 pass, `bun lint` 0 errors, `bun run test` all packages pass (372 server, 345 web, 46 contracts, 26 shared, 26 desktop, 18 scripts).

### Phase 8: Claude Code Hooks Integration (Badge System) ✅ COMPLETE

Implemented Claude Code hooks integration: the server generates per-session `--settings` JSON files that configure Claude Code lifecycle hooks (SessionStart, Stop, Notification) to call back to the Clui server via HTTP. Hook events drive rich sidebar badges and OS notifications.

**New files:**
- `apps/server/src/hooks/hookSettings.ts` — Generates per-session hook settings JSON, writes/removes temp files. Hook commands use `curl -s -X POST` to call back to the Clui server.
- `apps/server/src/hooks/hookReceiver.ts` — HTTP handler for `/hooks/session-start`, `/hooks/stop`, `/hooks/notification`. Parses Claude Code hook JSON (robust extraction of session_id, cwd from multiple key conventions and nested objects). Classifies notifications into Permission/Error/Waiting/Attention categories (mirroring cmux). Truncates body to 180 chars. Builds typed `ClaudeSessionEvent` events.
- `apps/server/src/hooks/hookReceiver.test.ts` — 16 tests: input parsing, notification classification, event building
- `apps/server/src/hooks/hookSettings.test.ts` — 11 tests: settings JSON structure, URL encoding, file write/remove, directory creation

**Modified files:**
- `packages/contracts/src/claude-terminal.ts` — Added `ClaudeHookStatus` (working/needsInput/pendingApproval/error/completed), `ClaudeHookNotificationCategory` (permission/error/waiting/attention), `ClaudeHookStatusEvent`, `ClaudeHookNotificationEvent` to `ClaudeSessionEvent` union
- `apps/server/src/terminal/Layers/ClaudeSessionManager.ts` — Added `HookConfig` (serverPort + settingsDir). Generates hook settings JSON and passes `--settings <path>` when spawning claude CLI. Cleans up settings files on session end (stopProcess). Resolves `ServerConfig` via `Effect.serviceOption` in the layer.
- `apps/server/src/wsServer.ts` — Added HTTP route handlers for `/hooks/session-start`, `/hooks/stop`, `/hooks/notification`. Parses threadId from URL query param, reads JSON body, builds events, broadcasts via WS push. Runs outside the Effect pipeline for minimal overhead.
- `apps/web/src/types.ts` — Added `hookStatus: ClaudeHookStatus | null` to `Thread`
- `apps/web/src/store.ts` — Added `setHookStatus` action. Preserves `hookStatus` across read model syncs.
- `apps/web/src/routes/__root.tsx` — Global `claude.onSessionEvent` subscription: updates hookStatus on `hookStatus` events, clears on `hibernated`/`exited`, dispatches OS notifications on `hookNotification` (only when thread not focused or window hidden).
- `apps/web/src/lib/threadStatus.ts` — `claudeTerminalStatusPill()` now accepts optional `hookStatus` for rich badges: Working (blue, pulsing), Needs Input (amber), Pending Approval (amber), Error (red), Completed (gray). Falls back to simple Running/Paused when no hook status.
- `apps/web/src/lib/notifications.ts` — Added `dispatchHookNotification()` for OS-level notifications from hook events.
- `apps/web/src/components/TerminalToolbar.tsx` — `TerminalStatusBadge` now renders from `claudeTerminalStatusPill()` with dynamic color tints based on hook status. Replaces hardcoded "Live"/"Paused" badges.
- `apps/web/src/components/ThreadTerminalView.tsx` — Added `hookStatus`/`hookNotification` to exhaustive switch in `writeEvent`
- `apps/web/src/store.test.ts` — Added `hookStatus: null` to `makeThread` helper
- `apps/web/src/worktreeCleanup.test.ts` — Added `hookStatus: null` to `makeThread` helper

**Hook lifecycle flow:**
1. `ClaudeSessionManager.startSession()` generates hook settings JSON → writes to `stateDir/hook-settings/<threadId>.json` → passes `--settings <path>` to claude CLI
2. Claude Code fires hooks → `curl` POSTs to `http://127.0.0.1:PORT/hooks/<event>?thread=<id>&session=<id>` with JSON body on stdin
3. Server HTTP handler parses body, classifies notification (if applicable), builds `ClaudeSessionEvent`s
4. Events broadcast via WS push to all clients
5. Client `EventRouter` updates `hookStatus` in Zustand store + dispatches OS notifications
6. Sidebar badges and toolbar badge render rich status from `hookStatus`
7. Settings JSON files cleaned up on session end (hibernate/exit/destroy)

**Badge mapping:**
| Hook Event | Status | Label | Color | Animation |
|------------|--------|-------|-------|-----------|
| SessionStart | working | Working | Blue (sky) | Pulsing |
| Notification (permission) | pendingApproval | Pending Approval | Amber | Static |
| Notification (waiting) | needsInput | Needs Input | Amber | Static |
| Notification (error) | error | Error | Red | Static |
| Stop | completed | Completed | Gray | Static |
| No hook data + active PTY | — | Running | Green | Pulsing |
| Dormant PTY | — | Paused | Gray | Static |

**Checkpoint verified:** `bun typecheck` 6/6 pass, `bun lint` 0 errors, `bun run test` all packages pass (399 server, 345 web, 46 contracts, 26 shared, 26 desktop, 18 scripts).

### Phase 9: Auto-Generate Thread Titles ✅ COMPLETE

Implemented auto-title generation from the user's initial prompt via Claude Code hooks. Threads now get meaningful titles instead of "New Thread" when the user sends their first message.

**New files:**
- `apps/server/src/terminal/titleGenerator.ts` — `extractPromptText()` extracts prompt text from `UserPromptSubmit` hook JSON body (searches `prompt`, `message`, `text`, `input` fields at top level and nested in `data`/`context`/`event`). `generateTitleFromPrompt()` strips ANSI codes, takes first non-empty line, collapses whitespace, truncates to 60 chars with ellipsis.
- `apps/server/src/terminal/titleGenerator.test.ts` — 21 tests for prompt extraction and title generation
- `apps/server/src/persistence/Migrations/018_TitleSource.ts` — Idempotent migration adding `title_source TEXT NOT NULL DEFAULT 'auto'` column to `projection_threads`

**Modified files:**
- `packages/contracts/src/orchestration.ts` — Added `TitleSource` schema (`"auto" | "manual"`), added `titleSource` field to `OrchestrationThread` (with decoding default `"auto"`), `ThreadMetaUpdateCommand` (optional), and `ThreadMetaUpdatedPayload` (optional)
- `apps/server/src/persistence/Migrations.ts` — Registered migration 018
- `apps/server/src/persistence/Services/ProjectionThreads.ts` — Added `titleSource: TitleSource` to `ProjectionThread` schema
- `apps/server/src/persistence/Layers/ProjectionThreads.ts` — Added `title_source` to INSERT/SELECT/UPDATE SQL queries
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` — `thread.created` sets `titleSource: "auto"`. `thread.meta-updated` propagates `titleSource`, with safeguard: skips auto-title updates when thread's `titleSource` is `"manual"`.
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` — Added `title_source AS "titleSource"` to thread SELECT, added `titleSource` to thread assembly
- `apps/server/src/orchestration/projector.ts` — In-memory projector: `thread.created` sets `titleSource: "auto"`, `thread.meta-updated` propagates `titleSource`
- `apps/server/src/orchestration/decider.ts` — `thread.meta.update` case includes `titleSource` in event payload
- `apps/server/src/wsServer.ts` — Added `autoTitledThreads` Set to track threads already titled in this session. On `user-prompt-submit` hook: extracts prompt text via `extractPromptText()`, generates title via `generateTitleFromPrompt()`, dispatches `thread.meta.update` with `titleSource: "auto"` (fire-and-forget). Only runs once per thread per server session.
- `apps/web/src/types.ts` — Added `titleSource: TitleSource` to `Thread` interface
- `apps/web/src/store.ts` — Maps `titleSource` from read model in `syncServerReadModel`
- `apps/web/src/components/TerminalToolbar.tsx` — `EditableTitle` sends `titleSource: "manual"` on manual rename
- `apps/web/src/components/Sidebar.tsx` — Thread rename sends `titleSource: "manual"`

**Auto-title flow:**
1. User sends first prompt in a thread
2. Claude Code fires `UserPromptSubmit` hook → `curl` POSTs to `/hooks/user-prompt-submit?thread=<id>`
3. Server extracts prompt text from hook JSON body
4. `generateTitleFromPrompt()` cleans and truncates to 60 chars
5. Server dispatches `thread.meta.update` with generated title and `titleSource: "auto"`
6. Orchestration pipeline persists title + titleSource, broadcasts domain event
7. Sidebar updates in real-time via snapshot sync

**Manual override protection:**
- `titleSource: "auto"` — initial/auto-generated (eligible for auto-title)
- `titleSource: "manual"` — user renamed (protected from auto-title)
- Server tracks `autoTitledThreads` Set to avoid repeated auto-titles per session
- Projector safeguard: skips auto-title updates when existing `titleSource` is `"manual"`

**Checkpoint verified:** `bun typecheck` 6/6 pass, `bun lint` 0 errors, `bun run test` all packages pass (424 server, 345 web, 46 contracts, 26 shared, 26 desktop, 18 scripts).

### Phase 10: Restore Git Workflow UI ✅ COMPLETE

**Goal:** Bring back t3code's git workflow that was lost during the refactor — branch/worktree selection on new thread creation, git action toolbar, and terminal drawer shortcuts.

**Key finding:** All git components already existed intact from the t3code fork. The work was purely **wiring existing components into the Clui UI**, not rebuilding them.

**Modified files:**

1. **`apps/web/src/components/TerminalToolbar.tsx`** — Replaced static branch badge with interactive `BranchToolbarBranchSelector` (searchable branch combobox with checkout, create branch, worktree support). Added `GitActionsControl` split button (smart quick action: commit/push/PR with commit dialog, default-branch protection, toast progress). Added `PullRequestThreadDialog` for PR checkout from branch picker. Used `useBranchToolbar` hook for branch state management.

2. **`apps/web/src/components/ThreadTerminalView.tsx`** — Enhanced `NewThreadView` with Local/Worktree toggle + `BranchToolbarBranchSelector` before "Start Claude". Handles worktree creation on start (creates worktree → updates thread metadata → starts Claude in worktree cwd). Shows contextual cwd info ("Worktree from main" vs path). Added `PullRequestThreadDialog` for PR checkout flow.

3. **`apps/web/src/components/useBranchToolbar.ts`** — Bug fix: added missing `api.claude.hibernate()` call when worktree path changes (matching `BranchToolbar.tsx` behavior). Without this, switching branches wouldn't restart the terminal in the new cwd.

4. **`apps/web/src/store.ts`** — Added `addOptimisticThread` action for instant thread availability on creation. Creates a minimal thread in the Zustand store so the route has it immediately when navigating, avoiding a race condition where the thread doesn't exist in the store yet.

5. **`apps/web/src/components/Sidebar.tsx`** — Fixed race condition: optimistic thread insert via `addOptimisticThread` before navigation, fire-and-forget server dispatch (changed `await` to `void`). Previously, navigating to the new thread route before the server snapshot synced caused a blank page.

6. **`apps/web/src/routes/_chat.tsx`** — Wired `Cmd+J` (`terminal.toggle`) and `Cmd+Shift+J` (`projectTerminal.toggle`) keyboard handlers. The shortcut matchers and default bindings existed but were never wired into the keyboard handler.

7. **`apps/web/src/routes/_chat.$threadId.tsx`** — Added `ThreadTerminalDrawerContainer` that renders the `ThreadTerminalDrawer` (shell terminal split panel) when `terminalOpen` is true. Wired to `useTerminalStateStore` for all state management (split, new, close, resize, active terminal tracking).

**Components wired (not rebuilt):**
- `GitActionsControl` (840 lines) — commit/push/PR split button with dialogs
- `BranchToolbarBranchSelector` (466 lines) — searchable branch combobox
- `PullRequestThreadDialog` (284 lines) — PR resolve + checkout flow
- `ThreadTerminalDrawer` (920 lines) — resizable shell terminal drawer
- `useBranchToolbar` hook — branch state management
- `gitReactQuery.ts` — TanStack Query wrappers (polling, caching, mutations)
- Server git module (`apps/server/src/git/`) — 3-tier Effect services

**Toolbar layout:**
```
[Title] [Branch▾] [Status] | [Git Actions▾] | [Stop/Resume/Restart]
```

**Keyboard shortcuts wired:**
- `Cmd+J` — Toggle thread shell terminal drawer
- `Cmd+Shift+J` — Toggle project shell terminal drawer

**Post-Phase 10 bug fixes (same session):**
- **Worktree cwd validation** — `wsServer.ts` `claude.start` route rejected worktree paths outside the workspace root. Fixed by also allowing the thread's registered `worktreePath` from the snapshot.
- **Worktree branch name input** — Added branch name input field in NewThreadView when worktree mode is active, prefilled with `feature/ITE-`. Passes `newBranch` to `createWorktree` API. Start button disabled when branch name ends with `/` or `-` (prevents creating branches with just the prefix).

**Checkpoint verified:** `bun typecheck` 6/6 pass, `bun lint` 0 errors (12 warnings, baseline), `bun run test` all packages pass (424 server, 345 web, 46 contracts, 26 shared, 26 desktop, 18 scripts).

## Key Files for Next Session

| File | Purpose |
|------|---------|
| `PLAN.md` | Full implementation plan with file-level detail |
| `AGENTS.md` | Build instructions, tech stack, project snapshot (symlinked as CLAUDE.md) |
| `apps/web/src/components/TerminalToolbar.tsx` | Terminal toolbar with branch selector + git actions + status badge |
| `apps/web/src/components/ThreadTerminalView.tsx` | Three-state terminal view with branch/worktree picker in NewThreadView |
| `apps/web/src/components/useBranchToolbar.ts` | Branch state management hook (hibernate on cwd change) |
| `apps/web/src/components/GitActionsControl.tsx` | Commit/push/PR split button (wired, not modified) |
| `apps/web/src/components/BranchToolbarBranchSelector.tsx` | Branch picker combobox (wired, not modified) |
| `apps/web/src/store.ts` | Zustand store with `addOptimisticThread` |
| `apps/web/src/routes/_chat.tsx` | Layout with Cmd+J/Cmd+Shift+J terminal shortcuts |
| `apps/web/src/routes/_chat.$threadId.tsx` | Thread route with ThreadTerminalDrawerContainer |
| `apps/server/src/terminal/Layers/ClaudeSessionManager.ts` | ClaudeSessionManager implementation |
| `apps/server/src/wsServer.ts` | WS routes + hook HTTP routes + auto-title dispatch |

## How to Continue

Next session prompt:

```
Continue Clui implementation — Phase 11: Terminal Input Enhancement + Polish

Read SESSION.md and PLAN.md first. They contain the full project context, architecture decisions, and completed phase details.

Clui is a terminal multiplexer for terminal-native coding agents. Each thread is a real terminal running its selected harness via node-pty; current harnesses are Claude Code and pi. Phases 0–11 are complete: Agent SDK removed, DB schema, ClaudeSessionManager service, terminal UI (ThreadTerminalView with three-state routing), lifecycle management (LRU eviction, graceful shutdown, startup recovery, session resume via --session-id), polish (terminal toolbar, keyboard shortcuts, configurable font settings, git branch integration), testing (45+ new tests), Claude Code hooks integration (badge system with sidebar + toolbar badges, OS notifications), auto-title generation (extracts prompt from UserPromptSubmit hook, generates ≤60-char title, titleSource: auto/manual protection), git workflow UI restoration (GitActionsControl commit/push/PR toolbar, BranchToolbarBranchSelector in toolbar + NewThreadView, PullRequestThreadDialog, worktree creation on start with branch name input prefilled feature/ITE-, optimistic thread creation, Cmd+J/Cmd+Shift+J terminal drawer shortcuts, worktree cwd validation fix), and persisted coding harness support (`claudeCode | pi`) with default-harness settings plus pi-compatible shared-session resume.

Phase 11 scope (SESSION.md § Phase 11):

1. Terminal input enhancement — macOS shortcuts in xterm.js:
   - Cmd+Left → \x01 (Ctrl-A, beginning of line)
   - Cmd+Right → \x05 (Ctrl-E, end of line)
   - Cmd+Backspace → \x15 (Ctrl-U, kill line)
   - Option+Left/Right → word movement (\x1bb / \x1bf)
   - Use xterm.js `attachCustomKeyEventHandler` to intercept before browser

2. Polish and bug fixes from manual testing of Phase 10:
   - Test branch switching with active terminals
   - Test worktree creation flow in NewThreadView (branch name input, worktree cwd validation)
   - Test GitActionsControl commit/push/PR in thread context
   - Test Cmd+J / Cmd+Shift+J terminal drawer toggle
   - Verify PullRequestThreadDialog checkout flow

3. Make the worktree branch name prefix (feature/ITE-) configurable per project instead of hardcoded

4. Any cleanup items found during testing

Before starting work:
- Run bun typecheck && bun lint && bun run test to confirm green baseline (expect 6/6 typecheck, 0 lint errors, 424+ server tests, 345+ web tests).

Rules: Both bun lint and bun typecheck must pass. Use bun run test (never bun test). Prioritize correctness and maintainability. Don't duplicate logic — extract shared modules. ultrathink
```

## Phase 11: Terminal Input Enhancement + Polish ✅ COMPLETE

**Goal:** Fix keyboard shortcuts in Claude terminals, configurable branch prefix.

### 11.1 Terminal input enhancement ✅

The navigation shortcuts (`terminalNavigationShortcutData`, `isTerminalClearShortcut`) already existed in `keybindings.ts` and were wired into the shell terminal drawers (ThreadTerminalDrawer, ProjectTerminalDrawer), but were **NOT** wired into the Claude terminal's `ActiveTerminalView`. Fixed by adding `attachCustomKeyEventHandler` to `ActiveTerminalView` in `ThreadTerminalView.tsx`.

**Shortcuts now working in Claude terminals:**
- `Cmd+Left` → `\x01` (Ctrl-A, beginning of line)
- `Cmd+Right` → `\x05` (Ctrl-E, end of line)
- `Cmd+Backspace` → `\x15` (Ctrl-U, kill line) — **NEW** shortcut added to `keybindings.ts`
- `Option+Left/Right` → `\x1bb` / `\x1bf` (word movement)
- `Cmd+K` / `Ctrl+L` → terminal clear

### 11.2 Configurable worktree branch prefix ✅

Replaced hardcoded `"feature/ITE-"` with per-project configurable prefix stored in `localStorage` (key `clui:worktree-branch-prefix`).

- Default: `"feature/ITE-"` (backward compatible)
- Editable via "prefix" button in NewThreadView when worktree mode is active
- Persisted per project cwd — different projects can have different prefixes
- No server-side changes needed (purely client-side)

### 11.3 Tests ✅

+4 new tests in `keybindings.test.ts`:
- `maps Cmd+Backspace on macOS to kill line`
- `does not map Cmd+Backspace on non-macOS`
- `does not map plain Backspace`
- `does not map Option+Backspace`

**Checkpoint verified:** `bun typecheck` 6/6 pass, `bun lint` 0 errors (12 warnings, baseline), `bun run test` all packages pass (424 server, 349 web (+4), 46 contracts, 26 shared, 26 desktop, 18 scripts).

## Post-Phase 11: Selectable Coding Harnesses (Claude Code / pi) ✅ COMPLETE

Implemented first-class persisted coding harness support across contracts, persistence, transport, server runtime, and the web UI.

**What changed:**
- Added persisted thread-level `harness: "claudeCode" | "pi"` with migration/backfill for existing rows.
- Added app setting `defaultCodingHarness`; new threads inherit it.
- New/unstarted threads can switch harnesses from the new-thread screen.
- Added additive `pi.*` contracts, IPC, WebSocket methods, and client wiring alongside existing `claude.*` APIs.
- Added `PiSessionManager`, which launches `pi` with a pi-compatible shared session store under server state, persists each thread's active `piSessionFile`, and injects a runtime extension to report session switches (`/resume`, `/new`, `/fork`, import) back to Clui.
- Routed start/resume/restart/hibernate flows by harness and hid Claude-only YOLO controls for pi threads.
- Enforced invariant: harness changes are rejected once a thread has started.

**Key design note:** pi resume now persists a separate per-thread `piSessionFile`. Clui still keeps pi data under server state, but it uses pi's native per-cwd layout so `/resume` discovery behaves like stock pi while Clui can still reopen the exact session each thread last selected.

**Primary files:**
- `packages/contracts/src/orchestration.ts`
- `packages/contracts/src/ipc.ts`
- `packages/contracts/src/ws.ts`
- `packages/contracts/src/pi-terminal.ts`
- `apps/server/src/terminal/Services/PiSession.ts`
- `apps/server/src/terminal/Layers/PiSessionManager.ts`
- `apps/server/src/wsServer.ts`
- `apps/server/src/serverLayers.ts`
- `apps/server/src/persistence/Migrations/022_ProjectionThreadsHarness.ts`
- `apps/web/src/appSettings.ts`
- `apps/web/src/routes/_chat.settings.tsx`
- `apps/web/src/store.ts`
- `apps/web/src/types.ts`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/components/ThreadTerminalView.tsx`
- `apps/web/src/components/TerminalToolbar.tsx`
- `apps/web/src/routes/__root.tsx`
- `apps/web/src/wsNativeApi.ts`

**Verification:** `bun typecheck` ✅, `bun lint` ✅. Full `bun run test` was not run for this change set.

## Key Files for Next Session

| File | Purpose |
|------|---------|
| `PLAN.md` | Full implementation plan with file-level detail |
| `AGENTS.md` | Build instructions, tech stack, project snapshot (symlinked as CLAUDE.md) |
| `apps/web/src/components/TerminalToolbar.tsx` | Terminal toolbar with branch selector + git actions + harness-aware actions/status |
| `apps/web/src/components/ThreadTerminalView.tsx` | Three-state terminal view with key handler, branch prefix config, and new-thread harness switching |
| `apps/web/src/keybindings.ts` | Terminal navigation shortcuts (Cmd+Left/Right, Cmd+Backspace, Option+Left/Right) |
| `apps/web/src/components/useBranchToolbar.ts` | Branch state management hook (hibernate on cwd change, now harness-aware) |
| `apps/web/src/components/GitActionsControl.tsx` | Commit/push/PR split button |
| `apps/web/src/components/BranchToolbarBranchSelector.tsx` | Branch picker combobox |
| `apps/web/src/appSettings.ts` | App settings schema including `defaultCodingHarness` |
| `apps/web/src/store.ts` | Zustand store with optimistic thread creation and persisted harness state |
| `apps/web/src/wsNativeApi.ts` | Native API transport wiring for both `claude.*` and `pi.*` |
| `apps/web/src/routes/_chat.tsx` | Layout with Cmd+J/Cmd+Shift+J terminal shortcuts |
| `apps/web/src/routes/_chat.$threadId.tsx` | Thread route with ThreadTerminalDrawerContainer |
| `apps/server/src/terminal/Layers/ClaudeSessionManager.ts` | ClaudeSessionManager implementation |
| `apps/server/src/terminal/Layers/PiSessionManager.ts` | PiSessionManager implementation with shared pi store, explicit `piSessionFile` resume, and runtime session-sync extension |
| `apps/server/src/wsServer.ts` | WS routes + hook HTTP routes + harness routing + auto-title dispatch |

## Future Phases

### Phase 12: Split Terminal View
- Multiple threads visible simultaneously
- Drag-to-split terminal panes
