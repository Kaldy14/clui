/**
 * Module-level cache for xterm.js Terminal instances used by Claude sessions.
 *
 * Terminals are detached (not disposed) when switching threads and reattached
 * when the user returns. This avoids costly teardown/recreation and preserves
 * scrollback that was written while the terminal was live.
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { terminalThemeFromApp } from "./terminalTheme";

export interface CachedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  /** The DOM element the terminal is currently attached to, or null if detached. */
  container: HTMLElement | null;
}

const cache = new Map<string, CachedTerminal>();

/** Track which terminals already have a WebGL addon to avoid leaking GPU contexts. */
const webglLoaded = new WeakSet<Terminal>();

export function createTerminal(): CachedTerminal {
  const fitAddon = new FitAddon();
  const terminal = new Terminal({
    cursorBlink: true,
    lineHeight: 1.2,
    fontSize: 13,
    scrollback: 10_000,
    fontFamily: '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
    theme: terminalThemeFromApp(),
  });
  terminal.loadAddon(fitAddon);
  return { terminal, fitAddon, container: null };
}

function tryLoadWebgl(terminal: Terminal): void {
  if (webglLoaded.has(terminal)) return;
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      webglLoaded.delete(terminal);
    });
    terminal.loadAddon(webgl);
    webglLoaded.add(terminal);
  } catch {
    // WebGL not supported, fall back to canvas renderer
  }
}

export function getOrCreate(threadId: string): CachedTerminal {
  const existing = cache.get(threadId);
  if (existing) return existing;
  const entry = createTerminal();
  cache.set(threadId, entry);
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
    // Already attached to this container
    entry.fitAddon.fit();
    return entry;
  }

  // If the terminal was previously opened then detached (container is null but
  // the Terminal instance has already been opened), xterm.js cannot re-open the
  // same instance. Dispose and recreate. This happens in React StrictMode which
  // double-invokes effects: mount→cleanup→mount on the same element.
  if (entry && !entry.container && entry.terminal.element) {
    entry.terminal.dispose();
    cache.delete(threadId);
    entry = undefined;
  }

  if (!entry) {
    entry = createTerminal();
    cache.set(threadId, entry);
  }

  // Detach from previous container if any
  if (entry.container) {
    detach(threadId);
  }
  entry.terminal.open(container);
  tryLoadWebgl(entry.terminal);
  entry.container = container;
  entry.fitAddon.fit();
  return entry;
}

/** Detach a terminal from the DOM without disposing it. */
export function detach(threadId: string): void {
  const entry = cache.get(threadId);
  if (!entry || !entry.container) return;
  // xterm.js doesn't have a "detach" API — we remove the child elements
  // and null out the container reference. The Terminal instance stays alive.
  const el = entry.container;
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
  entry.container = null;
}

/** Dispose a terminal and remove it from the cache. */
export function dispose(threadId: string): void {
  const entry = cache.get(threadId);
  if (!entry) return;
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
