# AI Review Workbench Plan

## Context

The current AI review work was implemented as a right-side overlay (`DiffAiReviewPanel`) on top of the existing diff panel, but that misses the desired product shape and can appear to load indefinitely. The requested direction is closer to PullBrief’s review workbench: a diff-first review surface where AI ranks/organizes the changed files and is available contextually while reading the diff.

Current implementation findings:

- `apps/web/src/components/DiffPanel.tsx` already has the core diff surface, file tree, viewed-file tracking, split/stacked toggle, inline edit, keyboard shortcuts (`j/k/v/e`, `⌘F`, `Esc`), and contextual “Ask Pi” on line/selection.
- `apps/web/src/components/DiffAiReviewPanel.tsx` is a separate slide-over panel that auto-runs a React Query request when opened.
- `apps/web/src/lib/providerReactQuery.ts` calls `api.orchestration.generateDiffReview` with `staleTime: Infinity` and only a generic loading UI.
- `apps/server/src/diffReview/Layers/DiffReview.ts` shells out to `pi` with a 180s timeout for structured JSON. Until that returns/errors, the UI shows “Generating review map…”, which is perceived as infinite loading.
- `apps/server/src/diffReview/DiffCollector.ts` already has useful branch/local/turn diff collection and risk pre-ranking logic.
- `../pullbrief` workbench patterns to reuse conceptually:
  - diff-first layout, not an AI side panel;
  - left rail can switch between AI-ranked order and folder tree, with ranking/risk still visible in the folder tree;
  - file summary cards explain why a file matters;
  - AI actions are contextual from the diff, not a permanent assistant panel;
  - quick answers appear near the selection; PullBrief also uses bottom drawers, but this CLUI pass will use an in-workbench stack instead.
- Prompt research findings from PullBrief plus OWASP/Anthropic best-practice docs:
  - treat patch text, file names, commit messages, and reviewer notes as untrusted data;
  - clearly separate instructions from user/diff data;
  - use explicit output contracts and validate structured output;
  - ground claims in evidence, cite file paths/lines when possible, and state uncertainty/missing context;
  - optimize for senior-reviewer speed with concise, direct output rather than generic AI review prose.

## Approach

Recommended direction: delete the current slide-over AI review and rebuild AI review from scratch as a separate AI Review workbench opened from the toolbar.

- Add a separate AI Review button next to the existing top-toolbar diff toggle (`apps/web/src/components/TerminalToolbar.tsx`). Keep the existing diff button/shortcut unchanged.
- Add a default AI Review shortcut: `mod+shift+a` (`⌘⇧A` on macOS, `Ctrl+Shift+A` elsewhere) with a new keybinding command such as `diff.aiReview.toggle`, scoped to `!terminalFocus`.
- Clicking the AI Review button or pressing the shortcut opens the review workbench and starts generation for the current diff scope immediately.
- Keep split/stacked as a diff-rendering preference inside the diff/workbench surface, not as the AI entry point.
- Make AI review generation explicit and recoverable: the AI Review toolbar button/shortcut is the generation trigger; inside the workbench show progress copy, timeout/error, retry/regenerate, and cached result reuse instead of an unbounded-feeling auto-load.
- Use the AI review result to reorder and annotate files in a left rail. `AI rank` mode orders by review priority; `Folder tree` mode keeps directory hierarchy but still displays rank/risk/review-mode decorations per file.
- Render review summaries inline above/inside each file section so the diff remains the primary surface.
- Preserve and extend existing contextual “Ask Pi” behavior for selected lines/ranges; avoid a permanent right-side assistant panel.
- Add persistent code highlighting for selected/stacked diff ranges.
- Add a diff context menu with actions: `Explain`, `Explain with additional instruction`, and `Add to AI stack`.
- Add an in-workbench AI stack/queue that lets the reviewer collect multiple highlighted ranges/instructions and send them to Pi all at once. Do not add a bottom drawer in this pass.

## Files to modify

Likely critical files:

