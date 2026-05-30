#!/usr/bin/env bash
# Re-sync the locally-developed PM plugin after editing its files.
# Project-scoped: only available when Claude Code runs inside this repo.
# Delegates to the pm-agent CLI's dev-only `reload` (validate + clean reinstall).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if [ ! -f "$REPO/bin/pm-agent.js" ]; then
  echo "✗ Could not locate pm-agent CLI from $SCRIPT_DIR (expected $REPO/bin/pm-agent.js)." >&2
  exit 1
fi

exec node "$REPO/bin/pm-agent.js" reload "$REPO"
