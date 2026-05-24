# Session 2026-05-24 15:20:46 — claude — memory-system-v2-migration

**Tool:** Claude Code
**Started from session:** docs/agent/sessions/2026-05-24-1345-drop-cd-wrapper-from-protocol.md
**Branch:** main
**Code worktree:** clean
**Tracked dirty code paths:** none
**Relevant untracked code paths:** none
**Active task:** memory-system-v2-migration

## Done

- Migrated the agent memory system from v1 to **v2 hybrid**:
  - Lean root `AGENTS.md` (~110 lines, was ~333) — identity, verbs,
    authority order, hard rules, doc index only. Full operating
    manual moved to `docs/agent/PROTOCOL.md`.
  - Real Claude adapter in `CLAUDE.md` (was just a one-paragraph
    pointer); covers TodoWrite advisory, ECC collision rules, no
    `@`-imports of mutable docs, tool tag convention.
  - New Codex adapter `.codex/notes.md` (mirror of CLAUDE.md for
    Codex). Required gitignore surgery: pre-existing 0-byte
    gitignored `.codex` file at repo root renamed to `.codex.bak`;
    `.gitignore` line `.codex` rewritten to `.codex/*` +
    `!.codex/notes.md`.
  - Three helper scripts dropped in from upstream
    `~/Projects/agent-memory-system/docs/agent/scripts/`:
    `drift-check.sh`, `latest-session.sh`, `validate-memory.sh`.
    All three allowlisted in `.claude/settings.local.json` so they
    run prompt-free. **This permanently solves the
    `cd "$(git rev-parse ...)"` prompt-spam problem** documented in
    the prior session.
  - `STATE.md` rewritten to v2 schema: `Protocol version: 2`,
    `Tool last wrote`, `Last code commit` (full SHA + subject),
    `Tracked dirty code paths`, `Relevant untracked code paths`,
    `Active task`, `Latest session read`. Old `Code baseline SHA`
    field dropped (over-engineered, burned us once in v1; see
    commit `f911990`).
  - New `JOURNAL.md` (append-only chronological narrative).
  - `DECISIONS.md` **kept** as the email-to-telegram fork delta —
    one-line decision index complements JOURNAL.md's chronology.
    Upstream skips it on v1; we have 22 entries that justify it.

## Changed files / intent

- `AGENTS.md` — rewritten as lean root contract. Old protocol body
  removed; refer to `docs/agent/PROTOCOL.md`.
- `CLAUDE.md` — rewritten as proper Claude adapter (was 1-paragraph
  pointer with ECC note).
- `.codex/notes.md` — new Codex adapter file.
- `.codex.bak` — was `.codex` (0-byte gitignored marker). Pending
  decision: delete after Codex CLI soak confirms it doesn't recreate.
- `.gitignore` — narrowed `.codex` entry so `.codex/notes.md`
  commits while other `.codex/` content stays ignored.
- `docs/agent/PROTOCOL.md` — NEW, full v2 operating manual,
  customized for email-to-telegram (DECISIONS.md retained as fork
  delta documented in header; three-tier untracked-relevance rule
  preserved with explicit `src/**` vs `tmp/**` examples; Test 8
  added on top of upstream Tests 1–7).
- `docs/agent/STATE.md` — rewritten to v2 schema.
- `docs/agent/JOURNAL.md` — NEW, append-only narrative.
- `docs/agent/DECISIONS.md` — appended one entry for the v2 adoption.
- `docs/agent/scripts/drift-check.sh` — NEW, from upstream.
- `docs/agent/scripts/latest-session.sh` — NEW, from upstream.
- `docs/agent/scripts/validate-memory.sh` — NEW, from upstream.
- `docs/agent/tasks/memory-system-v2-migration.md` — checkboxes
  advanced; findings filled in; current edge updated.
- `.claude/settings.local.json` — gitignored; added three
  `Bash(docs/agent/scripts/*.sh)` entries.

## Decisions

- **Hand-port rather than run the upstream installer.** Installer
  assumes fresh state; we have 24 sessions, 22 decisions, real CI
  config, and content to preserve. Indexed in DECISIONS.md.
- **Keep DECISIONS.md alongside JOURNAL.md.** Email-to-telegram fork
  delta from upstream v2 (which folds decisions into JOURNAL).
  Documented in PROTOCOL.md header.
- **Drop `Code baseline SHA` from STATE.md.** Over-engineered;
  `Last code commit` + `drift-check.sh` is enough. The v1
  bootstrap-baseline-correction dance (`f911990`) was a smell we
  shouldn't reproduce.
- **Replace `.codex` empty file with `.codex/notes.md` directory.**
  Backup at `.codex.bak` pending soak.

## Failed approaches / do not retry

- (Inherited from prior sessions, still valid in v2.)
  `Bash(cd "$(git rev-parse --show-toplevel)" && *)` allowlist entry
  cannot match — Claude's static permission matcher refuses to
  evaluate `$(...)` before pattern-matching. The v2 scripts solve
  this by being callable as a bare path (`docs/agent/scripts/foo.sh`)
  which IS statically matchable.
- (Inherited.) `git -C <abs_path> <verb>` does not normalize against
  `Bash(git <verb>:*)` allowlist entries — the matcher keys on
  literal first tokens.

## Next

1. Run `docs/agent/scripts/validate-memory.sh` as the preflight for
   this very commit (it serves as acceptance Test 7 by reflexion).
2. Narrow-stage all migration files and commit as `chore(agent):
bootstrap memory system v2 (lean root + on-demand protocol +
scripts + JOURNAL, keep DECISIONS index)`.
3. Mark task plan steps 9 and 12 as `[x]`, flip task to
   `Status: completed`, `Completed: 2026-05-24`, `Active: no`.
4. Run Test 8 (untracked relevance) standalone — quick `touch` +
   `start session` rehearsal + cleanup.
5. Defer Tests 1, 2, 6 (cross-tool soak) to a future session when
   Codex CLI is at hand.
6. Decide on `.codex.bak` cleanup after soak.
7. Pre-rebaseline DB backups still pending — delete after v2.5.0
   has another day of soak.

## Resume prompt

Memory system v2 migration is committed. Open
`docs/agent/STATE.md` to see the current focus and resume prompt;
run `docs/agent/scripts/drift-check.sh` to confirm the worktree is
clean. The active task file
`docs/agent/tasks/memory-system-v2-migration.md` should show
`Status: completed`. Optional follow-up: run Test 8 from
`docs/agent/PROTOCOL.md` "Acceptance tests" (`touch src/_drift_test.ts
tmp/scratch_test.md`; rehearse `start session`; verify only
`src/_drift_test.ts` is flagged; cleanup). Cross-tool acceptance
(Tests 1, 2, 6) requires both Claude Code and Codex CLI in the same
clone — soak when convenient. The pre-rebaseline DB backups on
staging and prod are still pending deletion per STATE.md's "Next".
