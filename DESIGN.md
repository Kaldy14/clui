# Design

## Source of truth

- Status: Active
- Last refreshed: 2026-08-02
- Primary product surfaces: Project/thread sidebar, terminal threads, journey graph threads, settings, git/diff tools
- Evidence reviewed: `README.md`, `PLAN.md`, `AGENTS.md`, `apps/web/src/index.css`, `apps/web/src/routes/_chat.$threadId.tsx`, `apps/web/src/components/ThreadTerminalView.tsx`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/ui/`, `packages/contracts/src/orchestration.ts`

## Brand

- Personality: Focused, technical, calm, direct, and information-dense without feeling crowded.
- Trust signals: Durable state, visible agent activity, explicit waiting/approval states, predictable controls, inspectable artifacts, and reversible actions.
- Avoid: Decorative dashboards, novelty gradients, ambiguous agent autonomy, hidden state transitions, excessive animation, and terminal-themed imitation inside non-terminal surfaces.

## Product goals

- Goals: Make terminal-native agents manageable across projects and threads; add a journey surface where agents and the user can build and resolve a free-form work graph; make current work, blockers, decisions, and human input immediately legible.
- Non-goals: Enforce a fixed workflow shape; require an issue tracker; turn the journey canvas into a general-purpose whiteboard; replace terminal threads.
- Success signals: A user can start a journey with either Pi or Codex, understand its frontier at a glance, expand or focus a node, answer a structured request, observe agent work, switch graph direction, and return later without losing state.

## Personas and jobs

- Primary personas: A technical solo developer coordinating one or more coding agents across real repositories.
- User jobs: Explore ambiguous work, answer agent questions, validate proposals, track tasks and todo groups, inspect implementation progress, and understand what is blocked or active.
- Key contexts of use: Desktop-first development sessions, long-running agent work, rapid switching between terminal and journey threads, and recovery after app or process restarts.

## Information architecture

- Primary navigation: Existing project/thread sidebar remains the entry point. The standard new-thread composer switches between a terminal session and a journey; Journey mode exposes an agent selector limited to Pi and Codex. The sidebar has one creation action for both.
- Core routes/screens: Existing thread route branches to terminal or journey content. The journey surface consists of a graph toolbar, pannable graph, expandable nodes, and an optional activity/interaction area within expanded nodes.
- Content hierarchy: Journey destination and controls; actionable/current nodes; dependencies and spawned relationships; expanded node details; node-linked live agent output inspector; completed history.

## Design principles

- Semantic graph first: Agents create and update meaningful nodes and edges; layout coordinates are a presentation concern.
- Progressive disclosure: Collapsed nodes are overview labels, not summaries: show only type, status, a single-line title, and the expand/focus controls. Reveal summaries, forms, questionnaires, todos, artifacts, and activity only after expansion. Show each semantic fact once; do not pair a large type icon with a redundant type label.
- One node, one surface: Expanded content continues the node's existing surface. Use spacing, typography, and quiet dividers for hierarchy instead of nesting panels or cards inside the node.
- Expansion owns the foreground: An expanded node renders above every collapsed sibling, and a focused node renders above the expanded layer. Expanded content uses its intrinsic height; the graph canvas pans around it rather than adding an internal vertical scrollbar.
- Reversible focus: Node focus is distinct from expansion. It enlarges the chosen expanded node and fits it prominently into the canvas without changing durable graph data; Escape, the node control, or Fit graph restores the overview.
- Keep work observable in context: A running node exposes its live agent transcript without replacing or obscuring the graph on desktop; the output inspector keeps the originating node visible as context.
- Graph progress is live state, not a final-report visualization: Agents create a running node before concrete research or implementation, mutate it at meaningful transitions, and record the real outcome when the work finishes. The final assistant message summarizes the run; it is not the primary graph transport.
- Status must not rely on color alone: Every status combines color with iconography, label, border/motion treatment, and accessible text.
- Free-form workflows, strict data: Journey shapes are unrestricted, while node types, statuses, interactions, and mutations use versioned validated contracts. Pi and Codex must produce the same graph contract so changing the harness does not change how the Journey behaves.
- Preserve user orientation: Layout changes are deliberate, animation is restrained, and expanded/selected state remains stable across graph updates. Layer spacing follows rendered node dimensions plus a compact edge gutter; speculative height estimates must not leave large empty bands in the graph. The minimap shows status-colored node silhouettes and a restrained viewport mask so it remains a useful overview at every pan position.
- Tradeoffs: Prefer clear durable state and predictable layout over maximal autonomous agent freedom or visually dense live logs.

## Visual language

- Color: Reuse Clui theme tokens for chrome. Node types receive restrained accent families; statuses alter borders, badges, icons, and motion without replacing type identity.
- Typography: Reuse the application sans and monospace conventions. Node titles are compact; metadata and activity use smaller muted text; long content uses readable line height.
- Spacing/layout rhythm: Compact 4/8px-derived rhythm, low-padding collapsed nodes, readable graph gaps, and consistent node widths within a layout pass.
- Shape/radius/elevation: Reuse medium rounded cards, subtle borders, and low elevation. Selection and human-attention states may raise elevation slightly. Inside an expanded Journey node, prefer flat sections and separators; reserve bordered containers for actual controls such as inputs, not content grouping.
- Motion: Short layout transitions; a restrained activity pulse for running nodes; respect reduced motion.
- Imagery/iconography: Reuse Lucide icons. Do not use illustrative imagery in the journey workspace.

## Components

- Existing components to reuse: Buttons, badges, inputs, textareas, radio groups, checkboxes, collapsibles, scroll areas, tooltips, sheets, and app toolbar/sidebar patterns under `apps/web/src/components/ui/`.
- New/changed components: Journey surface, graph toolbar, status-aware interactive minimap, journey node with separate expand and focus controls, compact single-signal type metadata, intrinsic-height expanded details, flat interaction form renderer, todo list, activity feed, node-linked live agent output inspector, empty journey state, thread-surface selector, and Journey agent selector.
- Variants and states: Node types include goal, question, proposal, task, todo group, research, implementation, review, and note. Statuses include draft, ready, running, waiting for user, blocked, completed, failed, cancelled, and superseded.
- Token/component ownership: Journey-specific accent mappings live with the journey UI; shared theme primitives remain in `apps/web/src/index.css` and existing UI components.

## Accessibility

- Target standard: WCAG 2.2 AA for the journey surface.
- Keyboard/focus behavior: Toolbar and expanded node controls are keyboard reachable; focus mode has explicit enter/exit labels and exits with Escape; clicking interactive content does not drag the node; focus remains visible; graph nodes expose meaningful accessible labels.
- Contrast/readability: Type and status accent combinations must pass contrast in light and dark themes; text never depends on low-opacity color alone.
- Screen-reader semantics: Nodes identify type, title, and status; todos use lists and checkboxes; forms use labels/fieldsets; activity updates use restrained live regions.
- Reduced motion and sensory considerations: Disable activity pulsing and animated layout transitions under `prefers-reduced-motion`.

## Responsive behavior

- Supported breakpoints/devices: Desktop and tablet are primary; narrow browser windows remain usable.
- Layout adaptations: Graph toolbar wraps; expanded nodes cap width but not height; focused nodes receive a wider reading layout and are fitted to the available canvas; controls keep minimum touch targets; viewport can fit selected/all nodes. Long expanded content remains one intrinsic-height surface navigated with the graph viewport. The live output inspector shares horizontal space on desktop and overlays the canvas at narrow widths so it remains readable without permanently collapsing the graph.
- Touch/hover differences: Essential controls remain visible or focusable and never depend solely on hover.

## Interaction states

- Loading: Keep graph chrome visible with a centered lightweight spinner or skeleton nodes.
- Agent output: Opening live output is non-destructive and preserves graph position. The inspector renders the selected harness's native live event stream, distinguishes a running stream from completed history, and can be closed without stopping the agent.
- Empty: Prompt for a destination and offer to create the first node.
- Error: Preserve the last valid graph, identify the failed action/run, and provide retry or dismiss controls.
- Success: Completed nodes remain visible with concise outcome summaries; journey completion is explicit, not inferred only from an empty frontier.
- Disabled: Explain why an action is unavailable, especially for blocked nodes and incomplete required form fields.
- Offline/slow network: Optimistic purely visual preferences are local; graph mutations wait for server acknowledgement and retain user input on failure.

## Content voice

- Tone: Concise, factual, collaborative, and action-oriented.
- Terminology: Journey, node, dependency, spawned node, task, todo, waiting for you, agent working, blocked, completed.
- Microcopy rules: Prefer direct verbs (`Answer`, `Approve`, `Retry`, `Add node`); name nodes rather than referring to opaque IDs; state who or what is blocking progress.

## Implementation constraints

- Framework/styling system: React 19, Tailwind CSS v4, Base UI primitives, Zustand, TanStack Router/Query, Effect Schema contracts, WebSocket RPC, and SQLite projections.
- Design-token constraints: Reuse existing semantic tokens and dark-mode behavior; add no competing design-system layer.
- Performance constraints: Avoid continuous force simulation; update only changed graph elements; cap rendered live activity; keep layout asynchronous or bounded for larger graphs.
- Compatibility constraints: Existing terminal threads and persisted orchestration events must decode unchanged. Journey graph data is separate from terminal scrollback and PTY lifecycle. Pi uses registered extension tools and its structured transcript; Codex uses a thread-scoped stdio MCP server, non-interactive JSONL events, and resumable session IDs. Both harnesses mutate the same validated server-side Journey contract.
- Test/screenshot expectations: Unit-test graph reducers, layout direction, interaction validation, and thread-surface branching; run browser/component coverage where practical; require `bun lint` and `bun typecheck`.

## Open questions

- [ ] Decide whether user-authored edges/nodes become part of the MVP after agent-authored mutations are stable.
- [ ] Define the long-term conflict policy for parallel implementation nodes that touch overlapping files.
