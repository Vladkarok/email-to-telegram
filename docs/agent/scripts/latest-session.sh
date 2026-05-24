#!/usr/bin/env bash
# latest-session.sh
# Print the path to the newest session file under docs/agent/sessions/.
# Used by `start session` (to know what to read) and by `save session`
# (to compute "Started from session").
#
# Exits 0 with the path on stdout if a session exists; exits 0 with empty
# stdout if there are no sessions yet (first bootstrap case).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# *.md only — *.md.template (examples) are intentionally ignored.
find docs/agent/sessions -maxdepth 1 -type f -name '*.md' | sort | tail -1
