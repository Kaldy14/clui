# Development Changelog

Session-by-session log of changes, fixes, and decisions made during development.

---

## 2026-03-18 — Add YOLO mode toggle to toolbar (mid-session permission bypass)

**Problem:** YOLO mode (auto-accept all tool calls) could only be set at session start via the checkbox on the launch screen. There was no way to toggle it on a running session without manually restarting.

**Fix:** Added a YOLO mode toggle button to `TerminalToolbar` with a confirmation popover explaining the behavior. When toggled, the session is restarted with `--resume` + `--dangerously-skip-permissions`, preserving conversation context while changing the permission mode. The YOLO state is persisted per-thread in `terminalStateStore` so it survives navigation and is respected by Resume/New Session buttons. The start screen checkbox now reads from/writes to the same store, keeping both UIs in sync.

**Affected files:** `apps/web/src/terminalStateStore.ts`, `apps/web/src/components/TerminalToolbar.tsx`, `apps/web/src/components/ThreadTerminalView.tsx`

---

## 2026-03-18 — Fix sidebar thread sorting: active threads now pinned to top

**Problem:** Thread ordering in the sidebar was unpredictable. Active/working threads would drop down when other threads received updates. The sort was purely `updatedAt`-based with no awareness of thread activity state.

**Root cause:** The sort comparator only compared `updatedAt` timestamps. Terminal status changes (`thread.terminal-status-changed`) don't bump `updatedAt` in the projector, so an actively working thread's position was determined solely by when it last received a message — not by whether it's currently busy. Other threads receiving any event that bumps `updatedAt` (messages, session changes, turn diffs) would push the active thread down.

**Fix:** Replaced the flat `updatedAt` sort with a tiered comparator (`compareThreadsForSidebar` in `Sidebar.logic.ts`). Tier 0 pins busy threads (active terminal or actionable hook status: working/needsInput/pendingApproval) to the top. Tier 1 contains everything else. Within each tier, threads sort by `updatedAt` descending with ID as tiebreaker. Applied to both the render-loop sort and the `focusMostRecentThreadForProject` helper.

**Affected files:** `apps/web/src/components/Sidebar.logic.ts`, `apps/web/src/components/Sidebar.tsx`

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
