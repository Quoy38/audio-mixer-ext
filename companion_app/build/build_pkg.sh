#!/usr/bin/env bash
# build_pkg.sh — assemble a signed macOS installer (.pkg) for the companion.
#
# Produces a double-click installer that lays down the companion + bundled runtime
# under /Library/Application Support/AudioMixerExt and installs the LaunchAgent via
# the postinstall script. When Developer ID identities are present in the keychain
# it deep-signs the runtime's Mach-O files and product-signs the pkg (required
# BEFORE notarization — signing has to happen before/inside packaging, which is why
# it lives here and not in notarize_pkg.sh). Without identities it emits an UNSIGNED
# pkg (useful for local plumbing tests only — Gatekeeper will reject it).
#
# Usage:
#   bash companion_app/build/build_pkg.sh [--arch x86_64|arm64] [--version X.Y.Z] [--unsigned]
#
# Signing identities are auto-detected from the keychain but can be overridden:
#   DEVELOPER_ID_APP="Developer ID Application: NAME (TEAMID)"
#   DEVELOPER_ID_INSTALLER="Developer ID Installer: NAME (TEAMID)"
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPANION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$COMPANION_DIR/.." && pwd)"

PKG_IDENTIFIER="com.audiomixerext.companion"
INSTALL_SUBPATH="Library/Application Support/AudioMixerExt"
ENTITLEMENTS="$SCRIPT_DIR/entitlements.plist"
PLIST_TEMPLATE="$COMPANION_DIR/com.audiomixerext.companion.plist"
PKG_SCRIPTS_SRC="$SCRIPT_DIR/pkg-scripts"

# ── Args ──────────────────────────────────────────────────────────────────────
TARGET_ARCH="$(uname -m)"
VERSION=""
FORCE_UNSIGNED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --arch)      TARGET_ARCH="$2"; shift 2 ;;
    --arch=*)    TARGET_ARCH="${1#*=}"; shift ;;
    --version)   VERSION="$2"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --unsigned)  FORCE_UNSIGNED=1; shift ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$TARGET_ARCH" in x86_64|arm64) ;; *) echo "Unsupported --arch: $TARGET_ARCH" >&2; exit 2 ;; esac

if [ -z "$VERSION" ]; then
  VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_ROOT/manifest.json" | head -1)"
  [ -n "$VERSION" ] || VERSION="1.0.0"
fi

RUNTIME_SRC="$COMPANION_DIR/runtime/$TARGET_ARCH"
if [ ! -x "$RUNTIME_SRC/python/bin/python3" ]; then
  echo "❌  No bundled runtime for $TARGET_ARCH at $RUNTIME_SRC/python." >&2
  echo "    Build it first: bash companion_app/build/build_macos_runtime.sh --arch $TARGET_ARCH" >&2
  exit 1
fi

# ── Resolve signing identities (unless --unsigned) ────────────────────────────
APP_IDENTITY=""
INSTALLER_IDENTITY=""
if [ -z "$FORCE_UNSIGNED" ]; then
  APP_IDENTITY="${DEVELOPER_ID_APP:-$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Developer ID Application/{print $2; exit}')}"
  INSTALLER_IDENTITY="${DEVELOPER_ID_INSTALLER:-$(security find-identity -v 2>/dev/null | awk -F'"' '/Developer ID Installer/{print $2; exit}')}"
fi

# ── Staging ───────────────────────────────────────────────────────────────────
BUILD_DIR="$(mktemp -d -t audio-mixer-pkg.XXXXXX)"
trap 'rm -rf "$BUILD_DIR"' EXIT
PAYLOAD="$BUILD_DIR/payload"
DEST="$PAYLOAD/$INSTALL_SUBPATH"
SCRIPTS="$BUILD_DIR/scripts"
DIST_DIR="$SCRIPT_DIR/dist"
OUT_PKG="$DIST_DIR/AudioMixerCompanion-$TARGET_ARCH-$VERSION.pkg"

mkdir -p "$DEST/companion" "$DEST/runtime/$TARGET_ARCH" "$SCRIPTS" "$DIST_DIR"

echo "⏳  Staging companion files..."
for f in server.py companion_profile.json model_weights.manifest.json requirements.lock; do
  cp "$COMPANION_DIR/$f" "$DEST/companion/$f"
done
[ -f "$COMPANION_DIR/run.sh" ] && cp "$COMPANION_DIR/run.sh" "$DEST/companion/run.sh" || true
cp "$PLIST_TEMPLATE" "$DEST/companion/com.audiomixerext.companion.plist"

