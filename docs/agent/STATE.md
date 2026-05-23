# State

**Updated:** 2026-05-23T09:24+02:00
**Branch:** main
**Code baseline SHA:** a216c92
**Code worktree:** clean
**Uncommitted code paths:** none

## Now

Project at **v2.5.0** on staging and prod. Agent memory protocol now formalizes
**multi-session task plans** under `docs/agent/tasks/<slug>.md` — for work
spanning checkpoints, compactions, or usage-limit interruptions. STATE.md "Now"
links to the active task; checkpoint keeps STATE.md + task file aligned; fresh
sessions resume by reading the task's checkboxes.

No active task in flight right now — the agent-memory iteration arc itself was
short enough to live in session files. The first real multi-session task will
exercise the new model.

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

- One local memory commit will land with this save (`multi-session-tasks`).

## Next

1. `publish session` when convenient.
2. Next real multi-session task: create the first `docs/agent/tasks/<slug>.md`
   to exercise the new model end-to-end.

## Open questions / blockers

- Pre-rebaseline DB backups on both servers — delete once v2.5.0 has soaked
  another day or two. Not blocking.
