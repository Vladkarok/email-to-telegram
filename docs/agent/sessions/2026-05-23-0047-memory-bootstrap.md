# Session 2026-05-23 00:47 memory-bootstrap

**Tool:** Claude Code
**Branch at end:** main
**Code baseline SHA at end:** a45111d
**Code worktree at end:** dirty — `.github/workflows/deploy-staging.yml` has
`paths-ignore` added for `docs/agent/**`, `AGENTS.md`, `CLAUDE.md` so memory
commits don't trigger a staging deploy; included in this bootstrap commit.

## Done

- Iterated four agent-memory-system plans (Plan A minimal, Plan B structured,
  Minimal+ Revised, and three external "pass1"/"pass2" reviews from GPT
  deep-research, Claude, and Perplexity). Converged on a single design.
- Created the memory system:
  - `AGENTS.md` (canonical, ~150 lines: tool-loading semantics, full protocol
    for `start session` / `save session` / `publish session` / `checkpoint` /
    recovery rule, `STATE.md` + session-file templates inline, doc index,
    four standing rules).
  - `CLAUDE.md` (`@AGENTS.md` import + ECC integration rule).
  - `docs/agent/STATE.md` seeded with current reality (v2.5.0 live, both
    DBs at the squashed baseline, the deploy-staging `paths-ignore` change
    flagged as the only dirty path).
  - `docs/agent/DECISIONS.md` backfilled with three durable decisions
    (re-baseline, v2.5.0 release, memory bootstrap).
  - `docs/agent/sessions/` with this first file.
  - `docs/agent/LOCAL.md` added to `.gitignore`.
- Added `paths-ignore: ['docs/agent/**', 'AGENTS.md', 'CLAUDE.md']` to
  `.github/workflows/deploy-staging.yml` so memory commits no longer rebuild
  or bounce the staging container.
- Trimmed the stale Claude project memory at
  `~/.claude/projects/-home-vladkarok-Work-email-to-telegram/memory/`:
  removed obsolete `project_manual_billing_branch.md` and
  `project_donation_pivot.md`; rewrote `MEMORY.md` as a one-line pointer to
  `docs/agent/STATE.md`. Kept `user_profile.md` and `feedback_review_loop.md`
  as still-useful workflow preferences.

## Decisions

- Plain Markdown over YAML frontmatter — equally LLM-parseable, lower
  friction (revisit if Phase 2 skills parse it).
- One-line `DECISIONS.md` index over ADR-lite log — reasoning lives in the
  immutable dated session file or commit, no duplication.
- No `PROJECT.md` / `OPERATIONS.md` / `CONTEXT.md` — link existing
  `README.md` + `docs/operations/` + `docs/plans/` rather than create thin
  duplicate-pointer files.
- `HHMM` in session filenames over `-2`/`-3` suffixes — deterministic sort,
  no collision.
- `save session` commits locally; explicit `publish session` for push.
- Track **Code baseline SHA** (latest non-memory commit) separately in
  `STATE.md` so memory commits don't trigger false-drift alarms at
  `start session`.
- Repo memory is canonical; the Claude ECC session machinery must be
  disabled for this project or rewritten as an adapter over `docs/agent/`.

## Failed approaches (avoid retrying)

- `drizzle-kit generate` against the original `drizzle/meta/` interactively
  requires answering rename-or-drop prompts that can't be piped — the squash
  had to be generated from an empty `out` dir and grafted back. Already
  solved in commit `a45111d`; recording so a future agent doesn't repeat
  the dead end.

## Next

1. Open a fresh **Codex CLI** session in this repo, type `start session`,
   and confirm: (a) it reads `AGENTS.md` + this file + `STATE.md`,
   (b) it runs the git check + baseline-SHA diff, (c) it runs the
   staging/prod `verify-with:` commands and reports current state.
2. Repeat in a fresh **Claude Code** session.
3. Resolve **ECC reconciliation** (open question in `STATE.md`): disable
   the ECC `SessionStart` hook for this project (simpler), OR rewrite the
   ECC `save-session` / `resume-session` skill into a pure adapter over
   `docs/agent/`.
4. Optionally delete the pre-rebaseline DB backups on both servers once
   v2.5.0 has soaked another day or two.

## Resume prompt

The agent memory system has just been bootstrapped. The first concrete
action is end-to-end verification: open a fresh **Codex CLI** session in
`/home/vladkarok/Work/email-to-telegram`, type `start session`, and confirm
the agent (a) reads `STATE.md` and this file, (b) runs `git status` and the
baseline-SHA diff (which should report "no real code commits since
baseline"), (c) executes the staging/prod `verify-with:` commands from
`STATE.md` and reports both as `:main` / `:v2.5.0` healthy at migration
head `1779472699656`. Then do the same in a fresh Claude Code session.
Before doing any other engineering work, resolve the ECC reconciliation
open question with the user — recommended default: disable the ECC
`SessionStart` hook for this project. Nothing else is in flight; the next
thread is user-driven.
