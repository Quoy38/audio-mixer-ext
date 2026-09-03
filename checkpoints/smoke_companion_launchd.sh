#!/usr/bin/env bash
set -euo pipefail

LABEL="com.audiomixerext.companion"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
HEALTH_URL="http://127.0.0.1:48231/v1/health"

fail() {
  echo "[companion-smoke] FAIL: $1" >&2
  exit 1
}

pass() {
  echo "[companion-smoke] PASS: $1"
}

echo "[companion-smoke] Running launchd companion smoke test..."

if launchctl list | grep -q "$LABEL"; then
  pass "LaunchAgent registered in launchd"
else
  fail "LaunchAgent $LABEL not found in launchctl list"
fi

[[ -f "$PLIST_PATH" ]] || fail "LaunchAgent plist missing at $PLIST_PATH"
if plutil -lint "$PLIST_PATH" >/dev/null 2>&1; then
  pass "LaunchAgent plist is valid"
else
  fail "LaunchAgent plist is invalid"
fi

HEALTH_JSON="$(curl -fsS --max-time 3 "$HEALTH_URL")" || fail "Health endpoint unavailable at $HEALTH_URL"
[[ "$HEALTH_JSON" == *'"ok":true'* ]] || fail "Health response missing ok=true"
[[ "$HEALTH_JSON" == *'"engine":"demucs"'* ]] || fail "Health response missing engine=demucs"
[[ "$HEALTH_JSON" == *'"split":true'* ]] || fail "Health response missing split=true"
[[ "$HEALTH_JSON" == *'"fast_short_clips":false'* ]] || fail "Health response missing fast_short_clips=false"
[[ "$HEALTH_JSON" == *'"fast_short_max_seconds":75'* ]] || fail "Health response missing fast_short_max_seconds=75"
[[ "$HEALTH_JSON" == *'"fast_medium_clips":true'* ]] || fail "Health response missing fast_medium_clips=true"
[[ "$HEALTH_JSON" == *'"fast_medium_max_seconds":180'* ]] || fail "Health response missing fast_medium_max_seconds=180"
[[ "$HEALTH_JSON" == *'"fast_medium_segment_seconds":30'* ]] || fail "Health response missing fast_medium_segment_seconds=30"
# Canonical overlap = 0.25 (source of truth = popup.js COMPANION_LOCK_PROFILE).
# This previously read 0.1 and contradicted verify_voice_isolation_lock.sh (0.25),
# which made release_gate.sh impossible to fully pass. Do NOT change without also
# updating popup.js COMPANION_LOCK_PROFILE and the plist.
[[ "$HEALTH_JSON" == *'"overlap":0.25'* ]] || fail "Health response missing overlap=0.25"
# Device may be mps (Apple Silicon) or cpu (Intel / macOS < 12.3 fallback); both are supported.
{ [[ "$HEALTH_JSON" == *'"device":"mps"'* ]] || [[ "$HEALTH_JSON" == *'"device":"cpu"'* ]]; } \
  || fail "Health response device is neither mps nor cpu"
pass "Health endpoint returns locked profile"

pass "Companion launchd smoke test complete"
