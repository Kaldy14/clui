# Development Changelog

Session-by-session log of changes, fixes, and decisions made during development.

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
