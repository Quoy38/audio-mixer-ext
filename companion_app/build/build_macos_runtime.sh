#!/usr/bin/env bash
# companion_app/build/build_macos_runtime.sh
# =============================================================================
# Build a SELF-CONTAINED, relocatable macOS Python runtime for the companion so
# end users need NO system Python, NO pip, and NO compiler at install time.
#
# It downloads a python-build-standalone CPython (per-arch, per R6 — no Universal2),
# installs the FROZEN requirements.lock into that runtime's own site-packages
# (no venv, so nothing bakes an absolute path), prunes ~200 MB of dead weight,
# and leaves a drop-in interpreter at:
#     companion_app/runtime/<arch>/python/bin/python3
#
# install-macos-service.sh auto-detects that path and skips the system-Python +
# venv + online-pip flow entirely (the old, fragile "download Python yourself" step).
#
# Usage:
#   bash companion_app/build/build_macos_runtime.sh                 # build for THIS Mac's arch
#   bash companion_app/build/build_macos_runtime.sh --arch arm64    # cross-target (native pip needs that arch)
#   bash companion_app/build/build_macos_runtime.sh --arch x86_64
#
# Reproducibility: the python-build-standalone release is PINNED below, mirroring
# the requirements.lock philosophy. Bump PBS_TAG/PBS_PY_VERSION deliberately, then
# rebuild + re-run checkpoints/release_gate.sh.
# =============================================================================
set -euo pipefail

# ── Pinned python-build-standalone runtime (astral-sh/python-build-standalone) ──
PBS_TAG="${PBS_TAG:-20260807}"
PBS_PY_VERSION="${PBS_PY_VERSION:-3.11.15}"
PBS_PY_SERIES="${PBS_PY_VERSION%.*}"   # e.g. 3.11
PBS_BASE_URL="https://github.com/astral-sh/python-build-standalone/releases/download"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPANION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REQUIREMENTS_LOCK="$COMPANION_DIR/requirements.lock"

# ── Parse args ───────────────────────────────────────────────────────────────
TARGET_ARCH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch) TARGET_ARCH="${2:-}"; shift 2 ;;
    --arch=*) TARGET_ARCH="${1#*=}"; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ── Resolve arch (default = TRUE hardware arch; sysctl, NOT uname -m which lies
#    under Rosetta on Apple Silicon) ───────────────────────────────────────────
detect_hw_arch() {
  if [[ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" == "1" ]]; then
    echo "arm64"
  else
    echo "x86_64"
  fi
}
[[ -n "$TARGET_ARCH" ]] || TARGET_ARCH="$(detect_hw_arch)"

case "$TARGET_ARCH" in
  arm64)  PBS_ARCH="aarch64" ;;
  x86_64) PBS_ARCH="x86_64" ;;
  *) echo "❌  Unsupported --arch '$TARGET_ARCH' (use arm64 or x86_64)." >&2; exit 2 ;;
esac

HOST_ARCH="$(detect_hw_arch)"
if [[ "$TARGET_ARCH" != "$HOST_ARCH" ]]; then
  echo "⚠️  Cross-building $TARGET_ARCH on a $HOST_ARCH host: pip installs run under this host's"
  echo "    interpreter, so torch wheels for $TARGET_ARCH cannot execute here. Build each arch"
  echo "    natively (or in CI on that arch). Continuing to fetch the runtime, but the pip step"
  echo "    may fail — this is expected off-arch."
fi

TARBALL_NAME="cpython-${PBS_PY_VERSION}+${PBS_TAG}-${PBS_ARCH}-apple-darwin-install_only.tar.gz"
DOWNLOAD_URL="${PBS_BASE_URL}/${PBS_TAG}/${TARBALL_NAME}"

OUT_DIR="$COMPANION_DIR/runtime/$TARGET_ARCH"
RUNTIME_DIR="$OUT_DIR/python"
RUNTIME_PY="$RUNTIME_DIR/bin/python3"

echo ""
echo "=== Build companion runtime — $TARGET_ARCH (CPython $PBS_PY_VERSION / pbs $PBS_TAG) ==="
echo ""

