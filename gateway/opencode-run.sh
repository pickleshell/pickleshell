#!/bin/bash
set -euo pipefail

# Wrapper script to run opencode with a PTY
# Usage: opencode-run.sh "message" /path/to/workspace [session_id] [model]
MESSAGE="$1"
WORKSPACE="$2"
SESSION_ID="${3:-}"
MODEL="${4:-}"

ARGS=(opencode run "$MESSAGE" --dir "$WORKSPACE" --format json --auto)
if [ -n "$SESSION_ID" ]; then
  ARGS+=(-s "$SESSION_ID")
fi
if [ -n "$MODEL" ]; then
  ARGS+=(-m "$MODEL")
fi

printf -v COMMAND '%q ' "${ARGS[@]}"
SHELL=/bin/bash exec script -qefc "$COMMAND" /dev/null 2>/dev/null
