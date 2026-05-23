# Agent Memory System — Implementation Plan

A reproducible, cross-tool (Claude Code + Codex CLI) project-memory system
backed by repo-committed Markdown. Two verbs drive it: **`start session`**
orients; **`save session`** persists. Two more: **`publish session`** for the
explicit push, **`checkpoint`** for a mid-session safety net.

This document is the canonical plan — copy it to a fresh project, fill in the
`[CUSTOMIZE]` markers, and follow the rollout. All lessons from the iterative
design work (four plan drafts, three external reviews) are baked in.

## Why this shape

- Both tools auto-load a small root file (Codex: `AGENTS.md`; Claude:
  `CLAUDE.md`). Keep those tiny so they stay within startup budget. Put
  mutable state in files that load **on the user's verb**, not at boot.
- Vendor-local memory (Claude auto-memory, Codex memories) is machine-local
  and not cross-tool. Repo Markdown is the only substrate that's portable,
  versioned, and visible to both tools.
- Save and publish are intentionally separate: **`save session` commits
  memory locally**, while **`publish session` pushes explicitly**. This keeps
  the workflow stable even if CI filters change or a save intentionally
  includes non-memory support files.
- Protocol = convention in `AGENTS.md`, not slash commands or hooks. Slash
  commands are tool-specific and machine-global — they fight the cross-tool
  goal. Skills/hooks are a Phase-2/Phase-3 add-on; not required.

## File layout

```
AGENTS.md                       canonical root, auto-loaded by both tools (small)
CLAUDE.md                       1-line `@AGENTS.md` import + ECC note      (~8 lines)
docs/agent/
  STATE.md                      current snapshot — overwritten each save  (~1 screen)
  DECISIONS.md                  one-line index into session files
  sessions/
    YYYY-MM-DD-HHMM-<slug>.md   dated handoffs, append-only, never edited
  tasks/
    <slug>.md                   multi-session task plans (optional; only
                                when a task spans sessions/checkpoints)
  LOCAL.md                      optional, gitignored, machine-specific notes
```

## Load classes — state these explicitly in `AGENTS.md`

- **Auto-loaded every session:** `AGENTS.md`, `CLAUDE.md`. Keep both tiny.
- **Read when the user says `start session`:** `docs/agent/STATE.md`, the
  latest session file, `docs/agent/LOCAL.md` if it exists, and the active
  task file under `docs/agent/tasks/` if `STATE.md`'s "Now" links to one.
- **Read on demand:** `docs/agent/DECISIONS.md`, `README.md`, project docs,
  CI workflows, code.
- **Do NOT `@`-import** any `docs/agent/*` file from `CLAUDE.md`. Imports
  load at startup every session and defeat the point.

## Latest-session filename: `YYYY-MM-DD-HHMM-<slug>.md`

Date + Europe-local time + short kebab-case slug. Sorts deterministically by
filename even with multiple sessions per day. The latest session is found
mechanically:

```bash
find docs/agent/sessions -maxdepth 1 -type f -name '*.md' | sort | tail -1
```

## Session protocol (copy verbatim into `AGENTS.md`)

### start session

0. **Normalize to repo root:** `cd "$(git rev-parse --show-toplevel)"`. All
   subsequent commands assume CWD = repo root; this is a one-line guard
   against the session starting in a subdirectory.
1. Read `docs/agent/STATE.md`.
2. Read the latest session file:
   `find docs/agent/sessions -maxdepth 1 -type f -name '*.md' | sort | tail -1`
3. If `docs/agent/LOCAL.md` exists, read it.
4. Verify live git state. Run, in order:
   - `git status --porcelain=v1` — full status, **advisory only** (memory
     in flight, untracked scratch, etc.).
   - `git status --porcelain=v1 --untracked-files=no -- ':!docs/agent' ':!AGENTS.md' ':!CLAUDE.md'` —
     **tracked-code-only status; the drift gate**. Untracked is advisory
     only (caught by the full status above), never drift.
   - `git log -10 --oneline`.
   - Drift commits: `git log <baseline>..HEAD --oneline -- ':!docs/agent' ':!AGENTS.md' ':!CLAUDE.md'`
   - Drift diff summary, when reconstructing: `git diff <baseline>..HEAD --stat -- ':!docs/agent' ':!AGENTS.md' ':!CLAUDE.md'`
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
     TS/JSON configs, etc.) is **possible code drift** — flag it as a
     probable in-progress new file. Surface for the user's decision; do
     not automatically reconstruct.
