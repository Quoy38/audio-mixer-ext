#!/usr/bin/env bash
# companion_app/doctor.sh
# =============================================================================
# ONE-COMMAND health diagnosis + safe auto-repair for the Audio Mixer Pro engine.
#
# This exists to END the multi-hour "why did isolation break with no code edits?"
# reconstructions. It checks every known drift/failure vector and, for each one,
# tells you the exact cause and the exact fix. With --fix it auto-repairs the SAFE
# actions (restart the service, evict a stray port holder) and only PRINTS the
# command for risky ones (reinstalling deps, re-downloading model weights).
#
# Usage:
#   bash companion_app/doctor.sh          # diagnose only
#   bash companion_app/doctor.sh --fix    # diagnose + auto-repair safe actions
#   bash companion_app/doctor.sh --deep   # also sha256-verify model weights
#   bash companion_app/doctor.sh --static # offline checks only (venv+deps+weights);
#                                         # no server/port/health needed. Used by the
#                                         # release gate so CI can verify integrity
#                                         # without a running companion.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="com.audiomixerext.companion"
PORT=48231
HEALTH_URL="http://127.0.0.1:$PORT/v1/health"
INSTALLED_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO_PLIST="$SCRIPT_DIR/$LABEL.plist"
LOCK="$SCRIPT_DIR/requirements.lock"
MANIFEST="$SCRIPT_DIR/model_weights.manifest.json"
CANON="$SCRIPT_DIR/companion_profile.json"
DRIFT_SCRIPT="$REPO_DIR/checkpoints/check_profile_drift.sh"
PY="$REPO_DIR/.venv/bin/python"
[[ -x "$PY" ]] || PY="$(command -v python3 || true)"

FIX=0; DEEP=0; STATIC=0
for arg in "$@"; do
  case "$arg" in
    --fix) FIX=1 ;;
    --deep) DEEP=1 ;;
    --static) STATIC=1 ;;
    *) echo "Unknown arg: $arg (use --fix, --deep, and/or --static)"; exit 2 ;;
  esac
done

FAILS=0; WARNS=0
declare -a FIX_HINTS=()
c_reset=$'\033[0m'; c_grn=$'\033[32m'; c_red=$'\033[31m'; c_yel=$'\033[33m'; c_cyn=$'\033[36m'
ok()   { echo "  ${c_grn}✓${c_reset} $1"; }
warn() { echo "  ${c_yel}!${c_reset} $1"; WARNS=$((WARNS+1)); }
bad()  { echo "  ${c_red}✗${c_reset} $1"; FAILS=$((FAILS+1)); }
hint() { FIX_HINTS+=("$1"); }
section() { echo ""; echo "${c_cyn}== $1 ==${c_reset}"; }

echo "${c_cyn}Audio Mixer Pro Engine — Doctor${c_reset}   (fix=$FIX deep=$DEEP static=$STATIC)"
echo "repo: $REPO_DIR"

# ── launchd PID + port owner PID (shared by several checks) ──────────────────
LAUNCHD_PID="$(launchctl list 2>/dev/null | awk -v l="$LABEL" '$3==l{print $1}')"
PORT_PIDS="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')"

# ── 1. Virtualenv ────────────────────────────────────────────────────────────
section "1. Python virtualenv"
if [[ -x "$REPO_DIR/.venv/bin/python" ]]; then
  ok "venv present ($($REPO_DIR/.venv/bin/python -V 2>&1))"
else
  bad "venv missing at $REPO_DIR/.venv — companion cannot run"
  hint "Reinstall: bash companion_app/install-macos-service.sh"
fi

# ── 2. LaunchAgent service ───────────────────────────────────────────────────
if [[ "$STATIC" == "0" ]]; then
section "2. LaunchAgent service"
if [[ -f "$INSTALLED_PLIST" ]]; then
  ok "installed plist present"
  if plutil -lint "$INSTALLED_PLIST" >/dev/null 2>&1; then ok "installed plist is valid XML"; else bad "installed plist is invalid XML"; fi
else
  bad "installed plist missing at $INSTALLED_PLIST (service not installed)"
  hint "Install: bash companion_app/install-macos-service.sh"
