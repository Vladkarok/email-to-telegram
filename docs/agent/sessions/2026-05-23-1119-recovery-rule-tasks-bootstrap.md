# Session 2026-05-23 11:19 recovery-rule-tasks-bootstrap

**Tool:** Claude Code
**Branch at end:** main
**Code baseline SHA at end:** a216c92
**Code worktree at end:** clean

## Done

- **Recovery rule consistency fix (plan + AGENTS.md).** Old phrasing
  implied untracked source/test/config files could trigger
  reconstruction. Untracked files don't exist in git, so they can't be
  reconstructed. New phrasing aligns the recovery rule with the
  three-tier worktree rule: tracked-code drift triggers reconstruction;
  untracked files are surfaced and inspected on demand only. Applied to
  both `tmp/agent-memory-plan-final.md` and the live `AGENTS.md`.
- **Bootstrap step 2 — `docs/agent/tasks/` now covered.** Previously
  the file layout listed `tasks/` but the rollout step omitted it. Step
  2 now says: create it at bootstrap, or defer until the first
  multi-session task starts — either is fine. Optional `.gitkeep`
  snippet included for repos that drop empty dirs.

## Decisions

- Recovery rule is consistent with the three-tier worktree rule
  (tracked = reconstruct; untracked = surface, never reconstruct).
- `docs/agent/tasks/` creation is bootstrap-or-lazy at the user's
  preference. This repo seeded a `.gitkeep` at bootstrap.

## Failed approaches (avoid retrying)

- n/a

## Next

1. Exercise the multi-session task model on real work — first
   `docs/agent/tasks/<slug>.md` is the production validation.

## Resume prompt

Agent memory system fully aligned with the canonical plan. Recovery
rule and three-tier worktree rule are mutually consistent. Bootstrap
checklist covers `docs/agent/tasks/`. Project at v2.5.0, baseline
`a216c92`, code worktree clean. No active multi-session task. First
next-action: any real deep review/refactor that's likely to span
sessions/compactions should create `docs/agent/tasks/<slug>.md` and
exercise the model end-to-end.
