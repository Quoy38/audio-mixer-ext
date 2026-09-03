#!/usr/bin/env bash
# Output-parity / drift check for the Demucs companion engine.
#
# Purely additive preservation tool (AGENTS.md prime directive). It runs the standalone
# parity harness against the RUNNING companion and never touches project code. Use it as
# an extra safety net around any change that could perturb separation output.
#
# Usage:
#   bash checkpoints/parity/run_parity_check.sh              # compare engine vs golden
#   bash checkpoints/parity/run_parity_check.sh --baseline   # (re)capture golden for current model
#
# Behavior:
#   * If the engine is unreachable, it SKIPS with exit 0 (mirrors the gate's --skip-health
#     philosophy so engine-less CI is not broken). Drift is only asserted when the engine is up.
#   * On drift it exits non-zero so it can gate a release when wired in.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
HOST="127.0.0.1"
PORT="48231"

MODE="check"
if [[ "${1:-}" == "--baseline" ]]; then
  MODE="baseline"
fi

# Prefer the companion venv (has numpy); fall back to system python3.
PY="$REPO_ROOT/.venv/bin/python"
if [[ ! -x "$PY" ]]; then
  PY="$(command -v python3 || true)"
fi
if [[ -z "$PY" ]]; then
  echo "[parity] SKIP: no python interpreter found."
  exit 0
fi

# Engine reachability probe.
if ! curl -s -m 5 "http://$HOST:$PORT/v1/health" >/dev/null 2>&1; then
  echo "[parity] SKIP: engine unreachable at http://$HOST:$PORT (start the companion to run parity)."
  exit 0
fi

echo "[parity] mode=$MODE  python=$PY"
exec "$PY" "$SCRIPT_DIR/parity_harness.py" --mode "$MODE" --host "$HOST" --port "$PORT"
