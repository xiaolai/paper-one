#!/bin/sh
# Click or scroll the running app, without the MCP bridge.
#
# A thin wrapper over `drive-window.swift`, which is where the reasoning lives.
# Compiles once into a cache under `node_modules/.cache/` — gitignored, and
# rebuilt whenever the source is newer — because `swiftc` takes a couple of
# seconds and a driving script makes many calls.
#
#   ./scripts/drive-window.sh click  1958 1143
#   ./scripts/drive-window.sh scroll 1790 785 -120
#
# Coordinates are screen points, origin at the top-left of the main display.
# For a window at (wx, wy) with an overlay titlebar, a webview point (x, y) is
# at (wx + x, wy + y); read the window's position with:
#
#   osascript -e 'tell application "System Events" to tell \
#     (first process whose unix id is PID) to get {position, size} of front window'
#
# THE FIRST CLICK ON AN UNFOCUSED WINDOW IS EATEN by macOS click-through — it
# only activates. Raise the window first (see AGENTS.md) or click twice.
#
# EXIT CODES: 0 posted, 2 bad usage, 3 the window server refused to create the
# event — which means this process may not post input events (Accessibility and
# Input Monitoring, in Privacy & Security). 3 exists because that failure used
# to exit 0 having touched nothing, and an investigation driven by this tool
# then read "clicked, nothing happened" as a finding about the app.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
src="$here/drive-window.swift"
cache="$root/node_modules/.cache/paper-tools"
bin="$cache/drive-window"

if [ ! -f "$src" ]; then
  echo "drive-window: $src is missing" >&2
  exit 2
fi

if [ ! -x "$bin" ] || [ "$src" -nt "$bin" ]; then
  mkdir -p "$cache"
  # `swiftc` writes nothing and still exits 0 on some failures, so the binary is
  # checked for rather than the exit code trusted — the same trap `actool` sets
  # and that AGENTS.md records for the icon build.
  swiftc -O "$src" -o "$bin" || true
  if [ ! -x "$bin" ]; then
    echo "drive-window: could not build $src (is the Xcode command line toolchain installed?)" >&2
    exit 2
  fi
fi

exec "$bin" "$@"
