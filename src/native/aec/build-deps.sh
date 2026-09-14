#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPS_DIR="$SCRIPT_DIR/deps"
PLUGIN_DIR="$DEPS_DIR/lib/gstreamer-1.0"

need_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: '$1' is required for Raven AEC."
    if [[ "$(uname -s)" == "Darwin" ]]; then
      echo "Install prerequisites with: brew install gstreamer pkg-config meson ninja"
    fi
    exit 1
  fi
}

need_command pkg-config
need_command gst-inspect-1.0

echo "=== Verifying GStreamer AEC dependencies ==="

# Check for GStreamer core
if ! pkg-config --exists gstreamer-1.0; then
    echo "ERROR: gstreamer-1.0 not found."
    echo ""
    echo "Install GStreamer:"
    echo "  macOS:   brew install gstreamer"
    echo "  Linux:   sudo apt install libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libgstreamer-plugins-bad1.0-dev"
    echo "  Windows: Download from https://gstreamer.freedesktop.org/download/"
    exit 1
fi

GST_VERSION=$(pkg-config --modversion gstreamer-1.0)
echo "  GStreamer core: $GST_VERSION"

# Check for GStreamer app (appsrc/appsink)
if ! pkg-config --exists gstreamer-app-1.0; then
    echo "ERROR: gstreamer-app-1.0 not found."
    exit 1
fi
echo "  GStreamer app (appsrc/appsink): OK"

# Check for GStreamer audio
if ! pkg-config --exists gstreamer-audio-1.0; then
    echo "ERROR: gstreamer-audio-1.0 not found."
    exit 1
fi
echo "  GStreamer audio: OK"

# Check for GStreamer bad-audio (needed by webrtcdsp plugin)
if ! pkg-config --exists gstreamer-bad-audio-1.0; then
    echo "ERROR: gstreamer-bad-audio-1.0 not found."
    exit 1
fi
echo "  GStreamer bad-audio: OK"

# Homebrew GStreamer does not ship webrtcdsp because it depends on WebRTC Audio
# Processing. Bootstrap the pinned static WebRTC library (and its internal
# static archives) before compiling the plugin. The helper is idempotent and
# returns immediately when deps/ is already complete.
echo ""
bash "$SCRIPT_DIR/build-webrtc-audio-processing.sh"

# Check for our custom webrtcdsp plugin
if [ -f "$PLUGIN_DIR/libgstwebrtcdsp.dylib" ] || [ -f "$PLUGIN_DIR/libgstwebrtcdsp.so" ]; then
    echo "  webrtcdsp plugin: OK (custom-built in deps/)"
else
    echo ""
    echo "  webrtcdsp plugin not found in $PLUGIN_DIR"
    echo "  Building from gst-plugins-bad source..."
    echo ""
    bash "$SCRIPT_DIR/build-webrtcdsp-plugin.sh"
fi

# Do not report success if the plugin file exists but cannot actually be loaded.
GST_PLUGIN_PATH="$PLUGIN_DIR${GST_PLUGIN_PATH:+:$GST_PLUGIN_PATH}" \
  gst-inspect-1.0 webrtcdsp >/dev/null 2>&1 || {
    echo "ERROR: custom webrtcdsp plugin was built but GStreamer could not load it."
    echo "Run: GST_PLUGIN_PATH=\"$PLUGIN_DIR\" gst-inspect-1.0 webrtcdsp"
    exit 1
  }

GST_PLUGIN_PATH="$PLUGIN_DIR${GST_PLUGIN_PATH:+:$GST_PLUGIN_PATH}" \
  gst-inspect-1.0 webrtcechoprobe >/dev/null 2>&1 || {
    echo "ERROR: custom webrtcechoprobe element could not be loaded."
    exit 1
  }

echo ""
echo "=== All GStreamer AEC dependencies satisfied ==="
echo "  WebRTC Audio Processing: OK"
echo "  webrtcdsp: OK"
echo "  webrtcechoprobe: OK"
