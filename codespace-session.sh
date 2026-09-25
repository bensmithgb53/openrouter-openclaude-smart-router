#!/usr/bin/env bash
# Usage: ./codespace-session.sh CODESPACE_NAME [MAX_MINUTES]
set -Eeuo pipefail
NAME="${1:?Usage: codespace-session.sh CODESPACE_NAME [MAX_MINUTES]}"
MAX_MINUTES="${2:-120}"
[[ "$MAX_MINUTES" =~ ^[0-9]+$ ]] || { echo 'MAX_MINUTES must be a number' >&2; exit 2; }
command -v gh >/dev/null || { echo 'Install GitHub CLI first: pkg install gh' >&2; exit 1; }

# GitHub's idle timeout is the primary safety net. This timer is an additional
# local guard and only works while the Termux process remains alive.
( sleep "$((MAX_MINUTES * 60))"; gh codespace stop -c "$NAME" >/dev/null 2>&1 || true ) &
TIMER_PID=$!
trap 'kill "$TIMER_PID" 2>/dev/null || true' EXIT INT TERM

echo "Connecting to $NAME; local stop timer is ${MAX_MINUTES} minutes."
gh codespace ssh -c "$NAME"
