@AGENTS.md

Project memory and session protocol live in `AGENTS.md` (shared with Codex
CLI). Personal global preferences in `~/.claude/CLAUDE.md` still apply.

The Claude ECC `save-session` / `resume-session` skill and its `SessionStart`
hook must wrap the files under `docs/agent/` and never maintain separate
state. See AGENTS.md "Standing rules" #4.
