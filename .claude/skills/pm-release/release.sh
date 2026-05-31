#!/usr/bin/env bash
# Cut a release of pm-agent: bump version, tag, push, publish to npm.
# Project-scoped: only available when Claude Code runs inside this repo.
# Delegates to the pm-agent CLI's `release`, which versions + pushes + publishes
# only already-committed work.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"

LEVEL="${1:-}"
if [ -z "$LEVEL" ]; then
  echo "✗ usage: release.sh <patch|minor|major>" >&2
  exit 1
fi

if [ ! -f "$REPO/bin/pm-agent.js" ]; then
  echo "✗ Could not locate pm-agent CLI from $SCRIPT_DIR (expected $REPO/bin/pm-agent.js)." >&2
  exit 1
fi

exec node "$REPO/bin/pm-agent.js" release "$LEVEL" "$REPO"
