# Session 2026-05-24 13:45 drop-cd-wrapper-from-protocol

**Tool:** Claude Code
**Branch at end:** main
**Code baseline SHA at end:** d20cf26
**Code worktree at end:** clean

## Done

- Rewrote step 0 of both `start session` and `save session` in `AGENTS.md`
  to drop the `cd "$(git rev-parse --show-toplevel)" && …` wrapper. The
  new instruction tells the agent to run bare `git <verb> …` from the
  inherited CWD (both Claude Code and Codex CLI start in repo root) and
  explicitly warns that `$(...)` substitution defeats the static
  permission matcher, so the old form prompts on every invocation.
- Fallback documented: if a future harness ever starts outside the repo,
  use a literal absolute `cd /abs/path && …` instead (matches `cd:*`).

## Decisions

- Protocol step 0 standardizes on bare git from inherited CWD. The
  `cd "$(...)"` wrapper is officially deprecated in this repo's
  protocol. (Also indexed in `docs/agent/DECISIONS.md`.)

## Failed approaches (avoid retrying)

- See prior session (`2026-05-23-1150-allowlist-protocol-tweaks.md`) for
  the two dead ends already catalogued:
  `Bash(cd "$(git rev-parse --show-toplevel)" && *)` allowlist entry, and
  `git -C <abs> <verb>` rewrites. Both still fail.

## Next

1. Delete pre-rebaseline DB backups once v2.5.0 has soaked (commands in
   STATE.md "Next").
2. Exercise the multi-session task model on a real deep review/refactor —
   create the first `docs/agent/tasks/<slug>.md`.

## Resume prompt

Project at v2.5.0, code baseline `d20cf26`, worktree clean. Protocol
step 0 is now prompt-free: bare git commands from inherited CWD. No
active task. Two open follow-ups in STATE.md "Next": delete pre-rebaseline
DB backups after another day of soak, and start using the multi-session
task model on the next real deep review/refactor.
