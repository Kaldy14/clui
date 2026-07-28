# Sidebar v2 parity plan

## Requirements summary

Port the current t3code Sidebar v2 experience into Clui with the same visual hierarchy and
interaction model, while keeping Clui's terminal-backed architecture and existing archive flow.

The implementation must include:

- One flat, project-filterable thread inbox instead of project accordions.
- Rich active thread cards and compact settled/snoozed history rows.
- Explicit settle, un-settle, snooze, wake-now, and timed wake behavior.
- Automatic settlement after three inactive days by default, configurable from one to ninety days
  or disabled, matching the current t3code implementation.
- Automatic settlement when a matching pull request becomes merged or closed.
- Numbered pull-request badges with t3code's open, merged, and closed presentation.
- The same Codex/OpenAI, Claude, and Pi harness icons used by t3code.
- t3code Sidebar v2 light/dark surface tokens and hover/selection behavior.
- Existing Clui archive behavior retained as a separate, stronger hiding action.
- Existing Clui terminal status, hook status, unread state, worktrees, bookmarks, context menus,
  drag ordering where still applicable, keyboard navigation, and deep links preserved.

## Source parity references

- `../t3code/apps/web/src/components/SidebarV2.tsx`
- `../t3code/apps/web/src/components/ThreadStatusIndicators.tsx`
- `../t3code/apps/web/src/components/chat/ProviderInstanceIcon.tsx`
- `../t3code/apps/web/src/components/chat/providerIconUtils.ts`
- `../t3code/apps/web/src/components/Icons.tsx`
- `../t3code/apps/web/src/index.css`
- `../t3code/packages/client-runtime/src/state/threadSettled.ts`
- `../t3code/apps/server/src/orchestration/decider.ts`
- `../t3code/apps/server/src/persistence/Migrations/033_ProjectionThreadsSettled.ts`
- `../t3code/apps/server/src/persistence/Migrations/034_ProjectionThreadsSnoozed.ts`

## Architecture decisions

### Lifecycle state

Add server-backed fields to the thread projection:

- `settledAt: string | null`
- `settledOverride: "active" | "settled" | null`
- `snoozedUntil: string | null`
- `snoozedAt: string | null`

Use dedicated orchestration commands and events for settlement and snoozing rather than
overloading `thread.meta.update`. The decider must reject settle/snooze commands for deleted,
archived, busy, approval-blocked, input-blocked, or queued threads.

Explicit un-settle records an active override so automatically eligible threads remain visible.
Starting a new turn or waking a snoozed thread clears obsolete lifecycle overrides.

### Archive compatibility

Archive remains separate:

- Archived rows do not appear in Sidebar v2.
- Settled rows remain visible in compact history.
- The legacy automatic archive setting must no longer remove ordinary inactive threads before the
  Sidebar v2 settlement lifecycle can represent them. Auto-archive will only consider already
  settled threads and use its configured threshold as a later cleanup stage.

### Pull requests

Reuse Clui's existing per-thread git-status queries and PR link opener. The Sidebar v2 row reports
the matching branch's PR state to the parent partition. Open PRs remain active; merged or closed
PRs become automatically settled unless explicitly pinned active.

Presentation matches t3code:

- Open: emerald.
- Merged: violet.
- Closed: red.
- Active row shows a clickable `#number` badge.
- Settled row shows a muted badge that restores its state color on hover.
- Tooltip lead uses `PR #number - State`, followed by the title.

### Harness presentation

Add reusable harness icons and use them in Sidebar v2 cards:

- `codex` -> OpenAI icon.
- `claudeCode` -> Claude icon.
- `pi` -> Pi icon.

Keep the icon at the card's lower-right metadata edge, with an accessible harness label.

## Implementation steps

1. Add migrations `031_ProjectionThreadsSettled.ts` and
   `032_ProjectionThreadsSnoozed.ts`, register them in `Migrations.ts`, and update projection row
   schemas and SQL reads/writes.
2. Extend orchestration contracts with lifecycle fields, commands, events, capability-safe
   decoding defaults, and associated TypeScript types.
3. Implement command invariants, decider events, projector updates, projection pipeline writes,
   and snapshot hydration.
4. Add focused lifecycle helpers for:
   - Effective settlement.
   - Automatic settlement using the configurable three-day default.
   - PR-state settlement.
   - Snooze eligibility and wake labels.
   - Busy/input/approval protection.
5. Update the web store so optimistic lifecycle changes survive stale snapshots and reconcile when
   the authoritative projection catches up.
