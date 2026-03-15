# Clui — Implementation Plan

> **The CLI with a UI.** Project-organized, thread-based terminal multiplexer for Claude Code CLI.

**Name:** Clui (CLI + UI)

## Overview

Fork t3code and replace its Agent SDK chat interface with embedded xterm.js terminals running Claude Code CLI directly. Keep the project → thread sidebar, branch/worktree management, and git workflow. Each thread becomes a terminal session running `claude` in the thread's worktree cwd, resumable via `claude --resume <session_id>`.

---

## Requirements Summary

### Must Have (MVP)
1. Project sidebar with nested threads (kept from t3code as-is)
2. Each thread renders a full-screen xterm.js terminal instead of a chat view
3. Threads spawn `claude` CLI via node-pty in the thread's worktree/branch cwd
4. Thread lifecycle: New → Active (live PTY) → Dormant (saved scrollback)
5. Resume dormant threads via `claude --resume <session_id>`
6. Scrollback persistence on hibernation and app close
7. Max active terminals cap with LRU eviction
8. Branch/worktree management per thread (kept from t3code)
9. Git operations: commit, push, PR flow (kept from t3code)

### Should Have
10. Terminal theming (inherit from system or configurable)
11. Copy/paste, find-in-terminal, URL detection
12. Thread status detection from terminal output (working/idle/waiting)
13. Split terminal view (multiple threads visible)

### Could Have
14. Import existing Claude sessions from `~/.claude/` into threads
15. Quick command palette for common actions
16. Terminal scrollback search across threads

### Future (Post-MVP)
17. Multi-CLI support: Codex CLI, GitHub Copilot CLI, Aider, etc.
18. Per-thread CLI selector (pick which agent CLI to spawn)
19. CLI-specific resume logic (each CLI has its own session/resume mechanism)

---

## Acceptance Criteria

