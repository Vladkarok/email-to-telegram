# Task: Migrate agent memory to v2 shape (lean root + on-demand protocol + scripts)

**Status:** completed
**Started:** 2026-05-24
**Completed:** 2026-05-24
**Active:** no
**Slug:** memory-system-v2-migration

## Goal

Adopt the structural improvements from `~/Projects/agent-memory-system/`
(the synthesis-of-models package) while keeping the content and lived-in
refinements we earned during v1. The migration is structural, not a
rewrite: every behavior we currently rely on must continue to work.

**Wins we're after (from the new system):**

- Tiny `AGENTS.md` (~70 lines) + on-demand `docs/agent/PROTOCOL.md`. Cuts
  the ~330-line auto-load every session.
- `docs/agent/scripts/{drift-check,latest-session,validate-memory}.sh` —
  statically allowlistable, eliminates `cd "$(git rev-parse ...)"`-class
  prompt spam permanently.
- `validate-memory.sh` preflight before each `save session` — catches
  missing `Resume prompt`, bad filename, accidentally staged non-memory
  files.
- `Started from session:` field + recheck → anti-stale-save guard for
  Claude↔Codex bounces.
- `Active task:` and `Latest session read:` fields in STATE.md.
- Filename `YYYY-MM-DD-HHMMSS-<tool>-<slug>.md` (sub-minute sort, tool tag).
- Explicit `.codex/notes.md` adapter so Codex doesn't rely on inferring
  "I'm Codex" from AGENTS.md context.

**Keep from v1 (do NOT regress):**

- `docs/agent/DECISIONS.md` as a grep-able one-line index. 21 entries
  are too valuable to fold into JOURNAL.md prose.
- Three-tier worktree rule wording (tracked code drift / memory in
  flight / untracked relevance with `src/**` vs `tmp/**` split) + the
  Test 3c acceptance.
- Concrete `verify-with:` commands in STATE.md (ssh aliases, container
  names, drizzle migration head query).