- `apps/web/src/components/TerminalToolbar.tsx`
  - Add the separate AI Review button next to the existing diff toggle, with shortcut label.
  - Wire click behavior to open AI Review and trigger generation.
- `apps/web/src/routes/_chat.tsx`
  - Add global shortcut handling for the new AI Review keybinding command.
- `apps/web/src/components/DiffPanel.tsx`
  - Add AI Review/workbench route state (likely `diff=1` plus a review-mode search flag) without changing normal diff toggle behavior.
  - Replace overlay usage with workbench-mode rendering.
  - Sort/annotate files by AI review ranking when review mode is active.
  - Add selected/stacked range highlighting and context-menu actions for explain/instruction/stack.
- `apps/web/src/components/DiffAiReviewPanel.tsx`
  - Remove this slide-over implementation instead of refactoring it; rebuild the AI review UI as new workbench components.
- `apps/web/src/components/DiffFileTree.tsx`
  - Add AI rank/risk/review-mode decorations that remain visible in folder-tree mode, or create a sibling ranked rail while preserving tree decorations.
- `apps/web/src/components/DiffQuickAskPopover.tsx`
  - Reuse for contextual AI answers; extend or replace with workbench popovers for `Explain`, `Explain with additional instruction`, and stack submission results.
- `apps/web/src/lib/providerReactQuery.ts`
  - Change AI review query behavior so it does not feel like an infinite auto-load; add explicit/manual generation support and better retry/error policy.
- `packages/contracts/src/keybindings.ts`, `apps/server/src/keybindings.ts`, `apps/web/src/keybindings.ts`
  - Add `diff.aiReview.toggle` and default `mod+shift+a` binding, plus formatting/matching helpers and tests.
- `packages/contracts/src/orchestration.ts`, `packages/contracts/src/ipc.ts`, `packages/contracts/src/ws.ts`
  - Adjust contracts for richer ranked-file metadata and batched stack ask input/output if needed.
- `apps/server/src/diffReview/DiffCollector.ts`
  - Reuse and possibly enrich risk-ranked file metadata for the workbench.
- `apps/server/src/diffReview/Layers/DiffReview.ts`
  - Harden `pi` execution, errors, and output shape; possibly add a faster deterministic fallback result so the workbench can still render.
- `apps/server/src/wsServer.ts`, `apps/server/src/serverLayers.ts`
  - Update if new RPC methods or service dependencies are introduced.
- Tests:
  - `packages/contracts/src/keybindings.test.ts`
  - `apps/server/src/keybindings.test.ts`
  - `apps/server/src/diffReview/DiffCollector.test.ts`
  - `apps/server/src/wsServer.test.ts`
  - `apps/web/src/keybindings.test.ts`
  - `apps/web/src/wsNativeApi.test.ts`
  - Add/update web component tests where existing patterns allow.

## Reuse

Existing code/utilities to reuse:

- Diff parsing/rendering:
  - `parsePatchFiles`, `FileDiff`, `Virtualizer` in `apps/web/src/components/DiffPanel.tsx`
  - `@pierre/diffs/react` also exports `PatchDiff`, selected line ranges, and annotations if we choose to move closer to PullBrief’s line-selection pattern.
- File tree and viewed state:
  - `DiffFileTree` in `apps/web/src/components/DiffFileTree.tsx`
  - PullBrief’s `AI rank`/`Folder tree` concept from `../pullbrief/apps/web/src/components/review-workbench/review-workbench.tsx`
- Contextual AI:
  - `DiffQuickAskPopover` and `askDiffReview` RPC already support selected file/line/patch questions.
  - `@pierre/diffs/react` exposes selected line range and annotation APIs that can support persistent highlight/stack state instead of relying only on transient browser text selection.
- Diff collection/ranking:
  - `collectBranchDiff`, `collectLocalDiff`, `buildDiffReviewPromptContext`, and risk scoring in `apps/server/src/diffReview/DiffCollector.ts`
