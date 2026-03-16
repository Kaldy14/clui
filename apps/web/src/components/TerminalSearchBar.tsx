import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import type { SearchAddon } from "@xterm/addon-search";

interface TerminalSearchBarProps {
  searchAddon: SearchAddon;
  onClose: () => void;
}

export function TerminalSearchBar({ searchAddon, onClose }: TerminalSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const queryRef = useRef("");

  // Focus the input when the search bar mounts
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleFindNext = useCallback(() => {
    const query = queryRef.current;
    if (query) searchAddon.findNext(query);
  }, [searchAddon]);

  const handleFindPrevious = useCallback(() => {
    const query = queryRef.current;
    if (query) searchAddon.findPrevious(query);
  }, [searchAddon]);

  const handleClose = useCallback(() => {
    searchAddon.clearDecorations();
    onClose();
  }, [searchAddon, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) {
          handleFindPrevious();
        } else {
          handleFindNext();
        }
      }
    },
    [handleClose, handleFindNext, handleFindPrevious],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const query = e.target.value;
      queryRef.current = query;
      if (query) {
        searchAddon.findNext(query);
      } else {
        searchAddon.clearDecorations();
      }
    },
    [searchAddon],
  );

  return (
    <div className="absolute right-4 top-10 z-10 flex items-center gap-1 rounded-md border border-border/60 bg-card/95 px-2 py-1 shadow-md backdrop-blur-sm dark:border-border/30 dark:bg-card/90">
      <input
        ref={inputRef}
        type="text"
        placeholder="Find..."
        spellCheck={false}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        className="w-48 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/50"
      />
      <button
        type="button"
        onClick={handleFindPrevious}
        title="Previous match (Shift+Enter)"
        className="rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        <ChevronUpIcon className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={handleFindNext}
        title="Next match (Enter)"
        className="rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        <ChevronDownIcon className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={handleClose}
        title="Close (Escape)"
        className="rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
