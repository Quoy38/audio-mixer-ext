#!/usr/bin/env bash
# Audio Mixer Pro Engine — macOS LaunchAgent Installer
# Installs the companion server as a persistent background service that:
#   - Starts automatically on login
#   - Restarts automatically if it crashes
#   - Runs silently in the background on port 48231
#
# Usage: bash install-macos-service.sh
# Uninstall: bash uninstall-macos-service.sh

set -euo pipefail

LABEL="com.audiomixerext.companion"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_SRC="$SCRIPT_DIR/$LABEL.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
VENV_DIR="$SCRIPT_DIR/../.venv"
LOG_DIR="$HOME/Library/Logs/AudioMixerExt"
# Device is auto-detected AFTER the venv + torch are installed (see step 4c). An explicit
# AUDIO_MIXER_DEMUCS_DEVICE always wins; otherwise we probe torch for MPS and fall back to
# cpu on Intel / older macOS. This provisional value is only used if detection can't run.
DEMUCS_DEVICE_OVERRIDE="${AUDIO_MIXER_DEMUCS_DEVICE:-}"
DEMUCS_DEVICE="${DEMUCS_DEVICE_OVERRIDE:-mps}"
HOST_ARCH="$(uname -m)"
PROFILE_PATH="$SCRIPT_DIR/companion_profile.json"

echo ""
echo "=== Audio Mixer Pro Engine — macOS Service Installer ==="
echo ""

# ── 1. Check macOS ──────────────────────────────────────────────────────────
if [[ "$(uname)" != "Darwin" ]]; then
  echo "❌  This installer is for macOS only."
  echo "    On Linux use systemd; on Windows use Task Scheduler."
  exit 1
fi

