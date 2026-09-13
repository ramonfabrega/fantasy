#!/bin/bash
# Install the gameday seatbelt as a launchd user agent.
#
#   scripts/seatbelt-agent.sh up       install + start (every 15 min)
#   scripts/seatbelt-agent.sh down     stop + remove
#   scripts/seatbelt-agent.sh status   is it loaded, when did it last run
#   scripts/seatbelt-agent.sh logs     tail what it has been saying
#   scripts/seatbelt-agent.sh test     run the check right now, notify for real
#
# The agent fires every 15 minutes; the script itself decides whether that is a
# moment worth a notification (see scripts/seatbelt-watch.ts). Off-season and
# off-day runs cost nothing — they exit before any network call.
set -euo pipefail

LABEL="com.ramonfabrega.ff-seatbelt"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HOME/Library/Logs"
BUN="$(command -v bun || echo /opt/homebrew/bin/bun)"

case "${1:-status}" in
up)
  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
  cat >"$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUN</string>
    <string>$REPO/scripts/seatbelt-watch.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/$LABEL.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/$LABEL.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST_EOF
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$PLIST"
  echo "up: $LABEL (every 15 min, logs -> $LOG_DIR/$LABEL.log)"
  ;;
down)
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "down: $LABEL removed"
  ;;
status)
  if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
    echo "loaded: $LABEL"
    launchctl print "gui/$UID/$LABEL" | grep -E 'state|last exit code|runs' || true
  else
    echo "not loaded ($PLIST $([ -f "$PLIST" ] && echo exists || echo missing))"
  fi
  echo "--- last 5 log lines ---"
  tail -n 5 "$LOG_DIR/$LABEL.log" 2>/dev/null || echo "(no log yet)"
  ;;
logs)
  tail -n "${2:-40}" "$LOG_DIR/$LABEL.log" 2>/dev/null || echo "(no log yet)"
  ;;
test)
  "$BUN" "$REPO/scripts/seatbelt-watch.ts" --force --watch
  ;;
*)
  echo "usage: $0 {up|down|status|logs|test}" >&2
  exit 64
  ;;
esac
