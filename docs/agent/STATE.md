# State

**Updated:** 2026-05-23T00:47+02:00
**Branch:** main
**Code baseline SHA:** a45111d
**Code worktree:** dirty
**Uncommitted code paths:** `.github/workflows/deploy-staging.yml` (added
`paths-ignore` for `docs/agent/**`, `AGENTS.md`, `CLAUDE.md` so memory commits
don't bounce staging — being committed together with this bootstrap)

## Now

Project is at **v2.5.0** on both staging and prod after the engineering-review
remediation arc, the drizzle migration re-baseline, and the delivery-resilience
release (photo-upload streaming, processing heartbeat). The agent memory
system has just been bootstrapped — this is the first `STATE.md`.

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

- Agent memory bootstrap (this file, the first session file, `DECISIONS.md`,
  `AGENTS.md`, `CLAUDE.md`, plus the `deploy-staging.yml` `paths-ignore`
  change) is about to be committed.

## Next

1. Open a fresh **Codex CLI** session in this repo, say `start session`, and
   confirm the protocol runs end-to-end (file reads + git check + the
   staging/prod `verify-with:` commands above).
2. Repeat in a fresh **Claude Code** session.
3. Resolve the open ECC reconciliation question below.
4. No other engineering work is pending; the next thread will be user-driven.

## Open questions / blockers

- **ECC reconciliation.** The Claude-only ECC `save-session` /
  `resume-session` skill and its `SessionStart` hook still write to
  `~/.claude/sessions/` (machine-local). Per `AGENTS.md` standing rule #4,
  they must either be disabled for this project or rewritten as thin adapters
  over `docs/agent/*`. Decision pending from the user — both choices are
  fine; "disable" is the simpler default.
- **Stale pre-rebaseline DB backups.** Both servers carry
  `~/e2t-prerebaseline-20260522-*.sql.gz`. Safe to delete once v2.5.0 has
  soaked another day or two without incident.
