#!/bin/sh
# observer-hostname-setup.sh — make the operator UI reachable at http://observer
#
# Wires up three pieces so a bare, memorable URL works (macOS):
#   1. /etc/hosts        →  observer resolves to 127.0.0.1
#   2. pf rdr rule       →  loopback :80 is redirected to the server's port (4477)
#   3. LaunchDaemon      →  pf is re-enabled + the ruleset reloaded on every boot
#
# The server itself keeps running as your normal user (unprivileged); only the
# port-80 redirect needs root. Re-runnable and idempotent. Undo with
# observer-hostname-uninstall.sh.
#
# Usage:  sudo sh scripts/observer-hostname-setup.sh
set -eu

PORT="${OBSERVER_PORT:-4477}"
HOST="observer"
ANCHOR="/etc/pf.anchors/observer"
PFCONF="/etc/pf.conf"
PFBAK="/etc/pf.conf.pm-agent.bak"
PLIST="/Library/LaunchDaemons/com.pm-agent.observer.plist"

if [ "$(id -u)" != "0" ]; then
  echo "This needs root (it edits /etc/hosts and /etc/pf.conf)."
  echo "Re-run:  sudo sh scripts/observer-hostname-setup.sh"
  exit 1
fi

# 1. hostname ---------------------------------------------------------------
if grep -qE "^[[:space:]]*127\.0\.0\.1[[:space:]]+.*\b${HOST}\b" /etc/hosts; then
  echo "· /etc/hosts already maps ${HOST}"
else
  printf '\n127.0.0.1\t%s\n' "$HOST" >> /etc/hosts
  echo "✓ /etc/hosts: 127.0.0.1 → ${HOST}"
fi

# 2. pf redirect anchor -----------------------------------------------------
cat > "$ANCHOR" <<EOF
rdr pass on lo0 inet proto tcp from any to any port 80 -> 127.0.0.1 port ${PORT}
EOF
echo "✓ ${ANCHOR}  (:80 → :${PORT})"

# 3. reference the anchor from the main ruleset (backed up, idempotent) ------
if [ ! -f "$PFBAK" ]; then
  cp "$PFCONF" "$PFBAK"
  echo "✓ backed up ${PFCONF} → ${PFBAK}"
fi

if grep -q '"observer"' "$PFCONF"; then
  echo "· ${PFCONF} already references the observer anchor"
else
  # Insert our anchor lines right after the matching com.apple lines so the
  # rdr/anchor ordering pf requires is preserved.
  awk '
    { print }
    /^rdr-anchor "com\.apple\/\*"/ { print "rdr-anchor \"observer\"" }
    /^load anchor "com\.apple"/    { print "load anchor \"observer\" from \"/etc/pf.anchors/observer\"" }
  ' "$PFBAK" > "$PFCONF"
  echo "✓ ${PFCONF}: referenced the observer anchor"
fi

# 4. apply now --------------------------------------------------------------
pfctl -E -f "$PFCONF" 2>/dev/null || true
echo "✓ pf enabled + ruleset loaded"

# 5. persist across reboots (pf is NOT auto-enabled on macOS) ----------------
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pm-agent.observer</string>
  <key>RunAtLoad</key><true/>
  <key>ProgramArguments</key>
  <array>
    <string>/sbin/pfctl</string>
    <string>-E</string>
    <string>-f</string>
    <string>/etc/pf.conf</string>
  </array>
</dict>
</plist>
EOF
launchctl bootout system "$PLIST" 2>/dev/null || true
launchctl bootstrap system "$PLIST" 2>/dev/null || launchctl load -w "$PLIST" 2>/dev/null || true
echo "✓ LaunchDaemon installed (re-arms pf on boot)"

echo
echo "Done — this was a one-time, machine-wide setup. You never run it again."
echo
echo "The name 'observer/' now points at the dashboard's port on this machine. Two more notes:"
echo "  • In your browser, type   observer/   with the trailing slash (it tells the browser"
echo "    it's an address, not a search)."
echo "  • Something has to be serving on port ${PORT} for the page to load. Either run"
echo "    'pm-agent serve' when you want it, OR — better — make it always-on (no sudo):"
echo
echo "        pm-agent observer-autostart"
echo
echo "    Then 'observer/' just works, anytime, without starting anything."
