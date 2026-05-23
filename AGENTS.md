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
  latest session file (sort by filename — see protocol),
  `docs/agent/LOCAL.md` if present, **and the active task file under
  `docs/agent/tasks/` if `STATE.md`'s "Now" section points to one**.
- **Read on demand:** `docs/agent/DECISIONS.md`, `README.md`,
  `docs/operations/`, `docs/plans/`, `.github/workflows/`, code.

## Session protocol

The user drives this with plain phrases. Each verb has a fixed behavior.

### start session

0. **Normalize to repo root** so relative paths resolve regardless of CWD:
   `cd "$(git rev-parse --show-toplevel)"`
1. Read `docs/agent/STATE.md`.
2. Read the latest session file:
   `find docs/agent/sessions -maxdepth 1 -type f -name '*.md' | sort | tail -1`
3. If `docs/agent/LOCAL.md` exists, read it.
4. Verify live git state. Run, in order:
   - `git status --porcelain=v1` — full status, **advisory only** (catches
     memory files in flight, untracked scratch like `tmp/`, etc.).
   - `git status --porcelain=v1 --untracked-files=no -- ':!docs/agent' ':!AGENTS.md' ':!CLAUDE.md'` —
     **tracked-code-only status; this is what drives the drift gate**
     (untracked files are caught by the advisory line above, not here).
   - `git log -10 --oneline` — recent history.
   - Drift commits since baseline (memory-only commits excluded):
     `git log <baseline>..HEAD --oneline -- ':!docs/agent' ':!AGENTS.md' ':!CLAUDE.md'`
   - Drift diff summary, when reconstructing:
     `git diff <baseline>..HEAD --stat -- ':!docs/agent' ':!AGENTS.md' ':!CLAUDE.md'`
5. Apply this three-tier rule to what the status commands surfaced:
   - **Tracked code drift** — code/CI commits since the baseline, OR the
     code-filtered tracked status is non-empty. Announce explicitly:
     _"STATE.md is N code commits behind / code worktree dirty in <paths>;
     reconstructing from git + latest session before trusting memory."_
   - **Memory in flight** — only `docs/agent/**`, `AGENTS.md`, `CLAUDE.md`
     are dirty. Advisory only ("STATE.md dirty in flight; will be committed
     by the next save"). **Never reconstruct.**
   - **Untracked files** (from the full advisory status) — advisory **by
     default**, with a relevance check. Scratch paths (`tmp/`, build
     outputs, nested dependency caches) are noise — ignore. An untracked
     file under a source/test/config path (`src/**`, `tests/**`, root
     TS/JSON configs, etc.) is **possible code drift** — flag it
     explicitly as a probable in-progress new file the previous session
     didn't commit. Surface for the user's decision; do not automatically
     reconstruct.
6. For volatile facts that matter to the current task, run the corresponding
   `verify-with:` command from `STATE.md` (deploy state, image tag, migration
   head).
7. Report: current focus, where work left off, the resume prompt from the
   latest session, anything that needs verification, the first concrete
   action.
8. Read `DECISIONS.md`, `README.md`, `docs/operations/`, `docs/plans/`, or
   code only if the task needs them. Do not load the whole project.

### save session

0. **Normalize to repo root:** `cd "$(git rev-parse --show-toplevel)"`
1. Run `verify-with:` commands for any facts that may have changed during
   the session.
2. Rewrite `docs/agent/STATE.md` per the template below — updated timestamp,
   branch, **Code baseline SHA**, **Code worktree** (clean/dirty),
   **Uncommitted code paths**, current focus, environments with real
   `verify-with:` commands, in-flight, next steps, blockers. Both the SHA and
   the worktree fields are about **code only** — compute mechanically,
   excluding memory-only paths:
   ```bash
   # Code baseline SHA (latest non-memory commit):
   git log -1 --format=%h -- ':!docs/agent' ':!AGENTS.md' ':!CLAUDE.md'
   # Code worktree state (the input to "clean"/"dirty" + the paths list):
   git status --porcelain=v1 --untracked-files=no -- ':!docs/agent' ':!AGENTS.md' ':!CLAUDE.md'
   ```
3. Create `docs/agent/sessions/YYYY-MM-DD-HHMM-<slug>.md` (Europe/Rome local
   time, short kebab-case slug) per the template below. Include a resume
   prompt.
4. If a non-trivial decision was made, append a one-line entry to
   `docs/agent/DECISIONS.md`.
5. **Stage narrowly — never `git add docs/agent` wholesale.** Only the
   three files this save actually touched:
   ```bash
   session_file="docs/agent/sessions/$(date +%F-%H%M)-<slug>.md"
   git add -- docs/agent/STATE.md docs/agent/DECISIONS.md "$session_file"
   ```
   If root files were intentionally changed in the same save (a protocol
   tweak, a workflow fix, etc.), stage them explicitly too — never
   implicitly:
   ```bash
   git add -- AGENTS.md CLAUDE.md .gitignore .github/workflows/deploy-staging.yml
   ```
   Then commit:
   `git commit -m "chore(agent): save session — <one-line summary>"`
6. **Do not push automatically.** The staging workflow has `paths-ignore`
   for `docs/agent/**`, `AGENTS.md`, `CLAUDE.md`, so pushing memory commits
   is safe — but pushing is the explicit `publish session` step.

### publish session

Push any unpushed agent-memory commits: `git push`. The staging workflow
ignores memory-only paths, so this does not trigger a deploy. Use only when
cross-machine continuity is wanted before the next code push.

### checkpoint (optional, mid-session)

Rewrite `docs/agent/STATE.md` only. **If a multi-session task file is
active** (see "Multi-session tasks" below), also update it — that's where
checkbox progress and per-step findings live. No session file, no
`DECISIONS.md` update, no commit. Promote to a full `save session` at end
of work.

### Recovery rule

If `STATE.md` can't be trusted (its baseline SHA is missing, the branch
differs, real code commits exist since the baseline, the worktree is
unexpectedly dirty), treat it as partially stale. Reconstruct from `git
log` since the pinned baseline plus the latest session file. Announce
_"reconstructed from git; please verify"_ before doing any work.

