/**
 * Module-level cache for xterm.js Terminal instances used by Claude sessions.
 *
 * Terminals are detached (not disposed) when switching threads and reattached
 * when the user returns. This avoids costly teardown/recreation and preserves
 * scrollback that was written while the terminal was live.
 *
 * LRU eviction disposes the oldest detached terminals when the cache exceeds
 * MAX_CACHED_TERMINALS. WebGL addons are disposed on detach and re-created on
 * attach to reclaim GPU contexts (browsers cap at ~16 active contexts).
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { terminalThemeFromApp } from "./terminalTheme";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE,
  getAppSettingsSnapshot,
} from "../appSettings";

export interface CachedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  /** The DOM element the terminal is currently attached to, or null if detached. */
  container: HTMLElement | null;
  /** Timestamp (ms) of the last attach or getOrCreate call. Used for idle sweep. */
  lastAccessedAt: number;
  /** Server scrollback byte offset at last sync. Used for delta-only scrollback
   *  fetches so we don't reset the terminal and lose old scrollback on reattach. */
  lastServerOffset: number;
}

/**
 * Max number of xterm.js instances kept in the cache. Beyond this limit,
 * the oldest *detached* terminals are disposed to free memory and GPU contexts.
 */
const MAX_CACHED_TERMINALS = 50;

const cache = new Map<string, CachedTerminal>();

/** Active WebGL addon per terminal — stored so we can dispose it on detach. */
const webglAddons = new WeakMap<Terminal, WebglAddon>();

/**
 * Optional predicate that returns `true` when a thread is "busy" (working,
 * pending approval, needs input, etc.) and should NOT be evicted even if
 * detached. Set via `setEvictionGuard`.
 */
let isThreadBusy: ((threadId: string) => boolean) | null = null;

/**
 * Register a guard that prevents eviction of busy threads. Call once at app
 * startup with a function that checks the store for active hook/terminal status.
 */
export function setEvictionGuard(guard: (threadId: string) => boolean): void {
  isThreadBusy = guard;
}

function resolveTerminalFontSettings(): { fontSize: number; fontFamily: string } {
  const settings = getAppSettingsSnapshot();
  return {
    fontSize: settings.terminalFontSize || DEFAULT_TERMINAL_FONT_SIZE,
    fontFamily: settings.terminalFontFamily || DEFAULT_TERMINAL_FONT_FAMILY,
  };
}

export function createTerminal(): CachedTerminal {
  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  const { fontSize, fontFamily } = resolveTerminalFontSettings();
  const terminal = new Terminal({
    cursorBlink: true,
    cursorInactiveStyle: "none",
    lineHeight: 1.2,
    fontSize,
    scrollback: 250_000,
    fontFamily,
    theme: terminalThemeFromApp(),
    macOptionIsMeta: true,
    fastScrollSensitivity: 5,
    smoothScrollDuration: 0,
    drawBoldTextInBrightColors: true,
    rescaleOverlappingGlyphs: true,
    minimumContrastRatio: 1,
    allowProposedApi: true,
  });
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  const unicode11 = new Unicode11Addon();
  terminal.loadAddon(unicode11);
  terminal.unicode.activeVersion = "11";
  terminal.loadAddon(
    new WebLinksAddon((_event, url) => {
      window.open(url, "_blank");
    }),
  );
  return { terminal, fitAddon, searchAddon, container: null, lastAccessedAt: Date.now(), lastServerOffset: 0 };
}

/** Update font settings for all cached terminals. */
export function updateFontSettings(): void {
  const { fontSize, fontFamily } = resolveTerminalFontSettings();
  for (const entry of cache.values()) {
    entry.terminal.options.fontSize = fontSize;
    entry.terminal.options.fontFamily = fontFamily;
    if (entry.container) {
      entry.fitAddon.fit();
    }
  }
}

function tryLoadWebgl(terminal: Terminal): void {
  if (webglAddons.has(terminal)) return;
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      webglAddons.delete(terminal);
    });
    terminal.loadAddon(webgl);
    webglAddons.set(terminal, webgl);
  } catch {
    // WebGL not supported, fall back to canvas renderer
  }
}

/** Dispose the WebGL addon to free GPU context while keeping the Terminal alive. */
function disposeWebgl(terminal: Terminal): void {
  const addon = webglAddons.get(terminal);
  if (!addon) return;
  try {
    addon.dispose();
  } catch {
    // Already disposed or context lost — ignore
  }
  webglAddons.delete(terminal);
}

/**
 * Evict the oldest detached terminals when the cache exceeds MAX_CACHED_TERMINALS.
 *
 * Eligible for eviction: detached (not attached to DOM) AND not busy (not
 * working, pending approval, needs input, etc.). Busy threads keep their
 * cached scrollback so the user sees output immediately when switching back.
 */
function evictDetachedIfOverCap(): void {
  if (cache.size <= MAX_CACHED_TERMINALS) return;

  const evictable: string[] = [];
  for (const [threadId, entry] of cache) {
    if (!entry.container && !(isThreadBusy?.(threadId))) {
      evictable.push(threadId);
    }
  }

  // Evict oldest entries first (Map iteration order is insertion order).
  // We re-insert on attach, so insertion order approximates LRU.
  const toEvict = cache.size - MAX_CACHED_TERMINALS;
  for (let i = 0; i < Math.min(toEvict, evictable.length); i++) {
    dispose(evictable[i]!);
  }
}

export function getOrCreate(threadId: string): CachedTerminal {
  const existing = cache.get(threadId);
  if (existing) return existing;
  const entry = createTerminal();
  cache.set(threadId, entry);
  evictDetachedIfOverCap();
  return entry;
}

