# Development Changelog

Session-by-session log of changes, fixes, and decisions made during development.

---

## 2026-04-14 — Release workflow: finalize job checked out non-existent `master`

**Problem:** Pushing a `v*.*.*` tag runs `.github/workflows/release.yml`, whose `finalize` job checks out `ref: master` before bumping package versions and pushing to `main`. This repository only has `main`, so checkout could fail and block automated version bumps after a GitHub Release.

**Root cause:** The workflow assumed the default branch was named `master` while the repo uses `main`.

**Fix:** Point the finalize checkout at `main` so it matches `git push origin HEAD:main`.

**Affected files:**
- `.github/workflows/release.yml`
- `docs/CHANGELOG-DEV.md`

---

## 2026-04-14 — WebSocket `pi.*` routing and hybrid prompt hook in `wsServer`

**Problem:** The server layer already provided `PiSessionManagerLive`, but `createServer` in `wsServer.ts` did not yield `PiSessionManager`, expose `pi.start` / `pi.write` / `pi.hibernate` / scrollback / resize, fan out `pi.sessionEvent`, or tie `pi.write` to `notifyPromptSubmitted` and auto-title. Auto-bootstrap `thread.create` omitted the new required `harness` field, so typecheck failed against current contracts.

**Root cause:** Pi terminal work landed in layers and contracts first; the monolithic WebSocket router was never updated in the same change. Submit-side hooking depends on server-side buffering (`advancePiWritePromptBuffer`) before `writeToSession`, which only exists when wired here.

**Fix:** Extended `ServerRuntimeServices`, imports, shutdown (`hibernateAll` for both managers), `thread.delete` and purge counts, `FIRE_AND_FORGET` for `pi.write`/`pi.resize`, `handlePiWriteBuffers` + `dispatchPiAutoTitleIfNeeded`, `onPiSessionEvent` + subscribe with finalizer, and the full `switch` cases mirroring Claude cwd validation. Bootstrap `thread.create` now passes `harness: DEFAULT_CODING_HARNESS`. Rebuilt `PI_WRITE_CONTROL_SEQ_RE` from `String.fromCharCode` segments so oxlint `no-control-regex` passes. Cleared unrelated oxlint warnings (Worker `addEventListener`, `SpeechControl` keys, `wsTransport` iteration, etc.) so `bun lint` stays green.

**Affected files:**
- `apps/server/src/wsServer.ts`
- `apps/server/src/piWritePromptBuffer.ts`
- `apps/web/src/components/SpeechControl.tsx`
- `apps/web/src/components/GitActionsControl.logic.ts`
- `apps/web/src/hooks/useAudioCapture.ts`
- `apps/web/src/lib/terminalInputFilter.ts`
- `apps/web/src/lib/whisperManager.ts`
- `apps/web/src/workers/whisperWorker.ts`
- `apps/web/src/wsTransport.ts`
- `docs/CHANGELOG-DEV.md`

---

## 2026-04-14 — Pi harness hook status: no "Working" on keystroke echo, show "Completed" after idle

**Problem:** In pi threads, the sidebar badge flipped to "Working" while typing in the agent prompt (local PTY echo), and after a run finished it never showed "Completed" because the server cleared inferred status with `hookStatus: null` instead of the lifecycle value the UI maps to the green pill.

**Root cause:** `PiSessionManager.onProcessData` treated every byte of PTY output as agent activity, including echo from `writeToSession`. The idle debouncer then emitted `null`, which `claudeTerminalStatusPill` intentionally renders as no badge — not `"completed"`, which is the only active-terminal state that shows "Completed".

**Fix:**
1. Track `lastClientWriteAtMs` on client writes and ignore transitions to `"working"` when output arrives within a short window (`PI_LOCAL_ECHO_SUPPRESS_AFTER_WRITE_MS`, 120ms) while not already working — keystroke echo is typically immediate; model output usually follows after the user pauses.
2. After PTY silence, emit `hookStatus: "completed"` (and keep internal state aligned) instead of `null`.
3. In `__root.tsx`, route pi `completed` through `sessionState.handleHookStatus` so turn-completed notifications, dock badge refresh, and `latestTurn.completedAt` bookkeeping match Claude sessions; other pi hook values still bypass straight into the store.
4. Updated `projector.test.ts` expectations for new default thread fields (`harness`, `bookmarked`) so the server test suite matches the current projection shape.

**Affected files:**
- `apps/server/src/terminal/Layers/PiSessionManager.ts`
- `apps/web/src/routes/__root.tsx`
- `apps/server/src/orchestration/projector.test.ts`
- `docs/CHANGELOG-DEV.md`

---

## 2026-04-13 — Basic sidebar badges and auto-title fallback for pi harness

**Problem:** Pi threads sat in the sidebar with no "Working" badge, no "Completed" indicator, no dock badge, and no auto-generated title. Every piece of that UX was wired to Claude Code's HTTP hook receiver, so pi threads — which have no hook channel at all — fell through all of it.

**Root cause:** `PiSessionManager` was pure PTY passthrough: `onProcessData` appended to the scrollback ring buffer and emitted a raw `output` event. Nothing in the pipeline ever set `hookStatus` for pi threads, so `Sidebar.logic.ts`'s `resolveThreadStatusPill()` had no signal to render. Separately, the auto-title flow was triggered exclusively inside the `/hooks/user-prompt-submit` HTTP handler (`extractPromptText` → `textGeneration.generateThreadTitle` → `thread.meta.update`), which pi never reaches.

**Fix:**
1. Added a `PiHookStatusEvent` variant to the `PiSessionEvent` union so the server can broadcast explicit `working | null` transitions alongside the existing `output`/`started`/`hibernated`/`exited`/`error` events.
2. `PiSessionManager` now infers activity from PTY output rate: any byte transitions the entry to `"working"` (emitting a `hookStatus` event), and a 1.5s idle debouncer fires a `hookStatus: null` event once the session goes quiet. The idle timer is cleared and hookStatus reset on `stopProcess` and `onProcessExit` so hibernate/exit/restart leave no stale state.
3. `__root.tsx`'s `api.pi.onSessionEvent` handler now routes `hookStatus` events directly into `useStore.setHookStatus`, bypassing the Claude-specific session-event state machine (grace periods, interrupt banner detection, API-error parsing) which doesn't apply to pi. The existing sidebar badge tiering (`Sidebar.logic.ts:174-178`) picks up `"working"` automatically once the field is populated.
4. Extracted the Claude auto-title body into a `dispatchAutoTitleIfNeeded(threadId, promptText)` helper in `wsServer.ts` and added a `tryPiAutoTitleFromWrite` fallback that accumulates `pi.write` keystrokes per thread, strips ANSI/control sequences on first newline, and feeds the first prompt to the same helper. Buffers are capped at 4KB and cleared on thread delete alongside `autoTitledThreads`.
5. `TextGeneration` remains the single text-gen backend, so pi threads borrow the Claude CLI summarizer without duplicating infrastructure.

