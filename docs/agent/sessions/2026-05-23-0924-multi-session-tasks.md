# Session 2026-05-23 09:24 multi-session-tasks

**Tool:** Claude Code
**Branch at end:** main
**Code baseline SHA at end:** a216c92
**Code worktree at end:** clean

## Done

- Answered the gap the user surfaced: how the protocol handles
  long-running multi-step work (deep reviews, refactors,
  execution-plan-driven tasks) so progress survives `checkpoint` cycles,
  context compaction, and usage-limit interruptions.
- Formalized **multi-session task plans** in `docs/agent/tasks/<slug>.md`.
  These hold the running plan (checkbox state per step) + per-step
  findings + open questions, lasting across sessions. STATE.md "Now"
  links to the active task; "Next" is the next checkbox.
- Updated `AGENTS.md`:
  - New "Multi-session tasks" section between Recovery rule and Templates.
  - New task file template under "## Templates".
  - Added `docs/agent/tasks/` to the doc index and load classes.
  - `checkpoint` definition updated to mention task-file alignment.
  - New standing rule #4 "Compaction and limit resilience": treat any
    approach to a context limit / imminent compaction / end-of-session as
    a forced `checkpoint`; flush in-context memory to disk before further
    work. Existing rules renumbered (ECC rule is now #5).
- Same updates applied to `tmp/agent-memory-plan-final.md`.
- Created `docs/agent/tasks/` with a `.gitkeep` so the directory exists
  before the first real task is created.

## Decisions

- New file type: `docs/agent/tasks/<slug>.md`. Under `docs/agent/` so it's
  already covered by the memory-paths excludes (no `paths-ignore`
  update, no drift-gate update needed).
- Task files live forever as history (no archive shuffle on completion);
  status header marks them complete.
- TodoWrite (Claude) / in-context step tracking (Codex) is the fast
  in-session draft; mirror to the task file at each `checkpoint`. The
  task file is durable; the in-context list is disposable.
- New standing rule for compaction/limit resilience — treats those
  events as forced `checkpoint`s.

## Failed approaches (avoid retrying)

- Considered putting task plans in `docs/plans/` (which already exists).
  Rejected: `docs/plans/` isn't in the memory paths-ignore list, so
  active edits would falsely trip the drift gate AND a push would
  redeploy staging. `docs/agent/tasks/` slots in cleanly.
- Considered using long-lived session files (appending to one session
  file across the task). Rejected: violates "sessions are dated and
  immutable" — session files are scoped to one session, not one task.

## Next

1. `publish session` when convenient.
2. The next real multi-session task should create the first
   `docs/agent/tasks/<slug>.md` and exercise the model end-to-end —
   that's the production validation.

## Resume prompt

Multi-session work now has a durable home: `docs/agent/tasks/<slug>.md`.
STATE.md "Now" links to the active task; `checkpoint` keeps both files
aligned without committing; `save session` includes the task file in the
narrow staging; fresh sessions resume by reading the task file's
checkboxes. Standing rule #4 says: treat any approach to a context limit,
imminent compaction, or end-of-session as a forced `checkpoint` — flush
in-context memory to disk first. One local memory commit will land with
this save (eight unpushed total, all memory-only since the v2.5.0
release). First next action: `publish session` when convenient; the
staging workflow ignores memory paths so the push is deploy-safe.
