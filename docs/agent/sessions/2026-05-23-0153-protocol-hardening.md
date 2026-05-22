# Session 2026-05-23 01:53 protocol-hardening

**Tool:** Claude Code
**Branch at end:** main
**Code baseline SHA at end:** a216c92
**Code worktree at end:** clean

## Done

- Evaluated four user-proposed protocol refinements. Adopted three, skipped
  one with reasoning.
- **Adopted #1 — narrow `save session` staging.** Replaced the broad
  `git add AGENTS.md CLAUDE.md docs/agent` with explicit per-file staging:
  `git add -- docs/agent/STATE.md docs/agent/DECISIONS.md "$session_file"`
  for routine saves, with a separate explicit add for root files only when
  intentionally changed. The bootstrap commit remains the documented
  exception (one broad add). Applied to both `AGENTS.md` and the plan.
- **Adopted #2 — repo-root normalization.** Added
  `cd "$(git rev-parse --show-toplevel)"` as step 0 of both `start session`
  and `save session` in `AGENTS.md` and the plan. Bulletproofs the
  protocol against running from a subdirectory.
- **Adopted #3 — robust baseline extraction in the acceptance test.**
  Replaced `awk` with
  `sed -n 's/^\*\*Code baseline SHA:\*\* //p' docs/agent/STATE.md | head -1`
  in the plan's Test 1 example. The previous `awk '$NF'` form was correct
  only as long as the SHA was the last whitespace-delimited token; the
  `sed` form is deterministic about what it extracts.
- **Skipped #4 — explicit `:(top,glob,exclude)docs/agent/**`pathspec.**
With #2 in place (always at repo root), the short form`:!docs/agent`is
semantically identical. The verbose form's`top` magic protects against
  being in a subdir, but that risk is already handled. Verbosity for no
  additional safety.
- Self-tested by using the new narrow staging on this very save — staged
  `STATE.md` + `DECISIONS.md` + this session file explicitly, and
  `AGENTS.md` separately (it was intentionally changed for the protocol
  edit).

## Decisions

- Narrow staging is the default for routine saves; broad staging is the
  bootstrap exception (still documented).
- Repo-root normalization is step 0 of both protocol verbs, not a
  precondition the agent is expected to satisfy independently.
- Short-form pathspec excludes (`:!docs/agent` etc.) stay; the explicit
  pathspec-magic form is available as documentation but not the default.

## Failed approaches (avoid retrying)

- The initial `awk -F'`'`baseline parser assumed backticks around the SHA;
STATE.md uses plain bare SHA, so the parser returned empty. Twice-bitten:
first fixed to`awk '$NF'`, now fixed properly to `sed`.

## Next

1. Open a fresh Codex CLI session, type `start session` — confirm step 0
   normalizes to repo root, the rest of the protocol runs, drift check
   returns empty.
2. Same in a fresh Claude Code session.
3. `publish session` whenever convenient — five local memory commits are
   waiting. Staging workflow's `paths-ignore` makes the push deploy-safe.

## Resume prompt

The memory protocol is now hardened against four classes of subtle bugs:
seed-baseline drift (pass3), false-positive drift after memory commits
(pass3), broad-staging accidents (this session), and CWD assumptions (this
session). Five local memory commits sit on `main`. The first concrete next
action is end-to-end verification: open a fresh Codex CLI session in
`/home/vladkarok/Work/email-to-telegram` and type `start session`. Expected:
the agent runs `cd "$(git rev-parse --show-toplevel)"` first, then reads
`STATE.md` (baseline `a216c92`) + this file, runs the drift check (empty),
runs the staging/prod `verify-with:` commands (`:main` and `:v2.5.0` both
healthy), and surfaces this resume prompt. Repeat in Claude Code (the ECC
hook will fire; agent should treat its summary as advisory per standing
rule #4). Once both pass, `publish session` to push. Nothing else pending.
