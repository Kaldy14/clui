import type { SearchAddon } from "@xterm/addon-search";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { TerminalSearchBar } from "./TerminalSearchBar";

describe("TerminalSearchBar", () => {
  it("focuses the query and routes search controls to the xterm addon", async () => {
    const findNext = vi.fn();
    const findPrevious = vi.fn();
    const clearDecorations = vi.fn();
    const onClose = vi.fn();
    const searchAddon = {
      findNext,
      findPrevious,
      clearDecorations,
    } as unknown as SearchAddon;

    const screen = await render(<TerminalSearchBar searchAddon={searchAddon} onClose={onClose} />);
    const query = screen.getByPlaceholder("Find...");

    await expect.element(query).toHaveFocus();
    await query.fill("needle");
    expect(findNext).toHaveBeenLastCalledWith("needle");

    await screen.getByTitle("Previous match (Shift+Enter)").click();
    expect(findPrevious).toHaveBeenLastCalledWith("needle");

    await screen.getByTitle("Next match (Enter)").click();
    expect(findNext).toHaveBeenCalledTimes(2);

    await query.click();
    await userEvent.keyboard("{Escape}");
    expect(clearDecorations).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