6. For volatile facts that matter to the current task, run the corresponding
   `verify-with:` command from `STATE.md`.
7. Report: current focus, where work left off, the resume prompt from the
   latest session, anything that needs verification, the first concrete
   action.
8. Read `DECISIONS.md`, `README.md`, project docs, or code only if the task
   needs them. Do not load the whole project.

### save session

0. **Normalize to repo root:** `cd "$(git rev-parse --show-toplevel)"`.
1. Run `verify-with:` commands for any facts that may have changed during
   the session.
2. Rewrite `docs/agent/STATE.md` — updated timestamp, branch, **Code
   baseline SHA**, **Code worktree** (clean/dirty), **Uncommitted code
   paths**, current focus, environments with real `verify-with:` commands,
   in-flight, next steps, blockers. Both the SHA and the worktree fields are
   about **code only** — compute mechanically, excluding memory-only paths:
   ```bash
   git log -1 --format=%h -- ':!docs/agent' ':!AGENTS.md' ':!CLAUDE.md'
   git status --porcelain=v1 --untracked-files=no -- ':!docs/agent' ':!AGENTS.md' ':!CLAUDE.md'
   ```
3. Create `docs/agent/sessions/YYYY-MM-DD-HHMM-<slug>.md` per the template
   below. Include a **resume prompt**.
4. If a non-trivial decision was made, append a one-line entry to
   `docs/agent/DECISIONS.md`.
5. **Stage narrowly — never `git add docs/agent` wholesale.** Stage only the
   three files this save actually touched:
   ```bash
   session_file="docs/agent/sessions/$(date +%F-%H%M)-<slug>.md"
   git add -- docs/agent/STATE.md docs/agent/DECISIONS.md "$session_file"
   ```
   If root files were intentionally changed in the same save (a protocol
   tweak, a workflow fix, a gitignore edit), stage them explicitly — never
   implicitly:
   ```bash
   git add -- AGENTS.md CLAUDE.md .gitignore .github/workflows/deploy-staging.yml
   ```
   Then commit:
   ```bash
   git commit -m "chore(agent): save session — <one-line summary>"
   ```
6. **Do not push automatically.** Pushing is the explicit `publish session`
   verb.

> _Bootstrap exception:_ the very first bootstrap commit intentionally creates
> many files (the root files + the entire `docs/agent/` tree + the workflow
> `paths-ignore`), so the broader `git add AGENTS.md CLAUDE.md docs/agent
.gitignore .github/workflows/deploy-staging.yml` is appropriate there.
> Routine saves use the narrow form above.

### publish session

`git push`. This is always an explicit user verb, even when the project's CI
workflows have `paths-ignore` for memory paths (see "CI prerequisite" below)
so memory-only pushes do not trigger deploys.

### checkpoint (optional, mid-session)

Rewrite `docs/agent/STATE.md` only. **If a multi-session task file is
active** (see "Multi-session tasks" below), also update it — that's where
checkbox progress and per-step findings live. No session file, no
`DECISIONS.md` update, no commit. Promote to a full `save session` at end
of work.

### Recovery rule

If the branch differs, the baseline SHA is missing, tracked code commits
exist since the baseline, or the tracked code worktree is unexpectedly
dirty, treat `STATE.md` as partially stale and reconstruct from `git log`
and `git diff --stat` since the pinned baseline plus the latest session
file. If relevant untracked source/test/config files are present, surface
them as possible in-progress work and inspect only if they matter to the
current task — they cannot be reconstructed from git. Announce
_"reconstructed from git; please verify"_ before doing any work.

## Multi-session tasks

For work likely to span multiple `checkpoint` / `save session` cycles —
deep reviews, refactors, multi-step plans — a single session file can't
hold the running plan + intermediate findings, and STATE.md is too narrow.
Use a task plan file:

1. **Create `docs/agent/tasks/<slug>.md`** at task start (template below).
   Plan section uses checkbox state: `[ ]` not started · `[~]` in
   progress · `[x]` completed.