6. Add reusable harness icon components derived from t3code's current SVGs.
7. Implement Sidebar v2 as Clui's primary sidebar:
   - Preserve the existing header, search, new-thread entry, footer, and settings access.
   - Replace project accordions with a project scope dropdown.
   - Render active threads as 78px cards.
   - Render snoozed and settled threads as 36px rows.
   - Keep Snoozed collapsed by default and Settled expanded by default.
   - Initially show 10 settled rows, then reveal pages of 25.
   - Preserve selection, context menus, title rename, delete/archive, bookmarks, worktree cleanup,
     and route behavior.
8. Add settle and snooze dispatch helpers and optimistic rollback/error toasts.
9. Update sidebar theme tokens in `apps/web/src/index.css` for exact light/dark parity.
10. Update Settings with a Sidebar v2 lifecycle section:

- Three-day automatic settlement default with a one-to-ninety-day range and disable toggle.
- Existing auto-archive framed as later cleanup, not the inbox lifecycle.

11. Update `docs/CHANGELOG-DEV.md` with problem, root cause, fix, and affected files.

## Screenshot acceptance matrix

All screenshots are informational review evidence and are captured with the real Clui application,
not the standalone mock.

1. `sidebar-v2-dark-overview.png`
   - Desktop dark theme.
   - Three active cards showing Codex, Claude, and Pi icons.
   - Open PR badge and settled merged PR visible.
2. `sidebar-v2-light-overview.png`
   - Desktop light theme.
   - Zinc-50 sidebar, zinc-25 hover, white active surface, subtle borders.
3. `sidebar-v2-row-actions.png`
   - Active row hover exposes Snooze and Settle without shifting card content.
4. `sidebar-v2-snoozed.png`
   - Snoozed shelf expanded with wake time and wake-now action.
5. `sidebar-v2-project-filter.png`
   - Project scope menu open with All projects and individual projects.
6. `sidebar-v2-pr-states.png`
   - Open green, merged violet, and closed red badges.
   - Settled badges muted at rest and restored on hover.
7. `sidebar-v2-mobile-320.png`
   - 320px-wide layout with no clipped actions, badges, or project menu.

## Acceptance criteria

- Sidebar threads are no longer grouped into project accordions.
- Project filtering scopes the flat list without changing thread order.
- Active, snoozed, settled, and archived states are distinct and persisted.
- Busy, queued, pending-approval, and needs-input threads cannot be settled. Snooze follows
  t3code: running background work may be snoozed, while queued and blocked-on-user work may not.
- A snoozed thread wakes at its deadline without a page reload.
- Starting work on a snoozed or settled thread returns it to the active inbox.
- A merged or closed matching PR automatically moves to Settled.
- PR badges open the existing PR URL flow and match t3code's state colors.
- Codex, Claude, and Pi cards display the correct icon.
- A direct route to a settled thread keeps that row reachable.
- Keyboard navigation, multi-selection, rename, delete, archive, bookmark, and context-menu actions
  remain functional.
- Light and dark themes visually match the approved mock and t3code tokens.
- Existing archive settings and archive management continue working.
- `bun lint` and `bun typecheck` pass.
- Relevant tests pass via `bun run test`; `bun test` is never used.
- Browser verification passes at desktop and 320px widths.

## Risks and mitigations

- **Lifecycle divergence between optimistic UI and snapshots:** use the existing pending-local-update
  reconciliation pattern and add stale-snapshot tests.
- **Busy-state false negatives:** centralize eligibility using terminal, session, hook, activity,
  approval, and input signals; reject on the server as the authority.
- **Auto-archive hiding history too early:** gate automatic archive to already-settled threads and
  cover the interaction with tests.
- **Large Sidebar component regression:** extract pure lifecycle/partition helpers and reusable row
  components before replacing the existing render tree.
- **PR status arriving after initial partition:** retain per-row subscriptions and report state to
  the parent using the t3code pattern.
- **Migration mismatch:** continue from Clui's current migration 030 and test upgrading an existing
  projection database.

## Verification

1. Run targeted orchestration, projection, lifecycle, store, and sidebar unit tests with
   `bun run test`.
2. Run `bun lint`.
3. Run `bun typecheck`.
4. Start or reuse the Clui development server.
5. Verify all acceptance states with `agent-browser`.
6. Capture the screenshot matrix above.
7. Review browser console output and confirm no uncaught errors during lifecycle transitions.

## 2026-07-28 follow-up — active-card status parity

### Verified t3code behavior

The current local t3code checkout implements Sidebar v2 status independently from its legacy
status pill:

- Status priority is `Approval` → `Input` → `Working` → `Failed` → ready.
- Both running and starting sessions display `Working`.
- The working row displays `Working <elapsed>` and ticks once per second.
- The timer starts from the active turn's `startedAt`, then `requestedAt`, then the session
  transition timestamp.
- Durations render as seconds below one minute, whole minutes below one hour, and `Hh Mm`
  thereafter.
