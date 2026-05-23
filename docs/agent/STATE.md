# State

**Updated:** 2026-05-23T02:08+02:00
**Branch:** main
**Code baseline SHA:** a216c92
**Code worktree:** clean
**Uncommitted code paths:** none

## Now

Project at **v2.5.0** on staging and prod. Agent memory protocol stable and
fully aligned across `AGENTS.md` (live), `tmp/agent-memory-plan-final.md`
(reproducible plan), and the actual `docs/agent/` files. Cosmetic
template-alignment tweaks just applied so the plan and the live protocol are
syntactically as well as semantically identical.

## Environments

- **Staging (`kc-vprojects`):** image `ghcr.io/vladkarok/email-to-telegram:main`,
  healthy, migration head `1779472699656` (squashed baseline)
  verify-with: `ssh kc-vprojects 'docker ps --filter name=email-to-telegram-app --format "{{.Image}} {{.Status}}"'`
- **Prod (`emails-tg-prod`):** image
  `ghcr.io/vladkarok/email-to-telegram:v2.5.0`, healthy, migration head
  `1779472699656` (squashed baseline)
  verify-with: `ssh emails-tg-prod 'docker ps --filter name=email-to-telegram-app --format "{{.Image}} {{.Status}}"'`
- **Migration head (either host):**
  `ssh <host> 'docker exec email-to-telegram-postgres-1 psql -U emailtelegram -d emailtelegram -tAc "select max(created_at) from drizzle.__drizzle_migrations"'`

## In flight

- Seven local memory commits await `publish session`: bootstrap → ECC →
  pass3 → narrow-staging → worktree-split → this template alignment.

## Next

1. Fresh Codex CLI / Claude Code session, `start session` — end-to-end test.
2. `publish session` when convenient.

## Open questions / blockers

- Pre-rebaseline DB backups on both servers — delete once v2.5.0 has soaked
  another day or two. Not blocking.
