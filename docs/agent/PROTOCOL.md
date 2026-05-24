# Agent Memory Protocol

Canonical operating manual for the four session verbs:
`start session`, `checkpoint`, `save session`, `publish session`.

**Read on verb execution, not at startup.** Keeps startup context small.
Authority order, hard rules, and load policy live in `AGENTS.md`.

This document is the **email-to-telegram fork** of the upstream
`agent-memory-system` v2 protocol, customized to keep two refinements
this project earned during v1:

1. **DECISIONS.md is kept as a grep-able one-line index** alongside
   JOURNAL.md. They complement: DECISIONS = "what we decided + link",
   JOURNAL = "what happened + when". Upstream skips DECISIONS.md on v1;
   we have 22 entries already worth keeping.
2. **Three-tier untracked-relevance rule** with explicit `src/**` vs
   `tmp/**` flagging in `start session` step 9 (upstream collapses this
   to "anything noisy is excluded by the script's pathspec"; we want the
   surfacing for in-progress files).

---

## start session

Restore context from the repository before doing any code work.

0. **Run protocol commands bare from inherited CWD.** Both Claude Code
   and Codex CLI start in the repo root. Do **not** wrap in
   `cd "$(git rev-parse --show-toplevel)" && …` — the static permission
   matcher cannot evaluate `$(...)`, so that form prompts on every call.
   The scripts in `docs/agent/scripts/` handle their own normalization
   internally.

1. Read `AGENTS.md`.
2. Read `docs/agent/PROTOCOL.md` (this file).
3. If you are Claude Code: read `CLAUDE.md`.
   If you are Codex CLI: read `.codex/notes.md`.
4. Read `docs/agent/STATE.md`.
5. Find the latest session file:
   ```bash
   docs/agent/scripts/latest-session.sh
   ```
   Then read that file.
6. If `STATE.md` has `Active task: <slug>`, read `docs/agent/tasks/<slug>.md`.
7. If `docs/agent/LOCAL.md` exists, read it. **Advisory only** — do not
   treat as truth.
8. Run drift check:
   ```bash
   docs/agent/scripts/drift-check.sh
   ```
9. Apply the **three-tier rule** to drift-check output:
   - **Tracked code drift** — `Tracked code changes (memory excluded):`
     is non-empty. Announce explicitly:
     _"STATE.md may be stale; tracked code dirty in <paths>;
     reconstructing from git + latest session before trusting memory."_
   - **Memory in flight** — only `docs/agent/**`, `AGENTS.md`,
     `CLAUDE.md`, or `.codex/**` dirty. The drift-check excludes these
     by pathspec, so they should not appear under "Tracked code
     changes" — if they do (e.g. a typo in pathspec), advisory only.
   - **Untracked files** — from `Untracked files (all):`. Apply
     relevance check:
     - **Scratch paths** (`tmp/`, build outputs, nested dependency
       caches) — noise. Ignore.
     - **Source/test/config paths** (`src/**`, `tests/**`, root
       TS/JSON configs, etc.) — flag as **possible in-progress new
       file** from a prior session that wasn't committed. Surface for
       the user's decision; do not auto-reconstruct.
10. For volatile facts that matter to the current task, run the
    corresponding `verify-with:` command from `STATE.md` (deploy state,
    image tag, migration head).
