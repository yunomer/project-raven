#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPS_DIR="$SCRIPT_DIR/deps"
LIB_DIR="$DEPS_DIR/lib"

WAP_VERSION="${RAVEN_WEBRTC_AUDIO_PROCESSING_VERSION:-1.3}"
WAP_ARCHIVE="webrtc-audio-processing-${WAP_VERSION}.tar.xz"
WAP_URL="https://freedesktop.org/software/pulseaudio/webrtc-audio-processing/${WAP_ARCHIVE}"
# Official 1.3 release checksum. Override only when intentionally changing version.
WAP_SHA256="${RAVEN_WEBRTC_AUDIO_PROCESSING_SHA256:-2365e93e778d7b61b5d6e02d21c47d97222e9c7deff9e1d0838ad6ec2e86f1b9}"

TMP_BASE="${TMPDIR:-/tmp}"
DOWNLOAD_PATH="$TMP_BASE/raven-${WAP_ARCHIVE}"
SRC_DIR="$TMP_BASE/raven-webrtc-audio-processing-${WAP_VERSION}"
BUILD_DIR="$TMP_BASE/raven-webrtc-audio-processing-${WAP_VERSION}-build"
MAIN_LIB="$LIB_DIR/libwebrtc-audio-processing-1.a"
PUBLIC_HEADER="$DEPS_DIR/include/webrtc-audio-processing-1/modules/audio_processing/include/audio_processing.h"

need_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: '$1' is required to build WebRTC Audio Processing."
    if [[ "$(uname -s)" == "Darwin" ]]; then
      echo "Install build prerequisites with: brew install meson ninja pkg-config"
    fi
    exit 1
  fi
}

verify_sha256() {
  local file="$1"
  local expected="$2"
  local actual=""

  if command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  elif command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  else
    echo "ERROR: shasum or sha256sum is required to verify ${WAP_ARCHIVE}."
    exit 1
  fi

  if [[ "$actual" != "$expected" ]]; then
    echo "ERROR: checksum mismatch for ${WAP_ARCHIVE}."
    echo "  expected: $expected"
    echo "  actual:   $actual"
    rm -f "$file"
    exit 1
  fi
}

# The plugin linker needs both the installed public library and Meson's internal
# static libraries (common_audio, libapi, Abseil, etc.). If they are already
# present, the bootstrap is complete and can be reused across builds.
if [[ -f "$MAIN_LIB" && -f "$PUBLIC_HEADER" && -f "$LIB_DIR/libcommon_audio.a" && -f "$LIB_DIR/liblibapi.a" ]]; then
  echo "  WebRTC Audio Processing ${WAP_VERSION}: OK (cached in deps/)"
  exit 0
fi

need_command curl
need_command tar
need_command meson
need_command ninja

mkdir -p "$LIB_DIR"

echo "=== Building WebRTC Audio Processing ${WAP_VERSION} ==="

if [[ ! -f "$DOWNLOAD_PATH" ]]; then
  echo "Downloading ${WAP_ARCHIVE}..."
  curl -fL --retry 3 --retry-delay 1 "$WAP_URL" -o "$DOWNLOAD_PATH"
fi

verify_sha256 "$DOWNLOAD_PATH" "$WAP_SHA256"

rm -rf "$SRC_DIR" "$BUILD_DIR"
mkdir -p "$SRC_DIR"
tar -xf "$DOWNLOAD_PATH" -C "$SRC_DIR" --strip-components=1

# Force Meson's bundled dependency wraps so the resulting static library set is
# self-contained and does not accidentally link against a different Homebrew
# Abseil version. The GStreamer plugin is linked from these archives directly.
meson setup "$BUILD_DIR" "$SRC_DIR" \
  --prefix="$DEPS_DIR" \
  --libdir=lib \
  --buildtype=release \
  --default-library=static \
  --wrap-mode=forcefallback

meson compile -C "$BUILD_DIR"
meson install -C "$BUILD_DIR"

# Meson installs the public WebRTC library and headers, but the GStreamer
# webrtcdsp plugin also links against several internal static targets that are
# intentionally not installed. Flatten all generated archives into deps/lib so
# build-webrtcdsp-plugin.sh can link them deterministically.
while IFS= read -r -d '' archive; do
  cp -f "$archive" "$LIB_DIR/"
done < <(find "$BUILD_DIR" -type f -name '*.a' -print0)

required_archives=(
  "libwebrtc-audio-processing-1.a"
  "libcommon_audio.a"
  "liblibapi.a"
  "liblibbase.a"
  "libsystem_wrappers.a"
)

missing=0
for archive in "${required_archives[@]}"; do
  if [[ ! -f "$LIB_DIR/$archive" ]]; then
    echo "ERROR: expected static archive not produced: $LIB_DIR/$archive"
    missing=1
  fi
done

if [[ ! -f "$PUBLIC_HEADER" ]]; then
  echo "ERROR: WebRTC Audio Processing headers were not installed under $DEPS_DIR/include."
  missing=1
fi

if [[ "$missing" -ne 0 ]]; then
  exit 1
fi

echo "  WebRTC Audio Processing ${WAP_VERSION}: built successfully"
