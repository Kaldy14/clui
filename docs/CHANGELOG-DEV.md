# Development Changelog

Session-by-session log of changes, fixes, and decisions made during development.

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

**Root cause:** xterm.js v6 replaced the native `.xterm-viewport` scroll container with VS Code's `SmoothScrollableElement` (a virtual scrollbar). The `.xterm-viewport` div still exists in the DOM but its `scrollTop` is always 0 and `scrollHeight === clientHeight`. Our scroll preservation code queried `.xterm-viewport` for position — `isViewportAtBottom()` always returned `true`, so `scrollAwareWrite` never entered the preservation branch. The "New output" indicator also never showed.

**Fix:** Replaced all `.xterm-viewport` DOM manipulation with xterm.js public API: `terminal.buffer.active.viewportY` (line-based scroll position), `terminal.buffer.active.baseY` (bottom of scrollback), and `terminal.scrollToLine(line)` for restoration. This is version-agnostic and immune to internal DOM structure changes. Also added defensive `visibilitychange` listener and `terminal.onScroll` tracking to re-assert scroll position when switching apps or clicking back into the terminal.

**Affected files:**
- `apps/web/src/components/ThreadTerminalView.tsx` — `isViewportAtBottom`, `scrollAwareWrite`, `onWindowResize`, `ResizeObserver` handler, `visibilitychange`/`onScroll` scroll defense

---

## 2026-03-23 — Fix thread terminal stealing focus from Claude Code

**Problem:** When a thread had an open thread terminal (persisted state), navigating to it or starting a Claude Code session would focus the thread terminal instead of Claude Code. Focus should default to Claude Code; the thread terminal should only auto-focus when explicitly opened by the user (e.g., Cmd+J toggle).

**Root cause:** `ThreadTerminalDrawer`'s `TerminalViewport` had `autoFocus={true}` hardcoded, causing it to steal focus on every mount — including mounts from persisted state or thread navigation. `focusRequestId` was hardcoded to `0` and never signaled explicit user opens.

**Fix:** Track closed→open transitions in `ThreadTerminalDrawerContainer` via a `focusRequestId` counter that increments only when `terminalOpen` transitions from `false` to `true` on the same thread. Added `key={threadId}` to reset focus state on thread navigation. Changed `autoFocus={true}` to `autoFocus={focusRequestId > 0}` so the thread terminal only auto-focuses when explicitly opened by user action.

**Affected files:**
- `apps/web/src/routes/_chat.$threadId.tsx` — focus tracking logic, key={threadId}
- `apps/web/src/components/ThreadTerminalDrawer.tsx` — conditional autoFocus

---

## 2026-03-23 — Replace sidebar sort key with `lastInteractedAt`

**Problem:** Sidebar thread sorting was unreliable — threads jumped around whenever Claude produced output, completed turns, appended activities, or any hook event fired. The `updatedAt` field used as the sort key was bumped by 11 different event types in the projector, making sort order unpredictable.

**Root cause:** `updatedAt` serves as a general "data modified" timestamp, bumped by every orchestration event (messages, activities, session changes, completions, reverts, meta updates). Using it for sidebar sort meant any background Claude activity reshuffled the list.

**Fix:** Added a dedicated `lastInteractedAt` field to `OrchestrationThread` that is ONLY updated in two places: (1) thread creation, and (2) when a new turn begins in `thread.session-set` (user submitted a prompt). The sidebar sort comparator now uses `lastInteractedAt` instead of `updatedAt`. Also added `lastInteractedAt` to `TerminalManager.TerminalSessionState` (bumped only on user actions: open, write, restart) and switched inactive terminal eviction to use it instead of `updatedAt`.

**Affected files:**
- `packages/contracts/src/orchestration.ts` — added `lastInteractedAt` to `OrchestrationThread`
- `apps/server/src/orchestration/projector.ts` — set on created + new turn
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` — set on created + new turn in persistence
- `apps/server/src/persistence/Migrations/019_LastInteractedAt.ts` — DB migration
- `apps/server/src/persistence/Services/ProjectionThreads.ts` — schema
- `apps/server/src/persistence/Layers/ProjectionThreads.ts` — SQL queries
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` — snapshot assembly
- `apps/server/src/terminal/Services/Manager.ts` — added `lastInteractedAt` to `TerminalSessionState`
- `apps/server/src/terminal/Layers/Manager.ts` — user-only bumps + eviction sort
- `apps/web/src/types.ts` — frontend type
- `apps/web/src/store.ts` — mapping
- `apps/web/src/components/Sidebar.logic.ts` — sort comparator

---

## 2026-03-23 — Fix stuck "Working" badge after quick Esc cancel

**Problem:** When the user sent a message and immediately pressed Esc to cancel before Claude's agent loop started, the "Working" badge in the sidebar stayed stuck permanently.

**Root cause:** `handleTurnStart` (fired by UserPromptSubmit hook) set `hookStatus = "working"` and `turnInProgress = true`. When the user cancelled before the agent loop began, neither the Stop hook nor the "⏎ Interrupted" terminal banner fired, so nothing cleared those flags. The 90-second idle timer re-armed indefinitely because `turnInProgress && terminal === "active"`, and the output recovery heuristic re-set "working" on any terminal output (keystroke echo) because `turnInProgress` was still true.

**Fix:** Added `turnConfirmed` tracking — a flag set only when a real hook (PostToolUse → "working", PermissionRequest → "pendingApproval"/"needsInput") fires, confirming the agent loop actually started. `handleTurnStart` alone does NOT confirm. When the idle timer fires for an unconfirmed turn, it clears `hookStatus`, `turnInProgress`, and sets `completedAt` (grace period) instead of re-arming, preventing the output recovery from re-setting the badge.

**Affected files:** `apps/web/src/lib/sessionEventState.ts`, `apps/web/src/lib/sessionEventState.test.ts`

---

## 2026-03-23 — Fix terminal content duplication when switching back to active thread

**Problem:** Every time the user clicked on a working (active) thread in the sidebar, the entire terminal content was duplicated — the same conversation appeared multiple times in the terminal output.

**Root cause:** `ActiveTerminalView` tracks `entry.lastServerOffset` to request delta-only scrollback on reattach. However, `lastServerOffset` was only set from the initial scrollback fetch response — live output events written to the terminal never updated it. When the user switched away and back, `getScrollback({ sinceOffset })` used the stale initial offset, returning all output that had arrived via live events (already visible in the terminal). This delta was written on top of existing content, causing duplication.

**Fix:** Update `entry.lastServerOffset` as live output events are processed in `writeEvent()`, so that on detach→reattach the scrollback delta fetch only returns truly new content.

**Affected files:** `apps/web/src/components/ThreadTerminalView.tsx`

---

## 2026-03-20 — Fix terminal scroll jump (round 2: race with xterm render pipeline)

**Problem:** Previous scroll-jump fix still allowed jumps. Scrolling up even 1px from the bottom while Claude Code output arrived caused the viewport to jump away.

**Root cause:** xterm.js v5 decouples parsing from rendering. The `write(data, callback)` callback fires after parsing but *before* the render rAF. xterm's render calls `_innerRefresh` which sets `scrollTop = ydisp * charHeight`, overwriting the scroll restoration done in the callback. Same race existed in resize handlers where the sync restore after `fit()` was overwritten by xterm's deferred render.

**Fix:** Schedule `scrollTop` restoration inside a `requestAnimationFrame` from within the write callback and after `fit()` calls. xterm's render rAF is registered first (during write processing / fit), so our rAF executes after xterm's in the same frame — guaranteeing our restoration is the last write to `scrollTop`.

**Affected files:** `apps/web/src/components/ThreadTerminalView.tsx`

---

## 2026-03-20 — Fix speech-to-text: no audio captured, "ultrathink" in UI, silent write failures

**Problem:** Speech-to-text was completely broken — pressing the shortcut showed "ultrathink" in the recording animation, audio was never captured, and transcribed text never reached the terminal.

