# State

**Updated:** 2026-05-23T11:19+02:00
**Branch:** main
**Code baseline SHA:** a216c92
**Code worktree:** clean
**Uncommitted code paths:** none

## Now

Project at **v2.5.0** on staging and prod. Agent memory protocol fully
aligned with `tmp/agent-memory-plan-final.md`. Recovery rule now matches
the three-tier worktree rule (untracked files surfaced but never
reconstructed — they don't exist in git). Bootstrap step 2 now mentions
`docs/agent/tasks/`. No active multi-session task in flight.

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

- None.

## Next

1. Exercise the multi-session task model on a real deep review/refactor —
   create the first `docs/agent/tasks/<slug>.md`.

## Open questions / blockers

- Pre-rebaseline DB backups on both servers — delete once v2.5.0 has soaked
  another day or two. Not blocking.
