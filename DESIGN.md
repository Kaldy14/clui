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
- Success signals: A user can start a journey, understand its frontier at a glance, expand a node, answer a structured request, observe agent work, switch graph direction, and return later without losing state.

## Personas and jobs

- Primary personas: A technical solo developer coordinating one or more coding agents across real repositories.
- User jobs: Explore ambiguous work, answer agent questions, validate proposals, track tasks and todo groups, inspect implementation progress, and understand what is blocked or active.
- Key contexts of use: Desktop-first development sessions, long-running agent work, rapid switching between terminal and journey threads, and recovery after app or process restarts.

## Information architecture

- Primary navigation: Existing project/thread sidebar remains the entry point. A thread has a surface (`terminal` or `journey`); terminal harness selection remains independent.
- Core routes/screens: Existing thread route branches to terminal or journey content. The journey surface consists of a graph toolbar, pannable graph, expandable nodes, and an optional activity/interaction area within expanded nodes.
- Content hierarchy: Journey destination and controls; actionable/current nodes; dependencies and spawned relationships; expanded node details; run/activity detail; completed history.

## Design principles

- Semantic graph first: Agents create and update meaningful nodes and edges; layout coordinates are a presentation concern.
- Progressive disclosure: Nodes remain scannable when collapsed and reveal forms, questionnaires, todos, artifacts, and activity when expanded.
- Status must not rely on color alone: Every status combines color with iconography, label, border/motion treatment, and accessible text.
- Free-form workflows, strict data: Journey shapes are unrestricted, while node types, statuses, interactions, and mutations use versioned validated contracts.
- Preserve user orientation: Layout changes are deliberate, animation is restrained, and expanded/selected state remains stable across graph updates.
- Tradeoffs: Prefer clear durable state and predictable layout over maximal autonomous agent freedom or visually dense live logs.

## Visual language

- Color: Reuse Clui theme tokens for chrome. Node types receive restrained accent families; statuses alter borders, badges, icons, and motion without replacing type identity.
- Typography: Reuse the application sans and monospace conventions. Node titles are compact; metadata and activity use smaller muted text; long content uses readable line height.
- Spacing/layout rhythm: Compact 4/8px-derived rhythm, generous canvas whitespace, and consistent node widths within a layout pass.
- Shape/radius/elevation: Reuse medium rounded cards, subtle borders, and low elevation. Selection and human-attention states may raise elevation slightly.
- Motion: Short layout transitions; a restrained activity pulse for running nodes; respect reduced motion.
- Imagery/iconography: Reuse Lucide icons. Do not use illustrative imagery in the journey workspace.

## Components

- Existing components to reuse: Buttons, badges, inputs, textareas, radio groups, checkboxes, collapsibles, scroll areas, tooltips, sheets, and app toolbar/sidebar patterns under `apps/web/src/components/ui/`.
- New/changed components: Journey surface, graph toolbar, journey node, node status indicator, interaction form renderer, todo list, activity feed, empty journey state, and thread-surface selector.
- Variants and states: Node types include goal, question, proposal, task, todo group, research, implementation, review, and note. Statuses include draft, ready, running, waiting for user, blocked, completed, failed, cancelled, and superseded.
- Token/component ownership: Journey-specific accent mappings live with the journey UI; shared theme primitives remain in `apps/web/src/index.css` and existing UI components.

## Accessibility

- Target standard: WCAG 2.2 AA for the journey surface.
- Keyboard/focus behavior: Toolbar and expanded node controls are keyboard reachable; clicking interactive content does not drag the node; focus remains visible; graph nodes expose meaningful accessible labels.
- Contrast/readability: Type and status accent combinations must pass contrast in light and dark themes; text never depends on low-opacity color alone.
- Screen-reader semantics: Nodes identify type, title, and status; todos use lists and checkboxes; forms use labels/fieldsets; activity updates use restrained live regions.
- Reduced motion and sensory considerations: Disable activity pulsing and animated layout transitions under `prefers-reduced-motion`.

## Responsive behavior

- Supported breakpoints/devices: Desktop and tablet are primary; narrow browser windows remain usable.
- Layout adaptations: Graph toolbar wraps; expanded nodes cap width; controls keep minimum touch targets; viewport can fit selected/all nodes.
- Touch/hover differences: Essential controls remain visible or focusable and never depend solely on hover.

## Interaction states

- Loading: Keep graph chrome visible with a centered lightweight spinner or skeleton nodes.
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
- Compatibility constraints: Existing terminal threads and persisted orchestration events must decode unchanged. Journey graph data is separate from terminal scrollback and PTY lifecycle.
- Test/screenshot expectations: Unit-test graph reducers, layout direction, interaction validation, and thread-surface branching; run browser/component coverage where practical; require `bun lint` and `bun typecheck`.

## Open questions

- [ ] Decide which real agent runtime first receives journey graph tools after the interaction MVP proves the graph model.
- [ ] Decide whether user-authored edges/nodes become part of the MVP after agent-authored mutations are stable.
- [ ] Define the long-term conflict policy for parallel implementation nodes that touch overlapping files.