fi
if [[ -n "$LAUNCHD_PID" && "$LAUNCHD_PID" != "-" ]]; then
  ok "service registered and running (pid $LAUNCHD_PID)"
elif launchctl list 2>/dev/null | grep -q "$LABEL"; then
  warn "service registered but not currently running (launchd will relaunch on demand)"
  hint "Restart: launchctl kickstart -k gui/\$(id -u)/$LABEL"
else
  bad "service NOT registered in launchd"
  hint "Load: launchctl load -w \"$INSTALLED_PLIST\"   (or run the installer)"
fi

# ── 3. Port 48231 owner (stray-process detection) ────────────────────────────
section "3. Port $PORT owner"
if [[ -z "$PORT_PIDS" ]]; then
  bad "nothing is listening on $PORT (engine offline)"
  hint "Start: launchctl kickstart -k gui/\$(id -u)/$LABEL"
else
  STRAY=0
  for p in $PORT_PIDS; do
    if [[ -n "$LAUNCHD_PID" && "$p" == "$LAUNCHD_PID" ]]; then
      ok "port owned by the launchd-managed server (pid $p)"
    else
      cmd="$(ps -p "$p" -o command= 2>/dev/null | cut -c1-90)"
      bad "port held by a NON-launchd process (pid $p): $cmd"
      warn "this is the classic 'stray bare python server.py' bug — wrong env/model, no logs"
      STRAY=1
    fi
  done
  if [[ "$STRAY" == "1" ]]; then
    hint "Evict stray + restart clean: kill $PORT_PIDS ; launchctl kickstart -k gui/\$(id -u)/$LABEL"
  fi
fi

# ── 4. Health endpoint ───────────────────────────────────────────────────────
section "4. Health endpoint"
HEALTH_JSON="$(curl -fsS --max-time 4 "$HEALTH_URL" 2>/dev/null || true)"
if [[ -n "$HEALTH_JSON" ]]; then
  ok "GET /v1/health responded"
  case "$HEALTH_JSON" in
    *'"ok":true'*) ok "engine reports ok=true" ;;
    *) bad "health did not report ok=true" ;;
  esac
  case "$HEALTH_JSON" in
    *'"device":"mps"'*) ok "device = mps (GPU accelerated)" ;;
    *'"device":"cpu"'*) warn "device = cpu — MPS fell back to CPU (much slower). Check PYTORCH_ENABLE_MPS_FALLBACK / torch version." ;;
    *) warn "device field not found in health" ;;
  esac
else
  bad "GET /v1/health unreachable — extension will treat Pro engine as offline"
  hint "Restart: launchctl kickstart -k gui/\$(id -u)/$LABEL   then re-run doctor"
fi

# ── 5. Profile drift (canonical vs live/plist/popup) ─────────────────────────
section "5. Profile drift"
if [[ -x "$PY" && -f "$DRIFT_SCRIPT" ]]; then
  if bash "$DRIFT_SCRIPT" >/tmp/doctor_drift.out 2>&1; then
    ok "no profile drift (live + installed plist + popup.js all match canonical)"
  else
    bad "profile drift detected:"
    sed 's/^/    /' /tmp/doctor_drift.out
    hint "Re-sync the drifted source to companion_app/companion_profile.json, then: launchctl kickstart -k gui/\$(id -u)/$LABEL"
  fi
else
  warn "cannot run profile drift check (missing python or $DRIFT_SCRIPT)"
fi
fi  # end live-only checks (STATIC skips sections 2-5)

# ── 6. Dependency lock ───────────────────────────────────────────────────────
section "6. Python dependencies vs requirements.lock"
if [[ -x "$REPO_DIR/.venv/bin/python" && -f "$LOCK" ]]; then
  DEP_OUT="$("$REPO_DIR/.venv/bin/python" - "$LOCK" <<'PYEOF'
import re, subprocess, sys
lock_path = sys.argv[1]
def norm(n): return n.lower().replace("_", "-")
lock = {}
for line in open(lock_path):
    line = line.strip()
    if not line or line.startswith("#"): continue
    if "==" in line:
        n, v = line.split("==", 1)
        lock[norm(n.strip())] = v.strip()
