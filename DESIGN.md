# Design

## Source of truth

- Status: Active
- Last refreshed: 2026-08-02
- Primary product surfaces: Project/thread sidebar, terminal threads, journey graph threads, settings, git/diff tools
- Evidence reviewed: `README.md`, `PLAN.md`, `AGENTS.md`, `apps/web/src/index.css`, `apps/web/src/routes/_chat.$threadId.tsx`, `apps/web/src/components/ThreadTerminalView.tsx`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/ui/`, `packages/contracts/src/orchestration.ts`, the current Journey header screenshot, and the Codex queued-composer interaction reference supplied on 2026-08-02

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
- Core routes/screens: Existing thread route branches to terminal or journey content. The journey surface consists of thin persistent header chrome, a pannable graph, expandable nodes, a bottom steering composer, and an optional activity/interaction area within expanded nodes.
- Content hierarchy: Journey destination and compact graph controls; actionable/current nodes; dependencies and spawned relationships; expanded node details; queued user steering and composer; node-linked live agent output inspector; completed history.

## Design principles

- Semantic graph first: Agents create and update meaningful nodes and edges; layout coordinates are a presentation concern.
- No speculative nodes: A node represents work that is starting now, a result that actually exists, or a concrete human/external blocker. Future roadmap items stay in the current node's detail until work begins; agents do not pre-populate `ready` proposals, tasks, research, or implementation placeholders.
- Progressive disclosure: Collapsed nodes are overview labels, not summaries: show only type, status, the complete wrapping title, expand/focus controls, and a compact agent-output action when real output exists. Node titles are never ellipsized or clipped; collapsed nodes grow vertically when a title needs more lines. Reveal summaries, forms, questionnaires, todos, artifacts, and activity only after expansion. Persistent actions stay in the node toolbar instead of being repeated in expanded content. Show each semantic fact once; do not pair a large type icon with a redundant type label.
- One node, one surface: Expanded content continues the node's existing surface. Use spacing, typography, and quiet dividers for hierarchy instead of nesting panels or cards inside the node.
- Expansion owns the foreground: An expanded node renders above every collapsed sibling, and a focused node renders above the expanded layer. Expanded content uses its intrinsic height; the graph canvas pans around it rather than adding an internal vertical scrollbar.
- Reversible focus: Node focus is distinct from expansion. It enlarges the chosen expanded node and fits it prominently into the canvas without changing durable graph data. The focused node's return control exits focus and collapses that node in one action; Escape or Fit graph may clear focus while preserving the expanded content.
- Keep work observable in context: A running node exposes its live agent transcript without replacing or obscuring the graph on desktop; the output inspector keeps the originating node visible as context.
- Steering is durable and asynchronous: The bottom composer accepts new prompts even while the agent is working. Prompts remain visible in FIFO order, can be removed before execution, survive thread switching, and automatically become the next agent turn when the harness is available.
- Autonomy is the default: Agent-owned work continues without a user click. A Journey pauses only for an explicit human interaction, a real external blocker, failure, cancellation, or completion. Node actions name the concrete recovery/decision they perform; there is no generic `Continue with agent` action.
- Graph progress is live state, not a final-report visualization: Agents create a running node before concrete research or implementation, mutate it at meaningful transitions, and record the real outcome when the work finishes. The final assistant message summarizes the run; it is not the primary graph transport.
- Status must not rely on color alone: Every status combines color with iconography, label, border/motion treatment, and accessible text.
- Free-form workflows, strict data: Journey shapes are unrestricted, while node types, statuses, interactions, and mutations use versioned validated contracts. Pi and Codex must produce the same graph contract so changing the harness does not change how the Journey behaves.
- Preserve user orientation: Layout changes are deliberate, animation is restrained, and expanded/selected state remains stable across graph updates. Layer spacing follows rendered node dimensions plus a compact edge gutter; speculative height estimates must not leave large empty bands in the graph. The header Fit graph action and canvas pan/zoom controls provide overview navigation without a persistent minimap covering the workspace.
- Tradeoffs: Prefer clear durable state and predictable layout over maximal autonomous agent freedom or visually dense live logs.

## Visual language

- Color: Reuse Clui theme tokens for chrome. Node types receive restrained accent families; statuses alter borders, badges, icons, and motion without replacing type identity.
- Typography: Reuse the application sans and monospace conventions. Node titles are compact but always shown in full and wrap across lines as needed; metadata and activity use smaller muted text; long content uses readable line height.
- Spacing/layout rhythm: Compact 4/8px-derived rhythm, low-padding collapsed nodes, readable graph gaps, and consistent node widths within a layout pass.
- Shape/radius/elevation: Reuse medium rounded cards, subtle borders, and low elevation. Selection and human-attention states may raise elevation slightly. Inside an expanded Journey node, prefer flat sections and separators; reserve bordered containers for actual controls such as inputs, not content grouping.
- Motion: Short layout transitions; a restrained activity pulse for running nodes; respect reduced motion.
- Imagery/iconography: Reuse Lucide icons. Do not use illustrative imagery in the journey workspace.

## Components

- Existing components to reuse: Buttons, badges, inputs, textareas, radio groups, checkboxes, collapsibles, scroll areas, tooltips, sheets, and app toolbar/sidebar patterns under `apps/web/src/components/ui/`.
- New/changed components: Journey surface, thin graph header with layout/fit controls, expandable bottom steering composer with a flat queued-prompt list, journey node with separate expand and focus controls, compact single-signal type metadata, intrinsic-height expanded details, flat interaction form renderer, todo list, activity feed, node-linked live agent output inspector, empty journey state, thread-surface selector, and Journey agent selector.
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
- Layout adaptations: The header keeps one compact row and hides secondary journey metadata before controls wrap. The composer is centered over the bottom canvas edge, expands upward, and leaves the graph visible around it. Expanded nodes cap width but not height; focused nodes receive a wider reading layout and are fitted to the available canvas; controls keep minimum touch targets; viewport can fit selected/all nodes. Long expanded content remains one intrinsic-height surface navigated with the graph viewport. The live output inspector shares horizontal space on desktop and overlays the canvas at narrow widths so it remains readable without permanently collapsing the graph.
- Touch/hover differences: Essential controls remain visible or focusable and never depend solely on hover.

## Interaction states

- Loading: Keep graph chrome visible with a centered lightweight spinner or skeleton nodes.
- Agent output: Opening live output is non-destructive and preserves graph position. Every node with real agent output exposes one compact, labelled icon action in its top-right toolbar in both collapsed and expanded states; the action indicates when that node's inspector is open and is not repeated inside expanded content. The inspector renders the selected harness's native live event stream, distinguishes a running stream from completed history, and can be closed without stopping the agent.
- Steering composer: The resting control is a compact single-line prompt. Focus or click expands it into a multiline composer. Enter queues/sends and Shift+Enter adds a newline. Busy submissions are labelled `Queued`; each waiting item can be removed. Finishing a run automatically starts the oldest queued prompt. Do not add a persistent helper footer for agent readiness, queue explanation, or keyboard shortcuts; the input placeholder, send control, and queued items communicate those states directly.
- Agent continuation: When no user prompt is queued, the oldest dependency-ready agent node starts automatically. `waitingForUser` nodes pause automatic continuation and render their explicit interaction. Failed nodes may expose a concrete retry action; completed, blocked, cancelled, superseded, and ordinary ready nodes do not show a generic continuation button.
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
- Compatibility constraints: Existing terminal threads and persisted orchestration events must decode unchanged. Journey graph data is separate from terminal scrollback and PTY lifecycle. Journey steering queues are per-thread UI state and normalize older persisted records that do not contain a queue. Pi uses registered extension tools and its structured transcript; Codex uses a thread-scoped stdio MCP server, non-interactive JSONL events, and resumable session IDs. Both harnesses mutate the same validated server-side Journey contract.
- Test/screenshot expectations: Unit-test graph reducers, layout direction, interaction validation, and thread-surface branching; run browser/component coverage where practical; require `bun lint` and `bun typecheck`.

## Open questions

- [ ] Decide whether user-authored edges/nodes become part of the MVP after agent-authored mutations are stable.
- [ ] Define the long-term conflict policy for parallel implementation nodes that touch overlapping files.

## Journey MVP architecture and invariants

Journey is a first-class thread surface, independent of the terminal harness. Its free-form shape is agent-authored: nodes and edges are semantic data, while XYFlow direction and coordinates are projections that may be recomputed or switched between top-to-bottom and left-to-right.

- The append-only event log is authoritative. Rebuildable projections expose the graph, node details, run summaries, deltas, and selected-fence output to the UI; the browser never becomes lifecycle authority.
- A logical run represents intent and lifecycle. Each run may have multiple physical attempts. Attempt IDs, wake generations, and fences prevent stale acknowledgements, output, cancellation, or reconciliation from mutating current state.
- Starting a root or child is atomic: node creation, run creation, dependency/admission checks, lease/permit ownership, and the first attempt start intent commit together or not at all.
- The server scheduler is dependency-aware and fair. It admits only ready DAG work, limits research concurrency, preserves round-robin/FIFO fairness, releases capacity selectively, and treats implementation writer leases separately from read-only research permits.
- Pi and Codex are run adapters, not graph authorities. Read-only research runs receive capability-scoped credentials; implementation runs receive a writer capability and canonical workspace identity. Both adapters emit the same validated Journey mutations.
- Reactor shutdown quiesces new admissions, cancels or fences active work, reconciles interrupted attempts, and resumes safely after restart. Durable output is stored by selected attempt fence and pushed as projection deltas; stale physical output is ignored.
- Policy is adaptive rather than a fixed workflow: a simple cohesive node may auto-continue, while complex research, questions, convergence, and current-revision approval pause for explicit interaction. Human-input nodes use writer leases/HITL ownership so only one authoritative responder resolves a request.
- Deleting a Journey cascades through nodes, dependencies, runs, attempts, leases, queued steering, artifacts, and output projections. The event remains replayable while derived records disappear or become tombstoned according to retention policy.

### Lifecycle

`draft → ready → running → waitingForUser | blocked → running → completed | failed | cancelled | superseded`.
Each transition is fenced and replayable. Failures retain the last valid projection and expose a concrete retry/reconcile action; restart recovery never assumes an unacknowledged attempt completed.

### MVP boundary

The MVP deliberately excludes issue-tracker synchronization, fixed workflow templates, general whiteboard editing, speculative future nodes, automatic conflict resolution for overlapping implementation work, and unbounded live transcript history. It focuses on one Journey thread, agent-authored graph mutations, Pi/Codex adapters, structured forms/questions, durable runs, and projection-driven graph rendering.
