#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
POPUP_JS="$ROOT_DIR/popup/popup.js"
SERVER_PY="$ROOT_DIR/companion_app/server.py"
PLIST_FILE="$ROOT_DIR/companion_app/com.audiomixerext.companion.plist"

fail() {
  echo "[voice-lock] FAIL: $1" >&2
  exit 1
}

pass() {
  echo "[voice-lock] PASS: $1"
}

check_file_contains() {
  local file="$1"
  local pattern="$2"
  local label="$3"
  if ! grep -q "$pattern" "$file"; then
    fail "$label missing in $file"
  fi
  pass "$label present"
}

check_file_not_contains() {
  local file="$1"
  local pattern="$2"
  local label="$3"
  if grep -q "$pattern" "$file"; then
    fail "$label found in $file"
  fi
  pass "$label absent"
}

check_range_not_contains() {
  local file="$1"
  local start_pattern="$2"
  local end_pattern="$3"
  local forbidden_pattern="$4"
  local label="$5"
  if sed -n "/$start_pattern/,/$end_pattern/p" "$file" | grep -Fq "$forbidden_pattern"; then
    fail "$label"
  fi
  pass "$label"
}

echo "[voice-lock] Verifying prepared vocal isolation regression guards..."

[[ -f "$POPUP_JS" ]] || fail "Missing popup.js"
[[ -f "$SERVER_PY" ]] || fail "Missing companion server.py"
[[ -f "$PLIST_FILE" ]] || fail "Missing companion launchd plist"

# Popup-side session ownership guards.
check_file_contains "$POPUP_JS" "PREPARED_INSTRUMENTAL_STATE" "Prepared state machine constants"
check_file_contains "$POPUP_JS" "isPreparedInstrumentalSessionCurrent" "Prepared session identity guard"
check_file_contains "$POPUP_JS" "schedulePreparedInstrumentalAction" "Prepared delayed-action session guard"
check_file_contains "$POPUP_JS" "setPreparedInstrumentalState" "Prepared lifecycle setter"
check_file_contains "$POPUP_JS" "const isolationActiveNow = preparedInstrumentalPreparing || preparedInstrumentalActive || liveCompanionIsolationActive;" "Restore settings keeps active isolation sessions"
check_file_contains "$POPUP_JS" "await restoreMediaElementVolume();" "Prepared error cleanup awaits media-volume restore"
check_range_not_contains "$POPUP_JS" "async function syncPreparedInstrumentalPlayback" "async function capturePreparedInstrumentalPass" "setTimeout(" "Prepared sync loop avoids unguarded setTimeout"

# Companion-side runtime safety/perf profile guards.
check_file_contains "$SERVER_PY" "PYTORCH_MPS_HIGH_WATERMARK_RATIO" "MPS watermark env safeguard"
check_file_contains "$SERVER_PY" "PYTORCH_ENABLE_MPS_FALLBACK" "MPS fallback env safeguard"
check_file_contains "$SERVER_PY" "DEMUCS_FAST_SHORT_CLIPS" "Short-clip acceleration guard"
check_file_contains "$SERVER_PY" "DEMUCS_FAST_MEDIUM_CLIPS" "Medium-clip acceleration guard"
check_file_contains "$SERVER_PY" "split_used" "Per-request split diagnostics"
check_file_contains "$SERVER_PY" "segment_used" "Per-request segment diagnostics"

# Ensure launchd profile matches run.sh fallback behavior.
check_file_contains "$PLIST_FILE" "PYTORCH_ENABLE_MPS_FALLBACK" "Launchd includes MPS fallback env"

# Optional live health check (unless --skip-health).
if [[ "${1:-}" != "--skip-health" ]]; then
  if curl -fsS "http://127.0.0.1:48231/v1/health" >/tmp/voice_lock_health.json 2>/dev/null; then
    HEALTH_JSON="$(cat /tmp/voice_lock_health.json)"
    [[ "$HEALTH_JSON" == *'"split":true'* ]] || fail "Health check missing split=true"
    [[ "$HEALTH_JSON" == *'"fast_short_clips":false'* ]] || fail "Health check missing fast_short_clips=false"
    [[ "$HEALTH_JSON" == *'"fast_short_max_seconds":75'* ]] || fail "Health check missing fast_short_max_seconds=75"
    [[ "$HEALTH_JSON" == *'"fast_medium_clips":true'* ]] || fail "Health check missing fast_medium_clips=true"
    [[ "$HEALTH_JSON" == *'"fast_medium_max_seconds":180'* ]] || fail "Health check missing fast_medium_max_seconds=180"
    [[ "$HEALTH_JSON" == *'"fast_medium_segment_seconds":30'* ]] || fail "Health check missing fast_medium_segment_seconds=30"
    [[ "$HEALTH_JSON" == *'"overlap":0.25'* ]] || fail "Health check missing overlap=0.25"
    # Device may be mps (Apple Silicon) or cpu (Intel / macOS < 12.3 fallback). Both are
    # supported engines — the extension treats cpu as a valid "cpu fallback" profile.
    { [[ "$HEALTH_JSON" == *'"device":"mps"'* ]] || [[ "$HEALTH_JSON" == *'"device":"cpu"'* ]]; } \
      || fail "Health check device is neither mps nor cpu"
    pass "Companion health profile validated"
  else
    fail "Companion health endpoint unavailable on 127.0.0.1:48231"
  fi
else
  pass "Skipped companion health check"
fi

rm -f /tmp/voice_lock_health.json
pass "Voice isolation regression lock checks completed"