freeze = {}
# --all so pip/setuptools/wheel are included, matching how requirements.lock was frozen.
out = subprocess.run([sys.executable, "-m", "pip", "freeze", "--all"], capture_output=True, text=True).stdout
for line in out.splitlines():
    if "==" in line:
        n, v = line.split("==", 1)
        freeze[norm(n.strip())] = v.strip()
problems = []
for n, v in sorted(lock.items()):
    fv = freeze.get(n)
    if fv is None:
        problems.append(f"MISSING {n} (lock={v})")
    elif fv != v:
        problems.append(f"{n}: installed {fv} != lock {v}")
if problems:
    print("DRIFT")
    for p in problems: print(p)
else:
    print("OK")
PYEOF
)"
  if [[ "$(echo "$DEP_OUT" | head -1)" == "OK" ]]; then
    ok "all locked dependency versions match (torch/torchaudio/numpy pinned)"
  else
    bad "dependency drift vs lock — THE #1 'broke with no edits' cause:"
    echo "$DEP_OUT" | tail -n +2 | sed 's/^/    /'
    hint "Restore exact versions: .venv/bin/python -m pip install -r companion_app/requirements.lock"
  fi
else
  warn "cannot check deps (missing venv or $LOCK)"
fi

# ── 7. Model weights ─────────────────────────────────────────────────────────
ACTIVE_MODEL="htdemucs"
if [[ -x "$PY" && -f "$SCRIPT_DIR/companion_profile.json" ]]; then
  ACTIVE_MODEL="$("$PY" -c 'import json,sys;print(json.load(open(sys.argv[1])).get("model","htdemucs"))' "$SCRIPT_DIR/companion_profile.json" 2>/dev/null || echo htdemucs)"
fi
section "7. Model weights ($ACTIVE_MODEL)"
if [[ -x "$PY" && -f "$MANIFEST" ]]; then
  WEIGHT_OUT="$(DEEP="$DEEP" MODEL="$ACTIVE_MODEL" "$PY" - "$MANIFEST" <<'PYEOF'
import hashlib, json, os, sys
manifest = json.load(open(sys.argv[1]))
deep = os.environ.get("DEEP") == "1"
model = os.environ.get("MODEL", "htdemucs")
cache = os.path.expanduser(manifest["cache_dir"])
spec = manifest.get("models", {}).get(model)
problems = []
if spec is None:
    print("DRIFT")
    print(f"no manifest entry for active model {model!r} — add it to model_weights.manifest.json")
    sys.exit(0)
files = spec["files"]
for f in files:
    path = os.path.join(cache, f["name"])
    if not os.path.exists(path):
        problems.append(f"MISSING {f['name']} (re-download needed)"); continue
    sz = os.path.getsize(path)
    if sz != f["size"]:
        problems.append(f"{f['name']}: size {sz} != {f['size']} (corrupt/partial)"); continue
    if deep:
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""): h.update(chunk)
        if h.hexdigest() != f["sha256"]:
            problems.append(f"{f['name']}: sha256 mismatch (corrupt)")
print(f"OK {len(files)}" if not problems else "DRIFT")
for p in problems: print(p)
PYEOF
)"
  HEAD1="$(echo "$WEIGHT_OUT" | head -1)"
  if [[ "$HEAD1" == OK* ]]; then
    NFILES="$(echo "$HEAD1" | awk '{print $2}')"
    if [[ "$DEEP" == "1" ]]; then ok "all $NFILES weight file(s) present + sha256 verified"; else ok "all $NFILES weight file(s) present + correct size (use --deep for sha256)"; fi
  else
    bad "model weight problem — /v1/stems/split will fail:"
    echo "$WEIGHT_OUT" | tail -n +2 | sed 's/^/    /'
    hint "Re-download by restarting the engine and running one isolation, or clear ~/.cache/torch/hub/checkpoints and let demucs refetch."
  fi
else
  warn "cannot check weights (missing python or $MANIFEST)"
fi

