# Session 2026-05-23 01:01 ecc-reconciliation

**Tool:** Claude Code
**Branch at end:** main
**Code baseline SHA at end:** a45111d
**Code worktree at end:** clean

## Done

- Resolved the one open question left by `2026-05-23-0047-memory-bootstrap`:
  what to do about the Claude-only ECC session machinery
  (`SessionStart` hook + `save-session` / `resume-session` skills).
- Investigated the hook: defined in
  `~/.claude/plugins/marketplaces/everything-claude-code/hooks/hooks.json`,
  global to all projects, not per-project disablable without fragile
  edits to the plugin file.
- Chose **convention over disable**. Updated `AGENTS.md` standing rule #4
  to reflect the truth: the ECC hook may fire and inject a "previous
  session summary"; the agent treats that summary as advisory only and
  always follows the `start session` protocol in `AGENTS.md`. The ECC
  skill names that collide with our verbs (`save session`, `resume
session`) are explicitly overridden by the protocol here.
- Updated `STATE.md`: removed the open ECC question; refreshed timestamp,
  baseline SHA, worktree state.
- Added the matching one-line entry to `DECISIONS.md`.

## Decisions

- ECC reconciliation: convention-based. The hook stays on globally
  (avoids fragile per-project plugin surgery); AGENTS.md is explicit
  that its protocol supersedes any ECC output for this project.

## Failed approaches (avoid retrying)

- Looking for a clean Claude Code mechanism to disable a marketplace
  plugin's hook per-project. As of writing, there isn't one without
  editing the plugin's own `hooks.json` (which would affect other
  projects and break on plugin updates).

## Next

1. Open a fresh **Codex CLI** session in this repo and type
   `start session`. Expected: it reads `STATE.md` + this file, runs the
   git baseline-SHA diff (no real code commits — only two memory commits
   filtered out), executes the staging/prod `verify-with:` commands,
   reports `:main` and `:v2.5.0` healthy at migration head
   `1779472699656`, and surfaces the resume prompt below.
2. Same in a fresh **Claude Code** session. The ECC hook will fire and
   load an old summary from `~/.claude/sessions/`; confirm the agent
   ignores it and follows AGENTS.md's `start session` protocol instead.
3. If both pass, run `publish session` (push) to put the two memory
   commits on the remote. The staging workflow ignores `docs/agent/**` +
   `AGENTS.md` + `CLAUDE.md` so no deploy will be triggered.
4. Optional: delete the pre-rebaseline DB backups on both servers once
   v2.5.0 has soaked another day or two
   (`~/e2t-prerebaseline-20260522-*.sql.gz`).

## Resume prompt

Phase 1 of the agent memory system is complete and the one open question
(ECC reconciliation) is now resolved. Two unpushed memory commits sit
on `main`: `a216c92` (bootstrap) and the imminent commit for this
session. Before pushing, verify the system works end-to-end: open a
fresh **Codex CLI** session and a fresh **Claude Code** session in
`/home/vladkarok/Work/email-to-telegram` and type `start session` in
each — confirm both follow AGENTS.md, read `STATE.md` and the latest
session file (this one), and run the staging/prod `verify-with:`
commands. In the Claude session, confirm the ECC SessionStart hook's
loaded summary is treated as advisory (the agent should follow
AGENTS.md, not the ECC summary). Once both pass, `publish session` to
push. Nothing else is in flight; the next thread is user-driven.
