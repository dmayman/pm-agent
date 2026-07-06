#!/usr/bin/env bash
#
# restart-observer.sh — bounce the local pm-agent stack after code changes.
#
# There are three moving parts, and they refresh differently:
#   1. The CLI (packages/*, bin/) is npm-linked, so `pm-agent observe|context|
#      refresh` picks up edits on the NEXT invocation — nothing to restart.
#   2. The operator UI server (`pm-agent serve`) loads its JS modules once at
#      boot, so code edits need the process bounced. ← this script does that.
#   3. The plugin hooks (hooks.json) need `pm-agent reload` AND a Claude Code
#      restart, which no script can do for you (hooks load at startup).
#
# Usage:  scripts/restart-observer.sh [port] [repo-dir]
#   port      port the operator UI runs on            (default: 4477)
#   repo-dir  repo whose ledger to serve              (default: $PWD)
#
# Example, from inside the repo you're tracking:
#   ~/Documents/GitHub/pm-agent/scripts/restart-observer.sh 4490

set -euo pipefail

PORT="${1:-4477}"
REPO="${2:-$PWD}"
LOG="${TMPDIR:-/tmp}/pm-agent-serve-${PORT}.log"
# The pm-agent working tree this script lives in — `reload` needs it explicitly
# since we're usually run from the *tracked* repo's cwd (e.g. habitus), not here.
PM_AGENT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "▶ Reloading plugin (hook changes)…"
pm-agent reload "${PM_AGENT_ROOT}" || echo "  (reload skipped — not in dev mode; that's fine)"

echo "▶ Restarting operator UI on :${PORT}…"
# Kill ONLY the process LISTENing on this port — a bare `lsof -ti :PORT` also
# returns browser tabs with open connections, which we must never kill.
LISTENER="$(lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "${LISTENER}" ]; then
  kill "${LISTENER}" 2>/dev/null || true
  # give the socket a moment to free so the new server doesn't hit EADDRINUSE
  for _ in 1 2 3 4 5; do
    lsof -ti "tcp:${PORT}" -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 0.3
  done
fi

# Relaunch detached so it survives this script exiting.
( cd "${REPO}" && nohup pm-agent serve --port "${PORT}" >"${LOG}" 2>&1 & )
sleep 1

if lsof -ti "tcp:${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✔ Operator UI → http://localhost:${PORT}  (repo: ${REPO})"
  echo "  logs: ${LOG}"
else
  echo "✗ Server didn't come up — check ${LOG}"
  exit 1
fi

echo "→ Restart Claude Code to load new hooks (the one step this can't do)."
