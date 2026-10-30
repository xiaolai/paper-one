#!/usr/bin/env swift
//
// Post REAL input events, for the gesture rows of the selection checklist.
//
// Why this exists. The Tauri MCP bridge (`webview_interact`) dispatches DOM
// events with `isTrusted: false`. WebKit ignores those for selection: no native
// selection is created and no `selectionchange` fires, so nothing driven
// through the bridge can exercise a gesture. `CGEvent` posts at the HID layer
// instead, which arrives as genuine input — which is what lets a drag, a
// double-click or a page-edge selection be tested at all.
//
// Requires Accessibility permission for whichever process runs this (System
// Settings → Privacy & Security → Accessibility). It refuses to run without it
// rather than posting events that silently go nowhere.
//
// DO NOT TOUCH THE MOUSE OR TRACKPAD WHILE THESE RUN. They drive the real
// system cursor, so physical input interleaves with the posted events and ends
// a drag early — which looks exactly like the app failing to snap. `drag`
// checks where the cursor actually landed and calls such a run VOID rather than
// letting it be read as a failure, but the machine still needs to be left alone.
//
// TWO TRAPS, both of which produced a false pass before they were understood.
//
//   1. The webview's own `screenX` / `screenY` LIE under WKWebView. They
//      reported (0, 1440) for a window actually at (3120, 285). Never map
//      coordinates with them. Ask the OS — `window <pid>` below — or pass
//      `--pid` and let this script do it.
//
//      If `window` reports no accessible window while the app is plainly on
//      screen, the Accessibility grant has gone stale for the scripting path
//      (`osascript` starts failing with -25211 too). Re-granting it in System
//      Settings fixes it; until then, take the origin from the MCP bridge —
//      `manage_window {action: "info"}` returns PHYSICAL pixels, so halve them
//      on a 2x display — and pass global coordinates without `--pid`.
//
//   2. A paginated book lays its section out in columns WIDER than the window
//      and translates to show one at a time, so an element rect from inside the
//      iframe can be far outside the visible window. Dragging to such a point
//      lands on another application: the selection comes back empty, the event
//      log is empty, and a naive test reads that as "no page turn — pass". The
//      `--pid` mode refuses to post outside the window for exactly this reason.
//
// Coordinates are GLOBAL DISPLAY points, origin top-left — the space
// `CGEvent(source:)` reports in, continuous across multiple displays. With
// `--pid <n>` they are instead WINDOW-RELATIVE points (i.e. webview
// coordinates, since Paper's webview fills its window), converted here and
// bounds-checked.
//
// Usage:
//   trusted-input.swift window <pid>                        -> "x y w h"
//   trusted-input.swift pos
//   trusted-input.swift [--pid N] drag  <x1> <y1> <x2> <y2> [steps] [msPerStep]
//   trusted-input.swift [--pid N] click <x> <y> [count]      // 2 = double, 3 = triple
//   trusted-input.swift [--pid N] rclick <x> <y>
//   trusted-input.swift [--pid N] shiftclick <x> <y>
//   trusted-input.swift [--pid N] down|moveto|up <x> <y>     // a drag, held open
//   trusted-input.swift key <keycode> [shift|cmd|opt|ctrl ...]
//
// Handy key codes: Return 36, Escape 53, ArrowRight 124, ArrowLeft 123,
// k 40, a 0, e 14, g 5, p 35, s 1.
//
// NOTE: arrow keys do NOT extend a selection in Paper — `App.tsx` binds them to
// page turns and calls `preventDefault()`, with no `shiftKey` check. Keyboard
// selection is therefore not reachable in the reading view.

import CoreGraphics
import ApplicationServices
import Foundation

func die(_ msg: String) -> Never {
    FileHandle.standardError.write(("trusted-input: " + msg + "\n").data(using: .utf8)!)
    exit(2)
}

guard AXIsProcessTrusted() else {
    die("not trusted for accessibility — grant the running terminal Accessibility permission, or these events go nowhere silently")
}

var args = Array(CommandLine.arguments.dropFirst())