# ── 1b. Prefer a pre-bundled self-contained runtime, if one shipped ──────────
# build/build_macos_runtime.sh drops a full CPython + deps at runtime/<arch>/python.
# When present the user needs NO system Python, venv, pip, or dep download.
# RUNTIME_ARCH is the TRUE hardware arch (sysctl), not uname -m which lies under Rosetta.
if [[ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" == "1" ]]; then
  RUNTIME_ARCH="arm64"
else
  RUNTIME_ARCH="x86_64"
fi
BUNDLED_RUNTIME_PY="$SCRIPT_DIR/runtime/$RUNTIME_ARCH/python/bin/python3"
USE_BUNDLED_RUNTIME=""
if [[ -x "$BUNDLED_RUNTIME_PY" ]]; then
  USE_BUNDLED_RUNTIME=1
  VENV_PYTHON="$BUNDLED_RUNTIME_PY"
  echo "✅  Using bundled runtime ($RUNTIME_ARCH): $VENV_PYTHON"
fi

# ── 2. Find Python 3.9+ (skipped when a bundled runtime is present) ──────────
if [[ -z "$USE_BUNDLED_RUNTIME" ]]; then
PYTHON=""
for candidate in python3.12 python3.11 python3.10 python3.9 python3; do
  if command -v "$candidate" &>/dev/null; then
    ver=$("$candidate" -c "import sys; print(sys.version_info[:2])")
    if "$candidate" -c "import sys; sys.exit(0 if (3,9) <= sys.version_info[:2] <= (3,12) else 1)"; then
      PYTHON="$(command -v "$candidate")"
      echo "✅  Found Python: $PYTHON ($ver)"
      break
    fi
  fi
done

if [[ -z "$PYTHON" ]]; then
  echo "❌  Python 3.9-3.12 is required for pinned companion dependencies."
  echo "    Your current default Python may be unsupported (for example 3.13)."
  echo "    Install Python 3.11 from https://www.python.org/downloads/"
  if command -v open >/dev/null 2>&1; then
    open "https://www.python.org/downloads/" >/dev/null 2>&1 || true
  fi
  exit 1
fi

# ── 3. Create / reuse virtualenv ─────────────────────────────────────────────
if [[ ! -f "$VENV_DIR/bin/python" && ! -f "$VENV_DIR/bin/python3" ]]; then
  echo "⏳  Creating Python virtual environment at $VENV_DIR ..."
  if ! "$PYTHON" -m venv "$VENV_DIR"; then
    echo "⚠️  Standard venv creation failed; retrying with --copies for macOS compatibility..."
    rm -rf "$VENV_DIR"
    "$PYTHON" -m venv --copies "$VENV_DIR"
  fi
fi

VENV_PYTHON=""
for candidate in "$VENV_DIR/bin/python" "$VENV_DIR/bin/python3" "$VENV_DIR/bin/python3.13" "$VENV_DIR/bin/python3.12" "$VENV_DIR/bin/python3.11" "$VENV_DIR/bin/python3.10" "$VENV_DIR/bin/python3.9"; do
  if [[ -x "$candidate" ]]; then
    VENV_PYTHON="$candidate"
    break
  fi
done

if [[ -z "$VENV_PYTHON" ]]; then
  echo "❌  Could not find a Python executable in $VENV_DIR/bin"
  exit 1
fi

echo "⏳  Ensuring pip is available in the virtual environment..."
"$VENV_PYTHON" -m ensurepip --upgrade >/dev/null 2>&1 || true

if ! "$VENV_PYTHON" -m pip --version >/dev/null 2>&1; then
  echo "❌  pip is not available in the companion virtual environment."
  echo "    Install a full Python 3.9+ from https://www.python.org/downloads/ and re-run this installer."
  exit 1
fi

# ── 4. Install / upgrade dependencies ────────────────────────────────────────
# Prefer the fully-pinned lock (reproducible; prevents the torch/torchaudio/numpy
# drift that silently broke isolation 20+ times on byte-identical code). Fall back
# to the loose requirements.txt only if the lock is missing. We deliberately do NOT
# --upgrade already-installed packages when using the lock: an unsolicited upgrade
# is precisely how the environment drifted underneath us before.
echo "⏳  Installing dependencies (this may take a few minutes on first run)..."
INSTALL_LOG="$(mktemp -t audio-mixer-install.XXXXXX.log)"
NO_ONNX_REQ=""

install_requirements_file() {
  local requirements_file="$1"
  "$VENV_PYTHON" -m pip install --quiet -r "$requirements_file" 2>"$INSTALL_LOG"
}

if [[ -f "$SCRIPT_DIR/requirements.lock" ]]; then
  echo "    Using pinned requirements.lock (reproducible build)."
  if ! install_requirements_file "$SCRIPT_DIR/requirements.lock"; then
    if grep -Eiq "Failed building wheel for onnx|Could not build wheels for onnx|metadata-generation-failed" "$INSTALL_LOG"; then
      echo "    ⚠️  ONNX build failed on this Mac; retrying without onnx (not required by companion server)."
      NO_ONNX_REQ="$(mktemp -t audio-mixer-requirements-no-onnx.XXXXXX.txt)"
      grep -Ev '^onnx==' "$SCRIPT_DIR/requirements.lock" > "$NO_ONNX_REQ"
      install_requirements_file "$NO_ONNX_REQ"
    else
      echo "❌  Dependency installation failed."
      tail -n 40 "$INSTALL_LOG"
      rm -f "$INSTALL_LOG"
      exit 1
    fi
  fi
else
  echo "    ⚠️  requirements.lock not found — falling back to loose requirements.txt."
  "$VENV_PYTHON" -m pip install --quiet --upgrade pip
  if ! install_requirements_file "$SCRIPT_DIR/requirements.txt"; then
    echo "❌  Dependency installation failed."
    tail -n 40 "$INSTALL_LOG"
    rm -f "$INSTALL_LOG"
    exit 1
  fi
fi
rm -f "$INSTALL_LOG"
if [[ -n "$NO_ONNX_REQ" ]]; then
  rm -f "$NO_ONNX_REQ"
fi
echo "✅  Dependencies installed."
fi  # end system-Python + venv + pip path (skipped when USE_BUNDLED_RUNTIME)

# Ensure a CA bundle is available for model-weight HTTPS downloads inside launchd.
echo "⏳  Ensuring CA certificates are available..."
if [[ -z "$USE_BUNDLED_RUNTIME" ]]; then
  "$VENV_PYTHON" -m pip install --quiet certifi
fi
CERTIFI_CA_BUNDLE="$($VENV_PYTHON -c 'import certifi; print(certifi.where())' 2>/dev/null || true)"
if [[ -z "$CERTIFI_CA_BUNDLE" || ! -f "$CERTIFI_CA_BUNDLE" ]]; then
  CERTIFI_CA_BUNDLE="/etc/ssl/cert.pem"
fi
if [[ -f "$CERTIFI_CA_BUNDLE" ]]; then
  echo "✅  CA bundle: $CERTIFI_CA_BUNDLE"
else
  echo "⚠️  Could not locate a CA bundle path; HTTPS model downloads may fail."
fi

# Bundled standalone Python has no default CA path; export the resolved bundle so the
# in-installer model pre-download (step 4b) can verify TLS. Harmless for the system-venv path.
export SSL_CERT_FILE="$CERTIFI_CA_BUNDLE" REQUESTS_CA_BUNDLE="$CERTIFI_CA_BUNDLE" CURL_CA_BUNDLE="$CERTIFI_CA_BUNDLE"

# ── 4c. Auto-detect the inference device (mps on Apple Silicon, else cpu) ─────
# Old Intel Macs and macOS < 12.3 have no MPS. Forcing device=mps there made the model
# fail to place and silently limp on cpu while /v1/health still advertised mps. We now
# probe torch directly (torch.backends.mps.is_available() already encodes the Apple-Silicon
# + macOS-12.3 requirement) and write the TRUE device into the plist. The extension accepts
# either: mps = locked profile, cpu = recognized cpu-fallback (see popup.js checkCompanionEngine).
echo "⏳  Detecting inference device (arch: $HOST_ARCH)..."
if [[ -n "$DEMUCS_DEVICE_OVERRIDE" ]]; then
  DEMUCS_DEVICE="$DEMUCS_DEVICE_OVERRIDE"
  echo "✅  Using device override AUDIO_MIXER_DEMUCS_DEVICE=$DEMUCS_DEVICE"
else
  DETECTED_DEVICE="$(
"$VENV_PYTHON" - <<'PYEOF' 2>/dev/null
try:
    import torch
    mps = getattr(torch.backends, "mps", None)
    print("mps" if (mps and torch.backends.mps.is_available()) else "cpu")
except Exception:
    print("cpu")
PYEOF
)" || true
  case "$DETECTED_DEVICE" in
    mps|cpu) DEMUCS_DEVICE="$DETECTED_DEVICE" ;;
    *)       DEMUCS_DEVICE="cpu" ;;
  esac
  echo "✅  Auto-detected inference device: $DEMUCS_DEVICE"