**Root cause:** Three independent bugs: (1) `AudioContext` created without `resume()` in `useAudioCapture.ts` — browser autoplay policy (Chrome 71+) left it in `"suspended"` state, so `ScriptProcessorNode.onaudioprocess` never fired and zero audio was captured. (2) Default `voicePrefix` in `appSettings.ts` was `"ultrathink"`, which displayed in the recording bar and was prepended to all transcriptions. (3) `claude.write()` call in `useSpeechToText.ts` was fire-and-forget with no `.catch()` — if the write failed, the transcription was silently lost. Additionally, the `WorkerOutMessage` type in `whisperManager.ts` was missing the `id` field on the `ready` variant (mismatching the worker), and the auto-load in `SpeechControl.tsx` had no `.catch()` for worker failures.

**Fix:** Added `await audioCtx.resume()` after AudioContext creation. Changed voicePrefix default to empty string. Added `.catch()` error handling to `claude.write()` matching the codebase pattern. Fixed worker message type mismatch. Added `.catch()` to auto-load.

**Affected files:** `apps/web/src/hooks/useAudioCapture.ts`, `apps/web/src/hooks/useSpeechToText.ts`, `apps/web/src/appSettings.ts`, `apps/web/src/lib/whisperManager.ts`, `apps/web/src/components/SpeechControl.tsx`

---

## 2026-03-20 — Fix "Pending Approval" badge returning after reset

**Problem:** Threads that finished work kept showing a "Pending Approval" badge. Using "Reset status badge" cleared it momentarily, but it returned on the next server sync.

**Root cause:** Two issues combined: (1) Server tracked only one pending approval requestId per thread (`Map<string, string>`). When a user rejected a tool (no `post-tool-use` fired) and Claude proposed another, the old requestId was overwritten and its `approval.requested` activity was never resolved — creating permanently orphaned activities. (2) Client `syncServerReadModel` unconditionally overwrites `activities` from the server (unlike `hookStatus` which preserves client state), so locally-cleared activities were restored on the next sync. `resolveThreadStatusPill` then fell through to activity-based "Pending Approval" even though the real-time hookStatus system said the thread was idle.

**Fix:** Client: Gate activity-based badges (`hasPendingApprovals`, `hasPendingUserInput`) behind `terminalStatus !== "active"` in both `resolveThreadStatusPill` and `threadSortTier`. For active terminals, hookStatus is the authoritative real-time source — null means idle at prompt, not pending approval. Server: Changed `pendingApprovalRequestIdByThread` from `Map<string, string>` to `Map<string, Set<string>>` so multiple pending approvals are tracked. `stop` and `user-prompt-submit` now resolve ALL pending approvals, not just the last one.

**Affected files:** `apps/web/src/components/Sidebar.logic.ts`, `apps/web/src/lib/threadStatus.ts`, `apps/server/src/wsServer.ts`

---

## 2026-03-20 — Move update button to sidebar footer, make it slim

**Problem:** The desktop update button sat in the sidebar header, overflowing and looking ugly. A separate banner below the content area duplicated update info with too much visual weight.

**Root cause:** Two separate update UI elements (header icon button + content-area banner) competed for space, and the banner was too large with multiple sub-elements.

**Fix:** Removed the header rocket icon button entirely. Replaced the old banner with a slim `SidebarMenuButton` row inside `SidebarFooter` (above Settings) that just says "Update available", "Downloading X%", or "Restart to update" depending on state. Dismiss X button retained. Cleaned up unused variables and imports.

**Affected files:** `apps/web/src/components/Sidebar.tsx`

---

## 2026-03-19 — Add "Reset status badge" to thread context menu

**Problem:** Thread status badges (e.g. "Pending Approval", "Working") can get stuck in a stale state when hook events arrive out of order or are missed entirely, with no way for the user to clear them.

**Root cause:** Status badges are driven by two independent sources: `hookStatus` (real-time hook events) and `thread.activities` (server-synced approval/input request activities). Both can get stuck — hookStatus from missed events, activities from stale `approval.requested` without matching `approval.resolved`.

**Fix:** Added a "Reset status badge" option to the thread right-click context menu. It clears the session event state machine's internal tracking via `clearThread()`, and the store's `hookStatus` + `activities` via `resetThreadStatus()`. The global `SessionEventState` instance is exposed via `set/getGlobalSessionEventState` so the Sidebar can access it.

**Affected files:** `apps/web/src/lib/sessionEventState.ts`, `apps/web/src/store.ts`, `apps/web/src/routes/__root.tsx`, `apps/web/src/components/Sidebar.tsx`

---

## 2026-03-19 — Fix terminal scroll jumping when output arrives while scrolled up

**Problem:** When scrolled even slightly away from the bottom of the Claude Code terminal, new output caused the viewport to jump unexpectedly instead of preserving the user's scroll position.

**Root cause:** Three issues in `ActiveTerminalView`:
1. `scrollAwareWrite` relied on `scrollLockedRef` which was only set by wheel events — scrollbar drag, keyboard scroll, and sub-row pixel offsets never triggered scroll lock, so `terminal.write()` was called with no scroll protection.
2. Scroll restoration used synchronous assignment + rAF, which raced with xterm.js's async rendering pipeline (`_innerRefresh` overwrites `scrollTop` after both).
3. Resize handlers (ResizeObserver, window resize) only preserved scroll when scroll lock was active.

**Fix:**
- `scrollAwareWrite` now checks viewport position on every write instead of relying on the scroll lock flag. Uses `terminal.write(data, callback)` so scroll restoration runs after xterm finishes rendering.
- Resize handlers always preserve scroll when user is scrolled up (not gated on `scrollLockedRef`).

**Affected files:** `apps/web/src/components/ThreadTerminalView.tsx`

---

## 2026-03-19 — Fix "Working" badge stuck after cancelling Claude Code

**Problem:** Pressing Escape to cancel work in Claude Code left the thread's sidebar badge stuck on "Working" indefinitely.

**Root cause:** The interrupt detection in `handleOutput` required both `"⏎"` and `"Interrupted"` in the same output chunk (`data.includes("⏎") && data.includes("Interrupted")`). PTY streaming often splits the interrupt banner `"⏎ Interrupted"` across two chunks, so the pattern never matched. The Stop hook also doesn't reliably fire on all cancellation types.

**Fix:** Replaced the dual-`includes` check with a proximity regex (`/⏎[^\n]{0,30}Interrupted/`) and added cross-chunk bridging — the tail of the previous output chunk is joined with the head of the current chunk so the pattern is detected even when split across two PTY writes.

**Affected files:** `apps/web/src/lib/sessionEventState.ts`, `apps/web/src/lib/sessionEventState.test.ts`

---

## 2026-03-19 — Auto-focus thread terminal on Cmd+J open

**Problem:** Opening the thread terminal drawer with Cmd+J did not focus the terminal, requiring an extra click.

**Root cause:** `ThreadTerminalDrawer` hardcoded `autoFocus={false}` on all `TerminalViewport` instances, so the mount effect never called `terminal.focus()`.

**Fix:** Set `autoFocus={true}` for the active terminal viewport (non-split), and `autoFocus={terminalId === resolvedActiveTerminalId}` in split view.

**Affected files:** `apps/web/src/components/ThreadTerminalDrawer.tsx`

---

## 2026-03-19 — Fix DiffPanel inline editor fails in worktree threads

**Problem:** Clicking "Edit file" in the DiffPanel for a thread using a git worktree fails with "File not found", even though the file exists.

**Root cause:** The `EditableFileView` and context menu used `projectCwd` (the base project directory) instead of `activeCwd` (which respects `worktreePath`). Diff file paths come from the worktree, but the file read RPC was sent with the original project cwd — where the file may not exist.

**Fix:** Replaced all `projectCwd` usages with `activeCwd` for the file editor, edit button guard, and context menu guard. Removed the now-unused `projectCwd` variable.

**Affected files:** `apps/web/src/components/DiffPanel.tsx`

---

## 2026-03-19 — Fix flaky CheckpointReactor test timeout

