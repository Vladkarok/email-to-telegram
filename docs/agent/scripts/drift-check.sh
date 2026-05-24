#!/usr/bin/env bash
# drift-check.sh
# Print branch, HEAD, tracked-code dirtiness (excluding agent memory), and
# untracked files. Read-only; never modifies the repo.
#
# Pathspec form is `.` + `:(exclude)...` per Git pathspec parsing rules —
# this is more robust than the bare `:!...` form across Git versions.
#
# Excludes:
#   - docs/agent/**     (the agent memory tree)
#   - AGENTS.md         (root contract)
#   - CLAUDE.md         (Claude adapter)
#   - .codex/**         (Codex adapter + config)
#
# Output is human-readable. v1 does not return exit codes by category —
# the calling agent interprets the output and writes truth into STATE.md.
# If you later want strict mode: clean=0, code dirty=10, upstream diverged=20.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

EXCLUDES=(
  ':(exclude)docs/agent/**'
  ':(exclude)AGENTS.md'
  ':(exclude)CLAUDE.md'
  ':(exclude).codex/**'
)

# Detect repo with no commits yet — fresh `git init` before bootstrap.
# Without this guard, `git log` aborts under `set -e`.
has_commits=true
git rev-parse --verify HEAD >/dev/null 2>&1 || has_commits=false

echo "Branch:"
git branch --show-current 2>/dev/null || echo "(no branch yet)"

echo
echo "HEAD:"
if [ "$has_commits" = true ]; then
  git log -1 --format='%H %s'
else
  echo "(no commits yet — empty repo, pre-bootstrap state)"
fi

echo
echo "Last code commit (excluding agent memory):"
if [ "$has_commits" = true ]; then
  git log -1 --format='%H %s' -- . "${EXCLUDES[@]}" 2>/dev/null || echo "(no non-memory commits yet)"
else
  echo "(no commits yet)"
fi

echo
echo "Tracked code changes (memory excluded):"
if [ "$has_commits" = true ]; then
  git status --porcelain=v1 --untracked-files=no -- . "${EXCLUDES[@]}" 2>/dev/null || true
else
  echo "(nothing tracked yet)"
fi

echo
echo "Untracked files (all):"
git ls-files --others --exclude-standard 2>/dev/null || true

echo
echo "Recent commits (last 10):"
if [ "$has_commits" = true ]; then
  git log -10 --oneline 2>/dev/null || true
else
  echo "(none)"
fi