**Affected files:**
- `packages/contracts/src/pi-terminal.ts`
- `apps/server/src/terminal/Layers/PiSessionManager.ts`
- `apps/server/src/wsServer.ts`
- `apps/web/src/routes/__root.tsx`
- `docs/CHANGELOG-DEV.md`

**Known gaps not closed in this pass:** no `needsInput`/`pendingApproval` detection for pi (requires prompt parsing), no turn-completed notification or diff-panel checkpoint capture for pi, and no pendingApproval persistence across reload. These are tracked for a later pass.

---

## 2026-04-13 — Sync repo docs with selectable coding harness support

**Problem:** The codebase now supports persisted per-thread coding harnesses (`claudeCode | pi`), default harness selection in Settings, and pi-specific session resume behavior, but the top-level docs still described Clui as Claude-only.

**Root cause:** `README.md`, `PLAN.md`, and `SESSION.md` had not been updated after the multi-harness implementation landed, so the documented architecture and resume model lagged behind the actual product.

**Fix:** Updated the top-level docs to describe current harness support, the new `defaultCodingHarness` setting, harness-specific resume behavior (Claude `--resume`, pi thread-scoped `--session-dir` + `-c`), and the new Pi session manager/runtime wiring. Also refreshed the handoff notes and next-session reference files.

**Affected files:**
- `README.md`
- `PLAN.md`
- `SESSION.md`
- `docs/CHANGELOG-DEV.md`

---

## 2026-04-13 — Add selectable coding harnesses (Claude Code / pi) for new threads

**Problem:** Clui only supported Claude Code as a thread terminal harness. There was no way to choose a default harness in Settings, no way to switch a brand-new thread to pi before first launch, and all runtime/session plumbing was hard-coded to Claude-specific APIs.

**Root cause:** Harness selection was not modeled in the thread domain at all — `thread.create`, the thread projection, the web store, and the new-thread UI only tracked model/runtime/interaction mode. On top of that, the transport/runtime layer only exposed `claude.*` WebSocket APIs and a Claude-only session manager, so there was no additive path for launching pi.

**Fix:**
1. Added a first-class `harness` thread field (`claudeCode | pi`) to orchestration contracts, projections, migrations, and the web store, defaulting historical threads to `claudeCode`.
2. Added an app-level `defaultCodingHarness` setting and Settings UI so new threads inherit the chosen harness.
3. Updated sidebar thread creation and the new-thread screen to seed/show the selected harness and allow switching it before first launch.
4. Added additive `pi.*` terminal contracts, WebSocket methods, client wiring, and a new `PiSessionManager` that runs `pi` in a thread-scoped `--session-dir`, using `-c` automatically to resume existing pi sessions for that thread.
5. Routed new-thread start/resume/restart flows by harness and hid Claude-only YOLO controls for pi threads.

**Affected files:**
- `packages/contracts/src/orchestration.ts`
- `packages/contracts/src/ipc.ts`
- `packages/contracts/src/ws.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/pi-terminal.ts`
- `apps/server/src/persistence/Services/ProjectionThreads.ts`
- `apps/server/src/persistence/Layers/ProjectionThreads.ts`
- `apps/server/src/persistence/Migrations/005_Projections.ts`
- `apps/server/src/persistence/Migrations/022_ProjectionThreadsHarness.ts`
- `apps/server/src/persistence/Migrations.ts`
- `apps/server/src/orchestration/decider.ts`
- `apps/server/src/orchestration/projector.ts`
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- `apps/server/src/terminal/Services/PiSession.ts`
- `apps/server/src/terminal/Layers/PiSessionManager.ts`
- `apps/server/src/serverLayers.ts`
- `apps/server/src/wsServer.ts`
- `apps/web/src/appSettings.ts`
- `apps/web/src/routes/_chat.settings.tsx`
- `apps/web/src/types.ts`
- `apps/web/src/store.ts`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/components/ThreadTerminalView.tsx`
- `apps/web/src/components/TerminalToolbar.tsx`
- `apps/web/src/components/useBranchToolbar.ts`
- `apps/web/src/routes/__root.tsx`
- `apps/web/src/wsNativeApi.ts`
- `apps/web/src/store.test.ts`
- `apps/web/src/worktreeCleanup.test.ts`
- `apps/server/src/checkpointing/Layers/CheckpointDiffQuery.test.ts`
- `apps/server/src/orchestration/commandInvariants.test.ts`
- `apps/server/src/orchestration/decider.projectScripts.test.ts`
- `apps/server/src/orchestration/Layers/CheckpointReactor.test.ts`
- `apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts`
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts`

---

## 2026-04-02 — Fix terminal.write timeout errors on idle thread terminals

**Problem:** Thread terminal drawer shows repeated `[terminal] Request timed out: terminal.write` errors when the terminal is idle.

**Root cause:** Commit `b9c014b` removed `terminalWrite`/`terminalResize` from the server's `FIRE_AND_FORGET_METHODS`, making them request-based RPCs. The client now expects a response within 120s. When the WebSocket drops and reconnects, orphaned pending requests from the old connection never receive responses and all timeout together. Additionally, `WsTransport` did not reject pending requests on connection close, so they always waited the full 120s.

**Fix:**
1. Made `terminal.write` and `terminal.resize` fire-and-forget on the client (matching `claude.write`/`claude.resize`) — interactive terminal input doesn't benefit from request tracking.
2. Re-added `terminalWrite`/`terminalResize` to the server's `FIRE_AND_FORGET_METHODS`.
3. Added `rejectPending()` to `WsTransport` that rejects all pending requests on WebSocket close, so any remaining request-based RPCs fail fast instead of hanging for 120s.