**Problem:** The `captures pre-turn baseline from project workspace root when thread worktree is unset` test in `CheckpointReactor.test.ts` intermittently timed out waiting for a git ref to be created.

**Root cause:** The `waitForGitRefExists` call used the default 2000ms timeout, which was too tight for loaded machines where the async git checkpoint capture triggered by the `thread.turn.start` event could take longer.

**Fix:** Increased the polling timeout from 2000ms to 5000ms for this specific assertion.

**Affected files:** `apps/server/src/orchestration/Layers/CheckpointReactor.test.ts`

---

## 2026-03-19 — DiffPanel: File Header Invisible in Light Mode

**Problem:** The sticky file header bar in the diff panel had no background in light mode, so scrolling content showed through it making the filename and controls unreadable.

**Root cause:** The sticky header only had `dark:bg-[#252a31]` — no light mode background was set, leaving it transparent.

**Fix:** Added `bg-background` to the base classes of the sticky file header so it has a solid background in light mode. Dark mode continues using the custom `#252a31` override.

**Affected files:** `apps/web/src/components/DiffPanel.tsx`

---

## 2026-03-19 — Terminal Scroll Lock: Preserve Position While CC Is Working

**Problem:** When Claude Code is actively working and outputting content, scrolling up to read terminal history was impossible — the viewport kept jumping back to the top/bottom on every new output or layout change.

**Root cause:** `terminal.write()` and `fitAddon.fit()` in `ActiveTerminalView` had no scroll position preservation. New output or container resize (sidebar toggle, diff panel open/close) would reset the viewport position, especially when the terminal switches between normal and alternate screen buffers.

**Fix:** Added a scroll lock mechanism to `ActiveTerminalView`:
- Detects when the user scrolls up via wheel events and sets a `scrollLocked` flag
- Wraps live output writes (`scrollAwareWrite`) to save/restore the viewport's `scrollTop` around `terminal.write()` calls, with a rAF safety net for async rendering
- Preserves scroll position across `fitAddon.fit()` in both the ResizeObserver and window resize handlers
- Auto-clears the lock when the user scrolls back to the bottom
- Shows a floating "↓ New output" button so the user can jump back to the live view

**Affected files:** `apps/web/src/components/ThreadTerminalView.tsx`

---

## 2026-03-19 — Git Quick Action: Default to Commit & Push, PR via Menu

**Problem:** The git quick action button defaulted to "Commit, push & PR" which always created a PR, even when users often just want to commit and push.

**Root cause:** `resolveQuickAction` returned `commit_push_pr` as the stacked action when working tree had changes, bundling PR creation into the primary button.

**Fix:** Changed the quick action to "Commit & Push" (`commit_push`) by default. PR creation remains accessible via the dropdown options menu (Commit / Push / Create PR items). Updated tests to match.

**Affected files:** `apps/web/src/components/GitActionsControl.logic.ts`, `apps/web/src/components/GitActionsControl.logic.test.ts`

---

## 2026-03-19 — Diff Panel Redesign: Inline Editor, File Tree, GitKraken Theme

**Problem:** The diff panel lacked a review workflow, had generic styling, and required switching to an external editor to fix issues found during review.

**Root cause:** The original diff panel was a read-only viewer with no review state tracking, no file tree, and default `pierre-dark` syntax theme.

**Fix:** Major diff panel redesign with multiple features:
- **Viewed workflow**: Per-file checkbox to mark files as reviewed (collapse in place), progress counter, reset button
- **Custom syntax theme**: `clui-dark` shiki theme with VS Code Dark+ token colors (keywords `#559CD6`, strings `#CE9178`, types `#3FC8B0`, brackets `#FFD700`)
- **GitKraken diff backgrounds**: Hardcoded dark mode colors (additions `#315037`, deletions `#392428`, emphasis `#592A2D`)
- **File tree sidebar**: Collapsible hierarchical tree showing folder structure, change type badges (A/M/D/R), viewed status
- **Keyboard navigation**: `j`/`k` to navigate files, `v` to toggle viewed, `e` to edit
- **Word-level diff**: `lineDiffType: "word"` for inline change highlighting
- **Review progress bar**: Thin green bar filling as files are marked viewed
- **Inline editor**: CodeMirror 6 editor (lazy-loaded) for editing files directly in the diff panel with `Cmd+S` save
- **`projects.readFile` RPC**: New end-to-end RPC method for fetching file contents with language inference

**Affected files:** `apps/web/src/components/DiffPanel.tsx`, `apps/web/src/components/DiffFileTree.tsx`, `apps/web/src/components/DiffInlineEditor.tsx`, `apps/web/src/lib/diffThemeClui.ts`, `apps/web/src/lib/diffEditorTheme.ts`, `apps/web/src/lib/diffRendering.ts`, `apps/web/src/components/DiffWorkerPoolProvider.tsx`, `apps/web/src/index.css`, `packages/contracts/src/project.ts`, `packages/contracts/src/ws.ts`, `packages/contracts/src/ipc.ts`, `apps/server/src/wsServer.ts`, `apps/web/src/wsNativeApi.ts`, `apps/web/src/lib/projectReactQuery.ts`

---

## 2026-03-19 — Add `projects.readFile` RPC and TanStack Query hooks

**Problem:** The DiffPanel inline editor needs to read file contents from the server to display original file content for editing, but no RPC method existed for reading workspace files.

**Root cause:** Only `projects.writeFile` existed; no corresponding read method was implemented.

**Fix:** Added `projects.readFile` RPC end-to-end: contract schemas (`ProjectReadFileInput`/`ProjectReadFileResult`), WS method tag, IPC type, server handler with path validation (reuses `resolveWorkspaceWritePath`), 1MB size limit, binary file detection, and language inference from file extension. Added client transport binding and `readFileQueryOptions` TanStack Query hook.

**Affected files:** `packages/contracts/src/project.ts`, `packages/contracts/src/ws.ts`, `packages/contracts/src/ipc.ts`, `apps/server/src/wsServer.ts`, `apps/web/src/wsNativeApi.ts`, `apps/web/src/lib/projectReactQuery.ts`

---

## 2026-03-19 — Fix "Working" badge disappearing during long thinking/subagent operations

**Problem:** The sidebar "Working" badge would disappear after ~90 seconds even though Claude Code was still actively working (e.g., during ultrathink, long thinking, or subagent execution). The thread would show no badge at all despite Claude being mid-turn.

**Root cause:** The `sessionEventState.ts` idle timeout (`WORKING_IDLE_TIMEOUT_MS = 90_000`) unconditionally cleared `hookStatus` to `null` after 90 seconds of no terminal output. During long-running operations that produce no output (thinking, subagent processing), the timeout would fire and remove the badge. The output recovery heuristic could restore it, but only when new output arrived — which could be minutes later.

**Fix:** Modified the idle timeout callback to check `turnInProgress` and `terminalStatus` before clearing. When a turn is still in progress and the terminal is active, the timer re-arms itself instead of clearing the badge. The badge only clears when the turn ends (completion/interrupt/dormant) or the terminal becomes inactive.

**Affected files:** `apps/web/src/lib/sessionEventState.ts`, `apps/web/src/lib/sessionEventState.test.ts`

---

## 2026-03-19 — Fix stale "Pending Approval" badge overriding real-time "Working" status

**Problem:** The sidebar badge would show "Pending Approval" even after the user approved and Claude was actively working. The badge would eventually switch to "Working" but with a noticeable delay.

**Root cause:** Two independent badge systems exist — activity-based (`derivePendingApprovals` from persisted server activities) and hook-based (`hookStatus` from real-time session events). In `resolveThreadStatusPill`, the activity-based check had higher priority than the hook-based check. When the user approved a permission, `hookStatus` transitioned to "working" immediately, but the `approval.resolved` activity could arrive late. During the gap, the stale activity-based "Pending Approval" overrode the real-time "Working" hookStatus.

**Fix:** Reordered badge priority in both `resolveThreadStatusPill` (Sidebar.logic.ts) and `threadStatusPill` (threadStatus.ts) so real-time hook status (`claudeTerminalStatusPill`) is checked before activity-based pending approvals. When `hookStatus` is set (non-null), it's always the most authoritative signal. When `hookStatus` is null (idle at prompt), activity-based checks serve as the persistence fallback for reconnection scenarios.

