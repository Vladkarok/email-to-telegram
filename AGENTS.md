# AGENTS.md

email-to-telegram — self-hosted email-alias forwarding for Telegram.
TypeScript / Fastify / drizzle-orm / Postgres / Cloudflare Worker ingress.
Deployed via GitHub Actions (push `main` → staging, push `v*` tag → prod).
See `README.md` for the system overview.

## Tool loading

This file is the canonical agent root for the project. Both Claude Code and
Codex CLI use it.

- **Codex CLI** auto-loads `AGENTS.md` (this file).
- **Claude Code** auto-loads `CLAUDE.md`, which `@AGENTS.md`-imports this file.
- Do **not** `@`-import any `docs/agent/*` file from `CLAUDE.md` — those are
  read on demand (see "Load classes" below), not at startup.

### Load classes

- **Auto-loaded every session:** `AGENTS.md`, `CLAUDE.md`. Keep both tiny.
- **Read when the user says "start session":** `docs/agent/STATE.md`, the
  latest session file (sort by filename — see protocol), and
  `docs/agent/LOCAL.md` if present.
- **Read on demand:** `docs/agent/DECISIONS.md`, `README.md`,
  `docs/operations/`, `docs/plans/`, `.github/workflows/`, code.

## Session protocol

The user drives this with plain phrases. Each verb has a fixed behavior.

### start session

1. Read `docs/agent/STATE.md`.
2. Read the latest session file:
   `find docs/agent/sessions -maxdepth 1 -type f -name '*.md' | sort | tail -1`
3. If `docs/agent/LOCAL.md` exists, read it.
4. Verify live git state — run `git status`, `git log -10 --oneline`, then
   compare HEAD against `STATE.md`'s **Code baseline SHA** ignoring
   memory-only commits:
   `git log <baseline>..HEAD --oneline -- ':!docs/agent' ':!AGENTS.md' ':!CLAUDE.md'`
5. If real code/CI commits exist since the baseline, or the worktree is dirty,
   announce it explicitly:
   _"STATE.md is N code commits behind / worktree dirty in <paths>;
   reconstructing from git + latest session before trusting memory."_
6. For volatile facts that matter to the current task, run the corresponding
   `verify-with:` command from `STATE.md` (deploy state, image tag, migration
   head).
7. Report: current focus, where work left off, the resume prompt from the
   latest session, anything that needs verification, the first concrete
   action.
8. Read `DECISIONS.md`, `README.md`, `docs/operations/`, `docs/plans/`, or
   code only if the task needs them. Do not load the whole project.

### save session

1. Run `verify-with:` commands for any facts that may have changed during
   the session.
2. Rewrite `docs/agent/STATE.md` per the template below — updated timestamp,
   branch, **Code baseline SHA** (latest commit that touches anything outside
   `docs/agent/`, `AGENTS.md`, `CLAUDE.md`), worktree state, current focus,
   environments with real `verify-with:` commands, in-flight, next steps,
   blockers.
3. Create `docs/agent/sessions/YYYY-MM-DD-HHMM-<slug>.md` (Europe/Rome local
   time, short kebab-case slug) per the template below. Include a resume
   prompt.
4. If a non-trivial decision was made, append a one-line entry to
   `docs/agent/DECISIONS.md`.
5. Stage and commit locally:
   `git add AGENTS.md CLAUDE.md docs/agent && \
 git commit -m "chore(agent): save session — <one-line summary>"`
6. **Do not push automatically.** The staging workflow has `paths-ignore`
   for `docs/agent/**`, `AGENTS.md`, `CLAUDE.md`, so pushing memory commits
   is safe — but pushing is the explicit `publish session` step.

### publish session

Push any unpushed agent-memory commits: `git push`. The staging workflow
ignores memory-only paths, so this does not trigger a deploy. Use only when
cross-machine continuity is wanted before the next code push.

### checkpoint (optional, mid-session)

