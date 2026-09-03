#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
VOICE_LOCK_SCRIPT="$ROOT_DIR/checkpoints/verify_voice_isolation_lock.sh"
COMPANION_SMOKE_SCRIPT="$ROOT_DIR/checkpoints/smoke_companion_launchd.sh"
DRIFT_SCRIPT="$ROOT_DIR/checkpoints/check_profile_drift.sh"
DOCTOR_SCRIPT="$ROOT_DIR/companion_app/doctor.sh"

SKIP_HEALTH=0
if [[ "${1:-}" == "--skip-health" ]]; then
  SKIP_HEALTH=1
fi

step() {
  echo ""
  echo "[release-gate] $1"
}

pass() {
  echo "[release-gate] PASS: $1"
}

fail() {
  echo "[release-gate] FAIL: $1" >&2
  exit 1
}

[[ -f "$VOICE_LOCK_SCRIPT" ]] || fail "Missing $VOICE_LOCK_SCRIPT"
[[ -f "$COMPANION_SMOKE_SCRIPT" ]] || fail "Missing $COMPANION_SMOKE_SCRIPT"
[[ -f "$DOCTOR_SCRIPT" ]] || fail "Missing $DOCTOR_SCRIPT"
[[ -f "$DRIFT_SCRIPT" ]] || fail "Missing $DRIFT_SCRIPT"

step "Running automated release checks"

if [[ "$SKIP_HEALTH" -eq 1 ]]; then
  bash "$VOICE_LOCK_SCRIPT" --skip-health
else
  bash "$VOICE_LOCK_SCRIPT"
fi
pass "Voice isolation lock checks"

# Dependency-lock + model-weight integrity (offline; the #1 'broke with no edits'
# vectors that health checks alone never catch). Runs even under --skip-health.
bash "$DOCTOR_SCRIPT" --static || fail "Dependency/model-weight integrity check failed (see doctor output)"
pass "Dependency lock + model weight integrity"

if [[ "$SKIP_HEALTH" -eq 1 ]]; then
  step "Skipping live companion checks (--skip-health)"
  echo "[release-gate] Companion smoke + profile-drift require a running engine; skipped."
else
  bash "$COMPANION_SMOKE_SCRIPT"
  pass "Companion launchd smoke checks"

  # Cross-source drift: canonical companion_profile.json vs live health, installed
  # plist, and popup.js COMPANION_LOCK_PROFILE all agree.
  bash "$DRIFT_SCRIPT" || fail "Profile drift detected across canonical/live/plist/popup (see output)"
  pass "Profile drift check (all sources agree)"
fi

step "Manual signoff items"
echo "1) READY_TO_TEST Case 5: Capture section skip/restart/next/last behavior"
echo "2) READY_TO_TEST Case 6: Filter preset exclusivity (no stacking)"
echo "3) Confirm preset debug flag is off:"
echo "   localStorage.removeItem(\"audioMixerPresetDebug\")"

step "Release gate complete"
echo "[release-gate] Automated checks are green."
echo "[release-gate] Complete manual signoff items above, then freeze/tag release."
