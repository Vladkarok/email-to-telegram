# Session 2026-05-23 11:50 allowlist-protocol-tweaks

**Tool:** Claude Code
**Branch at end:** main
**Code baseline SHA at end:** d20cf26
**Code worktree at end:** clean

## Done

- Extended `.claude/settings.local.json` allowlist with `sort:*`,
  `xargs:*`, `test:*`, `[:*` — covers the start-session pipeline
  (`find … | sort | tail -1 | xargs cat`, `[ -f docs/agent/LOCAL.md ]`).
- Confirmed via prompt behavior that **command-substitution wrappers
  block static matching**. The current AGENTS.md form
  `cd "$(git rev-parse --show-toplevel)" && …` cannot be allowlisted by
  pattern because the matcher refuses to statically analyze `$(...)`.
- Confirmed via prompt behavior that **`git -C <path> <verb>` does not
  match `Bash(git <verb>:*)`** — the matcher keys on the literal first
  tokens (`git -C …`), not the semantic verb. So `git -C /abs log …`
  prompts even when `git log:*` is allowed.
- Working forms that avoid prompts entirely (both split into individually
  allowlisted tokens):
  - `cd /abs/path && git <verb> …` — `cd:*` + `git <verb>:*` both hit.
  - Bare `git <verb> …` from whatever CWD the harness already has —
    relies on inherited CWD being the repo root (true for this project).
- `.claude/settings.local.json` is gitignored (confirmed: empty
  `git status` after editing it).

## Decisions

- Prefer **bare git commands from inherited CWD** for protocol steps
  going forward — simpler than `cd <abs> && …` and statically matches
  existing `git <verb>:*` allowlist entries. Only use the
  `cd "$(git rev-parse --show-toplevel)"` form when explicitly needed
  for portability (which it isn't, in practice — the harness already
  starts in the repo root).

## Failed approaches (avoid retrying)

- `Bash(cd "$(git rev-parse --show-toplevel)" && *)` allowlist entry
  looked plausible but doesn't help — static matcher rejects the entire
  command on the `$(...)` substitution before pattern-matching kicks in.
- `git -C <abs> log …` looked like a clean substitute but the matcher
  doesn't normalize past the `-C <path>` arguments to the verb.

## Next

1. Update `AGENTS.md` `start session` / `save session` step 0 and the
   sample commands to drop `cd "$(git rev-parse --show-toplevel)"`
   wrappers — use bare git commands instead, since the harness CWD is
   the repo root. This is the durable fix for the prompt spam.
2. Delete pre-rebaseline DB backups once v2.5.0 has soaked (commands in
   STATE.md "Next").
3. Exercise the multi-session task model on a real deep review/refactor.

## Resume prompt

Protocol commands now run prompt-free **if** they're issued as bare
`git <verb> …` from the inherited CWD (the repo root). AGENTS.md still
documents the `cd "$(git rev-parse --show-toplevel)" && …` form, which
unavoidably prompts (command substitution defeats static analysis). Next
session should update AGENTS.md step 0 in `start session` / `save
session` to recommend bare git commands and drop the cd wrapper — that
makes the documented protocol match what actually runs prompt-free.
Project at v2.5.0, code baseline `d20cf26`, worktree clean.
