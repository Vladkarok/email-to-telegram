# State

**Protocol version:** 2
**Updated:** 2026-05-24T15:20:46+02:00
**Tool last wrote:** Claude Code
**Branch:** main
**Last code commit:** d20cf2600a7402fa3c679c5e4bd5aa7c89ccf36b chore: gitignore tmp/, untrack scratch plan file
**Code worktree:** clean
**Tracked dirty code paths:** none
**Relevant untracked code paths:** none
**Active task:** memory-system-v2-migration
**Latest session read:** docs/agent/sessions/2026-05-24-1345-drop-cd-wrapper-from-protocol.md

## Now

Migrating the agent memory system from v1 (heavy AGENTS.md inline
protocol, DECISIONS.md-only) to **v2 hybrid** (lean AGENTS.md +
on-demand `docs/agent/PROTOCOL.md` + scripts + JOURNAL.md, with
DECISIONS.md retained as the email-to-telegram fork's addition).
See `docs/agent/tasks/memory-system-v2-migration.md`.
Project at **v2.5.0** on staging and prod, healthy.

## Resume prompt

The migration is mid-flight. Files written so far:
`docs/agent/scripts/{drift-check,latest-session,validate-memory}.sh`
(allowlisted), `docs/agent/PROTOCOL.md` (full v2 manual with fork
deltas documented), `docs/agent/JOURNAL.md` (seeded), `.codex/notes.md`
(replaces previous gitignored empty `.codex` file — backup at
`.codex.bak` pending removal), new lean `AGENTS.md`, new `CLAUDE.md`
adapter, this `STATE.md` rewritten to v2 schema, `.gitignore` adjusted
for `.codex/*` + `!.codex/notes.md`. **Next concrete step:** finish
this `save session` — create the v2-format session file, run
`docs/agent/scripts/validate-memory.sh` (must print `OK`), then narrow
stage all migration files and commit. After that, mark task plan
steps `[x]` and decide on the `.codex.bak` cleanup.

## In flight

- Memory-system v2 migration commit not yet made; many files in
  worktree.
- `.codex.bak` (was the gitignored empty marker file before the
  rename) — decision pending whether to delete or restore.

## Next

1. Create v2-format session file
   `docs/agent/sessions/2026-05-24-152046-claude-memory-system-v2-migration.md`.
2. Update `docs/agent/tasks/memory-system-v2-migration.md`: mark
   steps 1, 3, 4, 5, 6, 7 as `[x]`; step 9 (acceptance tests) as
   `[~]` after `validate-memory.sh` passes.
3. Append the v2-migration entry to `DECISIONS.md`.
4. Run `docs/agent/scripts/validate-memory.sh` — must `OK`.
5. Narrow-stage migration files (all under `docs/agent/`,
   `AGENTS.md`, `CLAUDE.md`, `.codex/notes.md`, `.gitignore`,
   `.claude/settings.local.json` is gitignored so won't appear),
   commit as `chore(agent): bootstrap memory system v2 (lean root +
on-demand protocol + scripts + JOURNAL, keep DECISIONS index)`.
6. Run remaining acceptance tests (Test 7 + Test 8 are repo-local
   and trivial; Tests 1, 2, 6 require cross-tool / cross-clone and
   can be soaked later; Test 5 already proven on v1).
7. After acceptance, delete `.codex.bak`.
8. Pre-rebaseline DB backups: still pending soak — delete after
   v2.5.0 has another day.

## Open questions / blockers

- `.codex.bak` was a 0-byte file with no git history. Likely a Codex
  CLI marker from `~/Projects/email-to-telegram` of some kind. Safe to
  delete after acceptance — but verify by running Codex CLI in this
  repo once and confirming it doesn't recreate the file at root.

## Environments

- **Staging (`kc-vprojects`):** image `ghcr.io/vladkarok/email-to-telegram:main`,
  healthy, migration head `1779472699656` (squashed baseline)
  verify-with: `ssh kc-vprojects 'docker ps --filter name=email-to-telegram-app --format "{{.Image}} {{.Status}}"'`
- **Prod (`emails-tg-prod`):** image `ghcr.io/vladkarok/email-to-telegram:v2.5.0`,
  healthy, migration head `1779472699656` (squashed baseline)
  verify-with: `ssh emails-tg-prod 'docker ps --filter name=email-to-telegram-app --format "{{.Image}} {{.Status}}"'`
- **Migration head (either host):** `ssh <host> 'docker exec email-to-telegram-postgres-1 psql -U emailtelegram -d emailtelegram -tAc "select max(created_at) from drizzle.__drizzle_migrations"'`