**Affected files:** `apps/web/src/components/Sidebar.logic.ts`, `apps/web/src/lib/threadStatus.ts`

---

## 2026-03-19 — Fix 5 additional badge state machine edge cases

**Problems identified via comprehensive verification of the badge state machine:**

1. **Stale hookStatus after reconnect**: On WebSocket reconnect, `sessionState.clearAll()` wiped the state machine internals (timers, turnInProgress, grace periods) but the Zustand store preserved stale `hookStatus` values, causing permanently wrong badges with no recovery path.

2. **Dormant terminal sort pollution**: `handleHookStatus` only guarded against dormant/new terminals for "working" hooks, not for "pendingApproval", "needsInput", or "error". Stale hooks for dormant terminals would set `hookStatus` and incorrectly sort the thread to tier 0 (needs action).

3. **False positive interrupt detection**: `data.includes("Interrupted")` matched any terminal output containing the word "Interrupted", including normal prose from Claude's responses. This could falsely clear the "Working" badge mid-turn.

4. **Inconsistent badge labels**: Activity-based user input showed "Awaiting Input" while hook-based showed "Needs Input" for the same state, with different colors (indigo vs amber).

5. **Missed unseen completion for background threads**: `latestTurn.completedAt` was only updated via full snapshot sync (deferred for background threads), so `hasUnseenCompletion` never triggered — the completion badge would vanish after `hookStatus` cleared with no fallback.

**Fixes:**

