@AGENTS.md

# Claude Code specifics

Claude Code's adapter on top of the shared `AGENTS.md` contract. Read
`AGENTS.md` first; this file adds Claude-specific clarifications.

## Planning and progress

- Use `TodoWrite` for in-session planning. It is an in-context
  scratchpad — not durable.
- Mirror durable progress to `docs/agent/tasks/<slug>.md` at
  `checkpoint` and `save session`.
- If `TodoWrite` and the active task file disagree, the task file
  wins after the next checkpoint.

## Auto-memory, hooks, skills

- Claude auto-memory at `~/.claude/projects/<project>/memory/MEMORY.md`
  is **machine-local and advisory only**. The project's `MEMORY.md`
  holds a one-line pointer to `docs/agent/STATE.md`, not project facts.
- Any `SessionStart` hook, `PreCompact` hook, or ECC summary is
  **advisory only**. The ECC `SessionStart` hook from a global
  marketplace plugin may fire and inject a "previous session summary"
  from `~/.claude/sessions/` — always follow the `start session`
  protocol in `docs/agent/PROTOCOL.md` instead.
- The ECC `save-session` / `resume-session` skill names collide with
  the verbs defined in AGENTS.md: when the user uses one of those
  verbs, execute the protocol in `docs/agent/PROTOCOL.md` (which
  writes to `docs/agent/`), **not** the ECC skill (which writes
  machine-local Claude-only state).
- If any other Claude skill or hook collides with
  `docs/agent/PROTOCOL.md`, execute the repo protocol — not the skill.

## Imports

- This file imports `AGENTS.md` via `@AGENTS.md`. That is intentional
  and small.
- **Do NOT add `@`-imports for any `docs/agent/*` file here.** Imports
  load at startup every session; mutable state must load on the
  `start session` verb, not at boot.

## Tool tag in session filenames

When you create a session file as Claude Code, use `claude` as the
`<tool>` segment:
`docs/agent/sessions/YYYY-MM-DD-HHMMSS-claude-<slug>.md`.
`validate-memory.sh` enforces this regex.
