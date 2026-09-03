#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
VENV="$SCRIPT_DIR/../.venv/bin/python"
RESTART_MODE=0

if [[ "${1:-}" == "--restart" ]]; then
  RESTART_MODE=1
fi

existing_pid="$(lsof -i tcp:48231 -t -n -P 2>/dev/null | head -n1 || true)"

if [[ -n "$existing_pid" ]]; then
  if [[ "$RESTART_MODE" -eq 1 ]]; then
    echo "[companion] Restart requested. Stopping existing instance on port 48231 (pid: $existing_pid)..."
    kill "$existing_pid" 2>/dev/null || true

    # Wait up to 5 seconds for graceful shutdown, then force kill if needed.
    for i in 1 2 3 4 5; do
      sleep 1
      lsof -i tcp:48231 -t -n -P >/dev/null 2>&1 || break
    done
    if lsof -i tcp:48231 -t -n -P >/dev/null 2>&1; then
      lsof -i tcp:48231 -t -n -P | xargs kill -9 2>/dev/null || true
    fi
  else
    echo "[companion] Companion already running on 127.0.0.1:48231 (pid: $existing_pid)."
    echo "[companion] Use 'bash companion_app/run.sh --restart' to force a restart."
    exit 0
  fi
fi

echo "[companion] Starting Demucs companion server on 127.0.0.1:48231..."
if [ -f "$VENV" ]; then
  exec env PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0 PYTORCH_ENABLE_MPS_FALLBACK=1 AUDIO_MIXER_DEMUCS_MODEL=htdemucs AUDIO_MIXER_DEMUCS_OVERLAP=0.25 AUDIO_MIXER_DEMUCS_FAST_SHORT_CLIPS=0 AUDIO_MIXER_DEMUCS_FAST_SHORT_MAX_SECONDS=75 AUDIO_MIXER_DEMUCS_FAST_MEDIUM_CLIPS=1 AUDIO_MIXER_DEMUCS_FAST_MEDIUM_MAX_SECONDS=180 AUDIO_MIXER_DEMUCS_FAST_MEDIUM_SEGMENT_SECONDS=30 "$VENV" server.py
else
  exec env PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0 PYTORCH_ENABLE_MPS_FALLBACK=1 AUDIO_MIXER_DEMUCS_MODEL=htdemucs AUDIO_MIXER_DEMUCS_OVERLAP=0.25 AUDIO_MIXER_DEMUCS_FAST_SHORT_CLIPS=0 AUDIO_MIXER_DEMUCS_FAST_SHORT_MAX_SECONDS=75 AUDIO_MIXER_DEMUCS_FAST_MEDIUM_CLIPS=1 AUDIO_MIXER_DEMUCS_FAST_MEDIUM_MAX_SECONDS=180 AUDIO_MIXER_DEMUCS_FAST_MEDIUM_SEGMENT_SECONDS=30 python3 server.py
fi