# ── 8. iCloud offloading (dataless critical files) ──────────────────────────
# "Desktop & Documents in iCloud" + Optimize Mac Storage can evict a file's
# contents to the cloud (flag: dataless). When the extension/companion then tries
# to read it, fault-in can time out (ETIMEDOUT) -> spontaneous breakage with ZERO
# code edits, that "heals itself" later when iCloud re-downloads. This is drift
# vector #4. We check the runtime-critical files here.
section "8. iCloud offloading (dataless files)"
CRIT_FILES=(
  "$REPO_DIR/popup/popup.js" "$REPO_DIR/popup/popup.html"
  "$REPO_DIR/content/content.js" "$REPO_DIR/background/background.js"
  "$REPO_DIR/offscreen/offscreen.js" "$REPO_DIR/offscreen/offscreen.html"
  "$REPO_DIR/voice-isolation-worklet.js" "$REPO_DIR/pitch-shifter-worklet.js"
  "$REPO_DIR/manifest.json" "$REPO_DIR/companion_app/server.py"
)
# .venv python (companion cannot start if its interpreter is evicted).
for p in "$REPO_DIR"/.venv/bin/python3.* "$REPO_DIR"/.venv/bin/python; do
  [[ -e "$p" ]] && CRIT_FILES+=("$p")
done
DATALESS_HITS=""
for f in "${CRIT_FILES[@]}"; do
  [[ -e "$f" ]] || continue
  if [[ -n "$(find "$f" -flags +dataless 2>/dev/null)" ]]; then
    DATALESS_HITS+="  ${f#$REPO_DIR/}\n"
  fi
done
if [[ -z "$DATALESS_HITS" ]]; then
  ok "no runtime-critical files are iCloud-offloaded"
else
  bad "iCloud has OFFLOADED runtime-critical files (dataless) — reads can time out and break isolation:"
  printf "$DATALESS_HITS" | sed 's/^/    /'
  hint "Materialize now: find them and run 'brctl download <abs-path>' or open each file; if that fails, restore from a checkpoint tarball."
  hint "PERMANENT FIX: keep this project OUT of iCloud — System Settings > Apple ID > iCloud > 'Optimize Mac Storage' OFF, or move the project off ~/Desktop, or Finder > right-click folder > 'Keep Downloaded'."
fi

# ── SAFE AUTO-REPAIR (--fix) ─────────────────────────────────────────────────
if [[ "$FIX" == "1" && "$STATIC" == "0" && "$FAILS" -gt 0 ]]; then
  section "Auto-repair (safe actions only)"
  # Evict a stray non-launchd port holder.
  if [[ -n "$PORT_PIDS" ]]; then
    for p in $PORT_PIDS; do
      if [[ -z "$LAUNCHD_PID" || "$p" != "$LAUNCHD_PID" ]]; then
        echo "  killing stray port holder pid $p ..."; kill "$p" 2>/dev/null || true
      fi
    done
  fi
  # (Re)load + restart the service.
  if [[ -f "$INSTALLED_PLIST" ]]; then
    launchctl load -w "$INSTALLED_PLIST" 2>/dev/null || true
    echo "  kickstarting $LABEL ..."
    launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true
  else
    echo "  installed plist missing — run: bash companion_app/install-macos-service.sh"
  fi
  echo "  waiting for health ..."
  for i in $(seq 1 12); do
    sleep 1
    if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then echo "  ${c_grn}engine healthy after repair${c_reset}"; break; fi
  done
  echo "  Risky repairs are NOT auto-run. If drift/deps/weights failed above, run the printed command."
fi

# ── SUMMARY ──────────────────────────────────────────────────────────────────
section "Summary"
if [[ "$FAILS" -eq 0 && "$WARNS" -eq 0 ]]; then
  echo "  ${c_grn}ALL GREEN — Pro engine is locked in and healthy.${c_reset}"
elif [[ "$FAILS" -eq 0 ]]; then
  echo "  ${c_yel}$WARNS warning(s), 0 failures — usable, review warnings above.${c_reset}"
else
  echo "  ${c_red}$FAILS failure(s), $WARNS warning(s).${c_reset}"
fi
if [[ ${#FIX_HINTS[@]} -gt 0 ]]; then
  echo ""
  echo "  Suggested fixes:"
  for h in "${FIX_HINTS[@]}"; do echo "    • $h"; done
  [[ "$FIX" == "0" ]] && echo "    (re-run with --fix to auto-apply the safe ones)"
fi
[[ "$FAILS" -eq 0 ]] && exit 0 || exit 1