1. Clear all `hookStatus` values in the store immediately after `sessionState.clearAll()` on reconnect.
2. Moved the dormant/new terminal guard to apply to all non-completed hooks (before: only "working").
3. Narrowed interrupt detection to require the `⏎` character (Claude Code's specific interrupt output format).
4. Unified label to "Needs Input" with amber color in both systems.
5. Eagerly patch `latestTurn.completedAt` for background threads when the "completed" hook fires.

**Affected files:** `apps/web/src/routes/__root.tsx`, `apps/web/src/lib/sessionEventState.ts`, `apps/web/src/lib/sessionEventState.test.ts`, `apps/web/src/components/Sidebar.logic.ts`, `apps/web/src/components/Sidebar.logic.test.ts`

---

## 2026-03-19 — Fix invisible text and dark highlighting in light mode terminal

**Problem:** When light mode is selected in the app, xterm.js terminal text becomes invisible on ANSI-colored backgrounds (e.g. diff highlighting from Claude Code). Green/red backgrounds for added/removed lines are too dark, and dark foreground text disappears against them. Selection highlighting is also hard to see.

**Root cause:** The light theme ANSI colors in `terminalTheme.ts` were very dark (e.g. green `#4d6b3a`, red `#8b3a3a`) — appropriate as foreground on white but unreadable when CLI tools use them as background colors. Claude Code's diff output uses ANSI background colors, so dark text on dark backgrounds = invisible. Selection background used a subtle green tint that was hard to distinguish.

**Fix:** Brightened all ANSI colors in both light themes (muted-earth, classic-pastel). Normal colors moved from ~30% to ~45% lightness, bright variants from ~35% to ~55% lightness. Changed selection background from green-tinted to blue-tinted with higher opacity for better visibility. Added a hint in the Appearance settings section telling users to run `/theme` inside Claude Code to match the app's resolved theme.

**Affected files:** `apps/web/src/lib/terminalTheme.ts`, `apps/web/src/routes/_chat.settings.tsx`

---

## 2026-03-19 — Add close button and Escape key to DiffPanel

**Problem:** The diff panel could only be closed by clicking the diff toggle button in the toolbar, which was unintuitive. No close affordance existed within the panel itself.

**Fix:** Added an X close button to the DiffPanel header (after the stacked/split toggle group) and an Escape keydown handler on the panel root. Pressing Escape while any element within the diff panel is focused will close it. The root div uses `tabIndex={-1}` so clicking anywhere in the panel makes it focusable for keyboard events.

**Affected files:** `apps/web/src/components/DiffPanel.tsx`

---

## 2026-03-19 — Fix thread terminal drawer stealing focus from Claude Code terminal

**Problem:** When switching to a thread that has the thread terminal drawer open, focus lands in the drawer terminal instead of the Claude Code terminal. Users expect focus to always go to the Claude Code terminal on thread switch.

**Root cause:** `ThreadTerminalDrawer` rendered `TerminalViewport` with `autoFocus={true}` hardcoded (both single and split view). On mount, both `ActiveTerminalView` (Claude Code) and `TerminalViewport` (drawer) called `terminal.focus()` via `requestAnimationFrame`. The drawer's focus call fired last, winning the race.

**Fix:** Changed `autoFocus` to `false` on the drawer's `TerminalViewport` in both the single-terminal and split-view paths. The drawer terminal no longer auto-focuses on mount; users click into it when needed. The Claude Code terminal always wins focus on thread switch.

**Affected files:** `apps/web/src/components/ThreadTerminalDrawer.tsx`

---

## 2026-03-19 — Fix "Pending Approval" badge not showing in sidebar

**Problem:** The "Pending Approval" badge in the sidebar would intermittently not appear for background threads until the user clicked on the thread. Sometimes it showed, sometimes not.

**Root cause:** Two issues: (1) The activity-based badge path (`derivePendingApprovals(thread.activities)`) was dead code — no server code ever dispatched `thread.activity.append` with `approval.requested` kind. The only working path was the hookStatus-based path (`claudeTerminalStatusPill`), which is ephemeral client-side state lost on page refresh/reconnection. (2) For background threads, domain events are deferred — even if activities were dispatched, the full snapshot sync wouldn't run until the user navigated to that thread.

**Fix:** Two-part fix:
1. **Server (wsServer.ts):** Dispatch `thread.activity.append` commands with `approval.requested` / `approval.resolved` activities when permission-request, post-tool-use, stop, and user-prompt-submit hooks fire. Activities are now persistent in the server's read model and included in snapshots, surviving reconnection.
2. **Client (__root.tsx):** Eagerly patch thread activities in the store when `thread.activity-appended` domain events arrive for background threads (same pattern as the existing session status eager patching), so the sidebar badge appears immediately without waiting for a full snapshot sync.

**Affected files:** `apps/server/src/wsServer.ts`, `apps/web/src/routes/__root.tsx`

---

## 2026-03-19 — Fix sidebar thread sorting with badge-driven tiered sort

**Problem:** Thread ordering in the sidebar was unpredictable. Clicking an old dormant thread made it jump to the top. Working threads would drop below idle threads. Threads that just finished were hidden below actively working ones. The sort was purely `updatedAt`-based — no awareness of thread state, and `session-set` events bumped `updatedAt` on every lifecycle change (terminal resume, reconnect).

**Root cause:** Two issues: (1) The in-memory projector and ProjectionPipeline both bumped `thread.updatedAt` unconditionally for every `thread.session-set` event, including terminal resume/reconnect — not just new user turns. Clicking an old thread resumes its terminal → `session-set` → `updatedAt` bumped → thread jumps to top. (2) Streaming `message-sent` events continuously bumped the working thread's `updatedAt`, keeping it above threads that had completed and needed user attention.

**Fix:** Two-part fix:
1. **Server (projector.ts, ProjectionPipeline.ts):** Only bump `updatedAt` for `session-set` when a genuinely new turn begins (`session.status === "running"` AND `activeTurnId` differs from previous). Session lifecycle events no longer affect sort order.
2. **Client (Sidebar.logic.ts, Sidebar.tsx):** Replaced flat `updatedAt` sort with a badge-driven tiered comparator (`createThreadSortComparator`). Tiers mirror badge priority so what the user sees matches where the thread sits:
   - Tier 0: Needs Action (Pending Approval, Needs Input, Error)
   - Tier 1: Unseen Completion (turn finished, user hasn't visited)
   - Tier 2: Active Work (Working/Running)
   - Tier 3: Idle (sorted by `updatedAt` within tier)
   Key property: merely viewing/clicking a thread never changes its tier — only real activity can promote it. Follows the Telegram/Linear model where status drives position.

**Affected files:** `apps/server/src/orchestration/projector.ts`, `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`, `apps/web/src/components/Sidebar.logic.ts`, `apps/web/src/components/Sidebar.logic.test.ts`, `apps/web/src/components/Sidebar.tsx`

---

## 2026-03-19 — Fix thread title regeneration on compact/resume

**Problem:** After compacting context or resuming a thread, the thread title would be regenerated, overwriting the existing title.

**Root cause:** `autoTitledThreads` is an in-memory `Set` in `wsServer.ts` that tracks which threads have been auto-titled. On server restart, this set is empty, so any prompt submit (including those triggered by compact/resume) would re-trigger title generation. Additionally, the in-memory projector lacked the manual-title guard that the SQL projection pipeline had.

**Fix:**
- Seed `autoTitledThreads` from the projection snapshot on startup — any thread with a title other than "New thread" is marked as already titled.
- Added manual-title guard to the in-memory projector (`projector.ts`) to skip auto-title updates when `titleSource` is "manual", matching the existing guard in `ProjectionPipeline.ts`.

**Affected files:**
- `apps/server/src/wsServer.ts`
- `apps/server/src/orchestration/projector.ts`

---

## 2026-03-19 — Add "Viewed" file review workflow and GitKraken diff colors

**Problem:** The diff panel had no way to track review progress across files, and dark mode diff colors used generic `color-mix()` values that lacked contrast.

**Root cause:** Missing review state management and theme-specific CSS for the shadow DOM `FileDiff` component.

**Fix:**
- Added `viewedFiles` state with toggle/reset callbacks; viewed files collapse (conditional rendering) and sort to the bottom of the list.
- Added per-file review header with checkbox, file path (basename emphasized), and +/- stats computed from hunks.
- Added review progress counter ("3/8 viewed") and reset button in the panel header.
- Split `DIFF_PANEL_UNSAFE_CSS` into `DIFF_CSS_LIGHT` (existing color-mix approach) and `DIFF_CSS_DARK` (hardcoded GitKraken colors), selected by `resolvedTheme`.
- Added `.dark` scoped overrides in `index.css` for diff viewport and file card backgrounds.

**Affected files:**
- `apps/web/src/components/DiffPanel.tsx`
- `apps/web/src/index.css`

---

## 2026-03-19 — Change git toolbar quick action from "Commit & Push" to "Commit, Push & PR"

**Problem:** The git quick action button in the toolbar only performed "Commit & Push" (`commit_push`) when there were working tree changes, requiring an extra step to create a PR.

**Root cause:** `resolveQuickAction` returned `commit_push` as the default action for dirty working trees.

**Fix:** Changed the quick action to `commit_push_pr` with label "Commit, push & PR" so the full commit-push-PR flow runs in one click. Updated the icon mapping to show the GitHub PR icon for this action.

**Affected files:**
- `apps/web/src/components/GitActionsControl.logic.ts`
- `apps/web/src/components/GitActionsControl.tsx`
- `apps/web/src/components/GitActionsControl.logic.test.ts`

---

## 2026-03-18 — Add window drag region to active thread toolbar

**Problem:** In Electron, the window could only be dragged from the sidebar header when a thread was active. The main toolbar at the top had no drag region, forcing users to reach for the sidebar to reposition the window.

**Root cause:** `TerminalToolbar` did not apply the `drag-region` CSS class, unlike other top-bar areas (`_chat.index.tsx`, `Sidebar.tsx`, `DiffPanel.tsx`).

**Fix:** Conditionally add the `drag-region` class to the toolbar container when running in Electron. All interactive elements (buttons, inputs, toggles) remain clickable via existing CSS `no-drag` rules.

**Affected files:**
- `apps/web/src/components/TerminalToolbar.tsx`

---

## 2026-03-18 — Default git toolbar quick action to Commit & Push

**Problem:** The git toolbar button defaulted to "Commit, push & PR" on non-default branches without an open PR, and "Push & create PR" when ahead. Users wanted "Commit & Push" / "Push" as the default instead.

**Root cause:** `resolveQuickAction` in `GitActionsControl.logic.ts` conditionally chose `commit_push_pr` as the quick action when no open PR existed and the branch wasn't the default.

**Fix:** Simplified `resolveQuickAction` to always return `commit_push` (Commit & Push / Push) as the default action, removing the automatic PR creation from the quick action. PR creation remains available via the dropdown menu.

**Affected files:**
- `apps/web/src/components/GitActionsControl.logic.ts`
- `apps/web/src/components/GitActionsControl.logic.test.ts`

---

## 2026-03-18 — Fix speech-to-text: replace MediaRecorder with raw PCM capture

**Problem:** Speech-to-text produced no transcription output. Speaking into the microphone resulted in silence — nothing was ever written to the terminal.

**Root cause:** The audio capture pipeline used `MediaRecorder` → webm/opus blob → `AudioContext.decodeAudioData()` → Float32Array. This roundtrip is unreliable:
1. `MediaRecorder` encodes audio into webm/opus codec format.
2. `new AudioContext({ sampleRate: 16000 }).decodeAudioData()` does not reliably resample across browsers and Electron — the spec says the context "may" honor the requested sample rate.
3. The `getUserMedia({ sampleRate: 16000 })` constraint is ignored by most browsers, so audio arrives at 44.1/48kHz but is treated as 16kHz, producing garbage input for Whisper.

**Fix:** Rewrote `useAudioCapture` to capture raw PCM directly via `ScriptProcessorNode`, bypassing `MediaRecorder` entirely:
- `getUserMedia` requests mono audio at the system's native sample rate (no fake 16kHz constraint).
- `ScriptProcessorNode` copies raw Float32Array PCM chunks on each audio process event.
- On stop, chunks are concatenated and explicitly resampled from the native rate (44.1k/48k) to 16kHz using linear interpolation.
- No encoding/decoding roundtrip — the Float32Array goes straight to the Whisper worker.

**Affected files:**
- `apps/web/src/hooks/useAudioCapture.ts`: Complete rewrite — raw PCM capture with explicit resampling.

---

## 2026-03-18 — Fix speech-to-text: microphone permissions, status deadlock, error display

**Problem:** Voice input did nothing when clicked. Three compounding issues:
1. Electron never granted microphone permission — no `setPermissionRequestHandler` on the session, so `getUserMedia()` was silently denied. On macOS, `systemPreferences.askForMediaAccess("microphone")` was never called, so the OS permission dialog never appeared.
2. When the Whisper model wasn't ready, `startRecording` set status to `"notInstalled"` but the function only proceeded on `"idle"`, creating a permanent deadlock — the mic button became unresponsive until page refresh.
3. Errors (permission denied, model not loaded) were captured in the speech store but never displayed in the UI.

**Root cause:** Missing Electron permission plumbing, a status state machine bug, and missing error UI.

**Fix:**
- Added `setPermissionRequestHandler` in Electron's `createWindow()` to grant `"media"` permission, with macOS-specific `askForMediaAccess("microphone")` call.
- Fixed `startRecording` and `toggle` in `useSpeechToText` to also proceed from `"notInstalled"` status, and clear errors on retry.
- Added descriptive error messages for permission denial and model-not-loaded states.
- `SpeechControl` now reads the error store, shows errors in the mic tooltip, and tints the mic icon red on error.
- Falls through to download popover when status is `"notInstalled"`.

**Affected files:**
- `apps/desktop/src/main.ts`: Added `systemPreferences` import, `setPermissionRequestHandler` with macOS `askForMediaAccess`.
- `apps/web/src/hooks/useSpeechToText.ts`: Fixed status deadlock, added permission error detection, clear errors on retry.
- `apps/web/src/components/SpeechControl.tsx`: Added error display in tooltip, red tint on error, handle `"notInstalled"` status.

---

## 2026-03-18 — Fix YOLO mode lost on dormant session resume

**Problem:** When a session running in "Bypass permissions" (YOLO) mode goes dormant and is later resumed (auto-resume or manual Resume button), the `dangerouslySkipPermissions` flag was not passed to the `claude.start()` call. The session would resume in safe/default permission mode despite the toggle still being on in the UI.

**Root cause:** `DormantTerminalView.handleResume` in `ThreadTerminalView.tsx` did not read `yoloMode` from `terminalStateStore`. The toolbar's resume path (`TerminalToolbar.handleResume`) correctly passed the flag, but the dormant view's resume path was missing it entirely.

**Fix:** Added `yoloMode` selector from `useTerminalStateStore` in `DormantTerminalView` and forwarded `dangerouslySkipPermissions` in the resume `claude.start()` call, matching the toolbar's behavior.

**Affected files:** `apps/web/src/components/ThreadTerminalView.tsx`

---

## 2026-03-18 — Add YOLO mode toggle to toolbar (mid-session permission bypass)

**Problem:** YOLO mode (auto-accept all tool calls) could only be set at session start via the checkbox on the launch screen. There was no way to toggle it on a running session without manually restarting.

**Fix:** Added a YOLO mode toggle button to `TerminalToolbar` with a confirmation popover explaining the behavior. When toggled, the session is restarted with `--resume` + `--dangerously-skip-permissions`, preserving conversation context while changing the permission mode. The YOLO state is persisted per-thread in `terminalStateStore` so it survives navigation and is respected by Resume/New Session buttons. The start screen checkbox now reads from/writes to the same store, keeping both UIs in sync.

**Affected files:** `apps/web/src/terminalStateStore.ts`, `apps/web/src/components/TerminalToolbar.tsx`, `apps/web/src/components/ThreadTerminalView.tsx`

---

## 2026-03-18 — Fix sidebar thread sorting: clicking old threads no longer jumps to top

**Problem:** Thread ordering in the sidebar was unpredictable. Clicking an old dormant thread made it jump to the top (even without sending any input). Working threads would drop below idle threads. The sort was purely `updatedAt`-based, and `session-set` events bumped `updatedAt` on every session lifecycle change (terminal resume, reconnect), not just on meaningful user activity.

**Root cause:** The in-memory projector and ProjectionPipeline both bumped `thread.updatedAt` unconditionally for every `thread.session-set` event. This includes terminal resume/reconnect (status → "ready"), not just new user turns (status → "running"). Clicking an old thread resumes its terminal → `session-set` fires → `updatedAt` bumped → thread jumps to top. Similarly, other threads getting spurious `session-set` bumps would push actively working threads down.

**Fix:** Changed both the in-memory projector (`projector.ts`) and the SQLite projection pipeline (`ProjectionPipeline.ts`) to only bump `updatedAt` for `session-set` when a genuinely new turn begins: `session.status === "running"` AND `activeTurnId` differs from the previous turn. Session lifecycle events (resume, reconnect, idle transitions) no longer affect sort order. Also extracted a shared `compareThreadsForSidebar` comparator in `Sidebar.logic.ts` for the two sort call-sites. Follows the standard messaging-app pattern (Slack, WhatsApp, iMessage, Telegram): only new message/turn activity affects list position; viewing never reorders.

**Affected files:** `apps/server/src/orchestration/projector.ts`, `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`, `apps/web/src/components/Sidebar.logic.ts`, `apps/web/src/components/Sidebar.tsx`

---

## 2026-03-18 — Fix Whisper speech-to-text: key-repeat auto-stop, hallucinations, slow transcription

**Problem:** Holding Cmd+Shift+V auto-stops recording immediately, producing phantom text like "ultrathink you". Transcription with whisper-small is extremely slow (30-60s+ for short clips). Long audio recordings may hang or never complete.

**Root cause:**
1. The `keydown` handler in `_chat.tsx` didn't filter `event.repeat`, so holding the shortcut rapidly toggled start→stop→start→stop.
2. Sub-second recordings cause Whisper to hallucinate common phrases ("you", "Thank you", etc.) on near-silence, which combined with the voice prefix to produce "ultrathink you".
3. The Whisper worker used default WASM fp32 inference with no quantization — the slowest possible path.
4. No chunked processing for long audio, causing the model to choke on recordings >30s.

**Fix:**
- `_chat.tsx`: Added `event.repeat` guard to prevent key-repeat from toggling speech.
- `useSpeechToText.ts`: Added minimum audio duration guard (0.7s / 11,200 samples at 16kHz) — rejects too-short recordings before transcription. Added hallucination phrase filter (Set of known Whisper phantom outputs).
- `whisperWorker.ts`: Added WebGPU detection with fp32 fallback, q8 quantization for WASM (massive speedup). Added `chunk_length_s: 30` and `stride_length_s: 5` for chunked processing of long recordings.

**Affected files:** `apps/web/src/routes/_chat.tsx`, `apps/web/src/hooks/useSpeechToText.ts`, `apps/web/src/workers/whisperWorker.ts`

---

## 2026-03-18 — Filter terminal query responses leaking as visible text

**Problem:** Garbage escape sequences (`^[]11;rgb:0c0c/0c0c/0c0c^[\^[[16;1R`) appear in terminal threads and keep reappearing after deletion.

**Root cause:** Claude Code CLI queries the terminal for background color (OSC 11) and cursor position (DSR/CPR). xterm.js correctly generates response sequences, but the `onData` handler forwards them back to the PTY as raw input. The shell then echoes these responses as visible text.

**Fix:** Added `stripTerminalResponses()` utility that filters out OSC responses (`\x1b]...\x1b\\` or `\x1b]...\x07`) and CPR responses (`\x1b[row;colR`) from xterm.js `onData` before forwarding to the server. Applied to all three terminal input handlers.

**Affected files:**
- `apps/web/src/lib/terminalInputFilter.ts` (new): Regex-based filter for terminal query responses.
- `apps/web/src/lib/terminalInputFilter.test.ts` (new): 8 test cases covering OSC 10/11, CPR, mixed input.
- `apps/web/src/components/ThreadTerminalView.tsx`: Filter `onData` before forwarding to PTY.
- `apps/web/src/components/ProjectTerminalDrawer.tsx`: Same filter applied.
- `apps/web/src/components/ThreadTerminalDrawer.tsx`: Same filter applied.

---

## 2026-03-18 — Detect API errors (529/429/5xx) and clear stuck "Working" badge

**Problem:** When Claude Code hits an API error (e.g. 529 overloaded, 429 rate limit), the sidebar badge stays stuck on "Working" because the CLI doesn't fire a `/hooks/stop` callback on API errors. The only recovery was the 90-second idle timeout.

**Root cause:** The hook-based status system relies on Claude Code firing stop hooks to transition out of "working" state. API errors are printed to terminal output but don't trigger any hook, leaving `hookStatus` stuck.

**Fix:** Added regex-based detection of `API Error: 429|5xx` patterns in terminal output (alongside existing `Interrupted` detection). When matched while `hookStatus` is `"working"`, immediately transitions to `"error"` status, clears `turnInProgress`, and stops the idle timer.

**Affected files:**
- `apps/web/src/lib/sessionEventState.ts`: Added `API_ERROR_RE` regex and error detection in `handleOutput`.
- `apps/web/src/lib/sessionEventState.test.ts`: Added tests for 529, 429, and non-working-state scenarios.

---

## 2026-03-18 — Fix duplicate terminal content when switching back to active thread

**Problem:** When switching away from an active Claude Code thread and switching back, the terminal content (banner, prompt, output) appeared duplicated — the same lines rendered twice.

**Root cause:** The scrollback delta from `getScrollback(sinceOffset)` and live `output` events buffered during the async RPC overlap in content. Both are written to xterm.js with no deduplication, causing the visible duplication.

**Fix:** Added a monotonic byte `offset` field to `ClaudeOutputEvent`. The server includes the scrollback buffer offset after each chunk is appended. On the client, after flushing the scrollback delta (which updates `lastServerOffset`), buffered output events with `offset <= lastServerOffset` are skipped since the delta already covered them.

**Affected files:**
- `packages/contracts/src/claude-terminal.ts`: Added `offset: Schema.Number` to `ClaudeOutputEvent`.
- `apps/server/src/terminal/Layers/ClaudeSessionManager.ts`: Include `entry.scrollbackBuffer.offset` in emitted output events.
- `apps/web/src/components/ThreadTerminalView.tsx`: Skip buffered output events already covered by the scrollback delta.

---

## 2026-03-18 — Persist Whisper model across releases

**Problem:** Every app reload/release required re-downloading the Whisper speech model, even though the model files were still present in the browser's Cache API from a previous download.

**Root cause:** `speechStore.modelDownloaded` starts as `false` on every app load (ephemeral Zustand state, no persistence). The UI always showed the download prompt regardless of whether the model was already cached.

**Fix:** Added `isModelCached()` to `whisperManager` that probes the browser's Cache API for existing HuggingFace Transformers model files. `SpeechControl` now checks the cache on mount and silently auto-loads the model if found (instant from cache, no network).

**Affected files:**
- `apps/web/src/lib/whisperManager.ts`: Added `isModelCached()` that checks the `transformers-cache` Cache API store.
- `apps/web/src/components/SpeechControl.tsx`: Added `useEffect` on mount to probe cache and auto-load.

---

## 2026-03-18 — Fix false "Working" badge on new threads during typing

**Problem:** Creating a new thread and typing the first prompt showed a "Working" badge even though Claude Code hadn't started processing anything. The badge appeared after ~8 seconds of the terminal being active.

**Root cause:** The output recovery heuristic in `sessionEventState.ts` set `hookStatus = "working"` whenever ANY terminal output arrived on an active terminal with null hookStatus — including PTY keystroke echo, TUI redraws, and cursor movement. After the 8-second startup grace expired, every keystroke the user typed triggered the false badge. cmux has the [same issue](https://github.com/manaflow-ai/cmux/issues/1238).

**Fix:** Added a `turnInProgress` flag per thread that gates the output recovery heuristic:
- Set `true` when a real hook fires (`UserPromptSubmit` → "working", `PostToolUse` → "working", `PermissionRequest` → "needsInput"/"pendingApproval")
- Set `false` when the turn ends (`Stop` → "completed", terminal exits/hibernates, "Interrupted" detected)
- Output recovery ONLY fires when `turnInProgress === true`

This means: new thread typing (no hooks yet) → `turnInProgress = false` → output recovery blocked → no false badge. Long tool execution where idle timer cleared hookStatus → `turnInProgress = true` → output recovery works correctly.

**Affected files:** `apps/web/src/lib/sessionEventState.ts`, `apps/web/src/lib/sessionEventState.test.ts` (8 new tests)

---

## 2026-03-18 — Extract session event state from EventRouter into testable module

**Problem:** The EventRouter component in `__root.tsx` had 4 Maps and complex timer/grace period logic inside a `useEffect` closure, making it untestable. Flagged as P2 tech debt.

**Root cause:** All session event state (completedAt, workingIdleTimers, workingIdleLastReset, terminalStartedAt) and their associated logic were tightly coupled to the React component lifecycle.

**Fix:**
- Extracted Maps and timer/grace logic into `apps/web/src/lib/sessionEventState.ts` as a standalone `createSessionEventState()` factory with injectable deps (including `now()` for testing).
- Updated `__root.tsx` to create and use the extracted module, keeping notification dispatch and navigation in the component.
- Added 16 unit tests in `sessionEventState.test.ts` covering startup grace, completion grace, idle timers, interrupt detection, and cleanup.

**Affected files:** `apps/web/src/lib/sessionEventState.ts` (new), `apps/web/src/lib/sessionEventState.test.ts` (new), `apps/web/src/routes/__root.tsx`

---

## 2026-03-18 — Fix double Claude Code banner on session resume

**Problem:** When clicking on a finished/dormant thread and resuming, or switching away from an active thread and back, the Claude Code startup banner (`▐▛███▜▌ Claude Code v2.1.78`) appeared twice — old session content stacked on top of new content.

**Root cause (two bugs):**
1. **Server:** `ScrollbackRingBuffer` was never cleared when starting a new session on an existing thread entry. Old output persisted and accumulated with new session output.
2. **Client:** When the server's ring buffer trimmed old lines and couldn't provide a delta, it fell through to full materialization — but the response was indistinguishable from a delta. The client appended full content on top of existing cached terminal content instead of resetting.

**Fix:**
- `ScrollbackRingBuffer.clear()` now also resets `_totalBytes` and `_droppedBytes` to zero, creating a clean epoch boundary.
- `materializeSince()` returns `null` (force full reset) when `sinceOffset > _totalBytes`, detecting stale offsets from a previous session epoch.
- `ClaudeSessionManager.startSession()` clears the scrollback buffer when reusing an existing session entry.
- Added `reset` flag to `getScrollback` response so the client knows when it received full content instead of a delta (covers both session restart and ring buffer trim cases).
- `ActiveTerminalView.flushIfReady()` uses the `reset` flag to clear the terminal (`\u001bc`) before writing, preventing stale content from persisting.

**Affected files:** `packages/contracts/src/ipc.ts`, `apps/server/src/terminal/Services/ClaudeSession.ts`, `apps/server/src/terminal/Layers/ClaudeSessionManager.ts`, `apps/server/src/wsServer.ts`, `apps/web/src/components/ThreadTerminalView.tsx`

---

## 2026-03-18 — Fix false "Working" badge on finished/dormant threads

**Problem:** Clicking a finished thread immediately showed a "Working" badge even though nothing was actively running. Additionally, threads that completed work sometimes stayed stuck on "Working" indefinitely.

**Root cause (two bugs):**
1. `DormantTerminalView` auto-resumed ALL dormant threads unconditionally — including threads where Claude finished its work and the CLI exited. The resumed CLI outputted startup text, and the output recovery heuristic (`__root.tsx`) interpreted it as "working" (since `terminalStatus === "active"` and `hookStatus === null`).
2. After the "completed" hook fired and hookStatus was cleared to null, post-completion CLI output (prompt rendering) arriving after the 2-second `COMPLETED_GRACE_MS` window would re-trigger the output recovery heuristic, setting hookStatus back to "working" with no way to clear it except the 90-second idle timer.

**Fix:**
- Added `dormantReason` field to `Thread` ("hibernated" | "exited" | null) to distinguish LRU-evicted threads from CLI-exited threads. Only auto-resume hibernated threads.
- Added 8-second startup grace period (`terminalStartedAt` map) to suppress output→"working" inference during CLI startup.
- Increased `COMPLETED_GRACE_MS` from 2s to 8s to cover post-completion CLI output.
- Stopped deleting `completedAt` entry in the output recovery path — keeps the grace window alive until a real "working" hook (new turn) clears it.
- Real hook events (`UserPromptSubmit`, `PostToolUse`) clear both `terminalStartedAt` and `completedAt`, re-enabling output recovery for subsequent turns.

**Affected files:** `apps/web/src/types.ts`, `apps/web/src/store.ts`, `apps/web/src/routes/__root.tsx`, `apps/web/src/components/ThreadTerminalView.tsx`, `apps/web/src/store.test.ts`, `apps/web/src/worktreeCleanup.test.ts`

---

## 2026-03-18 — Fix voice input: transcription, push-to-talk UX, voice prefix

**Problem:** Voice input recorded audio but transcribed text never reached the terminal. UX was a confusing toggle; no way to auto-prepend a prompt prefix like "ultrathink".

**Root cause:** The whisper web worker dropped the `id` field from incoming messages, so the manager could never match transcription results to pending promises — they silently resolved nothing. The keyboard shortcut handler also just set store status without actually starting audio capture.

**Fix:**
- `apps/web/src/workers/whisperWorker.ts`: Pass `id` through in all `IncomingMessage`/`OutgoingMessage` types and every `postMessage` call.
- `apps/web/src/hooks/useSpeechToText.ts`: Exposed separate `startRecording`/`stopRecording` (not just `toggle`). Added empty-transcription guard. Prepends configurable `voicePrefix` and appends `\n` to auto-submit. Listens for `clui:speech-toggle` custom event for keyboard shortcut support.
- `apps/web/src/components/SpeechControl.tsx`: Replaced toggle UX with explicit start/stop buttons. Recording state shows a stop icon. Idle tooltip shows the active voice prefix. Active recording shows the prefix tag.
- `apps/web/src/appSettings.ts`: Added `voicePrefix` setting (default: `"ultrathink"`).
- `apps/web/src/routes/_chat.settings.tsx`: Added voice prefix input field in Speech-to-Text settings section.
- `apps/web/src/routes/_chat.tsx`: Keybinding handler dispatches `clui:speech-toggle` custom event instead of directly manipulating store state.

**Affected files:** `apps/web/src/workers/whisperWorker.ts`, `apps/web/src/hooks/useSpeechToText.ts`, `apps/web/src/components/SpeechControl.tsx`, `apps/web/src/appSettings.ts`, `apps/web/src/routes/_chat.settings.tsx`, `apps/web/src/routes/_chat.tsx`, `docs/CHANGELOG-DEV.md`

---

## 2026-03-17 — Claude Code CLI check and settings cleanup

**Problem:** Settings page contained dead t3code leftovers (Codex App Server binary/home path, assistant streaming toggle). New users had no way to know if Claude Code CLI was installed.

**Root cause:** Settings were carried over from the t3code fork but never wired to any runtime code. The `providers` array in server config was always empty.

**Fix:**
- `apps/web/src/routes/_chat.settings.tsx`: Added "Claude Code CLI" section at top of settings with link to https://claude.com/product/claude-code for new users. Removed dead "Codex App Server" and "Responses" sections.
- `apps/web/src/appSettings.ts`: Removed dead schema fields `codexBinaryPath`, `codexHomePath`, `enableAssistantStreaming`.

**Affected files:** `apps/web/src/routes/_chat.settings.tsx`, `apps/web/src/appSettings.ts`, `docs/CHANGELOG-DEV.md`

---

## 2026-03-17 — Speech-to-text (Whisper) voice input feature

**Problem:** No voice input capability in the terminal toolbar; users had to type all input manually.

**Root cause:** N/A — new feature.

**Fix:** Implemented end-to-end speech-to-text pipeline using Whisper running locally in a Web Worker:
- `packages/contracts`: Added `speech.toggle` keybinding command and `SpeechToggleShortcut` schema.
- `apps/web/src/appSettings.ts`: Added `whisperModel` and `whisperLanguage` settings with defaults (`"small"`, `"en"`).
- `apps/web/src/routes/_chat.settings.tsx`: Added Settings UI section for downloading/selecting the Whisper model.
- `apps/web/src/workers/whisperWorker.ts`: Web Worker that loads and runs the Whisper ONNX model via `@huggingface/transformers`.
- `apps/web/src/lib/whisperManager.ts`: Singleton manager wrapping the worker with `ensureModel`, `transcribe`, and `isModelReady` APIs.
- `apps/web/src/hooks/useAudioCapture.ts`: Hook for microphone access, MediaRecorder, real-time audio level analysis, and PCM Float32Array output.
- `apps/web/src/speechStore.ts`: Zustand store for speech UI state (`idle | recording | transcribing | downloading | notInstalled`), audio level, download progress.
- `apps/web/src/hooks/useSpeechToText.ts`: Orchestration hook — on toggle: checks model readiness, starts/stops recording, transcribes audio, writes result to the active thread terminal.
- `apps/web/src/components/SpeechControl.tsx`: Toolbar button with 5 visual states (idle, not-installed, downloading, recording with waveform bars, transcribing spinner).
- `apps/web/src/index.css`: Added `pulse-mic` and `waveform-bar` keyframe animations.
- `apps/web/src/components/TerminalToolbar.tsx`: Mounted `<SpeechControl>` in the terminal actions area.
- `apps/web/src/routes/_chat.tsx`: Wired `isSpeechToggleShortcut` (⌘⇧V) into the global keydown handler.

**Files:** `packages/contracts/src/keybindings.ts`, `apps/web/src/appSettings.ts`, `apps/web/src/routes/_chat.settings.tsx`, `apps/web/src/workers/whisperWorker.ts`, `apps/web/src/lib/whisperManager.ts`, `apps/web/src/hooks/useAudioCapture.ts`, `apps/web/src/speechStore.ts`, `apps/web/src/hooks/useSpeechToText.ts`, `apps/web/src/components/SpeechControl.tsx`, `apps/web/src/index.css`, `apps/web/src/components/TerminalToolbar.tsx`, `apps/web/src/routes/_chat.tsx`

---

## 2026-03-17 — Enter key triggers Start Claude on new thread view

**Problem:** When switching to a new thread, users had to click the "Start Claude" button with the mouse. Pressing Enter did nothing.

**Fix:** Added a keydown listener to the `NewThreadView` container that triggers `handleStart` on Enter. The container auto-focuses on mount so Enter works immediately after thread switch. Input fields (branch name, prefix) are excluded so typing in them is unaffected.

**Files:** `apps/web/src/components/ThreadTerminalView.tsx`

---

## 2026-03-17 — Fix mouse wheel scrolling in alternate screen buffer (Claude Code TUI)

**Problem:** Users cannot scroll within Claude Code's TUI conversation view when running in a thread terminal. Mouse wheel events do nothing — the output stays static even though there is more content above/below the visible area.

**Root cause:** Claude Code runs in xterm.js alternate screen buffer mode (no scrollback). xterm.js v6 has a fallback that converts wheel events to arrow keys for alt-screen apps, but it silently eats wheel events when `CoreMouseService.consumeWheelEvent()` returns 0 — which happens when `_renderService.dimensions.device.cell.height` is undefined (common during WebGL context transitions after terminal detach/reattach). The event is canceled (`preventDefault` + `stopPropagation`) with no input sent to the PTY.

**Fix:** Added a wheel event listener in capture phase on the terminal container in `ActiveTerminalView`. When the terminal is in alternate buffer mode, wheel events are intercepted before xterm.js's buggy fallback and reliably converted to arrow key escape sequences (`\x1b[A` / `\x1b[B`) sent directly to the PTY. Normal buffer mode is unaffected — events pass through to xterm.js for native scrollback scrolling.

**Files:** `apps/web/src/components/ThreadTerminalView.tsx`

---

## 2026-03-17 — Move update banner to sidebar bottom, make subtle, add dismiss

**Problem:** The desktop update banner appeared at the top of the sidebar as a large, prominent Alert component that took up too much visual space.

**Fix:** Moved the banner from inside `SidebarContent` (top) to just above `SidebarFooter` (bottom). Replaced the full `Alert` component with a compact inline row using smaller icons, truncated text, ghost button, and muted colors. Added a dismiss button (X icon) with local state to hide the banner.

**Files:** `apps/web/src/components/Sidebar.tsx`

---

## 2026-03-16 — Working badge recovery fix

**Problem:** The "Working" sidebar badge would disappear while Claude was still actively working. A thread could be visibly producing output with no badge shown.

**Root cause:** The 90-second idle timer in `__root.tsx` cleared `hookStatus` to `null` during gaps in terminal output (e.g., long tool executions). Once cleared, subsequent output could never restore it — the output handler only reset the timer when `hookStatus` was already `"working"`, creating a one-way door.

**Fix:** Generalized the narrow "ompact" (compaction) recovery check to recover `hookStatus = "working"` on *any* output arriving on an active terminal with null hookStatus. The 2-second completion grace period prevents false recovery right after a Stop event.

**File:** `apps/web/src/routes/__root.tsx` (output event handler, ~line 460)

**Context:** Previously a narrow recovery existed only for context compaction output (checking for "ompact" in the data). That was added because compaction produced no hooks, making it look like Claude was done. The generalized fix covers compaction plus all other silent-gap scenarios.
