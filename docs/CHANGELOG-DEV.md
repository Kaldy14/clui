# Development Changelog

Session-by-session log of changes, fixes, and decisions made during development.

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