| # | Criterion | Verification |
|---|-----------|--------------|
| AC1 | Creating a new thread and typing a message spawns `claude` in the correct worktree cwd | `ps aux \| grep claude` shows process with expected cwd |
| AC2 | Switching threads preserves the previous thread's PTY process | Switch away and back; terminal state is identical, process PID unchanged |
| AC3 | Dormant threads display saved scrollback as read-only | Kill PTY manually; thread shows static scrollback with "Resume" button |
| AC4 | Clicking "Resume" on dormant thread runs `claude --resume <id>` | New PTY spawns with `--resume` flag; conversation continues from last point |
| AC5 | Closing app with 10 active terminals saves all scrollback | Relaunch; all threads show scrollback, zero PTYs running until user clicks in |
| AC6 | Exceeding max terminals (default 12) hibernates LRU thread | Open 13 threads; oldest untouched thread auto-hibernates |
| AC7 | Branch toolbar works: create branch, switch, create worktree | Thread's terminal cwd updates to worktree path |
| AC8 | Git operations (commit, push, PR) work from sidebar | PR created via sidebar matches the thread's branch |
| AC9 | Agent SDK code fully removed | No `@anthropic-ai/claude-agent-sdk` in node_modules or imports |
| AC10 | App starts in < 3 seconds with 200 dormant threads | Measure startup; no PTYs spawned until user interaction |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Electron Shell                    │
│                  (apps/desktop)                      │
├──────────┬──────────────────────────────────────────┤
│          │                                          │
│ Sidebar  │         Terminal Content Area             │
│ (React)  │         (xterm.js per thread)             │
│          │                                          │
│ Projects │  ┌─────────────────────────────────────┐ │
│  └Thread │  │  Active: live xterm.js ↔ node-pty   │ │
│  └Thread │  │  Dormant: static scrollback view    │ │
│  └Thread │  │  New: "Start conversation" prompt   │ │
│ Projects │  └─────────────────────────────────────┘ │
│  └Thread │                                          │
│          │  ┌─────────────────────────────────────┐ │
│          │  │  Branch Toolbar (kept from t3code)  │ │
│          │  └─────────────────────────────────────┘ │
├──────────┴──────────────────────────────────────────┤
│              WebSocket Transport                     │
├─────────────────────────────────────────────────────┤
│              Node.js Server                          │
│  ┌───────────────────────────────────────────────┐  │
│  │  TerminalSessionManager                       │  │
│  │    activeTerminals: Map<ThreadId, Session>     │  │
│  │    startSession(threadId, cwd, resumeId?)      │  │
│  │    hibernateSession(threadId)                   │  │
│  │    getScrollback(threadId)                      │  │
│  │    reconcileActiveSessions(maxActive)           │  │
│  └───────────────────────────────────────────────┘  │
│  ┌──────────────┐  ┌────────────┐  ┌────────────┐  │
│  │   SQLite DB   │  │  Git Ops   │  │ Worktrees  │  │
│  └──────────────┘  └────────────┘  └────────────┘  │
└─────────────────────────────────────────────────────┘
```

---

## Implementation Phases

### Phase 0: Fork & Setup (Day 1) ✅ COMPLETE

**Goal:** Clean fork of t3code, verify it builds, rename.

| Step | Action | Files |
|------|--------|-------|
| 0.1 | Fork t3code into `better-claude-cmux` repo | — |
| 0.2 | Rename package from `@clui/monorepo` to `@clui/monorepo` | `/package.json` (line 2) |
| 0.3 | Update all `@clui/*` package names to `@clui/*` | `apps/web/package.json`, `apps/server/package.json`, `apps/desktop/package.json`, `packages/contracts/package.json`, `packages/shared/package.json` |
| 0.4 | Verify build: `bun install && bun run build` | — |
| 0.5 | Verify dev: `bun run dev` and confirm the existing app runs | — |

---

### Phase 1: Delete Agent SDK Layer (Day 1-2) ✅ COMPLETE

**Goal:** Remove all provider/agent SDK code. The app won't have a working content area yet — that's fine.

**Status:** All provider/SDK code deleted, app builds clean (7/7 typecheck, 5/5 build, 0 lint errors).

#### 1.1 Delete provider adapters

| File | Action |
|------|--------|
| `apps/server/src/provider/Layers/ClaudeCodeAdapter.ts` (~1900 lines) | **Delete** |
| `apps/server/src/provider/Layers/CodexAdapter.ts` | **Delete** |
| `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts` | **Delete** |
| `apps/server/src/provider/Layers/ProviderService.ts` | **Delete** |
| `apps/server/src/provider/Services/` (entire directory) | **Delete** |
| `apps/server/src/provider/` (entire directory if empty after above) | **Delete** |

#### 1.2 Remove SDK dependency

| File | Action |
|------|--------|
| `apps/server/package.json` line 25 | Remove `@anthropic-ai/claude-agent-sdk` |
| Run `bun install` to clean lockfile | — |

#### 1.3 Clean up contracts

| File | Action |
|------|--------|
| `packages/contracts/src/orchestration.ts` line 34 | Remove `ProviderKind` schema or replace with simple string literal |
| `packages/contracts/src/orchestration.ts` line 49 | Remove `DEFAULT_PROVIDER_KIND` |
| `packages/contracts/src/provider.ts` | **Delete** or gut — remove all SDK-specific types |
| `packages/contracts/src/orchestration.ts` lines 483-608 | Remove provider-specific commands: `thread.message.assistant.delta`, `thread.message.assistant.complete`, `thread.proposed-plan.upsert`, `thread.turn.diff.complete`, `thread.activity.append`, `thread.turn.usage.update` |

#### 1.4 Remove chat UI components

| File | Action |
|------|--------|
| `apps/web/src/components/ChatView.tsx` (or similar) | **Delete** |
| `apps/web/src/components/Composer*.tsx` | **Delete** (the message input composer) |
| `apps/web/src/composerDraftStore.ts` | **Delete** |
| `apps/web/src/components/DiffPanel.tsx` | **Keep** (useful for viewing git diffs) |
| `apps/web/src/components/Message*.tsx` | **Delete** (chat message renderers) |

#### 1.5 Stub the thread route

| File | Action |
|------|--------|
| `apps/web/src/routes/_chat.$threadId.tsx` | Replace `ChatView` with a placeholder `<div>Terminal goes here</div>` |

**Checkpoint:** App builds, sidebar works, clicking a thread shows placeholder.

---

### Phase 2: Database Schema Changes (Day 2) ✅ COMPLETE

**Goal:** Add terminal-specific columns, remove provider-specific ones.

#### 2.1 New migration

Create `apps/server/src/persistence/Migrations/016_TerminalSessions.ts` (or next number):

```sql
-- Add terminal session columns to projection_threads
ALTER TABLE projection_threads ADD COLUMN claude_session_id TEXT;
ALTER TABLE projection_threads ADD COLUMN scrollback_snapshot TEXT;
ALTER TABLE projection_threads ADD COLUMN terminal_status TEXT NOT NULL DEFAULT 'new';
-- terminal_status: 'new' | 'active' | 'dormant'

-- Add settings table for terminal config
CREATE TABLE IF NOT EXISTS terminal_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO terminal_settings (key, value) VALUES ('max_active_terminals', '12');
```

#### 2.2 Update contracts

| File | Action |
|------|--------|
| `packages/contracts/src/orchestration.ts` `OrchestrationThread` (line 295) | Add fields: `claudeSessionId: string \| null`, `terminalStatus: "new" \| "active" \| "dormant"` ✅ |
| Old fields (`session`, `proposedPlans`, `activities`, `checkpoints`) | **Kept** — still actively used by projector, CheckpointReactor, and persistence layers |

#### 2.3 Update projection queries

| File | Action |
|------|--------|
| `apps/server/src/persistence/Layers/Sqlite.ts` | Update thread SELECT/INSERT/UPDATE queries to include new columns |

**Checkpoint:** App builds, migration runs, new columns exist.

---

### Phase 3: TerminalSessionManager — Server Side (Day 2-4) ✅ COMPLETE

**Goal:** Build the core server-side terminal management using Effect and node-pty.

#### 3.1 Create TerminalSessionManager service

Create `apps/server/src/terminal/Layers/TerminalSessionManager.ts`:

```typescript
// Effect service that manages PTY processes for threads
interface TerminalSession {
  threadId: ThreadId
  pty: IPty                    // node-pty process
  claudeSessionId: string | null  // captured from claude CLI output
  lastInteractedAt: number     // for LRU eviction
  scrollbackBuffer: string     // accumulated terminal output
}

interface TerminalSessionManager {
  // Spawn claude CLI in cwd, optionally with --resume
  startSession(threadId: ThreadId, cwd: string, resumeSessionId?: string): Effect<void>

  // Capture scrollback, kill PTY
  hibernateSession(threadId: ThreadId): Effect<string> // returns scrollback

  // Get live or saved scrollback
  getScrollback(threadId: ThreadId): Effect<string | null>

  // Write to PTY stdin (user input from xterm.js)
  writeToSession(threadId: ThreadId, data: string): Effect<void>

  // Subscribe to PTY output (for streaming to xterm.js)
  onSessionOutput(threadId: ThreadId, callback: (data: string) => void): Effect<void>

  // Evict LRU sessions when over cap
  reconcileActiveSessions(): Effect<void>

  // Get session status
  getSessionStatus(threadId: ThreadId): Effect<"new" | "active" | "dormant">

  // Hibernate all (for app shutdown)
  hibernateAll(): Effect<void>
}
```

**Key behaviors:**
- `startSession` builds the command: `claude` (new) or `claude --resume <id>` (resume)
- PTY output is buffered in `scrollbackBuffer` (ring buffer, max ~500KB per session)
- `hibernateSession` captures the buffer, writes to SQLite, kills the PTY process
- `reconcileActiveSessions` checks `activeTerminals.size > maxActive`, hibernates the oldest by `lastInteractedAt`
- On PTY exit (claude quits), auto-transition to dormant, save scrollback

#### 3.2 Reuse existing terminal infrastructure

t3code already has terminal support:
- `apps/server/src/terminal/Services/PTY.ts` — PTY adapter service contract
- `apps/server/src/terminal/Layers/NodePtyAdapter.ts` — node-pty integration

**Action:** Extend `NodePtyAdapter` or build `TerminalSessionManager` on top of it. The existing adapter handles PTY spawning; we add lifecycle management (hibernation, LRU, scrollback capture).

#### 3.3 Wire into WebSocket server

| File | Action |
|------|--------|
| `apps/server/src/wsServer.ts` | Add new WebSocket message types: `terminal.start`, `terminal.write`, `terminal.output` (push), `terminal.resize`, `terminal.hibernate`, `terminal.getScrollback` |

The transport protocol:
- **Client → Server:** `terminal.start { threadId, cwd, resumeSessionId? }`, `terminal.write { threadId, data }`, `terminal.resize { threadId, cols, rows }`
- **Server → Client (push):** `terminal.output { threadId, data }`, `terminal.status { threadId, status }`, `terminal.sessionId { threadId, claudeSessionId }`

#### 3.4 Session ID assignment

Session IDs are assigned upfront rather than extracted from output:

```typescript
// Generate UUID for new sessions, pass via --session-id
const claudeSessionId = input.resumeSessionId ?? crypto.randomUUID();
const args = input.resumeSessionId
  ? ["--resume", input.resumeSessionId]
  : ["--session-id", claudeSessionId];
```

**Note:** The original plan called for regex parsing of Claude CLI output, but Claude Code doesn't print session IDs in any parseable format. Using `--session-id <uuid>` is the reliable approach (implemented in Phase 5).

**Checkpoint:** Can start a claude PTY, stream output over WebSocket, hibernate and resume.

---

### Phase 4: Terminal UI — Client Side (Day 4-6) ✅ COMPLETE

**Goal:** Replace the chat view with a terminal view per thread.

#### 4.1 Create ThreadTerminalView component

Create `apps/web/src/components/ThreadTerminalView.tsx`:

```typescript
function ThreadTerminalView({ threadId, thread }: ThreadTerminalViewProps) {
  switch (thread.terminalStatus) {
    case 'new':
      return <NewThreadView threadId={threadId} thread={thread} />
    case 'active':
      return <ActiveTerminalView threadId={threadId} />
    case 'dormant':
      return <DormantTerminalView threadId={threadId} thread={thread} />
  }
}
```

#### 4.2 ActiveTerminalView

Create `apps/web/src/components/ActiveTerminalView.tsx`:

- Initialize xterm.js `Terminal` instance with WebGL renderer addon
- Connect to WebSocket: subscribe to `terminal.output` for this threadId
- Forward keyboard input via `terminal.write`
- Handle resize via `terminal.resize` + `@xterm/addon-fit`
- On unmount (switch threads): do NOT kill the terminal — just detach xterm.js from the DOM
- On re-mount (switch back): reattach xterm.js, replay any buffered output while detached

**xterm.js instance management:**
- Keep a `Map<ThreadId, Terminal>` in a Zustand store or module-level cache
- When switching threads, detach the old `Terminal` from its DOM container (don't dispose it)
- When switching back, reattach — instant, no re-render needed
- Only dispose when thread is hibernated or deleted
- This mirrors how cmux keeps Workspace objects alive but only mounts one SwiftUI view

#### 4.3 DormantTerminalView

Create `apps/web/src/components/DormantTerminalView.tsx`:

- Fetch saved scrollback from server via `terminal.getScrollback`
- Render in a read-only xterm.js instance (or plain `<pre>` with ANSI-to-HTML)
- Show a "Resume Conversation" button
- On resume: dispatch `terminal.start { threadId, cwd, resumeSessionId: thread.claudeSessionId }`

#### 4.4 NewThreadView

Create `apps/web/src/components/NewThreadView.tsx`:

- Minimal UI: project name, branch info, "Start Conversation" button
- On start: dispatch `terminal.start { threadId, cwd }`

#### 4.5 Wire into route

| File | Action |
|------|--------|
| `apps/web/src/routes/_chat.$threadId.tsx` | Replace `ChatView` with `ThreadTerminalView` |
| Keep | `DiffPanel` (inline sidebar for git diffs) |
| Keep | `BranchToolbar` at the top |

#### 4.6 Update sidebar status pills

| File | Action |
|------|--------|
| `apps/web/src/components/Sidebar.logic.ts` | Update `getThreadStatusPill` to use `terminalStatus` |

New status mapping:
- `"new"` → no pill (or gray "New")
- `"active"` → green pulsing "Running"
- `"dormant"` → gray "Paused"

#### 4.7 Add xterm addons

| File | Action |
|------|--------|
| `apps/web/package.json` | Add `@xterm/addon-webgl`, `@xterm/addon-search`, `@xterm/addon-web-links` |

**Checkpoint:** Click thread → see terminal → type → claude responds. Switch threads preserved. Dormant threads show scrollback.

#### Post-Phase 4: Frontend Architecture Review ✅ COMPLETE

5-agent parallel review (style, quality, accessibility, browser/platform, test-engineer). 12 fixes applied:

**P0:** WebGL addon leak (WeakSet tracking), missing `disposed` guard in ActiveTerminalView, route placeholder in sheet branch, duplicated `terminalThemeFromApp()` extracted to `lib/terminalTheme.ts`.

**P1:** `pointer-events: none` → `disableStdin` (enables copy/paste on dormant), `handleResume` reads actual cached terminal dims, error `role="alert"`, icons `aria-hidden`, `aria-busy` on buttons, `ResizeObserver` on terminal container, exhaustive switch in `writeEvent`, stale `cached` ref → ownership flag.

**Deferred to Phase 6:** keyboard escape binding, `screenReaderMode` setting, MutationObserver debounce, `makeThread` fixture extraction, terminal font size docs.

---

### Phase 5: Lifecycle Management (Day 6-7) ✅ COMPLETE

All lifecycle features implemented and verified.

#### 5.1 LRU eviction ✅
- `lastInteractedAt` tracked on every `writeToSession` and `startSession`
- `reconcileActiveSessions()` called fire-and-forget after each `startSession` (max 10, configurable)
- Over cap: sort by `lastInteractedAt`, hibernate oldest
- `terminal.status` pushed to client via orchestration events

#### 5.2 Graceful shutdown ✅
- `hibernateAll()` runs before closing WebSocket connections (sequential ordering)
- Each session: capture scrollback → persist via orchestration → kill PTY (SIGTERM → 1s → SIGKILL)
- 5 second timeout on hibernateAll, then force-kill remaining PTYs

#### 5.3 Startup behavior ✅
- All threads with `terminal_status = 'active'` set to `'dormant'` on startup (preserves `claudeSessionId` and `scrollbackSnapshot`)
- Zero PTYs spawn until user interacts

#### 5.4 Thread deletion cleanup ✅
- `destroySession(threadId)` — kills PTY, removes from map, no lifecycle events emitted
- Wired into `thread.delete` command dispatch in wsServer

#### 5.5 Session ID reliability fix ✅
- **Bug:** Regex extraction of session ID from Claude CLI output never worked (Claude Code doesn't print session IDs in parseable text)
- **Fix:** Generate UUID via `crypto.randomUUID()`, pass `--session-id <uuid>` for new sessions, `--resume <uuid>` for resumes
- Session ID known upfront, emitted immediately after spawn — no async extraction needed
- Removed dead code: `tryExtractSessionId()`, `ScrollbackRingBuffer.tail()`

**Checkpoint:** App handles 200 threads, only N active, LRU works, restart is clean, resume works across server restarts.

---

### Phase 6: Polish & Integration (Day 7-9) ✅ COMPLETE

All Phase 6 features implemented and verified.

#### 6.1 Terminal theming ✅
- Dark/light theme already synced via `lib/terminalTheme.ts`
- Font size and font family now configurable via app settings
- `claudeTerminalCache.ts` reads `terminalFontSize` / `terminalFontFamily` from `appSettings`
- `updateFontSettings()` propagates changes to all cached terminals live

#### 6.2 Keyboard shortcuts ✅

| Shortcut | Action | Implementation |
|----------|--------|----------------|
| `Cmd+N` | New thread in current project | Already wired (`chat.new`) |
| `Cmd+W` | Hibernate current thread | New `claude.hibernate` command |
| `Cmd+1-9` | Switch to thread by index | Direct handler in `_chat.tsx` |
| `Cmd+Shift+]` / `[` | Next/prev thread | New `thread.next` / `thread.prev` commands |
| `Cmd+K` | Quick thread search/switch | Already wired (`thread.search`) |

- Added 3 new keybinding commands to contracts: `claude.hibernate`, `thread.next`, `thread.prev`
- Added default bindings in server keybindings
- Added matcher functions in web keybindings
- Wired all shortcuts in `_chat.tsx` ChatRouteLayout

#### 6.3 Terminal toolbar ✅
- New `TerminalToolbar` component with:
  - Editable thread title (click to rename, commits via `thread.meta.update`)
  - Branch name badge with git branch icon
  - Terminal status badge (Live/Paused) with semantic colors and ping animation
  - Hibernate button (active terminals)
  - Resume + Restart buttons (dormant terminals)
- Compact h-9 bar with glass-like backdrop-blur styling
- Wired into `_chat.$threadId.tsx` above `ThreadTerminalView`

#### 6.4 Git integration ✅
- `BranchToolbar.tsx` — hibernates active claude terminal when branch/worktree changes
- Terminal restarts in new cwd on next user interaction

#### 6.5 Settings ✅
- Added `terminalFontSize` (8-32px, default 13) and `terminalFontFamily` to `appSettings`
- Terminal settings section in Settings page with live preview
- Reset to defaults button

---

### Phase 7: Testing & Hardening (Day 9-10) ✅ COMPLETE

+45 new tests across unit and integration layers.

#### Unit tests ✅
- `terminalUtils.test.ts` (NEW) — 30 tests for `capHistory`, `shouldExcludeEnvKey`, `createSpawnEnv`, `runWithThreadLock`, `assertValidCwd`
- `keybindings.test.ts` — 9 new tests for `isClaudeHibernateShortcut`, `isThreadNextShortcut`, `isThreadPrevShortcut`
- `ClaudeSessionManager.test.ts` — 33 tests (already existed from Phase 3)

#### Integration tests ✅
- `wsServer.test.ts` — 6 new tests for claude session WS routes (`claude.start`, `claude.hibernate`, `claude.getScrollback`, `claude.write`, `claude.resize`, resume flow)

#### E2E tests (Playwright) — deferred
- Requires full app stack with real PTYs; better suited for CI with container isolation
- Unit + integration coverage validates all critical paths

---

### Phase 8: Claude Code Hooks Integration (Badge System) ✅ COMPLETE

**Goal:** Use Claude Code's `--settings` hooks to drive rich sidebar badges — replace terminal output parsing with structured hook callbacks.

**Reference:** Take heavy inspiration from `../cmux` which implements this pattern well. Key cmux files:
- `Resources/bin/claude` — wrapper that injects `--settings` with hook JSON and `--session-id`
- `CLI/cmux.swift` (lines 8450-8867) — hook handler: `session-start`, `stop`, `notification` subcommands
- `CLI/cmux.swift` (lines 238-303) — `ClaudeHookSessionStore` for session→workspace mapping with 7-day retention
- `Sources/TerminalController.swift` — `notify_target` and `set_status`/`clear_status` commands for badge updates
- `Sources/TerminalNotificationStore.swift` — in-memory notification state with disk persistence

**cmux approach summary:** A `claude` wrapper script checks if running inside cmux (via `CMUX_SURFACE_ID` env var), verifies the cmux socket is live (0.75s timeout to avoid blocking startup), then injects `--session-id` (UUID) and `--settings` with hook JSON pointing to `cmux claude-hook <event>` commands. The hook handler maps sessions to workspaces/surfaces, sets status badges ("Running" with bolt icon, "Needs input" with bell icon), and routes notifications to the correct tab. Notification text is classified (Permission/Error/Waiting/Attention) and truncated to 180 chars.

Claude Code CLI supports `--settings <path>` which accepts a JSON file defining hooks for lifecycle events (`SessionStart`, `Stop`, `Notification`). By injecting a settings file at spawn time, we get structured callbacks instead of fragile output parsing.

#### 8.1 Hook settings injection

| File | Action |
|------|--------|
| `apps/server/src/terminal/Layers/ClaudeSessionManager.ts` | Generate per-session hook settings JSON and pass `--settings <path>` when spawning claude. Also inject `--session-id <uuid>` for session tracking (as cmux does). |

Settings JSON structure (mirroring cmux's `HOOKS_JSON`):
```json
{
  "hooks": {
    "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "curl -s http://localhost:$PORT/hooks/session-start?thread=$THREAD_ID", "timeout": 10 }] }],
    "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "curl -s http://localhost:$PORT/hooks/stop?thread=$THREAD_ID", "timeout": 10 }] }],
    "Notification": [{ "matcher": "", "hooks": [{ "type": "command", "command": "curl -s http://localhost:$PORT/hooks/notification?thread=$THREAD_ID", "timeout": 10 }] }]
  }
}
```

Key details from cmux:
- Clear `CLAUDECODE` env var to prevent nested session detection
- Timeout hooks (10s) to avoid blocking Claude startup
- Verify server is reachable before injecting hooks (graceful degradation if not)

#### 8.2 Hook receiver endpoint

| File | Action |
|------|--------|
| `apps/server/src/hooks/hookReceiver.ts` (NEW) | Lightweight HTTP handler for hook callbacks |
| `apps/server/src/server.ts` | Register hook routes on the existing HTTP server |

Endpoint receives hook events, maps them to thread IDs, and emits internal events. Reuse cmux's notification classification logic:
- Parse notification JSON for event type, message, nested data
- Classify: "Permission/Approve/Approval" → Permission, "Error/Failed/Exception" → Error, "Idle/Wait/Input/Prompt" → Waiting, default → Attention
- Truncate notification body to 180 chars

#### 8.3 Session-to-thread mapping store

| File | Action |
|------|--------|
| `apps/server/src/hooks/hookSessionStore.ts` (NEW) | Map `sessionId → { threadId, surfaceId, startedAt, updatedAt, lastSubtitle }` (inspired by cmux's `ClaudeHookSessionStore`) |

- Persist to SQLite (or JSON file like cmux's `claude-hook-sessions.json`)
- 7-day retention policy for stale records
- Thread-safe updates

#### 8.4 New ClaudeSessionEvent types

| File | Action |
|------|--------|
| `packages/contracts/src/terminal.ts` | Add hook-derived event types: `claude.working`, `claude.needsInput`, `claude.pendingApproval`, `claude.completed`, `claude.error`, `claude.notification` |

#### 8.5 Wire hooks into sidebar badge system

| File | Action |
|------|--------|
| `apps/web/src/lib/threadStatus.ts` | Map hook events to badge types with icons and colors (inspired by cmux's `set_status`) |

Badge mapping (mirroring cmux's status icons/colors):
- `SessionStart` → "Working" (bolt icon, blue, pulsing)
- `Notification` (needs input) → "Needs Input" (bell icon, amber)
- `Notification` (pending approval) → "Pending Approval" (amber)
- `Notification` (error) → "Error" (red)
- `Stop` → "Completed" (gray)
- PTY still running, no recent hook → "Running" (blue)
- PTY exited → "Paused" (gray)

#### 8.6 OS-level notifications

| File | Action |
|------|--------|
| `apps/server/src/hooks/notifications.ts` (NEW) | Forward hook events as OS notifications (Notification API in web, native in Electron) |

Reuse cmux's notification routing pattern:
- Route notifications to the correct thread/tab
- Show OS notification when thread is not in focus
- Custom notification sound support (future)

#### 8.7 Cleanup

- Remove any terminal output parsing used for status detection
- Settings JSON files cleaned up on session end
- Clear status on session dispose

**Checkpoint:** Sidebar badges update in real-time based on Claude Code lifecycle. OS notifications fire when threads need attention. No output parsing needed. `bun typecheck` 6/6, `bun lint` 0 errors, `bun run test` 399 server + 345 web tests pass.

---

### Phase 9: Auto-Generate Thread Titles ✅ COMPLETE

**Goal:** Threads should have meaningful titles instead of "New Thread" — derive a title from the initial prompt sent to Claude Code.

#### 9.1 Capture initial prompt text

| File | Action |
|------|--------|
| `apps/server/src/terminal/Layers/ClaudeSessionManager.ts` | After session starts, watch the first chunk of terminal output for the user's initial prompt (the text after the Claude banner before the first response) |

Two approaches (try in order):
1. **Parse terminal output:** After the Claude Code banner renders, the next user input line is the initial prompt. Capture it from PTY output.
2. **Use hook data:** If `SessionStart` hook provides context about the prompt, extract it there.

#### 9.2 Title generation

| File | Action |
|------|--------|
| `apps/server/src/terminal/titleGenerator.ts` (NEW) | Generate a short title from the initial prompt |

Strategies (cheapest first):
1. **Truncate:** First 60 chars of the prompt, cleaned up (strip newlines, trim)
2. **AI summary:** If an API key is available, call Claude Haiku to generate a 3-6 word title from the prompt (fire-and-forget, don't block the session)
3. **Fallback:** If no prompt captured within 30s, keep the default name

#### 9.3 Push title update to sidebar

| File | Action |
|------|--------|
| `packages/contracts/src/terminal.ts` | Add `terminal.titleUpdate` push event: `{ threadId, title }` |
| `apps/server/src/wsServer.ts` | Emit `terminal.titleUpdate` when title is generated |
| `apps/web/src/components/Sidebar/` | Handle `terminal.titleUpdate` — update thread name in real-time |

#### 9.4 Allow manual override

- User can still rename threads manually via sidebar (existing functionality)
- Auto-generated title only applies if the thread name hasn't been manually set
- Store a `titleSource: "auto" | "manual"` flag to avoid overwriting user renames

**Checkpoint:** New thread → type prompt → sidebar title updates within a few seconds to reflect what the thread is about.

---

### Phase 10: Restore Git Workflow UI (from t3code) ✅ COMPLETE (kept from t3code)

**Goal:** Bring back t3code's git workflow that was lost during the refactor — branch/worktree selection on new thread creation, and the action toolbar for commit/push/PR.

**Reference:** Research `../t3code` extensively before implementing. The original repo has the full git workflow UI — branch picker, worktree creation, commit/push/PR toolbar, and recent actions. Key areas to study:
- `apps/web/src/components/` — look for BranchToolbar, GitToolbar, NewThread, worktree picker components
- `apps/web/src/lib/` — git-related hooks and state management
- `apps/server/src/git/` — server-side git RPC handlers and worktree management
- `packages/contracts/src/` — git-related schemas and types

t3code had a great git workflow: when creating a new thread, you could choose between local or a worktree, pick the branch to start from, and the top toolbar had buttons for commit, push, create PR, and recent actions. This needs to come back.

#### 10.1 New thread creation flow — branch/worktree picker

| File | Action |
|------|--------|
| `apps/web/src/components/NewThreadView.tsx` | Restore branch/worktree selection UI from t3code's thread creation flow |

New thread creation should offer:
- **Local:** Run in the project's main directory (current branch)
- **Worktree:** Create a new worktree from a selected branch
- Branch picker dropdown (list local + remote branches)
- Option to create a new branch from current HEAD
- Worktree path auto-generated from branch name

#### 10.2 Git action toolbar

| File | Action |
|------|--------|
| `apps/web/src/components/GitToolbar.tsx` (NEW or restore from t3code) | Top toolbar with git action buttons |

Toolbar buttons:
- **Commit** — Opens commit dialog (staged changes summary, message input)
- **Push** — Push current branch to remote
- **Create PR** — Opens PR creation flow (title, description, base branch)
- **Pull** — Pull latest from remote
- **Branch indicator** — Shows current branch, click to switch

#### 10.3 Recent actions / activity feed

| File | Action |
|------|--------|
| `apps/web/src/components/RecentActions.tsx` (NEW or restore) | Show recent git actions (commits, pushes, PRs) per thread |

- Compact list of recent operations with timestamps
- Click to see details (commit diff, PR link, etc.)
- Sourced from git log and server-tracked action history

#### 10.4 Wire git operations to thread context

| File | Action |
|------|--------|
| `apps/server/src/git/` | Ensure all git RPC methods respect the thread's cwd (worktree path) |
| `apps/web/src/lib/` | Git operation hooks pass the active thread's worktree cwd |

Key: Every git operation must run in the context of the thread's worktree, not the project root. t3code already had this wiring — restore it.

#### 10.5 Branch toolbar integration with terminal

| File | Action |
|------|--------|
| `apps/web/src/components/BranchToolbar.tsx` | Ensure branch switching restarts the terminal in the new cwd |

- Switching branches updates the thread's cwd
- If a terminal is active, prompt to restart in new context
- Worktree threads always use the worktree path as cwd

**Checkpoint:** New thread offers branch/worktree choice. Active threads show git toolbar with commit/push/PR. Branch switching works end-to-end with terminal restart.

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Claude CLI session ID format changes | Resume breaks | Also store session path from `~/.claude/projects/`; fall back to fresh start |
| xterm.js memory leak with many cached instances | Memory grows | ✅ **Solved:** LRU cap (50), 2-hour idle sweep, WebGL disposal on detach. Busy threads protected from eviction. |
| WebGL GPU context exhaustion (~16 limit) | New terminals fall back to canvas | ✅ **Solved:** WebGL addon disposed on detach, re-created on attach. Only the active terminal holds a GPU context. |
| PTY scrollback buffer grows unbounded | Memory grows | Ring buffer with 5,000-line cap per session (server-side) |
| node-pty Electron version mismatch | Build breaks | Use `electron-rebuild`; pin node-pty version |
| Claude CLI not installed | App useless | Check PATH on startup; show install instructions |
| WebSocket disconnect during session | Lost output | Buffer server-side; replay on reconnect |

---

## Verification Steps

1. `bun install && bun run build` succeeds after each phase
2. `grep -r "claude-agent-sdk" apps/ packages/` returns zero after Phase 1
3. Create thread → terminal shows claude startup within 2 seconds
4. Switch between 3 active threads 10 times — no crashes, no orphans
5. Hit LRU cap → oldest hibernates → resume works
6. Close app → reopen → all threads show scrollback, zero PTYs
7. Worktree thread → claude makes changes → commit → push → PR
8. 50 threads (12 active, 38 dormant) → memory under 1GB
9. 200 threads in DB → app ready in < 3 seconds

---

## Timeline

| Phase | Scope | Duration |
|-------|-------|----------|
| 0 | Fork & Setup ✅ | Day 1 |
| 1 | Delete Agent SDK ✅ | Day 1-2 |
| 2 | Database Schema ✅ | Day 2 |
| 3 | TerminalSessionManager (server) ✅ | Day 2-4 |
| 4 | Terminal UI (client) | Day 4-6 |
| 5 | Lifecycle Management | Day 6-7 |
| 6 | Polish & Integration | Day 7-9 |
| 7 | Testing & Hardening | Day 9-10 |
| 8 | Claude Code Hooks (Badge System) ✅ | Day 10-12 |
| 9 | Auto-Generate Thread Titles ✅ | Day 12-13 |
| 10 | Restore Git Workflow UI | Day 13-16 |

**MVP (Phases 0-5):** ~7 days | **Polished v1:** ~10 days | **Full v1 with hooks:** ~12 days | **Complete v1:** ~16 days
