import { SearchAddon } from "@xterm/addon-search";
import { useCallback, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { isMacPlatform } from "../lib/utils";

export interface TerminalSearchState {
  searchOpen: boolean;
  searchAddon: SearchAddon | null;
  /** Call during terminal setup to load the addon and get back the key handler. */
  init: (terminal: Terminal) => void;
  /** Attach to `terminal.attachCustomKeyEventHandler` — returns `false` to swallow Cmd/Ctrl+F. */
  handleKey: (event: KeyboardEvent) => boolean | undefined;
  handleSearchClose: () => void;
  /** Call on cleanup to clear the ref. */
  dispose: () => void;
}

/**
 * Reusable search-addon hook for any xterm.js terminal.
 * Loads the SearchAddon, intercepts Cmd/Ctrl+F, and exposes state for TerminalSearchBar.
 *
 * @param refocusTerminal — called after search bar closes to return focus to the terminal.
 */
export function useTerminalSearch(refocusTerminal: () => void): TerminalSearchState {
  const [searchOpen, setSearchOpen] = useState(false);
  const searchAddonRef = useRef<SearchAddon | null>(null);

  const init = useCallback((terminal: Terminal) => {
    const addon = new SearchAddon();
    terminal.loadAddon(addon);
    searchAddonRef.current = addon;
  }, []);

  const handleKey = useCallback((event: KeyboardEvent): boolean | undefined => {
    if (
      event.type === "keydown" &&
      event.key.toLowerCase() === "f" &&
      !event.altKey &&
      !event.shiftKey &&
      (isMacPlatform(navigator.platform)
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey)
    ) {
      event.preventDefault();
      event.stopPropagation();
      setSearchOpen(true);
      return false;
    }
    return undefined;
  }, []);

  const handleSearchClose = useCallback(() => {
    setSearchOpen(false);
    refocusTerminal();
  }, [refocusTerminal]);

  const dispose = useCallback(() => {
    searchAddonRef.current = null;
  }, []);

  return {
    searchOpen,
    searchAddon: searchAddonRef.current,
    init,
    handleKey,
    handleSearchClose,
    dispose,
  };
}