- The accessible live region contains only `Working`; the ticking duration is hidden from screen
  readers so it is not announced every second.
- The working treatment uses t3code's slow opacity animation and respects reduced-motion
  preferences.
- Completion and wake labels are `Done` and `Woke`; terminal implementation details such as
  `Thinking` and `Using Tool` are not exposed in the Sidebar v2 card.

Primary evidence:

- `../t3code/apps/web/src/components/Sidebar.logic.ts`
- `../t3code/apps/web/src/components/Sidebar.logic.test.ts`
- `../t3code/apps/web/src/components/SidebarV2.tsx`
- `../t3code/apps/web/src/index.css`

### Clui parity mapping

Clui keeps its terminal-backed status sources, but maps them into the same Sidebar v2 presentation:

| Clui source                                              | Sidebar v2 presentation |
| -------------------------------------------------------- | ----------------------- |
| pending approval hook or authoritative pending approval  | `Approval`              |
| needs-input hook or authoritative pending input          | `Input`                 |
| working hook or running/connecting orchestration session | `Working <elapsed>`     |
| error hook or errored session                            | `Failed`                |
| unseen completion                                        | `Done`                  |
| recently woken snooze                                    | `Woke`                  |
| all other states                                         | relative activity time  |

The working timer uses the same t3code turn/session anchors, with Clui's persisted
`lastInteractedAt` as the terminal-harness fallback because a PTY session can stay alive across
multiple turns.

### Implementation and screenshot acceptance

1. Add and test Sidebar v2-specific status, working-start, and duration-format helpers without
   changing Clui's legacy sidebar/status badges.
2. Port t3code's self-ticking `WorkingDuration` and its screen-reader behavior.
3. Port the slow working opacity animation and reduced-motion handling.
4. Match t3code's `Approval`, `Input`, `Failed`, `Done`, and `Woke` labels and status colors.
5. Match t3code's receded treatment for non-selected ready and in-flight cards while keeping the
   colored status legible.
6. Capture a real Clui screenshot showing `Working <elapsed>` on a running thread and confirm that
   the value advances without re-rendering the whole sidebar.
7. Verify approval, input, failure, completion, wake, hover actions, PR badge, and harness icon
   remain correctly composed in the same card slot.

## 2026-07-28 follow-up — new-thread project picker parity

### Verified t3code behavior

The project picker in the supplied t3code screenshot is the dotted project name inside the hero
headline, not the `Current checkout` workspace control below the composer:

- A resolved draft reads `What should we build in <project>?`.
- The project name is a dotted-underlined menu trigger with the accessible label `Change project`.
- The menu is centered below the trigger, limited to a scrollable 16rem-wide surface, and uses a
  radio checkmark for the active project.
- The active project is promoted to the first menu position.
- Selecting another project opens that project's stored draft when available, otherwise creates a
  new draft for it, and replaces the current browser-history entry.
- The final separated menu action is `New project` with a folder-plus icon.
- With no projects, the hero becomes `Add a project to start` and the dotted action opens the
  project-add flow.

Primary evidence:

- `../t3code/apps/web/src/components/chat/DraftHeroHeadline.tsx`
- `../t3code/apps/web/src/hooks/useHandleNewThread.ts`
- `../t3code/apps/web/src/sidebarProjectGrouping.ts`

### Clui adaptation

Clui persists a `new` terminal thread immediately instead of keeping t3code's in-memory composer
draft. The visual and navigation behavior can still match without changing the event schema:

1. Extract Clui's existing thread-creation callback into a shared hook used by both the sidebar and
   the new-thread hero.
2. When the hero selects a different project, navigate with history replacement to that project's
   newest unarchived `new` thread if one exists; otherwise create a new `new` thread for the target
   project and navigate with replacement.
3. Keep each project's prompt and setup selections attached to its own persisted draft thread, which
   gives Clui the same return-to-draft behavior as t3code without orphan deletion or project moves.
4. Keep the existing Local/Worktree, branch, harness, backend, model, permission, and launch controls
   intact below the hero.
5. Reuse Clui's existing desktop folder picker for `New project`; web mode keeps the established
   sidebar path-entry flow available.

### Screenshot-first acceptance

Capture both states at 1440×900 in Clui's dark theme:

1. **Closed hero:** `What should we build in <project>?` centered above the composer, with the
   project name visibly dotted-underlined and the existing setup controls below it.
2. **Open picker:** the project menu directly below the name, current project checked and first,
   at least one alternate project visible, plus the separated folder-icon `New project` action.

Interaction evidence must additionally confirm:

- Selecting the alternate project changes the headline, route thread, project cwd, branch controls,
  and sidebar selection to the target project.
