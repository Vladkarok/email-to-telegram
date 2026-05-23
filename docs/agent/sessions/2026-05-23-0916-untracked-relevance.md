# Session 2026-05-23 09:16 untracked-relevance

**Tool:** Claude Code
**Branch at end:** main
**Code baseline SHA at end:** a216c92
**Code worktree at end:** clean

## Done

- Closed a remaining gap in the worktree-drift rule. Prior version:
  "untracked files are advisory only, never drift." That correctly muted
  noise from `tmp/` and other scratch dirs, but it would also silently
  swallow a real in-progress new source file (e.g. `src/foo.ts` created
  but not yet `git add`'d).
- Adopted the user's three-tier rule:
  - **Tracked code drift** → gate fires, reconstruct.
  - **Memory in flight** → advisory only, never reconstruct.
  - **Untracked files** → advisory by default, **with a relevance check**.
    Scratch (`tmp/`, build outputs, dependency caches) is noise; an
    untracked file under a source/test/config path (`src/**`, `tests/**`,
    root TS/JSON configs) is **possible code drift** — flag it explicitly
    in the advisory output. Don't auto-reconstruct; surface for the
    user's decision.
- Updated `AGENTS.md` step 5 of `start session` and the plan in
  `tmp/agent-memory-plan-final.md` with the same wording.
- Added **acceptance Test 3c** to the plan: touch `src/_drift_test.ts`,
  confirm full status surfaces it as `??`, drift gate stays empty,
  cleanup with `rm`. Self-tested live — passed.

## Decisions

- Adopt the three-tier rule. The gate stays mechanical and binary
  (tracked code only); the relevance check on untracked files is
  convention/judgment, applied by the agent reading the full status
  output. No new commands; no new pathspec gymnastics.

## Failed approaches (avoid retrying)

- (none this session)

## Next

1. `publish session` when convenient — one new memory commit landing.

## Resume prompt

The worktree-drift detection now has the right granularity: the gate is
mechanical and tracked-code-only (`git status --porcelain=v1
--untracked-files=no -- ':!docs/agent' ':!AGENTS.md' ':!CLAUDE.md'`),
while untracked files surface in the full advisory output where the agent
applies a relevance check — scratch paths ignored, source/test/config
paths flagged as possible drift. Memory dirty is purely advisory. No
behavioral regressions; this is purely a refinement of how the agent
should narrate what it found. One new local memory commit will land with
this save. First next action: `publish session` whenever convenient. CI
ignores memory-only paths; the push is deploy-safe.
