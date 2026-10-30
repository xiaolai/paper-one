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
// **A missing permission looks exactly like a successful run.** `CGEvent(...)`
// returns nil when this process may not post events — no Accessibility grant,
// or a terminal that has never been added to Input Monitoring — and every call
// site here optional-chained that nil away. The tool then exited 0 having
// touched nothing, so an investigation driven by it read "clicked, nothing
// happened" as a finding about the APP. Every construction is checked now and
// a failure exits 3, which is the only difference between a diagnostic
// instrument and a source of wrong conclusions.
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
//         drive-window double <x> <y>
//         drive-window scroll <x> <y> <ticks>   (negative ticks scroll down)
//
// # Why `double` exists, when two `click`s ought to have done it
//
// **A double-click is one event stream, not two clicks.** The click state rides
// on the event (`mouseEventClickState`), and `click` hardcodes 1 — so however
// fast they are posted, two invocations of it are two single clicks and WebKit
// selects nothing. Each invocation is also its own process, which puts the
// system's double-click interval between them with certainty.
//
// It is here because SELECTING A WORD is the reader's central gesture and this
// tool could not make one, so every question about the selection popup — the
// tools, the mark styles, the lookup face — could only be asked through the MCP
// bridge, which is the confound this file exists to remove. Three single clicks
// on a word produced no selection at all, which reads as a wrong coordinate.

import CoreGraphics
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write("drive-window: \(message)\n".data(using: .utf8)!)
    exit(2)
}

/// A refused event, told apart from a bad argument by its exit code.
///
/// ⚠️ **THIS IS THE FAILURE THE WHOLE FILE EXISTS TO NOT HAVE.** A tool that
/// cannot drive the app must say so; one that silently drives nothing and exits
/// 0 sends an investigation after the app instead of after the permission.
func refused(_ what: String) -> Never {
    FileHandle.standardError.write(
        """
        drive-window: the window server refused to create a \(what) event.
          This process may not post input events. Grant the terminal (or whatever
          launched this) Accessibility, and Input Monitoring, in System Settings ›
          Privacy & Security. Nothing was clicked or scrolled.

        """.data(using: .utf8)!)
    exit(3)
}

/// Build an event or exit. Never returns nil, which is the point.
func event(_ made: CGEvent?, _ what: String) -> CGEvent {
    guard let made else { refused(what) }
    return made
}

let args = CommandLine.arguments
guard args.count >= 4 else {
    fail("usage: drive-window click|double <x> <y> | drive-window scroll <x> <y> <ticks>")
}
guard let x = Double(args[2]), let y = Double(args[3]) else {
    fail("x and y must be numbers")
}

let point = CGPoint(x: x, y: y)
/* THE SOURCE IS CHECKED TOO. It is nil under the same conditions the events
 * are, and passing nil onward only moves the silent failure one line down. */
guard let source = CGEventSource(stateID: .hidSystemState) else {
    refused("event source")
}

/* MOVED FIRST, ALWAYS. A click posted at a point the cursor is not at still
 * lands there, but hover state does not update — so a control that only
 * appears on hover is not there to be clicked. */
event(
    CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left),
    "mouse-moved"
).post(tap: .cghidEventTap)
usleep(80_000)

/// One down/up pair at `point`, carrying `clickState`.
///
/// The state is what makes a click a click — see the header — and what makes the
/// second one of a pair a DOUBLE click rather than another single one.
func press(_ clickState: Int64) {
    for type in [CGEventType.leftMouseDown, CGEventType.leftMouseUp] {
        let click = event(
            CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left),
            "\(type == .leftMouseDown ? "mouse-down" : "mouse-up")"
        )
        /* See the header: without this WebKit does not forward the click. */
        click.setIntegerValueField(.mouseEventClickState, value: clickState)
        click.post(tap: .cghidEventTap)
        usleep(60_000)
    }
}

switch args[1] {
case "click":
    press(1)

case "double":
    /* ONE PROCESS, TWO STATES. The pair must arrive inside the system's
     * double-click interval, which is why this cannot be two `click` calls, and
     * the 40ms gap is well inside the shortest interval the mouse pane offers. */
    press(1)
    usleep(40_000)
    press(2)

case "scroll":
    guard args.count >= 5, let ticks = Int32(args[4]) else {
        fail("scroll needs a tick count; negative scrolls down")
    }
    /* EIGHT SMALL EVENTS rather than one large one. A single large delta is
     * treated as a fling by some scroll containers and lands somewhere the
     * caller did not ask for; a run of small ones lands predictably. */
    for _ in 0..<8 {
        event(
            CGEvent(
                scrollWheelEvent2Source: source,
                units: .pixel,
                wheelCount: 1,
                wheel1: ticks,
                wheel2: 0,
                wheel3: 0
            ),
            "scroll-wheel"
        ).post(tap: .cghidEventTap)
        usleep(40_000)
    }

default:
    fail("unknown action \(args[1]) — expected click, double or scroll")
}