11. Report briefly:
    - Current focus (from `STATE.md`'s "Now").
    - Where work left off (from `Resume prompt` in `STATE.md` or latest
      session).
    - Anything that needs verification.
    - The first concrete safe action.
12. Read `DECISIONS.md`, `README.md`, `docs/operations/`,
    `docs/plans/`, `.github/workflows/`, or code only if the task needs
    them. Do not load the whole project.

---

## checkpoint

A mid-session save-to-disk. Used before context-limit, before a long
step, before tool switch in the **same** worktree.

**What checkpoint is NOT:** a handoff to a different machine, a
different agent, or a different clone. For that, use `save session`.

Steps:

1. Rewrite `docs/agent/STATE.md` with the current state:
   - Updated timestamp (ISO 8601 with timezone, Europe/Rome)
   - Tool last wrote
   - Branch
   - Last code commit (from `drift-check.sh`)
   - Code worktree clean/dirty
   - Tracked dirty code paths
   - Relevant untracked code paths
   - Active task (if any)
   - Latest session read (path from `latest-session.sh`)
   - Now, Resume prompt, In flight, Next, Open questions
2. If `Active task` is set, update the matching
   `docs/agent/tasks/<slug>.md`:
   - Move `[ ]` → `[~]` / `[x]` / `[!]` / `[-]` as work progressed.
   - Update `Current edge` (where exactly work paused).
3. **Do NOT** create a session file.
4. **Do NOT** append `JOURNAL.md` or `DECISIONS.md`.
5. **Do NOT** `git add` or commit. The point is to land memory on disk
   fast so the next agent in the same worktree can read it.
6. Promote to full `save session` at end of work or before tool switch.

> **In Claude Code:** `TodoWrite` is an in-context scratchpad — mirror
> durable steps to the task file at each checkpoint.
> **In Codex CLI:** the agent's own step tracking serves the same role.

---

## save session

Full handoff. Promotes the in-memory plan to durable repo memory so the
next agent (any tool, any clone after `publish session`) can resume.

1. **Drift recheck.** Run `docs/agent/scripts/drift-check.sh` again
   before writing. Catches code edits the agent forgot to mention.

2. **Anti-stale-save guard.** Compare current `latest-session.sh` output
   with the path `STATE.md` recorded as `Latest session read`. If a new
   session file appeared (another agent saved while you worked):
   - **STOP.** Do not write over a stale base.
   - Read the new latest session.
   - Go to **Recovery** (below).
   - Re-attempt save only after recovery is complete.

3. Rewrite `docs/agent/STATE.md`. Must include all fields validated by
   `validate-memory.sh`:
   - `Protocol version: 2`
   - `Updated: <ISO 8601 with Europe/Rome offset>`
   - `Tool last wrote: Claude Code | Codex CLI`
   - `Branch: <name>`
   - `Last code commit: <full SHA> <subject>`
   - `Code worktree: clean | dirty`
   - `Tracked dirty code paths:` — explicit, or "none"
   - `Relevant untracked code paths:` — explicit, or "none"
   - `Active task: <none | slug>`
   - `Latest session read: <path | none>` — the session this save
     built on (the one read at `start session`, not the one being
     created now)
   - Sections: `Now`, `Resume prompt`, `In flight`, `Next`,
     `Open questions / blockers`, `Environments`

4. Update the active task file if one is set. Move checkboxes; update
   `Current edge`.

5. **Create** a new session file:

   ```
   docs/agent/sessions/YYYY-MM-DD-HHMMSS-<tool>-<slug>.md
   ```

   - `YYYY-MM-DD-HHMMSS` — Europe/Rome local time, six-digit time
     component for sub-minute sortability.
   - `<tool>` — `claude` or `codex` (the only tokens
     `validate-memory.sh` accepts on v2; extend the regex if you adopt
     a third tool).
   - `<slug>` — short kebab-case description (`[a-z0-9-]+`).

   The file must contain (template below):
   - `Tool`, `Started from session`, `Branch`, `Code worktree`,
     `Tracked dirty code paths`, `Relevant untracked code paths`,
     `Active task`
   - Sections: `Done`, `Changed files / intent`, `Decisions`,
     `Failed approaches / do not retry`, `Next`, `Resume prompt`

   `Resume prompt` is **mandatory**. A session file without it is a
   bad save.

6. Append a short entry to `docs/agent/JOURNAL.md`:

   ```
   ## YYYY-MM-DD HH:MM <tool> <slug>
   - <one-line accomplishment>
   - <key decision if any>
   - see: docs/agent/sessions/<file>.md
   ```

7. If a non-trivial decision was made, also append a one-line entry to
   `docs/agent/DECISIONS.md`:

   ```
   YYYY-MM-DD · <one-line decision> · <sessions/file.md or commit SHA>
   ```

   This is the email-to-telegram fork's addition; the upstream package
   does not require DECISIONS.md.

8. **Narrow staging.** Stage only the files this save actually touched.
   Never `git add .` or `git add docs/agent`:

   ```bash
   session_file="docs/agent/sessions/$(date +%F-%H%M%S)-<tool>-<slug>.md"
   git add -- docs/agent/STATE.md docs/agent/JOURNAL.md "$session_file"
   # If a decision was logged:
   git add -- docs/agent/DECISIONS.md
   # If active task was updated:
   git add -- docs/agent/tasks/<slug>.md
   # If root/identity files were intentionally changed (protocol tweak,
   # workflow fix, .gitignore edit), stage them explicitly — never
   # implicitly:
   git add -- AGENTS.md CLAUDE.md .codex/notes.md .gitignore \
              .github/workflows/deploy-staging.yml
   ```

9. **Preflight validation.** Run:

   ```bash
   docs/agent/scripts/validate-memory.sh
   ```

   Must print `OK`. If it fails, fix and re-stage. **Do not commit
   broken memory.**

10. **Local commit:**

    ```bash
    git commit -m "chore(agent): save session — <one-line summary>"
    ```

11. **No push.** Push is the explicit `publish session` verb. Even
    though `deploy-staging.yml` has `paths-ignore` for memory paths,
    push is still always an explicit user action.

---

## publish session

```bash
git push
```

That's it. Always an explicit user verb. The staging workflow has
`paths-ignore` for `docs/agent/**`, `AGENTS.md`, `CLAUDE.md`,
`.codex/**`, so memory-only pushes do not trigger deploys — but the
separation between local commit (`save session`) and remote push
(`publish session`) is intentional. It keeps the workflow stable even if
CI filters change.

Within a single clone, `publish session` is rarely needed day-to-day.
Across clones / machines, the other side won't see your latest save
until `publish session` runs and the other side pulls.

---

## Recovery rule

Trigger when any of the following is true on `start session`:

- The branch differs from what `STATE.md` claims.
- The `Last code commit` SHA is missing or far behind `HEAD`.
- Tracked code is unexpectedly dirty (from `drift-check.sh`).
- A new session file appeared after `STATE.md`'s `Latest session read`.
- A crash/limit happened before the last save completed.

Steps:

1. Treat `STATE.md` as **partially stale**. Don't trust the old
   `Resume prompt` blindly.
2. Re-run `drift-check.sh`. Look at `git log -10 --oneline` and
   `git diff --stat <Last code commit>..HEAD`.
3. Look at the worktree: `git diff` on dirty files.
4. If relevant untracked source/test/config files exist, inspect them
   if and only if they matter to the current task — they cannot be
   reconstructed from git.
5. Cross-reference: what does `STATE.md` say + what does the newest
   session file say + what does the active task file say + what does
   the actual diff show? The truth is the intersection.
6. Rewrite `STATE.md` as a recovery snapshot. Use the header:
   ```
   ## Now
   Recovered after interrupted session. Reconstructed from git diff +
   latest session. Verify before relying on it.
   ```
7. Do a `checkpoint` immediately. Pins the new reality to disk.
8. Continue work, then `save session` normally.

If recovery is non-trivial, surface the gap to the user **before** any
code edits.

---

## Multi-session tasks

Trigger: work that will obviously span more than one `save session` —
refactors, deep reviews, multi-step audits, bug hunts.

1. **Create `docs/agent/tasks/<slug>.md`** at task start (template
   below). `Status: in progress`. `Active: yes`.
2. **Only one task is `Active: yes` per branch at a time.** If a second
   one appears, stop and ask the user which is active.
3. **`STATE.md` `Active task`** field links to the task slug.
4. **Plan section** uses checkboxes:
   ```
   - [ ] not started
   - [~] in progress
   - [!] blocked
   - [x] done
   - [-] abandoned / superseded
   ```
5. **`checkpoint`** keeps `STATE.md` and the task file aligned. No
   commit.
6. **`save session`** at end of session writes a session file that
   **links** the task file rather than duplicating its findings.
7. **Fresh session resumes** by reading `STATE.md` → linked task file →
   last `[~]` / `[x]` markers + `Current edge`. Compaction and
   usage-limit interruptions are handled the same way: chat history is
   disposable; the task file is the durable plan.
8. **On task completion:** set `Status: completed`, `Completed: <date>`,
   `Active: no`. File stays for history — no archive shuffle.
9. If `Findings` for any step grows past ~200 lines, move it out to
   `docs/agent/artifacts/<date>-<slug>.md` and link from the task file.

---

## Templates

### STATE.md

```markdown
# State

**Protocol version:** 2
**Updated:** <ISO 8601 with Europe/Rome offset>
**Tool last wrote:** Claude Code | Codex CLI
**Branch:** <branch>
**Last code commit:** <full SHA> <subject>
**Code worktree:** clean | dirty
**Tracked dirty code paths:** <none | list>
**Relevant untracked code paths:** <none | list>
**Active task:** <none | slug>
**Latest session read:** <path | none>

## Now

<1–3 lines: what we are doing right now.>

## Resume prompt

<One paragraph for a fresh agent: goal, where to pick up, the first file
to open, the first command to verify. Direct, imperative.>

## In flight

- <important unfinished>

## Next

1. <first concrete step>
2. <next step>

## Open questions / blockers

- <if any>

## Environments

- Staging (kc-vprojects): <image tag>, <health>, migration head <ts>
  verify-with: `ssh kc-vprojects 'docker ps --filter name=email-to-telegram-app --format "{{.Image}} {{.Status}}"'`
- Prod (emails-tg-prod): <image tag>, <health>, migration head <ts>
  verify-with: `ssh emails-tg-prod 'docker ps --filter name=email-to-telegram-app --format "{{.Image}} {{.Status}}"'`
- Migration head (either host): `ssh <host> 'docker exec email-to-telegram-postgres-1 psql -U emailtelegram -d emailtelegram -tAc "select max(created_at) from drizzle.__drizzle_migrations"'`
```

### Session file

```markdown
# Session <YYYY-MM-DD HH:MM:SS> — <tool> — <slug>

**Tool:** Claude Code | Codex CLI
**Started from session:** <previous session path | none>
**Branch:** <branch>
**Code worktree:** clean | dirty
**Tracked dirty code paths:** <none | list>
**Relevant untracked code paths:** <none | list>
**Active task:** <none | slug>

## Done

- ...

## Changed files / intent

- `<path>` — <what changed and why>

## Decisions

- ... (also indexed in docs/agent/DECISIONS.md)

## Failed approaches / do not retry

- ...

## Next

1. ...

## Resume prompt

<One dense paragraph a fresh agent can act on immediately: goal, where
to pick up, the first concrete step, what to verify first.>
```

If worktree is dirty, the `Changed files / intent` section is
**mandatory**. A file list alone is not enough — the next agent needs to
know _why_ it changed and _what must not be accidentally reverted_.

### JOURNAL.md (append-only)

```markdown
# Journal

## YYYY-MM-DD HH:MM <tool> <slug>

- <one-line accomplishment>
- <key decision if any>
- see: docs/agent/sessions/<file>.md
```

### DECISIONS.md (one line per durable decision, append-only)

```
YYYY-MM-DD · <one-line decision> · <sessions/file.md or commit SHA>
```

Reversals add a superseding line. Reasoning lives in the linked session
file, never inline.

### Task file (`docs/agent/tasks/<slug>.md`)

```markdown
# Task: <one-line goal>

**Status:** in progress | completed | abandoned
**Started:** YYYY-MM-DD
**Completed:** YYYY-MM-DD | —
**Active:** yes | no
**Slug:** <kebab-case>

## Goal

<1–3 paragraphs: what and why.>

## Plan

- [x] Step 1: <description>
- [~] Step 2: <description>
- [!] Step 3: <description, blocked because …>
- [ ] Step 4: <description>

## Findings

### Step 1

<what surfaced>

### Step 2

<in-progress notes>

## Decisions

- <non-trivial decisions made during this task>

## Current edge

<Where exactly work paused. The next agent picks up here.>

## Open questions

- <pending>
```

---

## Acceptance tests

Run after any protocol change. Tests 1–7 are upstream; Test 8 is the
email-to-telegram fork's untracked-relevance rule.

### Test 1 — Cross-tool handoff Claude → Codex

1. Claude Code: `start session`, trivial work (touch a comment),
   `save session`.
2. Codex CLI (or after closing Claude): `start session`.
3. Codex must correctly name: current goal, active task (if any),
   dirty paths, the first concrete step.

### Test 2 — Cross-tool handoff Codex → Claude

Mirror of Test 1.

### Test 3 — Dirty code is announced

1. Modify a tracked code file. Do not commit. `save session`.
2. The new `STATE.md` and session file must list the file under
   `Tracked dirty code paths` and explain intent in `Changed files /
intent`.

### Test 4 — checkpoint is not a handoff

1. Do a `checkpoint`.
2. Open a fresh window in a **different clone** (or simulate by
   pulling from origin without your latest commit).
3. The other agent must NOT see the checkpoint state. Expected.

### Test 5 — Memory-only commit must NOT trigger CI

1. `save session` with only memory file changes.
2. `publish session`.
3. The deploy workflow must skip (because of `paths-ignore`).

### Test 6 — Anti-stale-save guard

1. From Tool A: `start session`. Note `Latest session read`.
2. From Tool B (different window/clone, same branch): make a
   `save session`.
3. Pull/rebase on Tool A side so the new session file is visible.
4. From Tool A: try `save session`. The guard must trigger: refuse
   to save, read the new session, enter recovery.

### Test 7 — validate-memory.sh catches structural errors

1. Manually break `STATE.md` (remove `## Resume prompt`).
2. Stage. Run `validate-memory.sh`. Must `FAIL`.
3. Restore. Try again. Must print `OK`.

### Test 8 — Untracked source file flagged; tmp/ scratch ignored

1. Create an untracked file under a code-relevant path:
   ```bash
   touch src/_drift_test.ts
   touch tmp/scratch_test.md
   ```
2. `start session`. The agent must:
   - Show `Tracked code changes:` as empty (drift gate quiet).
   - Show both files under `Untracked files (all):`.
   - **Explicitly flag** `src/_drift_test.ts` as possible in-progress
     work.
   - **Not flag** `tmp/scratch_test.md` (scratch, ignored).
3. Cleanup: `rm src/_drift_test.ts tmp/scratch_test.md`.

---

## Pitfalls and lessons learned

- **`cd "$(git rev-parse --show-toplevel)" && …` triggers a permission
  prompt on every call.** Claude Code's static matcher cannot evaluate
  `$(...)`. Use bare commands from inherited CWD; the scripts in
  `docs/agent/scripts/` handle normalization internally.
- **`git -C <abs_path> <verb> …` does not match `Bash(git <verb>:*)`
  allowlist entries.** The matcher keys on literal first tokens. Avoid
  `-C`; use bare commands.
- **`Last code commit` is not a sacred cow.** It's informational +
  feeds `drift-check.sh`. Don't build elaborate baseline-correction
  theory around it. (Earlier v1 had a "Code baseline SHA" with a
  bootstrap-correction dance — burned us once, dropped in v2.)
- **Don't broaden CI `paths-ignore` to `docs/**`.** GitHub Actions
skips a workflow only when **all** changed paths match — broader
filters are mostly harmless but mask intent. Keep narrow:
`docs/agent/**`, `AGENTS.md`, `CLAUDE.md`, `.codex/**`.
- **Don't put secrets in any committed memory file.** Reference them
  (`"DB password lives in each server's .env"`), never inline.
  `LOCAL.md` is gitignored but the same rule applies — local risk only.
  `validate-memory.sh` has a cheap pattern scan as a backstop.
- **Vendor session machinery may collide.** Claude marketplace
  plugins' `save-session` skill, ECC `SessionStart` hook, Codex hooks —
  when names collide with the verbs here, this protocol wins. Hard
  rule #5.
- **Don't make `STATE.md` long.** One screen, max. If it's growing
  past a screen, move durable plans to `docs/agent/tasks/<slug>.md`.
- **Don't `@`-import mutable docs from `CLAUDE.md`.** Imports load at
  startup. Mutable state belongs to `start session`, not boot.
- **Don't trust the most recent commit as "the code baseline"
  reflexively.** If the latest commit is memory-only, code baseline is
  the latest non-memory commit, which may be older. `drift-check.sh`
  filters this automatically via pathspec.