/// The frontmost window of `pid`, in global display points.
///
/// Asked of the accessibility API rather than of the webview, because the
/// webview's `screenX`/`screenY` are wrong — see the header.
func windowFrame(pid: pid_t) -> CGRect {
    let app = AXUIElementCreateApplication(pid)
    var windowsRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsRef) == .success,
          let windows = windowsRef as? [AXUIElement], let win = windows.first
    else { die("no accessible window for pid \(pid) — is the app running and not hidden?") }

    var posRef: CFTypeRef?
    var sizeRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(win, kAXPositionAttribute as CFString, &posRef) == .success,
          AXUIElementCopyAttributeValue(win, kAXSizeAttribute as CFString, &sizeRef) == .success
    else { die("could not read window position/size for pid \(pid)") }

    var origin = CGPoint.zero
    var size = CGSize.zero
    AXValueGetValue(posRef as! AXValue, .cgPoint, &origin)
    AXValueGetValue(sizeRef as! AXValue, .cgSize, &size)
    return CGRect(origin: origin, size: size)
}

// --pid puts every coordinate in window-relative space.
var frame: CGRect?
if let i = args.firstIndex(of: "--pid") {
    guard i + 1 < args.count, let pid = Int32(args[i + 1]) else { die("--pid needs a process id") }
    frame = windowFrame(pid: pid)
    args.removeSubrange(i...(i + 1))
}

guard let cmd = args.first else { die("no command") }

func num(_ i: Int) -> Double {
    guard i < args.count, let v = Double(args[i]) else { die("missing or bad numeric argument \(i)") }
    return v
}

/// Convert and bounds-check. A point outside the window is refused rather than
/// posted: it would land on another application, and the resulting empty
/// selection reads exactly like a passing test.
func point(_ xi: Int, _ yi: Int) -> CGPoint {
    let raw = CGPoint(x: num(xi), y: num(yi))
    guard let f = frame else { return raw }
    let p = CGPoint(x: f.origin.x + raw.x, y: f.origin.y + raw.y)
    guard raw.x >= 0, raw.y >= 0, raw.x <= f.width, raw.y <= f.height else {
        die("point (\(Int(raw.x)), \(Int(raw.y))) is outside the window (\(Int(f.width))x\(Int(f.height))) — refusing to post; it would land on another app and look like a pass")
    }
    return p
}

/// A short sleep between posted events.
///
/// Real input arrives spread over time, and WebKit's selection machinery is
/// driven by it: a mouse-down and mouse-up posted in the same millisecond can
/// be coalesced into something that never produces a drag at all.
func settle(_ ms: Double) { usleep(useconds_t(ms * 1000)) }

func post(_ e: CGEvent?) {
    guard let e else { die("failed to build a CGEvent") }
    e.post(tap: .cghidEventTap)
}

func mouse(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton = .left, clicks: Int64 = 1) {
    let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: button)
    if clicks > 1 { e?.setIntegerValueField(.mouseEventClickState, value: clicks) }
    post(e)
}

switch cmd {

case "window":
    guard args.count > 1, let pid = Int32(args[1]) else { die("window needs a pid") }
    let f = windowFrame(pid: pid)
    print("\(Int(f.origin.x)) \(Int(f.origin.y)) \(Int(f.width)) \(Int(f.height))")

case "pos":
    let p = CGEvent(source: nil)?.location ?? .zero
    print("\(Int(p.x)) \(Int(p.y))")

case "drag":
    let from = point(1, 2), to = point(3, 4)
    let steps = args.count > 5 ? Int(num(5)) : 24
    let per = args.count > 6 ? num(6) : 12
    // Move first, settle, THEN press. Pressing at a position the cursor has not
    // arrived at yet is how a drag becomes a click somewhere else.
    mouse(.mouseMoved, from); settle(60)
    mouse(.leftMouseDown, from); settle(per)
    for i in 1...max(steps, 1) {
        let t = Double(i) / Double(max(steps, 1))
        mouse(.leftMouseDragged, CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t))
        settle(per)
    }
    mouse(.leftMouseUp, to)
    /* Did a hand touch the mouse while this ran?
     *
     * These are posted to the real system cursor, so physical input interleaves
     * with them: the drag ends early and the selection comes back short. That is
     * indistinguishable, after the fact, from the app failing to snap — one such
     * run was nearly recorded as a bug before the far likelier explanation was
     * pointed out. The cursor must be exactly where the mouse-up put it, so any
     * drift means something else moved it and the run is void, not failing. */
    settle(40)
    if let landed = CGEvent(source: nil)?.location {
        let drift = max(abs(landed.x - to.x), abs(landed.y - to.y))
        if drift > 2 {
            die("cursor drifted \(Int(drift))pt during the drag (ended at \(Int(landed.x)),\(Int(landed.y)), expected \(Int(to.x)),\(Int(to.y))) — something else moved the pointer; this run is VOID, not a failure. Do not touch the mouse or trackpad while these run.")
        }
    }
    print("dragged \(Int(from.x)),\(Int(from.y)) -> \(Int(to.x)),\(Int(to.y))")