[[ -f "$REQUIREMENTS_LOCK" ]] || { echo "❌  Missing $REQUIREMENTS_LOCK" >&2; exit 1; }

# ── Disk preflight (this machine can run near-full; a torch build needs headroom) ─
FREE_KB="$(df -k "$COMPANION_DIR" | tail -1 | awk '{print $4}')"
MIN_FREE_KB=$((4 * 1024 * 1024))   # 4 GiB
if [[ "$FREE_KB" -lt "$MIN_FREE_KB" ]]; then
  echo "❌  Only $((FREE_KB / 1024)) MiB free; need ≥ 4 GiB to build a torch runtime safely." >&2
  echo "    Free some space and retry." >&2
  exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/audio-mixer-runtime.XXXXXX")"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

# ── 1. Download the standalone CPython (cached in TMPDIR to speed up retries) ─
TARBALL_PATH="$WORK_DIR/$TARBALL_NAME"
CACHE_DIR="${TMPDIR:-/tmp}/audio-mixer-pbs-cache"
mkdir -p "$CACHE_DIR"
CACHED_TARBALL="$CACHE_DIR/$TARBALL_NAME"
if [[ -s "$CACHED_TARBALL" ]]; then
  echo "📦  Reusing cached $TARBALL_NAME"
  cp "$CACHED_TARBALL" "$TARBALL_PATH"
else
  echo "⏳  Downloading $TARBALL_NAME ..."
  if ! curl -fL --retry 3 --connect-timeout 20 -o "$TARBALL_PATH" "$DOWNLOAD_URL"; then
    echo "❌  Download failed: $DOWNLOAD_URL" >&2
    echo "    Check the PBS_TAG/PBS_PY_VERSION pin or your network." >&2
    exit 1
  fi
  cp "$TARBALL_PATH" "$CACHED_TARBALL" 2>/dev/null || true
fi
TARBALL_SHA="$(shasum -a 256 "$TARBALL_PATH" | awk '{print $1}')"
echo "✅  Runtime archive ready ($(du -h "$TARBALL_PATH" | awk '{print $1}'), sha256 ${TARBALL_SHA:0:16}…)"

# ── 2. Extract → relocatable python/ prefix ──────────────────────────────────
echo "⏳  Extracting runtime ..."
tar -xzf "$TARBALL_PATH" -C "$WORK_DIR"
[[ -x "$WORK_DIR/python/bin/python3" ]] || { echo "❌  Unexpected archive layout (no python/bin/python3)." >&2; exit 1; }

mkdir -p "$OUT_DIR"
rm -rf "$RUNTIME_DIR"
mv "$WORK_DIR/python" "$RUNTIME_DIR"

# ── 3. Sanity-check the interpreter (ssl/lzma/sqlite are common standalone gaps) ─
if ! "$RUNTIME_PY" -c "import sys, ssl, lzma, sqlite3, ctypes; print('runtime ok:', sys.version.split()[0])"; then
  echo "❌  Bundled interpreter failed its stdlib self-check." >&2
  exit 1
fi

# ── 4. Install the FROZEN deps into the runtime's own site-packages (no venv) ──
# python-build-standalone ships NO CA bundle, so its OpenSSL cannot verify PyPI
# (SSLCertVerificationError / OSStatus -26276). Point it at a real bundle first.
resolve_ca_bundle() {
  local sib="$COMPANION_DIR/../.venv/bin/python" p c
  if [[ -x "$sib" ]]; then
    p="$("$sib" -c 'import certifi; print(certifi.where())' 2>/dev/null || true)"
    [[ -n "$p" && -f "$p" ]] && { echo "$p"; return 0; }
  fi
  for c in /etc/ssl/cert.pem /private/etc/ssl/cert.pem; do
    [[ -f "$c" ]] && { echo "$c"; return 0; }
  done
  return 1
}
CA_BUNDLE="$(resolve_ca_bundle || true)"
if [[ -n "$CA_BUNDLE" ]]; then
  export SSL_CERT_FILE="$CA_BUNDLE" PIP_CERT="$CA_BUNDLE"
  echo "🔐  pip CA bundle: $CA_BUNDLE"
