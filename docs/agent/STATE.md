# State

**Protocol version:** 2
**Updated:** 2026-05-24T15:39:36+02:00
**Tool last wrote:** Codex CLI
**Branch:** main
**Last code commit:** 9fb9c5704308f0cf6ac3004c8f622465e2a000b6 chore(agent): save session — v2 acceptance tests (7, 8) pass; fix paths-ignore for .codex/\*\*
**Code worktree:** clean
**Tracked dirty code paths:** none
**Relevant untracked code paths:** none
**Active task:** none
**Latest session read:** docs/agent/sessions/2026-05-24-152046-claude-memory-system-v2-migration.md

## Now

Codex-side cross-tool acceptance is in progress. Codex successfully
followed `start session`, read the v2 protocol/state/latest handoff,
ran `drift-check.sh`, and checkpointed a stale `STATE.md` baseline
from `69f83cc` to `9fb9c57`. No code drift or untracked files.

## Resume prompt

Open `docs/agent/PROTOCOL.md` for the v2 manual. STATE.md and
session files are in v2 format with `validate-memory.sh` preflight.
Codex CLI has completed the `start session` half of cross-tool
acceptance and is saving a Codex handoff. Next, switch back to Claude
Code in this clone and type `start session`; verify Claude reads the
new Codex session and reports the same current goal, clean code
worktree, no active task, and next step.

## In flight

- Cross-tool acceptance tests (1, 2, 6) partially complete: Codex
  `start session` succeeded and this `save session` provides the
  Codex → Claude handoff to verify next.

## Next

1. Switch back to Claude Code and run `start session`; verify Claude
   reads the Codex handoff correctly.
2. Decide when to `publish session` — the workflow change will
   trigger one staging redeploy on push.
3. Delete pre-rebaseline DB backups once v2.5.0 has soaked
   another day (still in soak):
   - staging: `ssh kc-vprojects 'rm /home/vladkarok/e2t-prerebaseline-20260522-200658.sql.gz'`
   - prod: `ssh emails-tg-prod 'rm /home/vladkarok/e2t-prerebaseline-20260522-201231.sql.gz'`

## Open questions / blockers

- None blocking.

## Environments

- **Staging (`kc-vprojects`):** image `ghcr.io/vladkarok/email-to-telegram:main`,
  healthy, migration head `1779472699656` (squashed baseline)
  verify-with: `ssh kc-vprojects 'docker ps --filter name=email-to-telegram-app --format "{{.Image}} {{.Status}}"'`
- **Prod (`emails-tg-prod`):** image `ghcr.io/vladkarok/email-to-telegram:v2.5.0`,
  healthy, migration head `1779472699656` (squashed baseline)
  verify-with: `ssh emails-tg-prod 'docker ps --filter name=email-to-telegram-app --format "{{.Image}} {{.Status}}"'`
- **Migration head (either host):** `ssh <host> 'docker exec email-to-telegram-postgres-1 psql -U emailtelegram -d emailtelegram -tAc "select max(created_at) from drizzle.__drizzle_migrations"'`
