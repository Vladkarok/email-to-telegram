# State

**Protocol version:** 2
**Updated:** 2026-05-24T15:29:28+02:00
**Tool last wrote:** Claude Code
**Branch:** main
**Last code commit:** 69f83cc3f420041142cd41b887e912eaf84c23e5 chore(agent): bootstrap memory system v2 — lean root + on-demand protocol + scripts + JOURNAL, keep DECISIONS index
**Code worktree:** clean
**Tracked dirty code paths:** none
**Relevant untracked code paths:** none
**Active task:** none
**Latest session read:** docs/agent/sessions/2026-05-24-152046-claude-memory-system-v2-migration.md

## Now

Memory system v2 migration **complete**. Project at v2.5.0 on
staging and prod, healthy. Local-only acceptance tests (Test 7 +
Test 8) passed. Discovered and fixed a paths-ignore gap:
`deploy-staging.yml` was missing `.codex/**` (memory pushes that
touch the new Codex adapter would have triggered deploys). Fix
staged; commit pending.

## Resume prompt

Open `docs/agent/PROTOCOL.md` for the v2 manual. STATE.md and
session files are now in v2 format with `validate-memory.sh`
preflight. The `.github/workflows/deploy-staging.yml` change is
in-flight: it adds `.codex/**` to `paths-ignore`. **This is a
code-path change** — the next `publish session` that includes it
will trigger a (no-op) staging deploy. Either commit + publish it
now (intentional bounce, takes ~2 minutes), or bundle into the
next real code push. Cross-tool acceptance (Tests 1, 2, 6) still
outstanding: open Codex CLI in this clone, type `start session`,
verify it follows the same v2 protocol; then do a `save session`
from Codex and switch back to Claude to verify Claude reads
Codex's handoff identically.

## In flight

- Cross-tool acceptance tests (1, 2, 6) pending — needs Codex CLI
  in this clone (user confirmed Codex CLI is installed).

## Next

1. Cross-tool soak: open Codex CLI here, `start session`, then
   `save session` from Codex; switch back to Claude, `start
session`, verify Claude reads Codex's handoff correctly.
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