else
  echo "⚠️  No CA bundle found; pip TLS verification may fail."
fi

echo "⏳  Installing pinned dependencies into the runtime (this takes a few minutes)..."
"$RUNTIME_PY" -m ensurepip --upgrade >/dev/null 2>&1 || true
INSTALL_LOG="$(mktemp "${TMPDIR:-/tmp}/audio-mixer-runtime-install.XXXXXX.log")"

pip_install_lock() {
  local req="$1"
  "$RUNTIME_PY" -m pip install --no-cache-dir --disable-pip-version-check -r "$req" 2>"$INSTALL_LOG"
}

if ! pip_install_lock "$REQUIREMENTS_LOCK"; then
  if grep -Eiq "Failed building wheel for onnx|Could not build wheels for onnx|metadata-generation-failed" "$INSTALL_LOG"; then
    echo "    ⚠️  onnx build failed; retrying without onnx (not used by the companion server)."
    NO_ONNX_REQ="$WORK_DIR/requirements-no-onnx.lock"
    grep -Ev '^onnx==' "$REQUIREMENTS_LOCK" > "$NO_ONNX_REQ"
    if ! pip_install_lock "$NO_ONNX_REQ"; then
      echo "❌  Dependency install failed." >&2; tail -n 40 "$INSTALL_LOG" >&2; rm -f "$INSTALL_LOG"; exit 1
    fi
  else
    echo "❌  Dependency install failed." >&2; tail -n 40 "$INSTALL_LOG" >&2; rm -f "$INSTALL_LOG"; exit 1
  fi
fi
rm -f "$INSTALL_LOG"

# certifi is not in the lock, but the launchd service needs an explicit CA bundle (drift vector).
"$RUNTIME_PY" -m pip install --no-cache-dir --disable-pip-version-check certifi >/dev/null 2>&1 || true

# Confirm the heavy pieces actually import in the bundled runtime.
if ! "$RUNTIME_PY" -c "import torch, torchaudio, demucs, fastapi, uvicorn; print('deps ok: torch', torch.__version__)"; then
  echo "❌  Core dependencies did not import from the bundled runtime." >&2
  exit 1
fi

# ── 5. Prune dead weight (~200 MB): caches, tests, headers, static libs ───────
echo "⏳  Pruning caches/tests/headers ..."
find "$RUNTIME_DIR" -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || true
find "$RUNTIME_DIR" -type d \( -name "tests" -o -name "test" \) -prune -exec rm -rf {} + 2>/dev/null || true
find "$RUNTIME_DIR" -type f \( -name "*.pyc" -o -name "*.a" \) -delete 2>/dev/null || true
rm -rf "$RUNTIME_DIR/lib/python${PBS_PY_SERIES}/site-packages/torch/include" 2>/dev/null || true

# ── 6. Record what we built (reproducibility / debugging) ────────────────────
TORCH_VER="$("$RUNTIME_PY" -c 'import torch; print(torch.__version__)' 2>/dev/null || echo unknown)"
cat > "$OUT_DIR/runtime.lock" <<EOF
# Generated by build_macos_runtime.sh — do not edit by hand.
arch=$TARGET_ARCH
python_build_standalone_tag=$PBS_TAG
python_version=$PBS_PY_VERSION
tarball=$TARBALL_NAME
tarball_sha256=$TARBALL_SHA
torch=$TORCH_VER
built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

RUNTIME_SIZE="$(du -sh "$RUNTIME_DIR" | awk '{print $1}')"
echo ""
echo "✅  Runtime built: $RUNTIME_DIR ($RUNTIME_SIZE)"
echo "    Interpreter:   $RUNTIME_PY"
echo "    torch:         $TORCH_VER"
echo "    Manifest:      $OUT_DIR/runtime.lock"
echo ""
echo "    install-macos-service.sh will now detect and use this bundled runtime."
