#!/usr/bin/env python3
"""Build an EPUB that tries to reach Paper's native layer, so that it can't.

An EPUB is a zip of HTML, and foliate renders it in an iframe carrying
`allow-same-origin allow-scripts`. That combination puts book JavaScript in the
application's own origin, where anything the application exposes to itself is
exposed to the book. Paper is heading towards filesystem access, signing keys,
device pairing and paid model calls — every one of which a shared book would be
able to invoke.

This book is the adversary. It probes for each route out and writes what it
found into its own DOM, where the host can read the verdict back.

Two targets, not one. On the DESKTOP the routes out are Tauri's — the global
object, the internals channel, `invoke`. In the BROWSER client there is no
Tauri at all, and the thing worth stealing is the session credential; the
probes for it are marked below. Running this book against only one of the two
tests only one of them.

It is NOT a passing test on its own. It is the fixture; the assertion is
`src/kernel/core/rendererIsolation.test.ts` for the static half, and reading
`#paper-isolation-verdict` out of the running app for the live half.

Deliberately not written into `public/`. Everything there is bundled into the
shipped application, and a book whose whole purpose is to attack the reader
should not be inside the reader.

Usage:  python3 scripts/make-hostile-epub.py [output-path]
Default output: /tmp/paper-hostile.epub
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path

CONTAINER_XML = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

OPF = """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:00000000-0000-4000-8000-paperhostile</dc:identifier>
    <dc:title>A book that would rather be a program</dc:title>
    <dc:creator>Renderer isolation fixture</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-08-16T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="probe" href="probe.xhtml" media-type="application/xhtml+xml"
          properties="scripted"/>
  </manifest>
  <spine>
    <itemref idref="probe"/>
  </spine>
</package>
"""

NAV = """<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Contents</title></head>
  <body>
    <nav epub:type="toc"><ol><li><a href="probe.xhtml">The probe</a></li></ol></nav>
  </body>
