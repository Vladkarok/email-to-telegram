# Codex CLI specifics

Codex CLI's adapter on top of the shared `AGENTS.md` contract. Read
`AGENTS.md` first; this file only adds Codex-specific clarifications.

## Project state lives in the repo

Canonical project state is `docs/agent/STATE.md` plus the latest
session handoff in `docs/agent/sessions/`. The shared protocol is
`docs/agent/PROTOCOL.md`. Read those on `start session`.

## Planning and progress

- Use Codex's own step tracking as an in-session scratchpad — it is
  in-context only, not durable.
- Mirror durable progress to `docs/agent/tasks/<slug>.md` at
  `checkpoint` and `save session`.

## Codex memories and config

- Codex local memories (machine-local) and any Codex hooks/config are
  **advisory only**. Do not use them as source of truth.
- If they conflict with `docs/agent/PROTOCOL.md`, the protocol wins.

## ECC / marketplace skills

If a Codex skill or hook shares a name with one of the four verbs
(`start session`, `checkpoint`, `save session`, `publish session`),
execute the repo protocol — not the skill.

## Tool tag in session filenames

When you create a session file as Codex CLI, use `codex` as the
`<tool>` segment in the filename:
`docs/agent/sessions/YYYY-MM-DD-HHMMSS-codex-<slug>.md`.
`validate-memory.sh` enforces this — `claude|codex` are the only
accepted tokens unless the regex is extended.
