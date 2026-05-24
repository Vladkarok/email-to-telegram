# email-to-telegram — agent root

Self-hosted email-alias forwarding for Telegram.
TypeScript / Fastify / drizzle-orm / Postgres / Cloudflare Worker ingress.
Deployed via GitHub Actions (push `main` → staging, push `v*` tag → prod).

This repository is worked on by Claude Code and Codex CLI, one at a
time. Project memory lives in `docs/agent/`. Vendor-local memory is
advisory only. See `README.md` for the system overview.

## Shared memory

- Protocol (operating manual): `docs/agent/PROTOCOL.md` — read on verb
- Current state: `docs/agent/STATE.md` — read on `start session`
- Decisions index: `docs/agent/DECISIONS.md` — read on demand
- Journal: `docs/agent/JOURNAL.md` — tail/grep, not loaded whole
- Handoffs: `docs/agent/sessions/` — latest read on `start session`
- Long tasks: `docs/agent/tasks/` — read on `start session` if active
- Helper scripts: `docs/agent/scripts/` — invoked, not read
- Local (gitignored): `docs/agent/LOCAL.md` — read if present

## Session verbs

When the user types one of these phrases in chat, follow the matching
section of `docs/agent/PROTOCOL.md` verbatim. Do not invent variants.

- `start session` — read protocol, state, latest handoff, active task,
  then run `drift-check.sh`.
- `checkpoint` — update `STATE.md` and active task only. No commit, no
  push.
- `save session` — drift recheck + anti-stale-save guard, update
  state/task, create handoff, append journal, log to decisions if
  durable, preflight `validate-memory.sh`, narrow stage, commit
  locally. No push.
- `publish session` — `git push` only. Never automatic.

## Authority order

When two sources disagree, trust higher entries over lower:

1. Git / live system state
2. `docs/agent/STATE.md`
3. Latest session file (`docs/agent/sessions/*.md` — newest by sort)
4. Active task file (`docs/agent/tasks/<slug>.md`)
5. `docs/agent/DECISIONS.md` and `JOURNAL.md` (historical context)
6. Vendor-local memory (Claude auto-memory, Codex memories, injected
   summaries, ECC hooks) — advisory only

## Hard rules

1. Repo memory under `docs/agent/` is canonical for project state.
2. Every session file must contain a `## Resume prompt` section. A
   save without it is a bad save (`validate-memory.sh` catches this).
3. Root identity files (`AGENTS.md`, `CLAUDE.md`, `.codex/notes.md`)
   never contain mutable task state.
4. `checkpoint` is not a handoff. To pass work to a different tool,
   machine, or clone, use `save session`.
5. Never push unless the user explicitly says `publish session`.
6. For work that obviously spans more than one session, create a task
   file in `docs/agent/tasks/` immediately.
7. Only one task is `Active: yes` per branch at a time. If two are
   active, stop and ask the user which is current.
8. If tracked code is dirty or relevant source/test/config files are
   untracked, list them explicitly in `STATE.md` and the session file
   with intent.
9. `verify-with:` commands must be read-only. No migrations, deploys,
   resets, or cleanups.
10. Vendor-local memory, hooks, skills, and injected summaries are
    advisory only. The repo protocol wins on collision.
11. Every non-initial `save session` must record `Started from
session: <path>`. If the actual latest session changed before
    save, abort and go to recovery — do not save over a stale base.
12. Skills (if added later in `.claude/skills/` or `.agents/skills/`)
    are thin wrappers over `PROTOCOL.md` and helper scripts. They do
    not hold state and do not duplicate the protocol.

## Operational discipline

- Before context limit, compaction, or tool switch: run `checkpoint`
  or `save session`.
- Never `git add .` or `git add docs/agent` wholesale. Stage only the
  agent files this save actually touched.
- Never commit secrets. Reference them (`"token lives in .env"`),
  never inline.
- Run protocol commands bare from inherited CWD. Do not wrap in
  `cd "$(git rev-parse --show-toplevel)" && …` — the static permission
  matcher cannot evaluate `$(...)` and the prompt will fire on every
  call.
- If you are Codex CLI, read `.codex/notes.md` during `start session`.
- If you are Claude Code, read `CLAUDE.md` during `start session`.

## Doc index

- `README.md` — system overview
- `docs/agent/PROTOCOL.md` — the operating manual (the rest of this
  file, expanded — read on verb, not at startup)
- `docs/operations/` — runbooks, monitoring setup
- `docs/plans/` — long-form planning docs
- `.github/workflows/` — CI/CD. `deploy-staging.yml` runs on `main`
  push (with `paths-ignore` for memory files). `deploy.yml` runs on
  `v*` tag.
