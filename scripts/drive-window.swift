// Click and scroll the app, without going through the MCP bridge.
//
// # Why this exists
//
// `AGENTS.md` documents how to SEE the app when the bridge cannot — the
// AppleScript activate, then `shot-window.sh` through the window server. There
// was no matching way to TOUCH it, so every interaction went through
// `webview_interact`, which injects script into the page.
//
// That gap cost most of a day. The browser client's frame pump stalls
// intermittently, and every reproduction had been preceded by bridge calls —
// so the bridge could never be ruled out, because there was no way to drive
// the app without it. With this, the app was driven start to finish by
// synthesised clicks and window-server screenshots, and the bridge was cleared
// by controlled test: the pump answered ten pages with injection live and used.
//
// A confound you cannot remove is a confound you keep paying for.
//
// # Two things that are not obvious and cost an hour each
//
// **The click state must be set.** A synthesised down/up pair with no
// `mouseEventClickState` is delivered, and AppKit reports `clickCount == 0`,
// which WKWebView treats as "not a click" and does not forward to the page.
// The window still ACTIVATES, so the symptom is a first click that focuses and
// every click after it doing nothing — which reads as a wrong coordinate.
//
// **The first click on an unfocused window is eaten.** macOS click-through
// means that click only activates; the page never sees it. Raise the window
// first, or send the click twice.
//
// # Coordinates
//
// Screen points, origin at the top-left of the main display — the same space
// System Events reports a window's `position` in. For a window at (wx, wy) with
// an overlay titlebar, a webview point (x, y) is at (wx + x, wy + y).
//
//   osascript -e 'tell application "System Events" to tell \
//     (first process whose unix id is PID) to get {position, size} of front window'
//
// Usage:  drive-window click  <x> <y>
//         drive-window scroll <x> <y> <ticks>   (negative ticks scroll down)

import CoreGraphics
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write("drive-window: \(message)\n".data(using: .utf8)!)
    exit(2)
}

let args = CommandLine.arguments
guard args.count >= 4 else {
    fail("usage: drive-window click <x> <y> | drive-window scroll <x> <y> <ticks>")
}
guard let x = Double(args[2]), let y = Double(args[3]) else {
    fail("x and y must be numbers")
}

let point = CGPoint(x: x, y: y)
let source = CGEventSource(stateID: .hidSystemState)

/* MOVED FIRST, ALWAYS. A click posted at a point the cursor is not at still
 * lands there, but hover state does not update — so a control that only
 * appears on hover is not there to be clicked. */
CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?
    .post(tap: .cghidEventTap)
usleep(80_000)

switch args[1] {
case "click":
    for type in [CGEventType.leftMouseDown, CGEventType.leftMouseUp] {
        let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
        /* See the header: without this WebKit does not forward the click. */
        event?.setIntegerValueField(.mouseEventClickState, value: 1)
        event?.post(tap: .cghidEventTap)
        usleep(60_000)
    }

case "scroll":
    guard args.count >= 5, let ticks = Int32(args[4]) else {
        fail("scroll needs a tick count; negative scrolls down")
    }
    /* EIGHT SMALL EVENTS rather than one large one. A single large delta is
     * treated as a fling by some scroll containers and lands somewhere the
     * caller did not ask for; a run of small ones lands predictably. */
    for _ in 0..<8 {
        CGEvent(
            scrollWheelEvent2Source: source,
            units: .pixel,
            wheelCount: 1,
            wheel1: ticks,
            wheel2: 0,
            wheel3: 0
        )?.post(tap: .cghidEventTap)
        usleep(40_000)
    }

default:
    fail("unknown action \(args[1]) — expected click or scroll")
}
