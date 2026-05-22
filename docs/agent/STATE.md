# State

**Updated:** 2026-05-23T01:01+02:00
**Branch:** main
**Code baseline SHA:** a45111d
**Code worktree:** clean
**Uncommitted code paths:** none

## Now

Project is at **v2.5.0** on both staging and prod after the engineering-review
remediation arc, the drizzle migration re-baseline, and the delivery-resilience
release (photo-upload streaming, processing heartbeat). The agent memory system
is bootstrapped and the ECC reconciliation is resolved (convention-based — see
`DECISIONS.md`).

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

- Nothing — the memory bootstrap and the ECC reconciliation are both
  committed locally (unpushed). Two memory commits await `publish session`
  whenever the user wants them on the remote.

## Next

1. Open a fresh **Codex CLI** session in this repo and type `start session` —
   confirm the protocol runs (file reads + git baseline-SHA diff +
   `verify-with:` commands).
2. Repeat in a fresh **Claude Code** session — confirm the ECC hook's
   advisory summary is ignored in favour of the AGENTS.md protocol.
3. `publish session` (push the bootstrap + ECC-reconciliation commits) once
   verification passes.
4. Next engineering thread is user-driven; nothing pending.

## Open questions / blockers

- **Pre-rebaseline DB backups** on both servers
  (`~/e2t-prerebaseline-20260522-*.sql.gz`) can be deleted once v2.5.0 has
  soaked another day or two without incident. Not blocking.