Rewrite `docs/agent/STATE.md` only. No session file, no `DECISIONS.md`
update, no commit. A safety net for long sessions — promote to a full
`save session` at end of work.

### Recovery rule

If `STATE.md` can't be trusted (its baseline SHA is missing, the branch
differs, real code commits exist since the baseline, the worktree is
unexpectedly dirty), treat it as partially stale. Reconstruct from `git
log` since the pinned baseline plus the latest session file. Announce
_"reconstructed from git; please verify"_ before doing any work.

## Templates

### `STATE.md`

```markdown
# State

**Updated:** <ISO 8601 with offset, Europe/Rome>
**Branch:** <name>
**Code baseline SHA:** <latest commit not under docs/agent or AGENTS/CLAUDE.md>
**Code worktree:** clean | dirty
**Uncommitted code paths:** <none, or short list>

## Now

<1–3 lines: current focus>

## Environments

- Staging (kc-vprojects): <image tag>, <health>, migration head <ts>
  verify-with: `ssh kc-vprojects 'docker ps --filter name=email-to-telegram-app --format "{{.Image}} {{.Status}}"'`
- Prod (emails-tg-prod): <image tag>, <health>, migration head <ts>
  verify-with: `ssh emails-tg-prod 'docker ps --filter name=email-to-telegram-app --format "{{.Image}} {{.Status}}"'`
- Migration head (either): `ssh <host> 'docker exec email-to-telegram-postgres-1 psql -U emailtelegram -d emailtelegram -tAc "select max(created_at) from drizzle.__drizzle_migrations"'`

## In flight

- ...

## Next

1. ...

## Open questions / blockers

- ...
```

### Session file

```markdown
# Session YYYY-MM-DD HH:MM <slug>

**Tool:** Claude Code | Codex CLI
**Branch at end:** <name>
**Code baseline SHA at end:** <last non-memory commit>
**Code worktree at end:** clean | dirty (paths …)

## Done

- …

## Decisions

- … (also indexed in docs/agent/DECISIONS.md)

## Failed approaches (avoid retrying)

- …

## Next

1. …

## Resume prompt

<One paragraph a fresh agent can act on immediately: goal, where to pick up,
the first concrete step, what to verify first.>
```

## Doc index

- `docs/agent/STATE.md` — current snapshot. Read on every `start session`.
- `docs/agent/sessions/` — dated handoffs. Read the latest at `start session`.
- `docs/agent/DECISIONS.md` — one-line index of durable decisions; each entry
  links the session file (or commit SHA, for entries pre-dating the memory
  system) that holds the reasoning.
- `docs/agent/LOCAL.md` — optional, gitignored, machine-specific notes.
- `README.md` — system overview.
- `docs/operations/` — runbooks, monitoring.
- `docs/plans/` — long-form planning docs.
- `.github/workflows/` — CI/CD. `deploy-staging.yml` runs on `main` push
  (with `paths-ignore` for memory files). `deploy.yml` runs on `v*` tag.

## Standing rules

1. **Verify live state over trusting memory.** Memory describes when it was
   written; git, servers, and the DB describe now. The git check on
   `start session` and the `verify-with:` commands in `STATE.md` are the
   mechanism — run them rather than quote memory.
2. **Avoid concurrent sessions on the same branch.** If a second agent
   opens, it must `git pull` and re-read `STATE.md` before any write.
3. **One thread per coherent unit of work.** External memory is what keeps
   threads short — don't run a single mega-thread per project.
4. **Repo memory is canonical.** The Claude ECC `save-session` /
   `resume-session` skill and its `SessionStart` hook must either be disabled
   for this project or operate purely as adapters over the files under
   `docs/agent/` (read the same files; write the same files; commit locally;
   no separate state). The Claude per-project memory at
   `~/.claude/projects/.../memory/MEMORY.md` should hold a one-line pointer
   to `docs/agent/STATE.md`, not project facts.
