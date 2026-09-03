#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALLER="$SCRIPT_DIR/companion_app/install-macos-service.sh"
HEALTH_URL="http://127.0.0.1:48231/v1/health"

echo ""
echo "=== Audio Mixer Pro Engine — One-Click Install ==="
echo ""

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This launcher is for macOS only."
  echo ""
  read -r -p "Press Enter to close..."
  exit 1
fi

if [[ ! -f "$INSTALLER" ]]; then
  echo "Could not find installer at: $INSTALLER"
  echo ""
  read -r -p "Press Enter to close..."
  exit 1
fi

# Fresh downloads / AirDrops tag every file with com.apple.quarantine. That makes
# Gatekeeper block these scripts ("unidentified developer") and makes launchd refuse
# to run server.py. Strip it from our own downloaded copy so the rest of the install
# and the background service run cleanly. This only clears the flag on the files shipped
# in this folder — exactly what right-click → Open does, applied once to the whole project.
if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$SCRIPT_DIR" 2>/dev/null || true
fi

echo "Starting companion install..."
echo ""

if bash "$INSTALLER"; then
  echo ""
  echo "Installation finished. Checking health..."
  if curl -sf --max-time 4 "$HEALTH_URL" >/dev/null 2>&1; then
    echo "Companion is healthy at $HEALTH_URL"
  else
    echo "Companion installed, but health is not ready yet."
    echo "Run: bash companion_app/doctor.sh"
  fi
  echo ""
  echo "Done."
else
  echo ""
  echo "Install failed. Run this for diagnostics:"
  echo "bash companion_app/doctor.sh"
fi

echo ""
read -r -p "Press Enter to close..."