export function get(threadId: string): CachedTerminal | undefined {
  return cache.get(threadId);
}

/**
 * Attach a cached terminal to a DOM element. If the terminal is already open
 * in another container it is detached first.
 */
export function attach(threadId: string, container: HTMLElement): CachedTerminal {
  let entry = cache.get(threadId);

  if (entry && entry.container === container) {
    // Already attached to this container — caller is responsible for fit()
    // after the browser has laid out the container.
    return entry;
  }

  // If the terminal was previously opened then detached, xterm.js cannot
  // re-open the same instance via open(). Instead, move the existing DOM
  // subtree to the new container — this preserves all client-side scrollback.
  if (entry && !entry.container && entry.terminal.element) {
    // Move to end of Map (most recently used) by re-inserting
    cache.delete(threadId);
    cache.set(threadId, entry);

    // Reparent the xterm DOM into the new container
    container.appendChild(entry.terminal.element);
    tryLoadWebgl(entry.terminal);
    entry.container = container;
    entry.lastAccessedAt = Date.now();
    // Don't fit() here — container isn't laid out yet. Caller handles fit
    // after requestAnimationFrame to get correct dimensions.

    evictDetachedIfOverCap();
    return entry;
  }

  if (!entry) {
    entry = createTerminal();
  }

  // Detach from previous container if any
  if (entry.container) {
    detachEntry(threadId, entry);
  }

  // Move to end of Map (most recently used) by re-inserting
  cache.delete(threadId);
  cache.set(threadId, entry);

  entry.terminal.open(container);
  tryLoadWebgl(entry.terminal);
  entry.container = container;
  entry.lastAccessedAt = Date.now();
  // Don't fit() here — container isn't laid out yet. Caller handles fit
  // after requestAnimationFrame to get correct dimensions.

  evictDetachedIfOverCap();
  return entry;
}

/** Detach a terminal from the DOM without disposing it. Frees its WebGL context. */
export function detach(threadId: string): void {
  const entry = cache.get(threadId);
  if (!entry || !entry.container) return;
  detachEntry(threadId, entry);
}

function detachEntry(_threadId: string, entry: CachedTerminal): void {
  // Free GPU context — will be re-created on next attach
  disposeWebgl(entry.terminal);

  // Remove xterm's DOM from the container but keep the Terminal instance
  // alive so its scrollback buffer is preserved. On next attach, the DOM
  // subtree is reparented into the new container via appendChild.
  const xtermEl = entry.terminal.element;
  if (xtermEl?.parentElement) {
    xtermEl.parentElement.removeChild(xtermEl);
  }
  entry.container = null;
}

/** Dispose a terminal and remove it from the cache. */
export function dispose(threadId: string): void {
  const entry = cache.get(threadId);
  if (!entry) return;
  disposeWebgl(entry.terminal);
  entry.terminal.dispose();
  cache.delete(threadId);
}

/** Refresh theme for all cached terminals. */
export function refreshTheme(): void {
  const theme = terminalThemeFromApp();
  for (const entry of cache.values()) {
    entry.terminal.options.theme = theme;
  }
}

export function has(threadId: string): boolean {
  return cache.has(threadId);
}

// ── Cache stats & cleanup ──────────────────────────────────────────────

export interface CacheStats {
  totalCached: number;
  totalEstimatedBytes: number;
  clearableCount: number;
  clearableEstimatedBytes: number;
}

function estimateTerminalBytes(terminal: Terminal): number {
  const lines = terminal.buffer.active.length;
  const cols = terminal.cols || 120;
  // Each cell stores ~8 bytes (Uint32 code + attribute data) in xterm.js internal buffer
  return lines * cols * 8;
}

export function getCacheStats(): CacheStats {
  let totalEstimatedBytes = 0;
  let clearableCount = 0;
  let clearableEstimatedBytes = 0;

  for (const [threadId, entry] of cache) {
    const bytes = estimateTerminalBytes(entry.terminal);
    totalEstimatedBytes += bytes;

    if (!entry.container && !isThreadBusy?.(threadId)) {
      clearableCount++;
      clearableEstimatedBytes += bytes;
    }
  }

  return { totalCached: cache.size, totalEstimatedBytes, clearableCount, clearableEstimatedBytes };
}

/** Dispose all detached, non-busy terminals. Returns the number of terminals cleared. */
export function clearIdleTerminals(): number {
  const toDispose: string[] = [];
  for (const [threadId, entry] of cache) {
    if (entry.container) continue;
    if (isThreadBusy?.(threadId)) continue;
    toDispose.push(threadId);
  }
  for (const threadId of toDispose) {
    dispose(threadId);
  }
  return toDispose.length;
}

// ── Idle sweep ─────────────────────────────────────────────────────────

/** Detached terminals untouched for this long are automatically disposed. */
const IDLE_TTL_MS = 2 * 60 * 60 * 1_000; // 2 hours
const IDLE_SWEEP_INTERVAL_MS = 5 * 60 * 1_000; // check every 5 minutes

function sweepIdleTerminals(): void {
  const cutoff = Date.now() - IDLE_TTL_MS;
  for (const [threadId, entry] of cache) {
    if (entry.container) continue; // attached — skip
    if (entry.lastAccessedAt > cutoff) continue; // recently used — skip
    if (isThreadBusy?.(threadId)) continue; // busy — skip
    dispose(threadId);
  }
}

// Start the sweep timer. Runs in the background as long as the app is open.
const idleSweepTimer = setInterval(sweepIdleTerminals, IDLE_SWEEP_INTERVAL_MS);
if (typeof idleSweepTimer === "object" && "unref" in idleSweepTimer) {
  idleSweepTimer.unref();
}
