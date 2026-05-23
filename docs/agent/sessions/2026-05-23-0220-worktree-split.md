# Session 2026-05-23 02:20 worktree-split

**Tool:** Claude Code
**Branch at end:** main
**Code baseline SHA at end:** a216c92
**Code worktree at end:** clean

## Done

- Closed the last asymmetry in the drift-detection design: the worktree
  check now matches the commit check.
- **Before:** `start session` step 4 ran plain `git status --porcelain=v1`
  and step 5 said "if the worktree is dirty, reconstruct." That treated a
  dirty `STATE.md` (e.g. after `checkpoint`, or mid-save) as drift.
  Symmetric with the bug the commit-side filter already fixed.
- **After:** step 4 runs two statuses:
  - Full: `git status --porcelain=v1` — advisory; catches memory in flight,
    untracked scratch like `tmp/`.
  - **Drift gate:**
    `git status --porcelain=v1 --untracked-files=no -- ':!docs/agent' ':!AGENTS.md' ':!CLAUDE.md'` —
    tracked-code-only. This is what step 5 actually checks. Untracked is
    advisory regardless.
- `save session` step 2 now spells out that both **Code baseline SHA** and
  the **Code worktree**/**Uncommitted code paths** fields are computed
  from the code-filtered status (with the same exclude pathspecs).
- Split acceptance Test 3 into 3a (code dirty → must flag as drift) and
  3b (memory dirty → must NOT flag; advisory only).
- Self-tested both 3a and 3b live. 3b passes against the current dirty
  state (AGENTS.md, STATE.md, DECISIONS.md, plan all mid-edit; drift gate
  is empty). 3a triggered the gate via a temporary newline append to
  README.md; reverted, gate empty again.

## Decisions

- Drift gate = tracked code only (`--untracked-files=no` + memory excludes).
- Memory-in-flight dirtiness is reported as advisory in `start session` but
  never triggers the reconstruction logic. This matches `checkpoint`'s
  intent (STATE.md is meant to be dirty until the next `save session`).
- Adopted the user's full proposal verbatim, plus the `--untracked-files=no`
  refinement after seeing `tmp/` and `cloudflare-worker/` survive the path
  filter in a live test.

## Failed approaches (avoid retrying)

- First attempt at the drift gate omitted `--untracked-files=no`. The
  pathspec excludes don't filter untracked files (which are unpathed in
  git's eyes), so `tmp/` and `cloudflare-worker/cloudflare-worker/` showed
  up in the supposedly-code-only output. Adding `--untracked-files=no`
  fixed it — untracked files are caught by the full advisory status above
  the gate, where they belong.

## Next

1. Open a fresh Codex CLI session, type `start session` — confirm the new
   dual status output is correctly produced and the drift gate is empty.
2. Repeat in Claude Code.
3. `publish session` when convenient (six local memory commits now).
4. Pre-rebaseline DB backups: housekeeping whenever you're comfortable
   v2.5.0 is stable.

## Resume prompt

The memory protocol's drift detection is now fully symmetric: the
commit-side filter (used since pass3) and the worktree-side filter (just
added) both treat `docs/agent/**`, `AGENTS.md`, `CLAUDE.md` as memory paths
that don't constitute "code drift." Untracked files (`tmp/`,
`cloudflare-worker/cloudflare-worker/`) are advisory only, never drift,
courtesy of `--untracked-files=no` on the gate command. Six local memory
commits sit on `main`. First concrete next action: open a fresh Codex CLI
session in `/home/vladkarok/Work/email-to-telegram` and type
`start session`. Expected output: full advisory status (shows untracked
`tmp/`, `cloudflare-worker/`), drift-gate status (empty), drift-commit
check (empty), staging/prod `verify-with:` (`:main` and `:v2.5.0` both
healthy at migration head `1779472699656`), then this resume prompt.
Repeat in Claude Code. Then `publish session` if you want them on the
remote — `paths-ignore` for memory paths keeps the push deploy-safe.