case "click":
    let p = point(1, 2)
    let count = args.count > 3 ? Int64(num(3)) : 1
    mouse(.mouseMoved, p); settle(60)
    // Each click of a multi-click carries a rising clickState; three independent
    // single clicks are three clicks, not a triple-click.
    //
    // Leave >1s between a click and a following drag, or WebKit chains them and
    // the drag extends the earlier selection instead of starting a new one —
    // that turned a 7-character sub-selection into 600 characters once.
    for c in 1...max(count, 1) {
        mouse(.leftMouseDown, p, clicks: c); settle(18)
        mouse(.leftMouseUp, p, clicks: c); settle(28)
    }
    print("clicked \(Int(p.x)),\(Int(p.y)) x\(count)")

case "rclick":
    let p = point(1, 2)
    mouse(.mouseMoved, p); settle(60)
    mouse(.rightMouseDown, p, .right); settle(24)
    mouse(.rightMouseUp, p, .right)
    print("right-clicked \(Int(p.x)),\(Int(p.y))")

case "shiftclick":
    let p = point(1, 2)
    mouse(.mouseMoved, p); settle(60)
    for type in [CGEventType.leftMouseDown, .leftMouseUp] {
        let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left)
        e?.flags = .maskShift
        post(e); settle(24)
    }
    print("shift-clicked \(Int(p.x)),\(Int(p.y))")

case "down":
    let p = point(1, 2)
    mouse(.mouseMoved, p); settle(60)
    mouse(.leftMouseDown, p)
    print("down \(Int(p.x)),\(Int(p.y))")

case "moveto":
    // Held-button move, so a drag can be inspected mid-gesture — which is how
    // "release outside the window" is tested without losing the button state.
    let p = point(1, 2)
    let steps = args.count > 3 ? Int(num(3)) : 12
    let cur = CGEvent(source: nil)?.location ?? p
    for i in 1...max(steps, 1) {
        let t = Double(i) / Double(max(steps, 1))
        mouse(.leftMouseDragged, CGPoint(x: cur.x + (p.x - cur.x) * t, y: cur.y + (p.y - cur.y) * t))
        settle(16)
    }
    print("moved to \(Int(p.x)),\(Int(p.y))")

case "up":
    let p = point(1, 2)
    mouse(.leftMouseUp, p)
    print("up \(Int(p.x)),\(Int(p.y))")

case "key":
    let code = CGKeyCode(num(1))
    var flags: CGEventFlags = []
    for m in args.dropFirst(2) {
        switch m {
        case "shift": flags.insert(.maskShift)
        case "cmd":   flags.insert(.maskCommand)
        case "opt":   flags.insert(.maskAlternate)
        case "ctrl":  flags.insert(.maskControl)
        default: die("unknown modifier \(m)")
        }
    }
    for isDown in [true, false] {
        let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: isDown)
        e?.flags = flags
        post(e); settle(18)
    }
    print("key \(Int(num(1))) \(args.dropFirst(2).joined(separator: "+"))")

default:
    die("unknown command \(cmd)")
}