fi

# ── 4b. Pre-download model weights (avoids first-use stall after install) ─────
DEFAULT_MODEL="htdemucs"
if [[ -f "$PROFILE_PATH" ]]; then
  PROFILE_MODEL="$($VENV_PYTHON -c 'import json,sys; print(json.load(open(sys.argv[1])).get("model",""))' "$PROFILE_PATH" 2>/dev/null || true)"
  if [[ -n "$PROFILE_MODEL" ]]; then
    DEFAULT_MODEL="$PROFILE_MODEL"
  fi
fi

echo "⏳  Pre-downloading Demucs model weights ($DEFAULT_MODEL)..."
if ! DEMUCS_MODEL_NAME="$DEFAULT_MODEL" "$VENV_PYTHON" - <<'PYEOF' >/dev/null 2>&1
import os
from demucs.pretrained import get_model

model_name = os.environ.get("DEMUCS_MODEL_NAME", "htdemucs")
get_model(model_name)
print("ok")
PYEOF
then
  echo "⚠️  Could not pre-download model weights during install."
  echo "    The first isolation run will download them automatically."
else
  echo "✅  Model weights are ready."
fi

# ── 5. Create log directory ──────────────────────────────────────────────────
mkdir -p "$LOG_DIR"

# ── 6. Build the LaunchAgent plist with real paths ───────────────────────────
mkdir -p "$HOME/Library/LaunchAgents"

sed \
  -e "s|COMPANION_PYTHON_PATH|$VENV_PYTHON|g" \
  -e "s|COMPANION_SERVER_PATH|$SCRIPT_DIR/server.py|g" \
  -e "s|COMPANION_APP_DIR|$SCRIPT_DIR|g" \
  -e "s|COMPANION_DEMUCS_DEVICE|$DEMUCS_DEVICE|g" \
  -e "s|COMPANION_SSL_CERT_FILE|$CERTIFI_CA_BUNDLE|g" \
  -e "s|COMPANION_LOG_OUT|$LOG_DIR/companion.log|g" \
  -e "s|COMPANION_LOG_ERR|$LOG_DIR/companion-error.log|g" \
  "$PLIST_SRC" > "$PLIST_DEST"

echo "✅  LaunchAgent plist installed at $PLIST_DEST"

# ── 7. Unload any old version, then load the new one ─────────────────────────
launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load -w "$PLIST_DEST"

echo "✅  Service loaded and running."
echo ""

# ── 8. Verify it's up ────────────────────────────────────────────────────────
echo "⏳  Waiting for server to start..."
for i in $(seq 1 15); do
  sleep 1
  if curl -sf --max-time 2 http://127.0.0.1:48231/v1/health >/dev/null 2>&1; then
    echo "✅  Server is healthy on http://127.0.0.1:48231"
    echo ""
    echo "=== Installation complete! ==="
    echo "   The Pro Engine will now start automatically every time you log in."
    echo "   Logs: $LOG_DIR/companion.log"
    echo "   To uninstall: bash $SCRIPT_DIR/uninstall-macos-service.sh"
    echo ""
    exit 0
  fi
  echo "   ... waiting ($i/15)"
done

echo ""
echo "⚠️   Server did not respond within 15 seconds."
echo "    Check logs for errors: $LOG_DIR/companion-error.log"
echo "    The service is installed and will retry automatically."
exit 1