## Multi-session tasks

For work likely to span multiple `checkpoint`/`save session` cycles —
deep reviews, refactors, multi-step plans — use a task plan file:

1. **Create `docs/agent/tasks/<slug>.md`** at task start (template
   below). Checkbox conventions: `[ ]` not started · `[~]` in progress ·
   `[x]` completed.
2. **STATE.md "Now"** links to the task file (e.g. "working on
   billing-refactor; see `docs/agent/tasks/billing-refactor.md`"); "Next"
   is the next checkbox.
3. **`checkpoint`** keeps STATE.md _and_ the task file aligned. Update
   after every meaningful unit of work — especially before approaching a
   context limit or compaction (see standing rule #5).
4. **`save session`** at session end writes a session file that
   **links** the task file rather than duplicating its findings. Include
   the task file in the narrow staging:
   ```bash
   git add -- docs/agent/STATE.md docs/agent/DECISIONS.md \
              docs/agent/tasks/<slug>.md "$session_file"
   ```
5. **Fresh session resumes** by reading `STATE.md` → the linked task
   file → the last `[x]`/`[~]` markers. Context compaction and
   usage-limit interruptions are handled the same way: in-context memory
   is disposable; the task file is the durable plan.
6. **On completion:** all `[x]`, add `**Completed:** <date>` at the
   top, link from `DECISIONS.md` if a durable decision came out of it.
   Task files stay for history; no archive shuffle needed.

In Claude Code, the in-session `TodoWrite` tool is a fast in-context
working draft; mirror durable steps to the task file at each `checkpoint`.

## Templates

### `STATE.md`

```markdown
# State

**Updated:** <ISO 8601 with offset, Europe/Rome>
**Branch:** <name>
**Code baseline SHA:** <git log -1 --format=%h -- ':!docs/agent' ':!AGENTS.md' ':!CLAUDE.md'>
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

### `DECISIONS.md`

One line per durable decision, append-only. Reversals add a superseding
line; reasoning lives in the linked session file, never inline.

```
YYYY-MM-DD · <one-line decision> · <sessions/file.md or commit SHA>
```

### Task file (`docs/agent/tasks/<slug>.md`)

```markdown
# Task: <one-line goal>

**Status:** in progress | completed | abandoned
**Started:** YYYY-MM-DD
**Completed:** YYYY-MM-DD | —
**Slug:** <kebab-case>

## Goal

<1–3 paragraphs: what and why>

## Plan

- [x] Step 1: <description>
- [~] Step 2: <description>
- [ ] Step 3: <description>

## Findings

### Step 1

<what surfaced>
### Step 2
<in-progress notes>

## Decisions

- <non-trivial; also indexed in DECISIONS.md>

## Open questions

- <pending>
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
- `docs/agent/tasks/` — multi-session task plans (optional; see protocol).
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
4. **Compaction and limit resilience.** Treat any approach to a context
   limit, any imminent compaction, or any end-of-session as a forced
   `checkpoint`: flush in-context working memory to `STATE.md` and the
   active task file (if any) **before** further work. The next agent reads
   from disk, not from chat history. Long tasks should use a task plan
   file (see "Multi-session tasks") so a single in-context summary loss
   never destroys plan state.
5. **Repo memory is canonical.** The Claude ECC `SessionStart` hook (defined
   in a global marketplace plugin and therefore not per-project disablable
   without fragile surgery) may fire at session start and inject a
   "previous session summary" from `~/.claude/sessions/`. Treat that summary
   as **advisory only** — it is machine-local, Claude-only, and may be
   stale. Always follow the `start session` protocol in this file.
   Likewise, the ECC `save-session` / `resume-session` skill names collide
   with the verbs defined above: when the user uses one of those verbs,
   execute the protocol in this file (which writes to `docs/agent/`), not
   the ECC skill (which writes machine-local Claude-only state). The Claude
   per-project memory at `~/.claude/projects/.../memory/MEMORY.md` holds a
   one-line pointer to `docs/agent/STATE.md`, not project facts.
