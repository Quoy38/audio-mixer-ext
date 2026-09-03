#!/usr/bin/env bash
# checkpoints/check_profile_drift.sh
# =============================================================================
# Compare the CANONICAL companion profile (companion_app/companion_profile.json)
# against every live / on-disk consumer and report drift. Exits non-zero on drift.
#
# WHY: The classic "worked one day, broke the next" failure was the INSTALLED
# LaunchAgent plist drifting (overlap 0.1 vs 0.25). popup.js isCompanionProfileLocked()
# demands an EXACT match, so one drifted field silently disables the Pro engine and
# the extension quietly falls back to low-quality local DSP. This script surfaces
# that drift instantly instead of leaving you to re-diagnose it by hand.
#
# Checks: live GET /v1/health, the installed plist env, and popup.js
# COMPANION_LOCK_PROFILE. Called by doctor.sh and release_gate.sh.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PY="$REPO_DIR/.venv/bin/python"
[[ -x "$PY" ]] || PY="$(command -v python3 || true)"
[[ -n "$PY" ]] || { echo "[profile-drift] FATAL: no python3 available" >&2; exit 2; }

CANON="$REPO_DIR/companion_app/companion_profile.json" \
INSTALLED_PLIST="$HOME/Library/LaunchAgents/com.audiomixerext.companion.plist" \
POPUP="$REPO_DIR/popup/popup.js" \
HEALTH_URL="http://127.0.0.1:48231/v1/health" \
"$PY" - <<'PYEOF'
import json, os, re, sys, urllib.request, plistlib

canon_path = os.environ["CANON"]
if not os.path.exists(canon_path):
    print(f"[profile-drift] FATAL: canonical profile missing at {canon_path}", file=sys.stderr)
    sys.exit(2)

with open(canon_path) as f:
    canon = json.load(f)
prof = canon["profile"]

# Device is intentionally NOT an exact-match lock against the canonical value. The installer
# auto-detects mps (Apple Silicon, macOS >= 12.3) or cpu (Intel / older macOS), and the
# extension accepts either (mps = locked profile, cpu = recognized cpu-fallback). cuda/directml
# are Windows-track devices (Phase D) and are not accepted by this macOS gate yet.
ALLOWED_LIVE_DEVICES = {"mps", "cpu"}

problems = []
checks = 0

def cmp(source, key, actual, expected):
    """Numeric-aware comparison: 180 == 180.0, true == True, 'mps' == 'mps'."""
    global checks
    checks += 1
    try:
        if float(actual) == float(expected):
            return
    except (TypeError, ValueError):
        pass
    if str(actual).lower() == str(expected).lower():
        return
    problems.append(f"{source}: {key}={actual!r} != canonical {expected!r}")

# 1) Live health — catches a running-but-misconfigured server.
try:
    with urllib.request.urlopen(os.environ["HEALTH_URL"], timeout=3) as r:
        health = json.load(r)
    for k in ("split", "fast_short_clips", "fast_short_max_seconds", "fast_medium_clips",
              "fast_medium_max_seconds", "fast_medium_segment_seconds", "overlap", "device"):
        if k in health:
            if k == "device":
                checks += 1
                if str(health[k]).lower() not in ALLOWED_LIVE_DEVICES:
                    problems.append(
                        f"live-health: device={health[k]!r} not in allowed {sorted(ALLOWED_LIVE_DEVICES)}"
                    )
            else:
                cmp("live-health", k, health[k], prof[k])
    print("[profile-drift] checked live /v1/health")
except Exception as e:
    print(f"[profile-drift] live /v1/health not reachable ({e}); skipping live check (doctor handles offline)")

# 2) Installed plist env — catches the classic pre-restart drift.
plist_env_map = {
    "AUDIO_MIXER_DEMUCS_OVERLAP": ("overlap", float),
    "AUDIO_MIXER_DEMUCS_FAST_SHORT_CLIPS": ("fast_short_clips", lambda v: v == "1"),
    "AUDIO_MIXER_DEMUCS_FAST_SHORT_MAX_SECONDS": ("fast_short_max_seconds", float),
    "AUDIO_MIXER_DEMUCS_FAST_MEDIUM_CLIPS": ("fast_medium_clips", lambda v: v == "1"),
    "AUDIO_MIXER_DEMUCS_FAST_MEDIUM_MAX_SECONDS": ("fast_medium_max_seconds", float),
    "AUDIO_MIXER_DEMUCS_FAST_MEDIUM_SEGMENT_SECONDS": ("fast_medium_segment_seconds", float),
}
installed_plist = os.environ["INSTALLED_PLIST"]
if os.path.exists(installed_plist):
    try:
        with open(installed_plist, "rb") as f:
            pl = plistlib.load(f)
        env = pl.get("EnvironmentVariables", {})
        for evar, (pkey, conv) in plist_env_map.items():
            if evar in env:
                cmp("installed-plist", pkey, conv(env[evar]), prof[pkey])
        print("[profile-drift] checked installed plist env")
    except Exception as e:
        print(f"[profile-drift] could not parse installed plist ({e})")
else:
    print("[profile-drift] installed plist not found (service not installed?)")

# 3) popup.js COMPANION_LOCK_PROFILE — catches a future code edit that changes the
#    lock without updating the canonical file.
try:
    txt = open(os.environ["POPUP"]).read()
    m = re.search(r"COMPANION_LOCK_PROFILE\s*=\s*Object\.freeze\(\{(.*?)\}\)", txt, re.S)
    if m:
        body = m.group(1)
        for k in prof:
            mm = re.search(rf"{k}\s*:\s*([^,\n]+)", body)
            if mm:
                cmp("popup.js", k, mm.group(1).strip().strip('"'), prof[k])
        print("[profile-drift] checked popup.js COMPANION_LOCK_PROFILE")
    else:
        print("[profile-drift] COMPANION_LOCK_PROFILE not found in popup.js")
except Exception as e:
    print(f"[profile-drift] could not parse popup.js ({e})")

print(f"[profile-drift] {checks} field comparisons performed")
if problems:
    print("\n[profile-drift] DRIFT DETECTED:", file=sys.stderr)
    for p in problems:
        print("  - " + p, file=sys.stderr)
    print("\nFix: re-sync the drifted source to companion_app/companion_profile.json,")
    print("then reload the service (doctor.sh --fix can re-sync the installed plist).")
    sys.exit(1)
print("[profile-drift] PASS: all sources agree with the canonical profile")
PYEOF
