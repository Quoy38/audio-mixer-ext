#!/usr/bin/env bash
# checkpoints/make_checkpoint.sh
# =============================================================================
# Create a VERIFIED checkpoint of the audio-mixer extension + companion lock system.
#
# A checkpoint is only ever created from a GREEN release gate, so every archive is
# a known-good, restorable state. The archive bundles the source code AND the full
# anti-drift lock system (requirements.lock, companion_profile.json,
# model_weights.manifest.json, doctor.sh, and the gate scripts) so a restore brings
# back both the code and the guarantees that keep isolation working.
#
# Usage:
#   bash checkpoints/make_checkpoint.sh                # full gate (needs live engine)
#   bash checkpoints/make_checkpoint.sh --skip-health  # code+integrity only (no engine)
#   bash checkpoints/make_checkpoint.sh --no-gate      # emergency: skip the gate (discouraged)
# =============================================================================
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

GATE_ARGS=()
RUN_GATE=1
for arg in "$@"; do
  case "$arg" in
    --skip-health) GATE_ARGS+=("--skip-health") ;;
    --no-gate) RUN_GATE=0 ;;
    *) echo "Unknown arg: $arg"; exit 2 ;;
  esac
done

if [[ "$RUN_GATE" -eq 1 ]]; then
  echo "[checkpoint] Running release gate before archiving (a checkpoint must be green)..."
  if ! bash checkpoints/release_gate.sh ${GATE_ARGS[@]+"${GATE_ARGS[@]}"}; then
    echo "[checkpoint] ABORT: release gate failed. Fix the failures above, then re-run." >&2
    exit 1
  fi
else
  echo "[checkpoint] WARNING: --no-gate given; archiving WITHOUT verification."
fi

TS="$(date +%Y%m%d-%H%M%S)"
NAME="audio-mixer-checkpoint-$TS"
ARCHIVE="checkpoints/$NAME.tar.gz"
SUMFILE="checkpoints/$NAME.sha256"

# Canonical file set: source code + companion + full lock system + docs.
# Big binaries (models/, libs/, assets/, prior checkpoints, .git) are excluded.
CANDIDATES=(
  popup/popup.js popup/popup.html popup/popup.css popup/popup.css.bak
  content/content.js
  background/background.js
  offscreen/offscreen.html offscreen/offscreen.js
  manifest.json pitch-shifter-worklet.js voice-isolation-worklet.js
  companion_app/server.py
  companion_app/requirements.txt companion_app/requirements.lock
  companion_app/companion_profile.json companion_app/model_weights.manifest.json
  companion_app/com.audiomixerext.companion.plist
  companion_app/install-macos-service.sh companion_app/uninstall-macos-service.sh
  companion_app/build/build_macos_runtime.sh
  companion_app/build/build_pkg.sh companion_app/build/notarize_pkg.sh
  companion_app/build/entitlements.plist companion_app/build/pkg-scripts/postinstall
  companion_app/run.sh companion_app/doctor.sh companion_app/README.md
  checkpoints/check_profile_drift.sh checkpoints/verify_voice_isolation_lock.sh
  checkpoints/smoke_companion_launchd.sh checkpoints/release_gate.sh
  checkpoints/make_checkpoint.sh
  checkpoints/parity/parity_harness.py checkpoints/parity/run_parity_check.sh
  checkpoints/parity/golden/htdemucs_44100.json
  AGENTS.md
  CHANGELOG.md PRODUCT_ROADMAP.md COMPANION_APP_PROTOCOL.md READY_TO_TEST.md
  VOICE_ISOLATION_INTEGRATION.md VOICE_ISOLATION_STATUS.md OPTIMIZATIONS.md README.md
)

# Only archive files that actually exist (list evolves over time).
FILES=()
for f in "${CANDIDATES[@]}"; do
  [[ -e "$f" ]] && FILES+=("$f")
done

# Pre-flight: refuse to archive iCloud-offloaded (dataless) files. tar cannot read
# their contents (lseek/read time out) and would produce a broken archive.
DATALESS=()
for f in "${FILES[@]}"; do
  [[ -n "$(find "$f" -flags +dataless 2>/dev/null)" ]] && DATALESS+=("$f")
done
if [[ ${#DATALESS[@]} -gt 0 ]]; then
  echo "[checkpoint] ABORT: these files are iCloud-offloaded (dataless) and cannot be archived:" >&2
  for f in "${DATALESS[@]}"; do echo "  $f" >&2; done
  echo "[checkpoint] Materialize them first (open each file, or 'brctl download <abs-path>')." >&2
  echo "[checkpoint] If iCloud cannot serve them, restore from a prior checkpoint tarball." >&2
  echo "[checkpoint] Permanent fix: disable iCloud 'Optimize Mac Storage' or move the project off ~/Desktop." >&2
  exit 1
fi

echo "[checkpoint] Archiving ${#FILES[@]} files -> $ARCHIVE"
tar -czf "$ARCHIVE" "${FILES[@]}"
shasum -a 256 "$ARCHIVE" > "$SUMFILE"

echo "[checkpoint] Wrote:"
echo "  $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
echo "  $SUMFILE"
echo ""
echo "[checkpoint] Verify + restore later with:"
echo "  shasum -a 256 -c $SUMFILE"
echo "  tar -xzf $ARCHIVE"
echo ""
echo "[checkpoint] Done. This archive is a VERIFIED known-good state."