2. **`STATE.md` "Now"** links to the task file (e.g. "working on
   `billing-refactor`; see `docs/agent/tasks/billing-refactor.md`");
   "Next" is the next checkbox in the plan.
3. **`checkpoint`** keeps STATE.md _and_ the task file aligned (no
   commit). Update after every meaningful unit of work — especially
   before approaching context limits or compaction (see standing rule
   on compaction resilience).
4. **`save session`** at session end writes a session file that _links_
   the task file rather than duplicating its findings. Include the task
   file in the narrow staging:
   ```bash
   git add -- docs/agent/STATE.md docs/agent/DECISIONS.md \
              docs/agent/tasks/<slug>.md "$session_file"
   ```
5. **Fresh session resumes** by reading `STATE.md` → the linked task
   file → the last `[x]` / `[~]` markers. Compaction and usage-limit
   interruptions are handled the same way: in-context memory is
   disposable; the task file is the durable plan.
6. **On task completion:** all `[x]`, add `**Completed:** <date>` near
   the top, link from `DECISIONS.md` if a durable decision came out of
   it. The file stays for history — no archive shuffle needed.

> In Claude Code, the in-session `TodoWrite` tool is a fast in-context
> working draft; mirror durable steps to the task file at each
> `checkpoint`. In Codex CLI, the agent's own step tracking serves the
> same role.

## Templates

### `STATE.md`

```markdown
# State

**Updated:** <ISO 8601 with offset, Europe-local time>
**Branch:** <name>
**Code baseline SHA:** <git log -1 --format=%h -- ':!docs/agent' ':!AGENTS.md' ':!CLAUDE.md'>
**Code worktree:** clean | dirty
**Uncommitted code paths:** <none, or short list>

## Now

<1–3 lines: current focus>

## Environments

- Staging ([CUSTOMIZE: ssh alias]): <image tag>, <health>, migration head <id>
  verify-with: `<CUSTOMIZE: real command>`
- Prod ([CUSTOMIZE: ssh alias]): <image tag>, <health>, migration head <id>
  verify-with: `<CUSTOMIZE: real command>`

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

### `DECISIONS.md`

```
YYYY-MM-DD · <one-line decision> · <sessions/file.md or commit SHA>
```

Append-only. Reversals add a superseding line. Reasoning lives in the
linked session file, never inline.

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

### `CLAUDE.md`

```
@AGENTS.md

Project memory and session protocol live in AGENTS.md (shared with Codex CLI).
Personal global preferences in ~/.claude/CLAUDE.md still apply.

[CUSTOMIZE if applicable: any project-specific ECC integration note — e.g. the
ECC `save-session` / `resume-session` skill and its `SessionStart` hook
must wrap docs/agent/ and never maintain separate state. See AGENTS.md
standing rule #4.]
```

## Standing rules (include in `AGENTS.md`)

1. **Verify live state over trusting memory.** Memory describes when it was
   written; git, servers, and the DB describe now. Run the git check on
   `start session` and the `verify-with:` commands — don't quote memory.
2. **Avoid concurrent sessions on the same branch.** If a second agent
   opens, it must `git pull` and re-read `STATE.md` before any write.
3. **One thread per coherent unit of work.** External memory is what keeps
   threads short.
4. **Compaction and limit resilience.** Treat any approach to a context
   limit, any imminent compaction, or any end-of-session as a forced
   `checkpoint`: flush in-context working memory to `STATE.md` and the
   active task file (if any) **before** further work. The next agent reads
   from disk, not from chat history. Long tasks should use a task plan
   file (see "Multi-session tasks") so a single in-context summary loss
   never destroys plan state.
5. **Repo memory is canonical.** Any vendor-local session machinery (e.g.
   Claude ECC `SessionStart` hook + `save-session`/`resume-session` skill)
   may fire — treat its output as **advisory only**. The verbs in this file
   define behavior; when colliding skill names exist (e.g. ECC's
   `save-session`), execute the protocol here, not the skill.

## Bootstrap rollout

1. **Audit existing docs.** Check `README.md`, `docs/operations/`,
   `docs/plans/` (or your project's equivalents). `AGENTS.md` will link them,
   not duplicate them. Create them first if they don't exist; the agent
   memory system is not a substitute for project docs.
2. **Create files:** `AGENTS.md`, `CLAUDE.md`, `docs/agent/STATE.md`,
   `docs/agent/DECISIONS.md`, `docs/agent/sessions/`. Create
   `docs/agent/tasks/` too, or defer it until the first multi-session
   task starts — either is fine. If git tracks empty dirs poorly in your
   workflow, drop a `.gitkeep`:
   ```bash
   mkdir -p docs/agent/sessions docs/agent/tasks
   touch docs/agent/sessions/.gitkeep docs/agent/tasks/.gitkeep
   ```
   Add `docs/agent/LOCAL.md` to `.gitignore` (do NOT create `LOCAL.md`
   itself — only if/when needed).
3. **Seed `STATE.md`** with current reality: branch, the computed Code
   baseline SHA (using the command in step 2 of `save session`), worktree
   state, environments with real `verify-with:` commands, in-flight,
   next steps, open questions. One screen.
4. **Seed the first session file** in `docs/agent/sessions/` (use Europe-
   local time as `HHMM`). Slug: `memory-bootstrap`. Include a resume prompt.
5. **Backfill `DECISIONS.md`** with 3–5 durable decisions worth recording.
   For decisions pre-dating the memory system, link a commit SHA or tag
   instead of a session file.
6. **Reconcile any existing vendor memory.** If Claude has stale
   per-project memory at `~/.claude/projects/<project>/memory/MEMORY.md`,
   trim obsolete entries and leave a one-line pointer to
   `docs/agent/STATE.md`. If a Claude `SessionStart` hook from a marketplace
   plugin will fire and inject a redundant summary, address it in standing
   rule #4 (convention — treat as advisory). True per-project disable
   typically isn't possible without fragile plugin surgery.
7. **CI prerequisite — add `paths-ignore`** for memory paths to any deploy
   workflow that triggers on `push: branches: [main]` (or your default
   branch). The narrow form:

   ```yaml
   on:
     push:
       branches: [main]
       paths-ignore:
         - "docs/agent/**"
         - "AGENTS.md"
         - "CLAUDE.md"
   ```

   Without this, every `publish session` rebuilds and bounces the deployed
   container.

8. **Commit the bootstrap** with a clear message:
   `chore(agent): bootstrap cross-tool memory system`
9. **Crucial post-bootstrap step — fix the Code baseline SHA.** The
   bootstrap commit usually touches non-memory paths (`.gitignore`, the CI
   workflow), so the bootstrap commit itself is the correct baseline. Right
   after committing, recompute and correct:
   ```bash
   git log -1 --format=%h -- ':!docs/agent' ':!AGENTS.md' ':!CLAUDE.md'
   ```
   If this returns the bootstrap commit's SHA, update `STATE.md` to use it
   (the seed in step 3 was computed _before_ the bootstrap commit existed).
   Commit again as `chore(agent): save session — baseline correction`. This
   eliminates a false-positive drift alarm on the next `start session`.
10. **Run the acceptance tests** (next section). Then in a fresh Codex CLI
    session and a fresh Claude Code session: type `start session` and
    confirm both follow the protocol identically.

## Acceptance tests

Run these once after bootstrap to verify drift detection works.

### Test 1 — Memory-only commit must NOT trigger drift

The bootstrap or first save commit _is_ the baseline (per step 9). Any
subsequent purely-memory commit should be filtered out by the start-session
drift check.

```bash
cd "$(git rev-parse --show-toplevel)"
baseline=$(sed -n 's/^\*\*Code baseline SHA:\*\* //p' docs/agent/STATE.md | head -1)
git log "$baseline..HEAD" --oneline -- ':!docs/agent' ':!AGENTS.md' ':!CLAUDE.md'
# Expected: empty (or only commits that legitimately touch non-memory paths).
```

### Test 2 — Real code commit MUST trigger drift

Make any trivial real-code commit (e.g. touch a doc file outside `docs/agent/`,
or a comment in code, then commit). Re-run Test 1. The new commit must
appear. Then either save-session to advance the baseline, or revert the
test commit if it was throwaway.

### Test 3a — Dirty _code_ file MUST be flagged as drift

Modify any tracked code file (e.g. `README.md`). Run the code-filtered
status:

```bash
git status --porcelain=v1 --untracked-files=no -- ':!docs/agent' ':!AGENTS.md' ':!CLAUDE.md'
```

The file must appear. A subsequent `save session` must record `Code worktree:
dirty` and list the path in `Uncommitted code paths`. Revert when done.

### Test 3b — Dirty _memory_ file must NOT be flagged as drift

Modify any memory file (e.g. `docs/agent/STATE.md`). Run both:

```bash
git status --porcelain=v1                                                                           # advisory: shows STATE.md as M
git status --porcelain=v1 --untracked-files=no -- ':!docs/agent' ':!AGENTS.md' ':!CLAUDE.md'        # drift gate: empty
```

The code-filtered status must be **empty**. A `start session` against this
state must report the memory dirtiness as advisory only and proceed —
without reconstructing from git. This is the post-`checkpoint` case.

### Test 3c — Untracked file in a source path SHOULD surface as possible drift

Create an untracked file under a code-relevant path:

```bash
touch src/_drift_test.ts          # or tests/_drift_test.ts, etc.
git status --porcelain=v1         # shows the file as ??
git status --porcelain=v1 --untracked-files=no -- ':!docs/agent' ':!AGENTS.md' ':!CLAUDE.md'
                                  # drift gate: empty (the gate is strictly tracked-code)
rm src/_drift_test.ts             # cleanup
```

A `start session` against this state must (a) leave the drift gate empty —
no automatic reconstruction — but (b) **explicitly flag the untracked
`src/` file** in the advisory section as a probable in-progress new file
from a prior session. Scratch paths like `tmp/` in the same advisory
output should _not_ be flagged. This is the three-tier rule in action.

## Pitfalls and lessons learned

- **The bootstrap commit is usually its own baseline.** It typically touches
  `.gitignore` and the CI workflow alongside the memory files. If you set
  `Code baseline SHA` from the pre-bootstrap state, the next `start session`
  will falsely report code drift. Mitigation: step 9 of the rollout.
- **Never eyeball the baseline.** Always run
  `git log -1 --format=%h -- ':!docs/agent' ':!AGENTS.md' ':!CLAUDE.md'`.
  This is in the protocol verbatim for that reason.
- **Don't `@`-import mutable docs from `CLAUDE.md`.** Imports load at
  startup. Mutable state belongs to `start session`, not to boot.
- **Don't broaden `paths-ignore` to `docs/**`.\** GitHub Actions skips a
  workflow only when *all\* changed paths match the ignored patterns —
  broader filters are mostly harmless, but narrower is clearer about intent
  and less likely to mask a real change in unrelated docs.
- **Don't trust the latest commit as "the baseline" reflexively.** If the
  latest commit is memory-only, the _baseline_ is the latest non-memory
  commit, which may be older. The mechanical command handles this.
- **Don't put secrets in any committed memory file.** Reference them
  ("DB password is in each server's `.env`"), never copy them. `LOCAL.md`
  is gitignored but the same rule applies — local risk only.
- **Vendor session machinery may collide with the verbs.** Examples: a
  Claude marketplace plugin's `save-session` skill, a `SessionStart` hook
  that injects a stale summary. Address in standing rule #4 — the protocol
  in `AGENTS.md` is canonical; vendor outputs are advisory.

## Project-specific customization checklist

Mark each as done when you've filled it in for your project:

- [ ] `AGENTS.md` line 1: replace the one-line project description.
- [ ] `AGENTS.md` "Doc index": list the actual existing docs
      (`README.md`, `docs/operations/`, `docs/plans/`, CI workflows, etc.).
- [ ] `STATE.md` "Environments" section: real ssh aliases / container names
      / `verify-with:` commands for staging and prod (or whatever envs
      exist). Use your project's actual stack (e.g. for Drizzle/Postgres:
      `docker exec <pg-container> psql -U <user> -d <db> -tAc "select max(...)
    from drizzle.__drizzle_migrations"`; for Alembic: `alembic current`).
- [ ] `paths-ignore` added to the deploy workflow(s) that trigger on `push`
      to your default branch.
- [ ] Vendor memory reconciliation done (any per-project `MEMORY.md` trimmed
      and pointed at `docs/agent/STATE.md`).
- [ ] Standing rule #4 in `AGENTS.md` updated if you have a specific vendor
      session system (e.g. ECC) whose verb names collide with this protocol.
- [ ] First seed of `STATE.md`, the first session file, and `DECISIONS.md`
      reflects real current state, not placeholders.

## Phased rollout — keep automation optional

- **Phase 1 (now):** the manual protocol above. Convention only. Cross-tool
  by construction. Should be the steady state for most projects.
- **Phase 2 (later, if it earns its keep):** wrap `start session` and
  `save session` as Claude skills and Codex skills. Same memory backend;
  the skill is just a thin adapter that runs the protocol steps
  deterministically.
- **Phase 3 (optional):** Claude `SessionStart` hook (and Codex equivalent
  when available) that injects a small `STATE.md` summary + git-drift
  report. The memory model doesn't change.

Don't try to be magical on day one. Convention works.
