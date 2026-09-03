#!/usr/bin/env bash
# Audio Mixer Pro Engine — macOS LaunchAgent Uninstaller
# Usage: bash uninstall-macos-service.sh

set -euo pipefail

LABEL="com.audiomixerext.companion"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo ""
echo "=== Audio Mixer Pro Engine — Uninstaller ==="
echo ""

if [[ ! -f "$PLIST_DEST" ]]; then
  echo "ℹ️   Service not installed (plist not found at $PLIST_DEST)."
  exit 0
fi

launchctl unload -w "$PLIST_DEST" 2>/dev/null || true
rm -f "$PLIST_DEST"

echo "✅  Service stopped and removed."
echo "    Logs remain at ~/Library/Logs/AudioMixerExt/ (delete manually if desired)."
echo ""
