# Development Changelog

Session-by-session log of changes, fixes, and decisions made during development.

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
