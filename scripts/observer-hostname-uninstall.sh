#!/bin/sh
# observer-hostname-uninstall.sh — undo observer-hostname-setup.sh
#
# Removes the http://observer wiring: the LaunchDaemon, the pf anchor + its
# reference in /etc/pf.conf (restored from backup), and the /etc/hosts entry.
#
# Usage:  sudo sh scripts/observer-hostname-uninstall.sh
set -eu

HOST="observer"
ANCHOR="/etc/pf.anchors/observer"
PFCONF="/etc/pf.conf"
PFBAK="/etc/pf.conf.pm-agent.bak"
PLIST="/Library/LaunchDaemons/com.pm-agent.observer.plist"

if [ "$(id -u)" != "0" ]; then
  echo "This needs root.  Re-run:  sudo sh scripts/observer-hostname-uninstall.sh"
  exit 1
fi

# 1. LaunchDaemon -----------------------------------------------------------
if [ -f "$PLIST" ]; then
  launchctl bootout system "$PLIST" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✓ removed LaunchDaemon"
fi

# 2. pf.conf + anchor -------------------------------------------------------
if [ -f "$PFBAK" ]; then
  cp "$PFBAK" "$PFCONF"
  rm -f "$PFBAK"
  echo "✓ restored ${PFCONF} from backup"
fi
rm -f "$ANCHOR"
pfctl -f "$PFCONF" 2>/dev/null || true
echo "✓ reloaded pf without the redirect"

# 3. /etc/hosts -------------------------------------------------------------
if grep -qE "\b${HOST}\b" /etc/hosts; then
  # Drop only lines that map 127.0.0.1 to exactly our host.
  grep -vE "^[[:space:]]*127\.0\.0\.1[[:space:]]+${HOST}[[:space:]]*$" /etc/hosts > /etc/hosts.tmp
  cat /etc/hosts.tmp > /etc/hosts
  rm -f /etc/hosts.tmp
  echo "✓ removed ${HOST} from /etc/hosts"
fi

echo
echo "Done. http://observer is no longer wired up (http://localhost:4477 still works)."