echo "⏳  Staging bundled runtime ($TARGET_ARCH, this copies ~800 MB)..."
ditto "$RUNTIME_SRC" "$DEST/runtime/$TARGET_ARCH"

cp "$PKG_SCRIPTS_SRC/postinstall" "$SCRIPTS/postinstall"
chmod +x "$SCRIPTS/postinstall"

# ── Deep-sign the runtime binaries (must happen before packaging) ─────────────
if [ -n "$APP_IDENTITY" ]; then
  echo "🔏  Deep-signing runtime with: $APP_IDENTITY"
  RT="$DEST/runtime/$TARGET_ARCH"
  # Strip extended attributes / resource forks first, else codesign rejects files
  # with "resource fork, Finder information, or similar detritus not allowed".
  xattr -cr "$RT" 2>/dev/null || true

  # Enumerate every Mach-O file: all .so/.dylib, plus any other executable Mach-O.
  SIGN_LIST="$BUILD_DIR/sign_list.txt"
  : > "$SIGN_LIST"
  find "$RT" -type f \( -name '*.so' -o -name '*.dylib' \) -print >> "$SIGN_LIST"
  while IFS= read -r f; do
    case "$f" in *.so|*.dylib) continue ;; esac
    if file "$f" | grep -q 'Mach-O'; then printf '%s\n' "$f" >> "$SIGN_LIST"; fi
  done < <(find "$RT" -type f -perm -u+x)

  TOTAL=$(wc -l < "$SIGN_LIST" | tr -d ' ')
  echo "    Signing $TOTAL Mach-O files (each fetches a secure timestamp — several minutes)..."
  SIGNED=0; FAILED=0
  while IFS= read -r f; do
    if codesign --force --timestamp --options runtime \
         --entitlements "$ENTITLEMENTS" --sign "$APP_IDENTITY" "$f" >/dev/null 2>&1; then
      SIGNED=$((SIGNED + 1))
    else
      FAILED=$((FAILED + 1))
      echo "    ⚠️  could not sign: ${f#"$RT"/}" >&2
    fi
    if [ $(( (SIGNED + FAILED) % 250 )) -eq 0 ]; then echo "    ... $((SIGNED + FAILED))/$TOTAL"; fi
  done < "$SIGN_LIST"
  echo "    Signed $SIGNED/$TOTAL (failures: $FAILED)"

  # The interpreter itself MUST be validly signed or nothing will launch.
  MAIN_PY="$(ls "$RT"/python/bin/python3.* 2>/dev/null | head -1 || true)"
  if [ -n "$MAIN_PY" ] && ! codesign -v --strict "$MAIN_PY" >/dev/null 2>&1; then
    echo "❌  The Python interpreter did not sign cleanly ($MAIN_PY)." >&2
    echo "    Check that the login keychain is unlocked and the identity is valid." >&2
    exit 1
  fi
else
  echo "⚠️  No Developer ID Application identity — runtime will be UNSIGNED."
fi

# ── Build the component + product archive ─────────────────────────────────────
echo "📦  Building component package..."
pkgbuild \
  --root "$PAYLOAD" \
  --scripts "$SCRIPTS" \
  --identifier "$PKG_IDENTIFIER" \
  --version "$VERSION" \
  --install-location "/" \
  "$BUILD_DIR/component.pkg"

echo "📦  Building product archive..."
productbuild --package "$BUILD_DIR/component.pkg" "$BUILD_DIR/product.pkg"

# ── Product-sign with the Installer identity ──────────────────────────────────
if [ -n "$INSTALLER_IDENTITY" ]; then
  echo "🔏  Product-signing installer with: $INSTALLER_IDENTITY"
  productsign --sign "$INSTALLER_IDENTITY" "$BUILD_DIR/product.pkg" "$OUT_PKG"
else
  echo "⚠️  No Developer ID Installer identity — emitting UNSIGNED pkg."
  cp "$BUILD_DIR/product.pkg" "$OUT_PKG"
fi

echo ""
echo "✅  Built: $OUT_PKG"
if [ -n "$APP_IDENTITY" ] && [ -n "$INSTALLER_IDENTITY" ]; then
  echo "    Signed. Next: bash companion_app/build/notarize_pkg.sh \"$OUT_PKG\""
else
  echo "    UNSIGNED (local test only). Provide Developer ID identities to ship."
fi