</html>
"""

# Every route out of the book that is worth refusing.
#
# `__TAURI__` is the convenience object `withGlobalTauri` attaches.
# `__TAURI_INTERNALS__` is the channel underneath it, which that flag does NOT
# remove — which is exactly why the CSP rather than the flag is the fix.
# `parent` is checked separately from `window` because the book is a frame.
#
# THE CREDENTIAL PROBES ARE FOR THE BROWSER BUILD (phase 18). There is no
# `__TAURI__` on a phone, so every probe above answers "reached nothing" there
# — and a fixture that only asks questions the target cannot fail is a fixture
# that proves nothing about it. What a browser HAS that the desktop does not is
# a session credential, and the whole reason it is an `HttpOnly` cookie rather
# than a `localStorage` entry is that a book's script shares this origin and
# could otherwise simply read it.
#
# `document.cookie` omits `HttpOnly` cookies by definition, so these probes
# pass by construction — which is the point. They are what makes a REGRESSION
# visible: the day somebody drops `HttpOnly` to debug something, or moves the
# credential into storage "just for now", this book says so out loud instead of
# the change going unnoticed.
PROBE = """<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>The probe</title>
  </head>
  <body>
    <h1>Renderer isolation</h1>
    <p>If the script in this book ran, the paragraph below says so.</p>
    <p id="paper-isolation-verdict">SCRIPT DID NOT RUN</p>
    <script><![CDATA[
      var reached = [];
      function probe(name, fn) {
        try { if (fn()) reached.push(name) } catch (e) { /* refused counts as safe */ }
      }
      probe('window.__TAURI__', function () { return !!window.__TAURI__ });
      probe('parent.__TAURI__', function () { return !!parent.__TAURI__ });
      probe('window.__TAURI_INTERNALS__', function () { return !!window.__TAURI_INTERNALS__ });
      probe('parent.__TAURI_INTERNALS__', function () { return !!parent.__TAURI_INTERNALS__ });
      probe('invoke', function () {
        var i = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
             || (parent.__TAURI__ && parent.__TAURI__.core && parent.__TAURI__.core.invoke);
        if (!i) return false;
        i('plugin:fs|read_text_file', { path: '/etc/passwd' });
        return true;
      });
      probe('parent.localStorage', function () { return !!parent.localStorage.length });

      // The browser client's session credential, by every route a book has to
      // it. `paper_session` is the cookie's name — `SESSION_COOKIE` in
      // `paper-webhost`, and the only other place it is written down.
      probe('document.cookie', function () { return /paper_session/.test(document.cookie) });
      probe('parent.document.cookie', function () { return /paper_session/.test(parent.document.cookie) });
      probe('credential in storage', function () {
        var stores = [window.localStorage, window.sessionStorage, parent.localStorage, parent.sessionStorage];
        for (var s = 0; s < stores.length; s++) {
          var store = stores[s];
          if (!store) continue;
          for (var i = 0; i < store.length; i++) {
            var key = store.key(i);
            if (/paper_session/.test(key) || /paper_session/.test(store.getItem(key) || '')) return true;
          }
        }
        return false;
      });

      // ⚠️ READING THE CREDENTIAL WAS NEVER THE ONLY ROUTE, and for a while it
      // was the only one probed. `HttpOnly` stops a script SEEING the cookie
      // and does nothing to stop the browser ATTACHING it: a book that can run
      // can `fetch` an authenticated endpoint, or open the frame socket, and be
      // answered as the reader without ever learning the value. A fixture that
      // only tried to read it would have reported "REACHED NOTHING" about a
      // book with the whole read surface in its hands.
      //
      // Asynchronous, so the verdict is written once these settle. Nothing
      // destructive is attempted — the point is whether the shelf ANSWERS.
      var pending = 3;
      function settled() { if (--pending <= 0) show(); }
      // THE ROUTE THAT NEEDS NO SCRIPT. A blob document inherits the client's
      // policy; while `frame-src` admitted `'self'`, this frame loaded the real
      // client — module running, cookie on its socket — under this page. The
      // location is read rather than trusting `load`, which fires for the
      // initial about:blank whether or not anything was allowed in.
      try {
        var framed = document.createElement('iframe');
        var framedDone = false;
        var framedFinish = function () {
          if (framedDone) return;
          framedDone = true;
          var loaded = false;
          try { loaded = !!framed.contentWindow && framed.contentWindow.location.href !== 'about:blank' }
          catch (e) { loaded = true }
          if (loaded) reached.push('framed the client');
          settled();
        };
        framed.onload = framedFinish;
        framed.setAttribute('aria-hidden', 'true');
        framed.style.width = '1px'; framed.style.height = '1px';
        framed.src = location.origin + '/';
        document.body.appendChild(framed);
        setTimeout(framedFinish, 3000);
      } catch (e) { settled() }

      try {
        fetch('/api/auth/session', { credentials: 'include' })
          .then(function (r) { if (r.status !== 401) reached.push('authenticated fetch (' + r.status + ')'); })
          .catch(function () { /* blocked or refused counts as safe */ })
          .then(settled, settled);
      } catch (e) { settled() }

      try {
        var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
        var sock = new WebSocket(proto + location.host + '/ws');
        var done = false;
        var finish = function (ok) {
          if (done) return;
          done = true;
          if (ok) reached.push('authenticated websocket');
          try { sock.close() } catch (e) {}
          settled();
        };
        sock.onopen = function () { finish(true) };
        sock.onerror = function () { finish(false) };
        sock.onclose = function () { finish(false) };
        setTimeout(function () { finish(false) }, 3000);
      } catch (e) { settled() }

      var el = document.getElementById('paper-isolation-verdict');
      function show() {
        el.textContent = reached.length
          ? 'REACHED: ' + reached.join(', ')
          : 'SCRIPT RAN, REACHED NOTHING';
      }
      // Say what is known now, in case neither asynchronous probe ever settles.
      show();
    ]]></script>
  </body>
</html>
"""


def build(output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w") as zf:
        # STORED and first, or a reader is entitled to reject the whole file.
        zf.writestr(
            zipfile.ZipInfo("mimetype"),
            "application/epub+zip",
            compress_type=zipfile.ZIP_STORED,
        )
        zf.writestr("META-INF/container.xml", CONTAINER_XML)
        zf.writestr("OEBPS/content.opf", OPF)
        zf.writestr("OEBPS/nav.xhtml", NAV)
        zf.writestr("OEBPS/probe.xhtml", PROBE)


def main() -> None:
    output = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/paper-hostile.epub")
    build(output)
    print(f"wrote {output}")
    print()
    print("Open it in Paper, then read the verdict:")
    print("  SCRIPT DID NOT RUN         -> the CSP blocked it. This is the pass.")
    print("  SCRIPT RAN, REACHED NOTHING-> script ran but found no route out.")
    print("  REACHED: ...               -> it names what it got to. See below.")
    print()
    print("ONE ENTRY IS NOT A FAILURE, and reading it as one would send you")
    print("hunting a hole that is not there. `parent.localStorage` fires when the")
    print("parent has ANY entry at all, and in the browser client it always will:")
    print("UI preferences live there by design. It reports that the book can SEE")
    print("the parent's storage, which is true and is why the credential is not")
    print("kept in it.")
    print()
    print("Everything else in a REACHED list is a failure, and these two most of")
    print("all — they mean a shared book can read the session credential and")
    print("speak to the shelf as the reader:")
    print("  document.cookie / parent.document.cookie -> HttpOnly was dropped")
    print("  credential in storage                    -> it was moved to storage")


if __name__ == "__main__":
    main()
