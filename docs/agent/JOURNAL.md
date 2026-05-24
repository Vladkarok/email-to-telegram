# Journal

Append-only chronological narrative. One entry per `save session`.
Newest at the bottom. Read by tail or grep, not loaded whole.

This complements `DECISIONS.md` (one-line decision index) — JOURNAL is
"what happened + when"; DECISIONS is "what we decided + link to why".

For sessions before 2026-05-24, the index is `DECISIONS.md` +
`docs/agent/sessions/2026-05-23-*.md` files. JOURNAL.md starts fresh
at the v2 migration.

## 2026-05-24 15:30 claude memory-system-v2-migration

- Migrated agent memory from v1 (heavy AGENTS.md + DECISIONS.md only)
  to v2 hybrid (lean AGENTS.md + on-demand PROTOCOL.md + scripts +
  JOURNAL.md, with DECISIONS.md retained as the email-to-telegram fork)
- Adopted scripts from `~/Projects/agent-memory-system/`:
  drift-check.sh, latest-session.sh, validate-memory.sh
- Replaced gitignored .codex empty file with .codex/notes.md adapter;
  .gitignore narrowed from `.codex` to `.codex/*` + `!.codex/notes.md`
- see: docs/agent/sessions/2026-05-24-153000-claude-memory-system-v2-migration.md