**Affected files:**
- `apps/web/src/wsNativeApi.ts`
- `apps/web/src/wsTransport.ts`
- `apps/server/src/wsServer.ts`
- `apps/server/src/wsServer.test.ts`

---

## 2026-04-01 — Fix "Working" badge stuck after Claude Code completes

**Problem:** After Claude Code finishes a turn and returns to the idle prompt, the badge stays on "Working" instead of showing "Completed". Newer Claude Code versions exacerbate this.

**Root cause:** The `handleOutput` completed→working recovery in `sessionEventState.ts` was too aggressive. After the Stop hook set `hookStatus="completed"`, any terminal output arriving >1.5s later (status line updates, prompt rendering, "※ Brewed for..." message) falsely triggered recovery to "working". Subsequent output kept resetting the 90-second idle timer, preventing it from ever clearing.

**Fix:** Removed the output-only completed→working recovery from `handleOutput`. Background subagent activity is already handled correctly by the PostToolUse hook path in `handleHookStatus`, making the output-only recovery redundant.

**Affected files:**
- `apps/web/src/lib/sessionEventState.ts`
- `apps/web/src/lib/sessionEventState.test.ts`

---

## 2026-03-31 — Fix branch selection reverting after switching on new thread

**Problem:** When clicking a new thread and quickly switching to a different branch/worktree, the selection would revert back to the previous branch after 1-2 seconds.

**Root cause:** Race condition between optimistic branch updates and snapshot syncs. When a new thread is created, the `thread.created` domain event triggers a throttled snapshot sync. If the user changes the branch before that snapshot response returns, `syncServerReadModel` unconditionally overwrites `branch` and `worktreePath` with the stale server values — discarding the user's optimistic update.

**Fix:**
1. Added a pending-branch-update guard (`pendingBranchUpdates` Map) in `store.ts` — when the user changes branch, a timestamp is recorded per thread. `syncServerReadModel` preserves local branch/worktreePath while the guard is active (up to 5s), clearing it once the server catches up.
2. Extended the `thread.meta-updated` domain event handler in `__root.tsx` to eagerly patch `branch`/`worktreePath` for ALL threads (not just background ones), and clear the pending guard on receipt — ensuring the store reflects the server-confirmed state as soon as the domain event arrives.

**Affected files:**
- `apps/web/src/store.ts`
- `apps/web/src/routes/__root.tsx`

---

## 2026-03-30 — Terminal typing performance optimizations

**Problem:** Typing in the Claude Code terminal was laggy — keystrokes sometimes didn't appear, there was a multi-second delay when switching threads, and the overall input experience felt sluggish.

**Root cause:** Death by a thousand cuts across the full input/output path:
1. Server encoded+sent a response for every fire-and-forget keystroke (claude.write, claude.resize) — wasted Schema encode + ws.send per keystroke that the client ignores.
2. `handleOutput()` ran two separate O(n) `threads.find()` store lookups on every PTY output chunk, plus a third in `resetWorkingIdleTimer`.
3. `encodeResponse` was allocated inside the per-message handler instead of once at module scope.
4. xterm.js scrollback buffer was 200,000 lines (~183MB per terminal at full capacity), slowing fit/reflow operations.
5. No timeout fallback on the scrollback gate for reattached terminals — a slow server response could block the terminal indefinitely.

**Fix:**
1. Added `FIRE_AND_FORGET_METHODS` set; server skips response encoding+sending for claude.write, claude.resize, terminal.write, terminal.resize.
2. Added `getThreadState` combined dep that does a single `threads.find()` returning both `hookStatus` and `terminalStatus`. Passed known `hookStatus` to `resetWorkingIdleTimer` to avoid redundant store read.
3. Hoisted `encodeResponse` to module scope alongside `encodePush`.
4. Reduced scrollback from 200k to 150k lines.
5. Added 200ms safety timeout for scrollback gate on reattached terminals.

**Affected files:**
- `apps/server/src/wsServer.ts` — hoisted encodeResponse, fire-and-forget response skip
- `apps/web/src/lib/sessionEventState.ts` — combined thread lookup, pass known hookStatus
- `apps/web/src/routes/__root.tsx` — wire getThreadState dep
- `apps/web/src/lib/claudeTerminalCache.ts` — scrollback 200k → 50k
- `apps/web/src/components/ThreadTerminalView.tsx` — scrollback gate timeout fallback

---

## 2026-03-30 — Existing worktree ignored when creating new thread in worktree mode

**Problem:** When creating a new thread, toggling to "Worktree" mode, and selecting a branch that already has a worktree, the Claude Code session starts in the main repo instead of the existing worktree directory.

**Root cause:** In `BranchToolbarBranchSelector.selectBranch`, the `isSelectingWorktreeBase` early return ran *before* `resolveBranchSelectionTarget`. When in worktree mode on a new thread (`effectiveEnvMode === "worktree" && !activeWorktreePath`), selecting any branch — even one with an existing worktree — called `onSetThreadBranch(branch.name, null)`, discarding the worktree path. The `cwd` then fell back to `project?.cwd` (main repo).

**Fix:** Moved the `resolveBranchSelectionTarget` / `reuseExistingWorktree` check before the `isSelectingWorktreeBase` check, so branches with existing worktrees are always reused regardless of the env mode.

**Affected files:**
- `apps/web/src/components/BranchToolbarBranchSelector.tsx` — reordered `selectBranch` logic

---

## 2026-03-27 — Worktree push targets wrong branch

**Problem:** When creating a new worktree and pushing, the push targets `origin/main` instead of the feature branch (e.g. `origin/feature/ITE-308-...`). Users had to manually run `git push -u origin <branch>` for every new worktree.

