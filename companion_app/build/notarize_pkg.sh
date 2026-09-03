#!/usr/bin/env bash
# notarize_pkg.sh — submit a signed .pkg to Apple notarization, then staple + verify.
#
# Requires a stored notary credential (a keychain profile). Create it once with:
#   xcrun notarytool store-credentials "AudioMixerNotary" \
#     --apple-id "you@example.com" --team-id "TEAMID" --password "app-specific-pw"
#
# Usage:
#   bash companion_app/build/notarize_pkg.sh [path/to.pkg]
#   bash companion_app/build/notarize_pkg.sh --resume SUBMISSION_ID [path/to.pkg]
# If no path is given, the newest pkg in companion_app/build/dist is used.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEYCHAIN_PROFILE="${AUDIO_MIXER_NOTARY_PROFILE:-AudioMixerNotary}"

SUBMISSION_ID=""
if [ "${1:-}" = "--resume" ]; then
  if [ -z "${2:-}" ]; then
    echo "❌  --resume requires a notarization submission ID." >&2
    exit 1
  fi
  SUBMISSION_ID="$2"
  shift 2
fi

PKG="${1:-}"
if [ -z "$PKG" ]; then
  PKG="$(ls -t "$SCRIPT_DIR"/dist/*.pkg 2>/dev/null | head -1 || true)"
fi
if [ -z "$PKG" ] || [ ! -f "$PKG" ]; then
  echo "❌  No .pkg found. Build one first (build_pkg.sh) or pass a path." >&2
  exit 1
fi

if [ -n "$SUBMISSION_ID" ]; then
  echo "🍏  Checking notarization submission: $SUBMISSION_ID"
  INFO="$(xcrun notarytool info "$SUBMISSION_ID" --keychain-profile "$KEYCHAIN_PROFILE")"
  printf '%s\n' "$INFO"
  STATUS="$(printf '%s\n' "$INFO" | sed -n 's/^[[:space:]]*status: //p' | tail -1)"
  case "$STATUS" in
    Accepted)
      ;;
    "In Progress")
      echo "⏳  Apple is still processing this submission. Run the same --resume command later."
      exit 2
      ;;
    Invalid|Rejected)
      echo "❌  Apple rejected this submission. Fetching its diagnostic log..." >&2
      xcrun notarytool log "$SUBMISSION_ID" --keychain-profile "$KEYCHAIN_PROFILE" || true
      exit 1
      ;;
    *)
      echo "❌  Unexpected notarization status: ${STATUS:-unknown}" >&2
      exit 1
      ;;
  esac
else
  echo "🍏  Submitting for notarization: $PKG"
  echo "    (Apple scans the upload; this usually takes a few minutes.)"
  WAIT_LOG="$(mktemp -t audio-mixer-notary.XXXXXX)"
  trap 'rm -f "$WAIT_LOG"' EXIT
  set +e
  xcrun notarytool submit "$PKG" --keychain-profile "$KEYCHAIN_PROFILE" --wait 2>&1 | tee "$WAIT_LOG"
  SUBMIT_STATUS="${PIPESTATUS[0]}"
  set -e
  if [ "$SUBMIT_STATUS" -ne 0 ]; then
    SUBMISSION_ID="$(sed -n 's/^[[:space:]]*id: //p' "$WAIT_LOG" | head -1)"
    if [ -n "$SUBMISSION_ID" ]; then
      echo "⚠️  Waiting stopped, but Apple may still be processing submission $SUBMISSION_ID." >&2
      echo "    Resume without re-uploading:" >&2
      echo "    bash companion_app/build/notarize_pkg.sh --resume $SUBMISSION_ID \"$PKG\"" >&2
    fi
    exit "$SUBMIT_STATUS"
  fi
fi

echo "📎  Stapling the notarization ticket..."
xcrun stapler staple "$PKG"

echo "🔎  Verifying Gatekeeper acceptance..."
spctl --assess -vvv --type install "$PKG" || true
xcrun stapler validate "$PKG"

echo ""
echo "✅  Notarized + stapled: $PKG"
echo "    This is the file to upload to the GitHub Release."
