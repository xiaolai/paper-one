#!/usr/bin/env bash
#
# Capture the app's window by its CGWindowID.
#
# THE LAST RESORT, not the first. The order is:
#
#   1. The Tauri MCP's `webview_screenshot`. It captures the webview itself, so
#      it cannot pick up another window and it works across Spaces.
#
#   2. AppleScript, then retry:
#        osascript -e 'tell application "System Events" to set frontmost of \
#          (first process whose unix id is PID) to true'
#      Most failures are the window being occluded, and that costs far more
#      than a screenshot — WebKit suspends requestAnimationFrame for a hidden
#      window, which is where pdf.js parks its page render, so the book loads
#      and then shows a blank canvas with no error. Activating fixes the
#      capture and the rendering together.
#
#   3. This script, when the main thread is genuinely wedged — a scanned PDF
#      decoding on pdf.js's JS fallback will do that for seconds at a time, and
#      `webview_screenshot` runs inside the webview, so it times out. This goes
#      through the window server instead and is unaffected.
#
# It captures by WINDOW ID, never by region. `screencapture -R x,y,w,h` grabs
# whatever is composited in that rectangle — which, when the app is not
# frontmost, is another application. That has already produced a screenshot of
# a terminal presented as the app's window, which is the failure AGENTS.md
# warns about and the reason this resolves an id first.
#
# Usage:
#   scripts/shot-window.sh [output.png] [pid]
#
# With no pid it finds the dev build (`target/debug/app`), then a release
# `Paper`. Pass one explicitly to capture something else.

set -euo pipefail

out="${1:-/tmp/paper-window.png}"
pid="${2:-}"

if [[ -z "$pid" ]]; then
  pid="$(pgrep -f 'target/debug/app' | head -1 || true)"
fi
if [[ -z "$pid" ]]; then
  pid="$(pgrep -x 'Paper' | head -1 || true)"
fi
if [[ -z "$pid" ]]; then
  echo "shot-window: no running app found. Start it, or pass a pid." >&2
  exit 1
fi

swift_src="$(mktemp -t winid).swift"
trap 'rm -f "$swift_src"' EXIT
cat > "$swift_src" <<'SWIFT'
import CoreGraphics
import Foundation

// Filtered to layer 0, because the menu bar and any panel belong to the same
// process and one of them is otherwise returned first — that produced a
// screenshot containing nothing but the menu bar. Then the largest, which is
// the document window.
let pid = Int(CommandLine.arguments[1])!
guard let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else {
    FileHandle.standardError.write("no window list\n".data(using: .utf8)!)
    exit(1)
}
func area(_ w: [String: Any]) -> Double {
    guard let b = w[kCGWindowBounds as String] as? [String: Any] else { return 0 }
    return (b["Width"] as? Double ?? 0) * (b["Height"] as? Double ?? 0)
}
let mine = list
    .filter { ($0[kCGWindowOwnerPID as String] as? Int) == pid }
    .filter { ($0[kCGWindowLayer as String] as? Int) == 0 }
    .sorted { area($0) > area($1) }
guard let win = mine.first, let id = win[kCGWindowNumber as String] as? Int else {
    FileHandle.standardError.write("no layer-0 window for pid \(pid)\n".data(using: .utf8)!)
    exit(1)
}
print(id)
SWIFT

window="$(swift "$swift_src" "$pid" | tail -1)"
if ! [[ "$window" =~ ^[0-9]+$ ]]; then
  echo "shot-window: could not resolve a window id for pid $pid — got '$window'" >&2
  exit 1
fi

rm -f "$out"
# -o omits the drop shadow, -x suppresses the shutter sound.
screencapture -x -o -l"$window" "$out"

# screencapture exits 0 having written nothing when the window id is stale, so
# the file check is the only real failure signal — the same trap as actool.
if [[ ! -s "$out" ]]; then
  echo "shot-window: screencapture produced no file for window $window." >&2
  echo "  The id was probably stale. Re-run; it is resolved fresh each time." >&2
  exit 1
fi

echo "shot-window: pid $pid, window $window -> $out ($(wc -c <"$out" | tr -d ' ') bytes)"
