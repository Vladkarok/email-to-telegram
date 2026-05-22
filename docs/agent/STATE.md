# State

**Updated:** 2026-05-23T01:12+02:00
**Branch:** main
**Code baseline SHA:** a216c92
**Code worktree:** clean
**Uncommitted code paths:** none

## Now

Project at **v2.5.0** on both staging and prod. Agent memory system bootstrapped
and reconciled with ECC (advisory-only). Pass3 vendor-doc-grounded review
applied: small protocol refinements (`--porcelain=v1`, explicit baseline-
computation command) and a baseline correction (the bootstrap commit `a216c92`
touched `.gitignore` + the staging workflow, so it is the correct non-memory
baseline — previously mis-set to the pre-bootstrap `a45111d`).

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

- Three local memory commits await `publish session`: `a216c92` (bootstrap),
  `132eb26` (ECC reconciliation), and the imminent commit for this pass3
  hardening save.

## Next

1. Open a fresh Codex CLI session, type `start session` — confirm the
   protocol runs and the corrected baseline `a216c92` reports zero drift.
2. Same in a fresh Claude Code session.
3. `publish session` once both verifications pass.

## Open questions / blockers

- Pre-rebaseline DB backups on both servers
  (`~/e2t-prerebaseline-20260522-*.sql.gz`) — delete once v2.5.0 has soaked
  another day or two. Not blocking.
