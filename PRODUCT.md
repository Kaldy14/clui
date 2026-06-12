# Product

## Register

product

## Users

Developers who live in the terminal and run coding agents (Claude Code, pi) all day. They are power users: keyboard-first, many concurrent sessions, low tolerance for friction or visual noise. Primary context is a desktop app open for hours next to an editor, usually in dark mode. The job to be done: spin up, organize, and resume agent coding sessions across projects, branches, and worktrees without ceremony.

## Product Purpose

Clui is "the CLI with a UI": a project-organized, thread-based terminal multiplexer for terminal-native coding agents. It wraps real PTY terminals (xterm.js + node-pty) with project/thread organization, branch/worktree management, and a built-in git workflow. It does not replace the CLI; it organizes it. Success means a user manages dozens of agent threads and never feels the UI getting between them and the terminal.

## Brand Personality

Quiet precision. Calm, focused, keyboard-first: the tool disappears into the task. Reference feel: Linear, Raycast. Confidence through restraint, not decoration. Copy is short, lowercase-calm, never chatty.

## Anti-references

- Generic SaaS gloss: gradient heroes, glassmorphism cards, big-number dashboards.
- Neon hacker aesthetic: green-on-black, glow effects, cyberpunk styling.
- Consumer-app playfulness: bubbly shapes, emoji-heavy copy, mascots.
- Heavy enterprise chrome: dense toolbars, boxed-in panels, visible borders everywhere.

## Design Principles

1. **The terminal is the hero.** Chrome around it stays quiet; accent color marks state and primary actions only.
2. **Keyboard-first, always.** Every flow has a keyboard path; hints teach shortcuts instead of adding buttons.
3. **Earned familiarity.** Standard affordances (segmented controls, composers, selects) over invented ones; users should trust each control on sight.
4. **Restraint by default.** Tinted neutrals, one accent, sparse borders. Danger states (e.g. YOLO mode) are the only loud thing on a screen.
5. **Fast and steady under load.** No decorative motion; transitions 150–250ms, state-driven only. Nothing shifts layout while a session streams.

## Accessibility & Inclusion

WCAG AA contrast targets on text and controls. `prefers-reduced-motion` already suppresses animations and must stay respected. All interactive controls keyboard-reachable with visible focus; destructive/dangerous toggles communicate by label and color, never color alone.
