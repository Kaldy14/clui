import { ProjectId, ThreadId } from "@clui/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { selectThreadTerminalState, useTerminalStateStore } from "./terminalStateStore";
import { projectTerminalThreadId } from "./types";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const PROJECT_A_ID = ProjectId.makeUnsafe("project-a");
const PROJECT_B_ID = ProjectId.makeUnsafe("project-b");

describe("terminalStateStore actions", () => {
  beforeEach(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.clear();
    }
    useTerminalStateStore.setState({ terminalStateByThreadId: {} });
  });

  it("returns a closed default terminal state for unknown threads", () => {
    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState).toEqual({
      terminalOpen: false,
      terminalHeight: 280,
      terminalIds: ["default"],
      runningTerminalIds: [],
      activeTerminalId: "default",
      terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
      activeTerminalGroupId: "group-default",
      yoloMode: false,
    });
  });

  it("opens and splits terminals into the active group", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(THREAD_ID, true);
    store.splitTerminal(THREAD_ID, "terminal-2");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-2"] },
    ]);
  });

  it("creates new terminals in a separate group", () => {
    useTerminalStateStore.getState().newTerminal(THREAD_ID, "terminal-2");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.activeTerminalGroupId).toBe("group-terminal-2");
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default"] },
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("tracks and clears terminal subprocess activity", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.setTerminalActivity(THREAD_ID, "terminal-2", true);
    expect(
      selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID)
        .runningTerminalIds,
    ).toEqual(["terminal-2"]);

    store.setTerminalActivity(THREAD_ID, "terminal-2", false);
    expect(
      selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID)
        .runningTerminalIds,
    ).toEqual([]);
  });

  it("resets to default and clears persisted entry when closing the last terminal", () => {
    const store = useTerminalStateStore.getState();
    store.closeTerminal(THREAD_ID, "default");

    expect(useTerminalStateStore.getState().terminalStateByThreadId[THREAD_ID]).toBeUndefined();
    expect(
      selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID)
        .terminalIds,
    ).toEqual(["default"]);
  });

  it("keeps a valid active terminal after closing an active split terminal", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");
    store.closeTerminal(THREAD_ID, "terminal-3");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-2"] },
    ]);
  });

  it("closes other project drawers without resetting their tab state", () => {
    const store = useTerminalStateStore.getState();
    const projectATerminalThreadId = projectTerminalThreadId(PROJECT_A_ID);
    const projectBTerminalThreadId = projectTerminalThreadId(PROJECT_B_ID);

    store.newTerminal(projectATerminalThreadId, "terminal-2");
    store.setProjectTerminalOpen(projectATerminalThreadId, true);
    store.setProjectTerminalOpen(projectBTerminalThreadId, true);

    const projectATerminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      projectATerminalThreadId,
    );
    const projectBTerminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      projectBTerminalThreadId,
    );

    expect(projectATerminalState.terminalOpen).toBe(false);
    expect(projectATerminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(projectATerminalState.activeTerminalId).toBe("terminal-2");
    expect(projectBTerminalState.terminalOpen).toBe(true);
    expect(projectBTerminalState.terminalIds).toEqual(["default"]);
  });
});
