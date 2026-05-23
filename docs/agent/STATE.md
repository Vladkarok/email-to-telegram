# State

**Updated:** 2026-05-23T02:20+02:00
**Branch:** main
**Code baseline SHA:** a216c92
**Code worktree:** clean
**Uncommitted code paths:** none

## Now

Project at **v2.5.0** on staging and prod. Agent memory protocol now
distinguishes **code drift** (the gate that triggers reconstruction) from
**memory in flight** (advisory only) in the worktree check — symmetric with
the same split that's been in place for the baseline-SHA commit comparison.
Drift gate uses `git status --porcelain=v1 --untracked-files=no --` with the
memory pathspec exclusion.

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

- Six local memory commits await `publish session`: bootstrap → ECC → pass3
  hardening → narrow staging + cd-to-root + sed parser → this code-vs-memory
  worktree split.

## Next

1. Fresh Codex CLI session, `start session` — confirm the new dual status
   output (full advisory + drift gate) renders correctly.
2. Fresh Claude Code session, `start session` — same.
3. `publish session` when convenient.

## Open questions / blockers

- Pre-rebaseline DB backups on both servers — delete once v2.5.0 has soaked
  another day or two. Not blocking.