- Prompt design references:
  - Verified `../pullbrief/apps/web/src/lib/reports/prompts.ts` and `../pullbrief/docs/PI_PROMPTS.md`: senior-reviewer speed, untrusted diff inputs, evidence-grounded claims, ranked files, concise answers, explicit uncertainty, and strict output contracts.
  - Research checked OWASP LLM Prompt Injection Prevention and Anthropic prompt-engineering guidance: separate instructions from user data, use clear/direct instructions, structure complex prompts, validate outputs, and avoid allowing untrusted diff content to override system intent.

## Steps

- [x] Product decisions: separate AI Review button first; default shortcut `mod+shift+a`; generate on button/shortcut click; no bottom drawer; include highlight/context-menu/stack interactions.
- [x] Fix the loading failure first: make AI review generation click-triggered, bounded, retryable, and visibly failed if `pi` errors/times out.
- [x] Redesign the AI review prompts before implementation using the verified PullBrief/OWASP/Anthropic practices: untrusted-input framing, evidence grounding, concise senior-review output, and strict JSON schema.
- [x] Add keybinding support for `diff.aiReview.toggle` (`mod+shift+a`) in contracts/server/web helpers and global route handling.
- [x] Add the separate AI Review toolbar button next to the existing diff toggle; clicking it opens the workbench and starts generation for the current scope.
- [x] Refactor `DiffPanel` state from `aiReviewOpen` overlay to an explicit AI Review workbench route/search state.
- [x] Delete `DiffAiReviewPanel.tsx` and build new workbench components from scratch: overview card, ranked file rail/cards, test focus, follow-up questions.
- [x] Wire AI review results into file ordering/decorations while preserving folder tree navigation, rank/risk display, and viewed state.
- [x] Add persistent highlighted code ranges and a context menu with `Explain`, `Explain with additional instruction`, and `Add to AI stack`.
- [x] Add an in-workbench stack queue and batched submit path so multiple selected ranges/instructions can be sent to Pi at once.
- [x] Add server hardening around `pi` execution and structured output errors; consider a deterministic fallback ranking from `DiffCollector` for immediate UI feedback.
- [x] Add/update tests for the backend diff-review path and the frontend/native API wiring.
- [x] Manually verify the workbench with branch diff, working-tree diff, turn diff, no-change diff, non-git project, and `pi` unavailable/timeout cases.

## Verification

- Ran focused server/web/contract tests for diff review collection, WS dispatch, native API wiring, route search, and keybindings:
  `bunx vitest run apps/web/src/keybindings.test.ts apps/web/src/diffRouteSearch.test.ts apps/web/src/wsNativeApi.test.ts packages/contracts/src/keybindings.test.ts apps/server/src/keybindings.test.ts apps/server/src/diffReview/DiffCollector.test.ts apps/server/src/wsServer.test.ts`
- Ran typecheck for contracts/server/web:
  `bun run --cwd packages/contracts typecheck`, `bun run --cwd apps/server typecheck`, `bun run --cwd apps/web typecheck`.
- Manual verification in the app:
  - open a thread diff;
  - use the new separate AI Review button and `⌘⇧A` / `Ctrl+Shift+A` shortcut;
  - confirm review generation starts on click/shortcut and completes or fails with a visible retryable error;
  - verify AI-ranked files can be read in order;
  - toggle back to normal diff view without losing scroll/viewed state;
  - right-click/select/highlight lines and use Explain, Explain with instruction, and Add to AI stack;
  - send a multi-item stack to Pi and verify the answer references the selected files/ranges;
  - check behavior when `pi` is missing or times out.

## Resolved decisions

1. Use a separate AI Review button first, placed next to the existing diff toggle.
2. Use `mod+shift+a` as the default AI Review shortcut unless implementation finds a platform conflict.
3. Generate the AI review when the button/shortcut is clicked.
4. Do not add the PullBrief bottom drawer in this pass.
5. Include persistent code highlighting, contextual explain actions, explain-with-instruction, and a stack queue for batching multiple selected ranges/instructions to Pi.
