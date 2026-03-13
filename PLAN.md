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

### Phase 0: Fork & Setup (Day 1)

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

### Phase 2: Database Schema Changes (Day 2)

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
| `packages/contracts/src/orchestration.ts` `OrchestrationThread` (line 295) | Add fields: `claudeSessionId: string \| null`, `terminalStatus: "new" \| "active" \| "dormant"` |
| Remove fields from `OrchestrationThread` | `session` (the old provider session), `proposedPlans`, `activities`, `checkpoints` |

#### 2.3 Update projection queries

| File | Action |
|------|--------|
| `apps/server/src/persistence/Layers/Sqlite.ts` | Update thread SELECT/INSERT/UPDATE queries to include new columns |

**Checkpoint:** App builds, migration runs, new columns exist.

---

### Phase 3: TerminalSessionManager — Server Side (Day 2-4)

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

#### 3.4 Session ID capture

Claude CLI prints its session ID during startup. We need to parse PTY output to capture it.

```typescript
// In TerminalSessionManager, parse PTY output for session ID
const SESSION_ID_PATTERN = /Session ID: ([a-f0-9-]+)/i

pty.onData((data) => {
  scrollbackBuffer += data
  const match = data.match(SESSION_ID_PATTERN)
  if (match) {
    claudeSessionId = match[1]
    persistSessionId(threadId, claudeSessionId)
  }
  emit('terminal.output', { threadId, data })
})
```

**Alternative approach:** After `claude` starts, read the session ID from `~/.claude/projects/` directory where Claude persists session files. This is more reliable than parsing output.

**Checkpoint:** Can start a claude PTY, stream output over WebSocket, hibernate and resume.

---

### Phase 4: Terminal UI — Client Side (Day 4-6)

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

---

### Phase 5: Lifecycle Management (Day 6-7)

#### 5.1 LRU eviction

- Track `lastInteractedAt` on every `writeToSession`
- After each `startSession`, call `reconcileActiveSessions()`
- If over cap: sort by `lastInteractedAt`, hibernate oldest
- Push `terminal.status` to client so UI updates

#### 5.2 Graceful shutdown

- On SIGTERM/SIGINT: `terminalSessionManager.hibernateAll()`
- Each session: capture scrollback → write to SQLite → kill PTY
- 5 second timeout, then force-kill
- Electron `before-quit`: send shutdown signal to server

#### 5.3 Startup behavior

- All threads with `terminal_status = 'active'` set to `'dormant'` on startup
- Zero PTYs spawn until user interacts

#### 5.4 Thread deletion cleanup

- If active: kill PTY, remove from map
- Clean up worktree (existing t3code logic)
- Soft-delete in SQLite (existing logic)

**Checkpoint:** App handles 200 threads, only N active, LRU works, restart is clean.

---

### Phase 6: Polish & Integration (Day 7-9)

#### 6.1 Terminal theming
- Read theme from app settings (dark/light, font, size)
- Apply to all terminal instances

#### 6.2 Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+N` | New thread in current project |
| `Cmd+T` | New thread (pick project) |
| `Cmd+W` | Hibernate current thread |
| `Cmd+1-9` | Switch to thread by index |
| `Cmd+Shift+]` / `[` | Next/prev thread |
| `Cmd+K` | Quick thread search/switch |

#### 6.3 Terminal toolbar
- Thread title (editable), branch name, status indicator
- Hibernate / Kill & Restart buttons

#### 6.4 Git integration verification
- `git.status` shows changes made by claude
- Branch operations restart terminal in new cwd
- PR creation works end-to-end

#### 6.5 Settings
- Max active terminals (4-32, default 12)
- Terminal font family/size/color scheme

---

### Phase 7: Testing & Hardening (Day 9-10)

#### Unit tests
- TerminalSessionManager: start, hibernate, resume, LRU
- Session ID capture, scrollback buffer

#### Integration tests
- WebSocket terminal flow
- Thread lifecycle: new → active → dormant → resume
- LRU eviction

#### E2E tests (Playwright)
- Create project → thread → terminal happy path
- Multi-thread switching
- App close/reopen persistence
- Dormant thread resume

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Claude CLI session ID format changes | Resume breaks | Also store session path from `~/.claude/projects/`; fall back to fresh start |
| xterm.js memory leak with many cached instances | Memory grows | Dispose instances for dormant threads; only cache active ones |
| PTY scrollback buffer grows unbounded | Memory grows | Ring buffer with 500KB cap per session |
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
| 0 | Fork & Setup | Day 1 |
| 1 | Delete Agent SDK | Day 1-2 |
| 2 | Database Schema | Day 2 |
| 3 | TerminalSessionManager (server) | Day 2-4 |
| 4 | Terminal UI (client) | Day 4-6 |
| 5 | Lifecycle Management | Day 6-7 |
| 6 | Polish & Integration | Day 7-9 |
| 7 | Testing & Hardening | Day 9-10 |

**MVP (Phases 0-5):** ~7 days | **Polished v1:** ~10 days