- The "narrow staging with explicit root-files carve-out" idiom for
  routine protocol tweaks (today's save is the model).
- Existing CI `paths-ignore` (already proven over 24 memory commits).
- Pitfall log of static-matcher specifics: `cd "$(...)"` fails,
  `git -C <path>` doesn't normalize, bootstrap baseline correction.

## Plan

- [x] Step 1: Audit the new package end-to-end. Read
      `INSTALL_FOR_CLAUDE.md`, `BOOTSTRAP_PROMPT.md`, `docs/ARCHITECTURE.md`,
      and the three scripts. Decide whether to use the package's installer or
      hand-port. Identify any package bugs / gaps.
- [x] Step 2: Draft the target file tree (what each file looks like
      post-migration). Especially: which paragraphs of our AGENTS.md become
      PROTOCOL.md content vs root content vs deleted.
- [x] Step 3: Migrate scripts. Add `docs/agent/scripts/*.sh`, make
      executable, allowlist them in `.claude/settings.local.json`. Test each
      script standalone before any protocol change.
- [x] Step 4: Add `.codex/notes.md`. Add minimal Codex adapter content
      (mirror of CLAUDE.md but for Codex specifics). [Also: renamed
      pre-existing 0-byte gitignored `.codex` file to `.codex.bak`,
      narrowed `.gitignore` to `.codex/*` + `!.codex/notes.md`.]
- [x] Step 5: Extract `docs/agent/PROTOCOL.md` from current AGENTS.md.
      Preserve our three-tier rule wording, narrow-staging carve-out, and
      pitfalls. Adopt their `Started from session` guard, scripts-driven
      steps, and STATE.md field additions.
- [x] Step 6: Shrink AGENTS.md to the lean shape (~110 lines): identity,
      verb names, authority order, hard rules, doc index. CLAUDE.md rewritten
      as a real Claude adapter (TodoWrite advisory, ECC collision rules,
      no `@`-imports of mutable docs, tool tag in session filenames).
- [x] Step 7: Rewrite STATE.md with new field set (`Protocol version`,
      `Tool last wrote`, `Last code commit`, `Active task`,
      `Latest session read`). Dropped `Code baseline SHA` field; kept
      `Code worktree` and renamed paths field to `Tracked dirty code paths`
  - new `Relevant untracked code paths` field per upstream.
- [x] Step 8: Decided to KEEP DECISIONS.md alongside JOURNAL.md. They
      complement: DECISIONS = "what + link to why", JOURNAL = "what + when".
      `validate-memory.sh` allows any file under `docs/agent/` so this
      doesn't fight the preflight. This is the email-to-telegram fork
      delta from upstream v2.
- [x] Step 9: Acceptance tests run. **Test 7 passed** —
      `validate-memory.sh` printed `OK` on the staged migration commit.
      Tests 1, 2, 6 (cross-tool/cross-clone) deferred to a future session
      with Codex CLI. Test 8 (untracked relevance) deferred — easy
      standalone rehearsal, not migration-blocking. Test 5 already proven
      on v1 (24 memory commits, zero false deploys).
- [ ] Step 10: Cross-tool soak — do a real `save session` in Claude,
      then `start session` in Codex CLI (same clone). Then reverse. Both
      must follow the new protocol identically. (Defer until next session
      unless user wants it now.)
- [x] Step 11: Updated `CLAUDE.md` ECC reconciliation note —
      rewrote in the adapter format with explicit Claude-specifics.
- [x] Step 12: Final commit + task completion. Commit landed,
      decisions appended, JOURNAL appended, `validate-memory.sh` printed
      `OK`. Status flipped to completed.

## Findings

### Step 1

Done. Read all three package docs + all three scripts. Key findings:

- Installer (`INSTALL_FOR_CLAUDE.md`) is designed for fresh installs.
  It does have a "merge with existing AGENTS.md" path but assumes the
  existing one is project-specific content (not an earlier iteration
  of the same protocol). Our case doesn't fit cleanly; hand-port wins.
- `drift-check.sh` uses `:(exclude)` pathspec form (more portable
  across Git versions than `:!`), handles empty-repo case explicitly.
  Output is human-readable; v1 returns no exit codes by category, but
  documents how to add strict mode (clean=0, code dirty=10, upstream
  diverged=20) later.
- `latest-session.sh` is trivially small; filters `*.md` (ignoring
  `.template` example files).
- `validate-memory.sh` is the richest: structural check on
  STATE.md fields + Resume/Now sections, filename regex
  `YYYY-MM-DD-HHMMSS-(claude|codex)-<slug>.md`, session-file
  Started-from + Resume + Done checks, staged-files-outside-memory
  reject, and a cheap secret-pattern scan on staged diff.
- Package's `validate-memory.sh` allowed-staging regex includes
  `docs/agent/|AGENTS\.md$|CLAUDE\.md$|\.codex/|\.gitignore$|\.github/`
  — does NOT reject DECISIONS.md since it sits under `docs/agent/`,
  so keeping DECISIONS.md doesn't require a patch.

Decision: **hand-port the structure, keep our content
verbatim where it's better (verify-with commands, DECISIONS index,
three-tier rule wording, narrow-staging carve-out for root files).**

### Steps 3–7

Done in one batch (this save). See the v2-format session file for the
detailed change log.

### Step 9

Test 7 will run as the save's preflight (validate-memory.sh before
commit). Test 8 deferred — easy to run standalone, not blocking.

## Decisions

- Hybrid approach: adopt new system's _structure_, keep our _content_
  and selected v1 refinements. Not a clean install of the package; not
  a wholesale keep-as-is either. (Indexed in DECISIONS.md on
  completion.)

## Current edge

Migration files all written; pre-commit preflight pending. Run
`docs/agent/scripts/validate-memory.sh` after the session file is
created. If it prints `OK`, narrow-stage and commit, then mark steps
9 and 12 `[x]`, flip task to `Status: completed`.

## Open questions

- Use their installer or hand-port? Decision after reading
  `INSTALL_FOR_CLAUDE.md`.
- Keep `DECISIONS.md` _and_ add `JOURNAL.md`, or just keep
  `DECISIONS.md`? Defer to Step 8.
- Migration done as a single commit or staged (scripts first, then
  protocol, then STATE.md format)? Lean toward staged — easier to roll
  back any one piece.
