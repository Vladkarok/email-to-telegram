# State

**Updated:** 2026-05-23T09:16+02:00
**Branch:** main
**Code baseline SHA:** a216c92
**Code worktree:** clean
**Uncommitted code paths:** none

## Now

Project at **v2.5.0** on staging and prod. Agent memory protocol stable.
Just refined the worktree-drift rule into an explicit three-tier model
(tracked code = gate / memory = advisory only / untracked = advisory with
relevance check) so a new untracked source file isn't silently lost as
noise alongside `tmp/`.

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

- One local memory commit will land with this save (`untracked-relevance`).

## Next

1. `publish session` when convenient.

## Open questions / blockers

- Pre-rebaseline DB backups on both servers — delete once v2.5.0 has soaked
  another day or two. Not blocking.