**Root cause:** `git worktree add -b <newBranch> <path> origin/main` auto-sets the upstream tracking of the new branch to `origin/main` (via `branch.autoSetupMerge`). Then `pushCurrentBranch` sees `hasUpstream=true` and runs bare `git push`, which either fails (`push.default=simple`, names don't match) or pushes to `origin/main` (`push.default=upstream`).

**Fix:** Two changes:
1. `createWorktree`: Added `--no-track` when branching from a remote-tracking ref to prevent auto-tracking the base branch.
2. `pushCurrentBranch`: Added upstream branch name mismatch detection — when the local branch name differs from the upstream branch name (e.g. `feature/X` tracking `origin/main`), uses `git push -u origin <branch>` to correct the tracking and push to the right remote branch.

**Affected files:**
- `apps/server/src/git/Layers/GitCore.ts` — `createWorktree` (--no-track), `pushCurrentBranch` (upstream mismatch detection)

---

## 2026-03-27 — Bookmark toggle instant feedback

**Problem:** Toggling "Mark for later" / "Remove bookmark" took 4-10 seconds to reflect in the sidebar. The click dispatched a server command with no optimistic update, requiring a full snapshot round-trip (9 SQL queries + full Zustand reconciliation) before the UI changed.

**Root cause:** Two gaps: (1) no optimistic store update at the click site, and (2) the `thread.meta-updated` eager-patch handler only patched `title`, not `bookmarked`, so background threads waited for a deferred full sync.

**Fix:** Added an optimistic Zustand update in the Sidebar click handler so the bookmark icon toggles instantly. Extended the eager-patch block in `__root.tsx` to also apply `bookmarked` from domain events, so the server-confirmed state resolves without a full snapshot sync.

**Affected files:**
- `apps/web/src/components/Sidebar.tsx` — Optimistic `bookmarked` toggle before `dispatchCommand`
- `apps/web/src/routes/__root.tsx` — Eager-patch `bookmarked` in `thread.meta-updated` handler

---

## 2026-03-26 — macOS dock badge for pending approvals

**Problem:** No visual indicator on the macOS dock icon when threads need user attention (pending approval or input requested), requiring constant window switching to check.

**Fix:** Added IPC channel from web → Electron main process to set the dock badge count. The badge shows the number of threads with `pendingApproval` or `needsInput` hookStatus and clears automatically when threads are resolved or on reconnect.

**Affected files:**
- `packages/contracts/src/ipc.ts` — Added `setBadgeCount` to `DesktopBridge`
- `apps/desktop/src/preload.ts` — Exposed `setBadgeCount` via IPC `ipcRenderer.send`
- `apps/desktop/src/main.ts` — Added `ipcMain.on` handler calling `app.dock.setBadge()`
- `apps/web/src/lib/notifications.ts` — Added `updateDockBadge()` helper
- `apps/web/src/routes/__root.tsx` — Calls `updateDockBadge` on hookStatus changes and reconnect

---

## 2026-03-26 — Session cleanup & storage reclamation

**Problem:** Clui accumulates significant SQLite data with no cleanup path. Thread soft-deletion leaves all child rows (messages, activities, turns, diffs, scrollback snapshots) orphaned. Dormant sessions hold scrollback snapshots (up to 200K lines each) indefinitely. No storage reclamation mechanism exists.

**Root cause:** The `thread.deleted` handler in the projection pipeline only set `deletedAt` on the thread row — it never cascade-deleted child data. There was no way to bulk-clear dormant session data.

**Fix:**
1. **Cascade delete on thread deletion**: When a thread is soft-deleted, all child projection data (messages, activities, turns, sessions, proposed plans, pending approvals, checkpoint diffs) is now hard-deleted and `scrollback_snapshot` is nulled — all within the existing transaction. `claudeSessionId` is preserved for `--resume`.
2. **"Purge sessions" button**: New sidebar footer button that kills dormant PTY processes and clears scrollback snapshots for all non-active, non-busy threads. Uses an AlertDialog confirmation. Protects the currently viewed thread and busy threads (active terminal, working/needsInput/pendingApproval hook status).
3. **Migration 021**: Retroactively cleans up orphaned data from previously soft-deleted threads.

**Affected files:**
- `packages/contracts/src/server.ts` — `PurgeInactiveSessionsInput`/`Result` schemas
- `packages/contracts/src/ws.ts` — `serverPurgeInactiveSessions` WS method + tagged body
- `packages/contracts/src/ipc.ts` — `NativeApi.server.purgeInactiveSessions`
- `apps/server/src/persistence/Services/ProjectionThreads.ts` — `clearScrollbackSnapshotBulk`
- `apps/server/src/persistence/Layers/ProjectionThreads.ts` — Implementation
- `apps/server/src/persistence/Services/ProjectionPendingApprovals.ts` — `deleteByThreadId`
- `apps/server/src/persistence/Layers/ProjectionPendingApprovals.ts` — Implementation
- `apps/server/src/terminal/Services/ClaudeSession.ts` — `purgeInactiveSessions`
- `apps/server/src/terminal/Layers/ClaudeSessionManager.ts` — Implementation
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` — Cascade deletes in `thread.deleted`
- `apps/server/src/wsServer.ts` — `server.purgeInactiveSessions` handler
- `apps/server/src/serverLayers.ts` — `ProjectionThreadRepositoryLive` in runtime services
- `apps/server/src/persistence/Migrations/021_CleanupDeletedThreadData.ts` — New migration
- `apps/server/src/persistence/Migrations.ts` — Registered migration 021
- `apps/web/src/wsNativeApi.ts` — Client RPC wiring
- `apps/web/src/lib/claudeTerminalCache.ts` — `disposeAllExcept`
- `apps/web/src/components/PurgeSessionsButton.tsx` — New component
- `apps/web/src/components/Sidebar.tsx` — Mounted purge button in footer

---

## 2026-03-26 — Thread bookmarking ("Mark for later")

**Problem:** Threads get lost over time. No way to flag threads you want to come back to — you have to scroll through and hope you find them.

**Fix:** Added a `bookmarked` boolean field to threads, persisted server-side (SQLite + event-sourced). Right-click context menu on any thread shows "Mark for later" / "Remove bookmark". Bookmarked threads display a filled amber bookmark icon in the sidebar for easy visual identification.

**Affected files:**
- `packages/contracts/src/orchestration.ts` — Added `bookmarked` to `OrchestrationThread`, `ThreadMetaUpdateCommand`, `ThreadMetaUpdatedPayload`
- `apps/server/src/persistence/Migrations/020_Bookmarked.ts` — New migration
- `apps/server/src/persistence/Migrations.ts` — Registered migration
- `apps/server/src/persistence/Services/ProjectionThreads.ts` — Added to schema
- `apps/server/src/persistence/Layers/ProjectionThreads.ts` — Added to SQL
- `apps/server/src/orchestration/decider.ts` — Pass through in meta update
- `apps/server/src/orchestration/projector.ts` — Apply in meta-updated event
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` — Persist in projection
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` — Read from DB
- `apps/web/src/types.ts` — Added to `Thread` interface
- `apps/web/src/store.ts` — Added to sync, change detection, optimistic thread
- `apps/web/src/components/Sidebar.tsx` — Context menu toggle + bookmark icon

---

## 2026-03-25 — Diff panel: Cmd+F search, working tree toggle, resizable file tree, v+advance

**Problem:** No way to search through diff content, no way to view actual git staged/unstaged changes (only checkpoint-based diffs), vertical file tree had fixed max height, and `v` (mark viewed) didn't auto-advance to next file.

**Fix:**
1. **Cmd+F search**: Opens a search bar that matches file names and raw patch content. Shows match count, navigates between matches with Enter/Shift+Enter or arrow buttons. Auto-scrolls to first match as you type.
2. **Working tree toggle**: Added a "Working tree" chip in the turn strip. When active, shows real `git diff` (staged + unstaged) instead of checkpoint-based diffs. Clicking any turn chip switches back.
3. **Resizable vertical file tree**: Changed from fixed `maxHeight: 40%` to a draggable resize handle with 240px default and `maxHeight: 60%`. Drag the bottom edge to resize.
4. **`v` auto-advance**: After toggling a file as viewed, focus moves to the next file (same as `j`).

**Affected files:**
- `apps/web/src/components/DiffPanel.tsx`

---

## 2026-03-25 — Diff panel keyboard shortcuts: auto-focus, broader scope, hint bar

**Problem:** Diff panel keyboard shortcuts (j/k/v/e) only worked after clicking inside the viewport area. Clicking the header, file tree, or any other panel area lost focus and disabled shortcuts. Escape was handled separately on the panel div, while navigation shortcuts were scoped to the inner viewport.

**Root cause:** Keyboard handler was registered on `patchViewportRef` (inner viewport) instead of `panelRef` (whole panel). No auto-focus on mount meant the user had to click inside the viewport first. `closeDiff` was also defined after the effect that referenced it (temporal dead zone risk).

**Fix:**
1. Moved all keyboard shortcuts (j/k/v/e/Escape) to a single handler on `panelRef` so they work regardless of which panel area has focus.
2. Added `useEffect` to auto-focus the panel on mount via `panel.focus({ preventScroll: true })`.
3. Moved `closeDiff` declaration before the keyboard effect to avoid temporal dead zone.
4. Added a subtle shortcut hints bar at the bottom of the panel showing `j/k navigate, v viewed, e edit, esc close`.

**Affected files:**
- `apps/web/src/components/DiffPanel.tsx`

---

## 2026-03-25 — Stabilize object references in syncServerReadModel to prevent re-render cascades

**Problem:** Every call to `syncServerReadModel` created new object references for ALL threads and projects via `.map()`, even when nothing changed. This invalidated every Zustand selector that touches `threads` or `projects` on every sync, causing re-render cascades across the entire UI. Additionally, `bumpLastInteractedAt` always created a new thread object since `new Date().toISOString()` always produces a unique string.

**Root cause:** No change detection — the map always returned new objects. For `bumpLastInteractedAt`, no same-second deduplication.

**Fix:**
1. Added `threadChanged()` helper that uses `updatedAt` as a cheap change-detection proxy, plus checks on volatile fields (session status, message count/streaming, latest turn, array lengths). If an existing thread matches, its reference is reused instead of creating a new object.
2. Added `projectChanged()` helper with similar scalar/array-length comparison. Projects reuse existing references when unchanged, and the sorted array itself is reused when order is also stable.
3. The `threads` array reference itself is preserved when no individual thread changed and the array length is the same.
4. `bumpLastInteractedAt` now compares timestamps to the second — if already bumped within the same second, the existing thread reference is returned unchanged.

**Affected files:**
- `apps/web/src/store.ts` — Added `threadChanged()`, `projectChanged()` helpers; modified `syncServerReadModel`, `mapProjectsFromReadModel`, and `bumpLastInteractedAt`

---

## 2026-03-25 — Avoid unnecessary Zustand subscriber notifications for background thread patches

**Problem:** Four `useStore.setState` calls in `__root.tsx` for background thread patches always created new `threads` arrays via `.map()` even when the target thread didn't exist or nothing changed. This triggered unnecessary Zustand subscriber notifications and downstream re-renders.

**Root cause:** Raw `state.threads.map()` always returns a new array reference, causing Zustand to notify all subscribers even when no thread was actually modified.

**Fix:** Replaced raw `.map()` with the existing `updateThread` helper from `store.ts` (which tracks whether any thread was actually modified and returns the original array when nothing changed). Each `setState` callback now compares `threads === state.threads` and returns the original state object when unchanged, preventing unnecessary notifications. Exported `updateThread` from `store.ts` to make it available to `__root.tsx`.

**Affected files:**
- `apps/web/src/store.ts` — Exported `updateThread` helper
- `apps/web/src/routes/__root.tsx` — Updated 4 setState calls (activity-appended, session-set, meta-updated, turn-completed) to use `updateThread` with identity check

---

## 2026-03-25 — Eliminate per-keystroke Promise/timeout allocation for terminal write and resize

**Problem:** Every terminal keystroke went through `api.claude.write()` which called `transport.request()`, creating a Promise, a 120-second timeout, and a pending Map entry. The response was always discarded with `.catch(() => undefined)`. Same for `api.claude.resize()`. This generated unnecessary GC pressure on every single keypress.

**Root cause:** `write` and `resize` used the same `request()` path as RPC methods that need responses, even though their results were never consumed.

**Fix:** Added a `fireAndForget()` method to `WsTransport` that sends the same message format (id + body with _tag) but skips Promise, timeout, and Map allocation entirely. Updated `claude.write` and `claude.resize` in `wsNativeApi.ts` to use `fireAndForget` instead of `request`. The server still processes the messages normally; unmatched response IDs are already handled gracefully.

**Affected files:**
- `apps/web/src/wsTransport.ts` — Added `fireAndForget()` public method
- `apps/web/src/wsNativeApi.ts` — Changed `claude.write` and `claude.resize` to use `fireAndForget`

---

## 2026-03-25 — Narrow useBranchToolbar Zustand selectors

**Problem:** `useBranchToolbar` subscribed to the entire `threads` and `projects` arrays but only needed one thread and one project (via `.find()`). Every thread mutation re-rendered all consumers.

**Root cause:** Broad array selectors instead of targeted single-item selectors.

**Fix:** Replaced `useStore((s) => s.threads)` with `useStore((s) => s.threads.find((t) => t.id === threadId))` and same for projects. Zustand's default `Object.is` equality means re-renders only fire when the specific thread/project object changes.

**Affected files:**
- `apps/web/src/components/useBranchToolbar.ts` — Narrowed selectors

---

## 2026-03-25 — Fix ChatRouteLayout re-rendering on every store sync

**Problem:** `ChatRouteLayout` subscribed to `useStore((s) => s.threads)` and `useTerminalStateStore((s) => s.terminalStateByThreadId)` at component level, but both values were only used inside a keydown event handler. Since `threads` is a new reference on every store sync and `terminalStateByThreadId` changes on any terminal state change, this caused the entire component tree (sidebar, outlet, drawers) to re-render unnecessarily, and the keydown listener to be torn down and re-registered on every sync.

**Root cause:** Reactive subscriptions used for values only needed at event-handler time. Standard Zustand anti-pattern.

**Fix:** Replaced reactive `useStore`/`useTerminalStateStore` subscriptions with `getState()` calls inside the keydown handler. Removed `threads`, `terminalStateByThreadId`, `setTerminalOpen`, and `setProjectTerminalOpen` from the useEffect dependency array. The handler now reads the latest store snapshot at keypress time without causing re-renders.

**Affected files:**
- `apps/web/src/routes/_chat.tsx` — Removed 4 store subscriptions, replaced with `getState()` calls in keydown handler

---

## 2026-03-25 — Fix thread not staying at top after user sends message

**Problem:** After sending a message in a thread at position 3, it jumps to top (Working badge, Tier 2) but drops back to position 3 once the turn completes and the user reads it. The thread should remain at position 1 since the user interacted with it most recently.

**Root cause:** `lastInteractedAt` (the within-tier sort key) was only bumped inside the `thread.session-set` orchestration event handler when a new `activeTurnId` was detected. However, the `thread.session.set` command is an internal command that is never dispatched in production — hook-driven status changes (`turnStart` → `setHookStatus("working")`) never touched `lastInteractedAt`.

**Fix:** Bump `lastInteractedAt` in the client store when a `turnStart` event fires (user sent a message). This is the only null→"working" transition that represents genuine user interaction, avoiding false bumps from other badge transitions.

**Affected files:**
- `apps/web/src/store.ts` — Added `bumpLastInteractedAt` store action
- `apps/web/src/routes/__root.tsx` — Call `bumpLastInteractedAt` on `turnStart` event

---

## 2026-03-24 — Replace scroll management with targeted drift guard

**Problem:** Three terminal scroll bugs: (1) viewport snaps to bottom unexpectedly, (2) scrolling ~10px up causes a jump back to previous position, (3) viewport jumps to top of session on every write when scrolled up.

**Root cause:** The old `scrollAwareWrite()` restored scroll position on EVERY write via save/restore in an async callback. This caused bugs #1 and #2: race conditions between user scrolling and async restore, and `scrollToLine()` clearing xterm.js's `isUserScrolling` flag via `BufferService.scrollLines()`. Simply removing it (trusting xterm.js native mechanism alone) caused bug #3: xterm.js v6's `Viewport._sync()` can lose scroll position when `setScrollDimensions` clamps `scrollTop` internally while `_suppressOnScrollHandler` prevents `_latestYDisp` from updating, so subsequent syncs never correct the clamped position.

**Fix:** Replaced `scrollAwareWrite` with `scrollGuardedWrite` — a targeted guard that only intervenes on **large** viewport jumps (drift > 1 screenful). This catches "jump to top/bottom" bugs while ignoring small drift from normal user scrolling between save and async callback (always < 1 screenful in write-processing time). Also:
1. Removed double-rAF position restore (no longer needed — single callback with drift threshold is sufficient)
2. Removed visibility change handler (`onVisibilityChange`) — was compensating for the old approach's side effects
3. Simplified window resize and ResizeObserver handlers to just `fitAddon.fit()` without save/restore
4. Kept: alt-buffer wheel→arrow conversion, "New output" indicator, `scrollOnUserInput: false`

**Affected files:**
- `apps/web/src/components/ThreadTerminalView.tsx` — ActiveTerminalView scroll handling

---

## 2026-03-24 — Fix badge not showing during background agent execution

**Problem:** When Claude Code spawns background agents and the main turn ends (Stop hook fires), the thread badge shows "Completed" even though subagents are still running. PostToolUse events from subagents were rejected during the 8-second `COMPLETED_GRACE_MS` window, and terminal output couldn't recover the "Working" badge because the recovery path only handled `hookStatus === null`, not `hookStatus === "completed"`.

**Root cause:** The completed grace period (8s) was too conservative — it protected against concurrent Stop/PostToolUse curl races (~100ms) but also blocked legitimate subagent activity signals. Additionally, no output-based recovery existed for the "completed" state.

**Fix:**
1. Added `POST_COMPLETION_STALE_MS` (1.5s) — short stale window sufficient for concurrent curl race protection while allowing subagent PostToolUse through after 1.5s.
2. Added output-based recovery from "completed" state — terminal output arriving after the stale window transitions hookStatus back to "working".
3. Recovery paths don't set `turnConfirmed`, so the idle timer can clear "working" after 90s of silence when all subagents finish.

**Affected files:**
- `apps/web/src/lib/sessionEventState.ts` — new constant, PostToolUse stale window, output recovery from completed
- `apps/web/src/lib/sessionEventState.test.ts` — updated existing grace period tests, added recovery tests

---

## 2026-03-24 — Memory and performance improvements

**Problem:** App consumes excessive memory with multiple terminals open (~6 GB virtual). Deep audit revealed several memory leaks and unbounded caches beyond scrollback sizing.

**Changes:**

1. **Reduce terminal scrollback ceiling (250K → 200K)** — Slight reduction; xterm.js allocates lazily so this is a cap, not an upfront cost.
2. **Reduce terminal cache cap (50 → 30)** — Still generous for normal workflows.
3. **Reduce idle sweep TTL (2h → 1h 30m)** — Faster cleanup of abandoned detached terminals.
4. **Reduce server scrollback ring buffer (250K → 200K)** — Match client ceiling.
5. **Fix ScrollbackRingBuffer not cleared after hibernation** — `hibernateSession()` materialized the buffer but never cleared it, doubling server memory per hibernated session.
6. **Add idle timeout to Whisper Worker** — The speech-to-text Web Worker (75-240 MB ONNX model) was never terminated after use. Now auto-terminates after 5 minutes of inactivity.
7. **Add gcTime to diff queries** — Checkpoint diff (`staleTime: Infinity`) and working tree diff had no `gcTime`, holding potentially large patch strings in TanStack Query cache for the default 5 minutes. Now 30s/60s respectively.
8. **Fix WsTransport stale setTimeout leak** — `send()` while disconnected created a polling interval + a 120s timeout. On success the timeout was never cleared. Now both are cleaned up.

**Affected files:**
- `apps/web/src/lib/claudeTerminalCache.ts` — scrollback ceiling, cache cap, idle TTL
- `apps/server/src/terminal/Layers/ClaudeSessionManager.ts` — server history limit, clear buffer after hibernation
- `apps/web/src/lib/whisperManager.ts` — idle timeout + auto-terminate
- `apps/web/src/lib/providerReactQuery.ts` — gcTime on diff queries
- `apps/web/src/wsTransport.ts` — fix stale setTimeout in send()

---

## 2026-03-24 — Diff panel improvements

**Changes:**
1. **Aggregate stats in header** — Shows total file count, additions, and deletions in the diff panel header bar next to the viewed counter.
2. **Full-file context toggle** — New "expand unchanged" button (unfold icon) enables `expandUnchanged` on all `FileDiff` components, showing hunk separator controls to expand and view the full file with git changes highlighted.
3. **File tree as left sidebar** — When the diff panel is wide enough (≥600px), the file tree moves from above the diff to a left sidebar, giving the diff content more vertical space. Falls back to the top position on narrow panels.
4. **Persisted preferences** — `diffRenderMode` (stacked/split), `showFileTree`, and `expandUnchanged` are now saved to localStorage and survive page refreshes.

**Affected files:**
- `apps/web/src/components/DiffPanel.tsx` — all four changes

---

## 2026-03-24 — Fix commit failing on large staged diffs

**Problem:** Creating a commit fails with "git diff --cached --patch --minimal output exceeded 1000000 bytes and was truncated" when staged changes produce a diff larger than 1MB.

**Root cause:** `collectOutput` in `GitService.ts` throws a hard `GitCommandError` when output exceeds the 1MB default cap. `prepareCommitContext` runs the full diff with no size override, even though the patch is only used for AI commit message generation and truncated to 50K chars downstream.

**Fix:** Added `outputMode: "truncate"` option to the git execution pipeline. In truncate mode, `collectOutput` silently drops chunks beyond the byte limit and appends `[truncated]` instead of throwing. `prepareCommitContext` now uses this mode for the staged patch.

**Affected files:**
- `apps/server/src/git/Services/GitService.ts` — added `outputMode` field to `ExecuteGitInput`
- `apps/server/src/git/Layers/GitService.ts` — `collectOutput` supports truncate mode
- `apps/server/src/git/Layers/GitCore.ts` — added `maxOutputBytes`/`outputMode` to `ExecuteGitOptions`, threaded through `executeGit`/`runGitStdout`, used in `prepareCommitContext`

---

## 2026-03-24 — Fix VS Code IDE dropdown launching Cursor instead

**Problem:** Selecting "VS Code" in the IDE dropdown opens Cursor.

**Root cause:** On macOS, Cursor installs a `code` CLI symlink at `/usr/local/bin/code` pointing to its own app bundle binary. Both `code` and `cursor` commands resolve to the same Cursor binary. The editor launch logic used the `code` command for VS Code, which got hijacked.

**Fix:** On macOS, `resolveEditorLaunch` and `resolveAvailableEditors` now resolve directly to the app-bundle binary path (e.g. `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`) instead of relying on the ambiguous PATH command. Falls back to the short command name when the app bundle isn't found.

**Affected files:**
- `apps/server/src/open.ts` — added `MAC_APP_BINARY` map, updated `resolveEditorLaunch` and `resolveAvailableEditors`
- `apps/server/src/open.test.ts` — updated tests for non-macOS generic path, added macOS bundle resolution test

---

## 2026-03-23 — Fix scroll corruption: alt buffer isUserScrolling + onScroll fighting

**Problem:** User gets kicked to the bottom of an active Claude Code session when scrolled up. After initial fix attempt, scroll became completely broken — couldn't scroll at all (oscillating bouncing), and "New output" badge showed even at the bottom.

**Root cause:** Three compounding issues:

1. **Alt buffer corrupts `BufferService.isUserScrolling`:** Our `onScroll` handler called `scrollToLine(50)` in alt buffer (where `ybase=0`), which went through `BufferService.scrollLines(50)` → `disp+ydisp >= ybase` → `isUserScrolling = false`. On normal buffer restore, `scroll()` forced `ydisp = ybase`.

2. **`scrollOnUserInput` default `true`:** Any keystroke while scrolled up triggered `scrollToBottom()`, corrupting `isUserScrolling`.

3. **`onScroll` handler fought user scrolling:** `terminal.onScroll` fires synchronously during SmoothScrollableElement's wheel processing (target phase), BEFORE our bubble-phase wheel handler could update `scrollLockLine`. Every scroll was detected as "drift" and restored to a stale position, causing oscillation. Stale `scrollLockedRef` also prevented "New output" from clearing at bottom.

**Fix:**
- `scrollOnUserInput: false` in terminal options
- **Removed the aggressive `onScroll` position-restoration handler.** xterm.js's native `isUserScrolling` in `BufferService.scroll()` preserves position. The `scrollAwareWrite` callback provides defense-in-depth. The active restoration was redundant and harmful.
- **Removed `scrollLockedRef` and `scrollLockLine`** — replaced with direct `isViewportAtBottom()` checks per write. With `smoothScrollDuration: 0`, scroll events are synchronous so the timing gap these refs closed no longer exists.
- Alt buffer writes bypass scroll protection entirely
- Simplified `onScroll` handler to only clear "New output" indicator
- Visibility handler uses local save/restore instead of shared `scrollLockLine`

**Affected files:**
- `apps/web/src/lib/claudeTerminalCache.ts` — `scrollOnUserInput: false`
- `apps/web/src/components/ThreadTerminalView.tsx` — rewritten scroll preservation

---

## 2026-03-23 — Fix badge stuck on "Working" when thread needs approval

**Problem:** When Claude Code asks for permission approval or user input, the sidebar badge briefly shows the correct status ("Pending Approval" / "Needs Input") but then reverts to "Working" within ~1 second.

**Root cause:** `handleOutput` in `sessionEventState.ts` had an output-based heuristic that transitioned `pendingApproval → working` when any PTY output arrived ≥1s after the status was set. The intent was to detect when the user approved a prompt (approval → tool executes → output). But Claude Code produces PTY output (cursor redraws, spinner animations, prompt rendering) while still waiting for approval, which falsely triggered the transition.

**Fix:** Removed the output-based `pendingApproval → working` transition entirely. The `PostToolUse` hook already provides the authoritative signal that the user approved — it fires with `hookStatus: "working"` after the tool completes, and the existing protection window at lines 172-176 correctly handles the race with stale PostToolUse events.

**Affected files:**
- `apps/web/src/lib/sessionEventState.ts` — removed output-based pendingApproval→working transition
- `apps/web/src/lib/sessionEventState.test.ts` — updated tests to verify output no longer transitions pendingApproval

---

## 2026-03-23 — Fix duplicate Claude Code UI on thread switching (round 2)

**Problem:** Every time the user switched away from a thread and back, the entire Claude Code startup banner and terminal content was duplicated — stacking 3 banners after 3 switches.

**Root cause:** The Effect Layer for `getScrollback` in `ClaudeSessionManager.ts` dropped the `sinceOffset` parameter — the function signature only captured `threadId` and never forwarded the second argument to the runtime. This meant the server always returned full scrollback instead of a delta. The client correctly sent `sinceOffset` and expected a delta back (with `reset: false`), so it appended the full scrollback to the terminal that already contained the same content.

**Fix:** Forward `sinceOffset` in the Effect Layer: `getScrollback: (threadId, sinceOffset) => Effect.sync(() => runtime.getScrollback(threadId, sinceOffset))`.

**Affected files:** `apps/server/src/terminal/Layers/ClaudeSessionManager.ts`

---

## 2026-03-23 — Use remote tracking ref as worktree base branch

**Problem:** When creating a new worktree-based thread from the "main" branch, the worktree was based on the local `main` ref, which can be many commits behind `origin/main` if the user never checks out and pulls main locally.

**Root cause:** `GitCore.createWorktree` passed the local branch name directly to `git worktree add -b <new> <path> main`, using the local ref as the starting point.

**Fix:** When `newBranch` is specified (creating a new branch from a base), resolve the base to its remote tracking ref (e.g. `origin/main`) if one exists. Falls back to the local ref when no remote is configured or the remote branch doesn't exist.

**Affected files:**
- `apps/server/src/git/Layers/GitCore.ts` — `createWorktree` now checks for remote tracking ref before selecting start point

---

## 2026-03-23 — Harden scroll preservation against timing races and buffer switches

**Problem:** User still gets kicked to the bottom of an active Claude Code session when scrolling up to read history. Output arriving in the same macrotask as the wheel event bypasses scroll preservation.

**Root cause:** Multiple compounding issues: (1) `onScrollLockDetect` deferred its check via `requestAnimationFrame`, creating a timing window where output could arrive before `scrollLockedRef` was set; (2) `scrollAwareWrite` only checked `isViewportAtBottom()` but not the wheel-driven `scrollLockedRef` flag, missing the case where the flag was set but `viewportY` hadn't updated yet; (3) `terminal.onScroll` handler was passive — it tracked `scrollLockLine` but didn't actively restore on unexpected drift; (4) xterm.js v6.0.0 is missing the `syncScrollPosition` fix from PR #5390, causing scroll teleport on alt↔normal buffer switches.

**Fix:**
- Removed `requestAnimationFrame` from `onScrollLockDetect` — by the time the bubble-phase handler fires, SmoothScrollableElement has already processed the wheel synchronously
- `scrollAwareWrite` now checks `scrollLockedRef.current` as secondary guard alongside `isViewportAtBottom()`
- Uses `scrollLockLine` (persisted from wheel handler) as restore target, surviving even if `viewportY` drifted
- `terminal.onScroll` handler now actively restores `scrollLockLine` on any unexpected drift (with re-entrancy guard), covering buffer switches and internal xterm.js events

**Affected files:**
- `apps/web/src/components/ThreadTerminalView.tsx` — `onScrollLockDetect`, `scrollAwareWrite`, `terminal.onScroll` handler

---

## 2026-03-23 — Fix runOnWorktreeCreate action never executing

**Problem:** Custom actions with "Run automatically on worktree creation" enabled never ran when a worktree was created.

**Root cause:** `setupProjectScript()` was defined and tested in `projectScripts.ts` but never imported or called in the worktree creation flow. `ThreadTerminalView.tsx`'s `handleStart` created the worktree and started the Claude session without checking for setup scripts.

**Fix:** After worktree creation in `handleStart`, call `setupProjectScript()` to find the configured setup script and `runProjectScriptInTerminal()` to execute it in the new worktree.

**Affected files:**
- `apps/web/src/components/ThreadTerminalView.tsx` — import and call `setupProjectScript` + `runProjectScriptInTerminal` after worktree creation

---

## 2026-03-23 — Fix terminal scroll jump regression (xterm.js v6 viewport change)

**Problem:** When scrolling through Claude Code session history, new output from Claude would kick the user to the top of the terminal, losing their scroll position. This was a regression of a previously working fix (commit e312b82).


[Showing lines 1-645 of 662 (50.0KB limit). Use offset=646 to continue.]