#!/usr/bin/env bash
# validate-memory.sh
# Preflight structural check before `save session` commits memory.
# Exits 0 on success; exits 1 with FAIL: lines on failure.
#
# Checks:
#   - STATE.md exists
#   - At least one session file exists (after first save)
#   - STATE.md contains required header fields
#   - STATE.md has a Resume prompt section
#   - latest session filename matches YYYY-MM-DD-HHMMSS-<tool>-<slug>.md
#   - latest session has "Started from session" header and Resume prompt
#   - No staged files outside the agent memory tree / adapters
#   - No obvious secrets in staged memory files
#
# v1 is structural; it does not judge meaning. The agent still has to write
# real content. The script catches mechanical breakage: missing fields,
# accidental `git add .`, secrets pasted by accident.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0

# --- STATE.md present
if [ ! -f docs/agent/STATE.md ]; then
  echo "FAIL: missing docs/agent/STATE.md"
  fail=1
fi

# --- At least one session file
latest="$(find docs/agent/sessions -maxdepth 1 -type f -name '*.md' 2>/dev/null | sort | tail -1 || true)"
if [ -z "${latest:-}" ]; then
  echo "FAIL: no session files in docs/agent/sessions/ (expected after first save)"
  fail=1
fi

# --- STATE.md required fields
if [ -f docs/agent/STATE.md ]; then
  for field in "Protocol version" "Updated" "Tool last wrote" "Branch" "Last code commit" "Code worktree" "Active task" "Latest session read"; do
    if ! grep -q "\*\*$field:" docs/agent/STATE.md; then
      echo "FAIL: STATE.md missing **$field:** field"
      fail=1
    fi
  done

  if ! grep -q "^## Resume prompt" docs/agent/STATE.md; then
    echo "FAIL: STATE.md missing '## Resume prompt' section"
    fail=1
  fi

  if ! grep -q "^## Now" docs/agent/STATE.md; then
    echo "FAIL: STATE.md missing '## Now' section"
    fail=1
  fi
fi

# --- Latest session file checks
if [ -n "${latest:-}" ]; then
  base="$(basename "$latest")"
  if ! echo "$base" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}-(claude|codex)-[a-z0-9-]+\.md$'; then
    echo "FAIL: latest session filename '$base' does not match YYYY-MM-DD-HHMMSS-<tool>-<slug>.md (tool ∈ claude|codex; extend this regex if you adopt another)"
    fail=1
  fi

  if ! grep -q "\*\*Started from session:" "$latest"; then
    echo "FAIL: $latest missing **Started from session:** header"
    fail=1
  fi

  if ! grep -q "^## Resume prompt" "$latest"; then
    echo "FAIL: $latest missing '## Resume prompt' section"
    fail=1
  fi

  if ! grep -q "^## Done" "$latest"; then
    echo "FAIL: $latest missing '## Done' section"
    fail=1
  fi
fi

# --- Staged files outside agent memory / adapters
unexpected="$(git diff --cached --name-only 2>/dev/null | grep -Ev '^(docs/agent/|AGENTS\.md$|CLAUDE\.md$|\.codex/|\.gitignore$|\.github/)' || true)"
if [ -n "$unexpected" ]; then
  echo "FAIL: staged files outside agent memory / adapter scope:"
  echo "$unexpected" | sed 's/^/  - /'
  echo "  (save session must stage only memory + identity files; code goes in a separate commit)"
  fail=1
fi

# --- Secret scan on staged memory files (cheap, not exhaustive)
staged_mem="$(git diff --cached --name-only 2>/dev/null | grep -E '^(docs/agent/|AGENTS\.md$|CLAUDE\.md$|\.codex/)' || true)"
if [ -n "$staged_mem" ]; then
  # Use a simple pattern; if false positives become annoying, refine.
  secret_hits="$(git diff --cached -- $staged_mem 2>/dev/null | grep -aEi '^(\+)(.*)(password|secret|api[_-]?key|token|private[_-]?key)\s*[:=]\s*["'\''[:alnum:]]' || true)"
  if [ -n "$secret_hits" ]; then
    echo "FAIL: possible secret in staged memory diff:"
    echo "$secret_hits" | head -5 | sed 's/^/  /'
    echo "  Reference secrets ('token lives in .env'), never inline. Unstage and rewrite."
    fail=1
  fi
fi

if [ "$fail" -eq 0 ]; then
  echo "OK: agent memory structure valid"
  exit 0
else
  exit 1
fi