- Returning to the original project restores its existing new-thread prompt draft.
- Keyboard focus, radio semantics, Escape dismissal, and the `Change project` accessible label work.
- No duplicate project or thread is created when the target already has a reusable new thread.
- `bun lint`, `bun typecheck`, targeted tests, and the full `bun run test` suite pass.

## 2026-07-28 correction — full t3code new-thread composition parity

The project-picker follow-up matched the picker behavior but retained Clui's old page composition.
That is not the requested parity target. The whole empty new-thread surface must now follow the
current local t3code implementation.

### Current t3code source of truth

- `../t3code/apps/web/src/components/ChatView.tsx`
  - Centers the draft composer as an absolute hero state rather than laying out separate stacked
    setup panels.
  - Uses `chat-composer-horizontal-inset` and a `max-w-3xl` composer.
  - Places the headline in an absolute block directly above the composer with `pb-8`.
- `../t3code/apps/web/src/components/chat/DraftHeroHeadline.tsx`
  - Supplies the centered 2xl/3xl headline and dotted project trigger.
- `../t3code/apps/web/src/components/chat/ChatComposer.tsx`
  - Uses a 22px outer frame, 20px inner surface, 70px minimum prompt editor, footer controls inside
    the same surface, and a circular send action.
- `../t3code/apps/web/src/components/ComposerPromptEditor.tsx`
  - Uses 16px mobile / 14px desktop prompt text, relaxed leading, and muted placeholder text.
- `../t3code/apps/web/src/components/BranchToolbar.tsx`
  - Attaches the checkout/worktree and branch context below the composer in a narrower recessed
    strip rather than displaying them as a separate row above it.
- `../t3code/apps/web/src/index.css`
  - Defines the continuous glass shell, 22px composer outline, joined 16px context strip, dark-mode
    highlight, blur, and fallback shape.

### Clui product-control mapping

The visual hierarchy, width, spacing, surface, and placement follow t3code. Clui keeps its real
terminal controls instead of inventing t3code-only functionality:

| t3code composer area      | Clui parity control                                                  |
| ------------------------- | -------------------------------------------------------------------- |
| provider/model picker     | coding-harness picker with harness icon                              |
| provider traits           | Pi render mode, Claude backend/model where applicable                |
| reasoning/access controls | Fast mode for Pi or YOLO for Claude/Codex                            |
| Build/Plan switch         | omitted                                                              |
| Full access control       | omitted                                                              |
| circular send action      | circular Start action with the same arrow treatment                  |
| Current checkout menu     | Local/Worktree selector using Clui's existing state                  |
| branch selector           | existing `BranchToolbarBranchSelector` in the attached context strip |

### Implementation plan

1. Add a reusable new-thread control trigger so harness and provider-specific options share the same
   compact footer treatment instead of repeating segmented-control styles.
2. Recompose `NewThreadView` as the t3code hero: full-height center, headline, 32px headline gap,
   `max-w-3xl` 22px composer, internal footer controls, and circular Start action.
3. Move Local/Worktree and the existing branch selector into a joined context strip beneath the
   composer, preserving deferred checkout, worktree creation, PR checkout, saved project defaults,
   and keyboard behavior.
4. Port only the t3code glass-shell/context-strip CSS required by this surface, using Clui's theme
   variables and providing the same fallback when `clip-path: shape()` is unavailable.
5. Keep image paste, prompt draft persistence, Fast, YOLO, Pi HTML/Terminal, Claude backend/model,
   harness switching, project switching, and `New project` behavior unchanged.
6. Make the footer horizontally scrollable and the attached context strip responsive so the layout
   preserves the t3code silhouette at desktop width without dropping Clui controls on narrow
   screens.
7. Add focused component/logic coverage for any extracted display mapping and retain the existing
   project-picker/navigation tests.
8. Verify on an isolated state directory and alternate ports only. Do not stop, restart, install,
   replace, or connect browser automation to the user's currently running Clui app.

### Screenshot-first acceptance

Capture from the isolated Clui build at 1440×900:

1. **Exact closed composition:** centered `What should we build in <project>?`, compact 22px composer
   directly below it, muted prompt, inline Clui controls, circular arrow action, and the narrower
   checkout/branch strip visibly attached below.
2. **Project menu open:** same composition remains stationary while the centered project radio menu
   opens below the dotted project name.
3. **Harness menu open:** harness icons and all enabled Clui harnesses appear from the first footer
   trigger without changing the composer geometry.
4. **Worktree state:** Local/Worktree selection and branch context remain inside the attached strip;
   selecting Worktree exposes the existing base-branch requirement without moving controls above
   the composer.
5. **Responsive state:** at mobile width the hero remains usable, footer controls scroll rather than
   wrap into a tall settings panel, and project/context menus remain keyboard accessible.

The running installed Clui app is explicitly out of scope for this pass and must remain untouched.
