# State

**Updated:** 2026-05-23T01:53+02:00
**Branch:** main
**Code baseline SHA:** a216c92
**Code worktree:** clean
**Uncommitted code paths:** none

## Now

Project at **v2.5.0** on staging and prod. Agent memory system operational with
the pass3 + protocol-hardening refinements: mechanical baseline, `--porcelain=v1`,
narrow staging, repo-root normalization, robust `sed` baseline parser.

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

- Five local memory commits await `publish session`: `a216c92` (bootstrap),
  `132eb26` (ECC), `5ab3c6a` (pass3 hardening), the imminent commit for this
  protocol hardening save, and whatever comes next.

## Next

1. Open a fresh Codex CLI session, type `start session` — confirm protocol
   runs end-to-end with the new repo-root normalization.
2. Same in a fresh Claude Code session.
3. `publish session` when convenient (CI ignores memory-only paths).

## Open questions / blockers

- Pre-rebaseline DB backups on both servers
  (`~/e2t-prerebaseline-20260522-*.sql.gz`) — delete once v2.5.0 has soaked
  another day or two. Not blocking.
