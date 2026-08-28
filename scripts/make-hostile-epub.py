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

Usage:  python3 scripts/make-hostile-epub.py [output-path] [--origin URL]
Default output: /tmp/paper-hostile.epub

`--origin` arms the script-free framing probe and must be ABSOLUTE. The book is
loaded from a `blob:` URL, whose opaque path no relative reference can resolve
against — see `static_frame`, which is where a `src="/"` that could never load
sat advertised as a test.
"""

from __future__ import annotations

import argparse
import zipfile
from html import escape
from pathlib import Path
from urllib.parse import urlparse

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
    <!-- THE FRAMING VECTOR NEEDS NO SCRIPT, so it is tested WITHOUT one:
         static markup, so a `frame-src` regression is visible on the normal
         path where CSP blocks the book's script entirely. A blob book
         inherits the client's policy; while `frame-src` admitted `'self'`
         this loaded the real client — module running, cookie on its socket —
         under this page. The harness inspects this frame's browsing context
         independently of any book JavaScript; the script below ALSO reports
         it, for a run where the script is (wrongly) allowed. -->
    __PAPER_STATIC_FRAME__
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
        // The EXISTENCE of `invoke` is the failure — a book must not reach the
        // native bridge at all. The call is fired only to show it goes
        // through, and its rejection is swallowed so a denied invoke does not
        // surface as an unhandled rejection that reads like a crash.
        if (!i) return false;
        try { Promise.resolve(i('plugin:fs|read_text_file', { path: '/etc/passwd' })).catch(function () {}); } catch (e) {}
        return true;
      });
      // parent.localStorage EXISTING is not a failure — the same-origin DOM
      // exposes it by construction; only a CREDENTIAL found in it is. Kept as
      // an INFORMATIONAL observation, apart from `reached`, so the verdict
      // does not cry wolf over a benign same-origin fact.
      var observed = [];
      (function () {
        try { if (parent.localStorage) observed.push('parent.localStorage reachable') } catch (e) {}
      })();
      var PROBE_TIMEOUT_MS = 3000;

      // The browser client's session credential, by every route a book has to
      // it. `paper_session` is the cookie's name — `SESSION_COOKIE` in
      // `paper-webhost`, and the only other place it is written down.
      probe('document.cookie', function () { return /paper_session/.test(document.cookie) });
      probe('parent.document.cookie', function () { return /paper_session/.test(parent.document.cookie) });
      // ⚠️ THE NAME IS NOT THE SECRET, and keying on it alone was a fixture
      // that only caught a regression careless enough to keep the name. A
      // credential "moved to storage just for now" gets called `session`,
      // `token`, `auth` — never `paper_session` — and this reported REACHED
      // NOTHING about every one of those. So the shape is checked too: any key
      // that reads like a credential is a hit, whatever it is called.
      //
      // It cries no wolf, and that is checked rather than hoped: every key the
      // client writes is `paper.*` or `sync:*` (settings, marks, cards, tags,
      // paint, positions, journal, presence), and not one of them matches.
      // Values are still matched on the cookie's exact name only — settings
      // JSON is prose and would false-positive on a word.
      var CREDENTIAL_KEY = /paper_session|session|token|auth|credential|secret|bearer|cookie/i;
      probe('credential in storage', function () {
        // Each store in its OWN try: one inaccessible store used to abort the
        // whole scan, so a later reachable store went unchecked — a false
        // negative. An unreadable store is noted, not fatal.
        var stores = [
          ['window.localStorage', function () { return window.localStorage }],
          ['window.sessionStorage', function () { return window.sessionStorage }],
          ['parent.localStorage', function () { return parent.localStorage }],
          ['parent.sessionStorage', function () { return parent.sessionStorage }],
        ];
        var hit = false;
        for (var s = 0; s < stores.length; s++) {
          try {
            var store = stores[s][1]();
            if (!store) continue;
            for (var i = 0; i < store.length; i++) {
              var key = store.key(i);
              if (CREDENTIAL_KEY.test(key) || /paper_session/.test(store.getItem(key) || '')) {
                // NAMED, because "credential in storage" alone sends the
                // reader hunting through four stores for which entry fired.
                hit = true;
                observed.push('credential-shaped: ' + stores[s][0] + '[' + key + ']');
              }
            }
          } catch (e) { observed.push(stores[s][0] + ' unreadable'); }
        }
        return hit;
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
        setTimeout(framedFinish, PROBE_TIMEOUT_MS);
      } catch (e) { settled() }

      try {
        // Bounded, and settled in every arm: a fetch left pending used to keep
        // `pending` above zero forever, so the final verdict never replaced
        // the preliminary one. Any 2xx is a hit — the endpoint's documented
        // authenticated answer is a 204; 401 is the safe expected refusal, and
        // anything else is reported as a probe ANOMALY rather than a breach.
        var fetchCtl = ('AbortController' in window) ? new AbortController() : null;
        if (fetchCtl) setTimeout(function () { try { fetchCtl.abort() } catch (e) {} }, PROBE_TIMEOUT_MS);
        fetch('/api/auth/session', { credentials: 'include', signal: fetchCtl && fetchCtl.signal })
          .then(function (r) {
            // ANY 2xx IS THE BREACH, not the 200 this looked for. The real
            // endpoint answers 204 — its extractor IS the authentication, so
            // reaching the handler at all means a live credential — and a
            // probe keyed on 200 filed the genuine hit under `observed` as a
            // harmless anomaly. A fixture that cannot report the thing it
            // exists to detect is worse than no fixture.
            if (r.status >= 200 && r.status < 300) reached.push('authenticated fetch (' + r.status + ')');
            else if (r.status !== 401) observed.push('auth fetch returned ' + r.status);
          })
          .catch(function () { /* blocked, aborted or refused counts as safe */ })
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
        setTimeout(function () { finish(false) }, PROBE_TIMEOUT_MS);
      } catch (e) { settled() }

      var el = document.getElementById('paper-isolation-verdict');
      // The verdict distinguishes a PENDING reading from a FINAL one, so a
      // harness that reads the paragraph early cannot mistake the preliminary
      // "reached nothing" for the settled result up to PROBE_TIMEOUT_MS later.
      // A `data-state` attribute carries it machine-readably; `observed` (the
      // benign facts) is separate from `reached` (the breaches).
      function render(final) {
        var state = final ? 'final' : 'pending';
        el.setAttribute('data-state', state);
        if (observed.length) el.setAttribute('data-observed', observed.join(', '));
        el.textContent = reached.length
          ? 'REACHED: ' + reached.join(', ')
          : (final ? 'SCRIPT RAN, REACHED NOTHING' : 'SCRIPT RAN, PROBES PENDING');
      }
      function show() { render(true); }
      // Say what is known now — marked PENDING — in case a probe never settles.
      render(false);
    ]]></script>
  </body>
</html>
"""


def static_frame(origin: str | None) -> str:
    """The script-free framing probe, or a stand-in that says it is off.

    ⚠️ ``src="/"`` IS WHAT THIS SHIPPED, AND IT CAN NEVER LOAD. Foliate hands
    the reader's XHTML to the iframe as a ``blob:`` URL, and a blob URL has an
    *opaque path*: the URL parser refuses every relative reference against one
    except a fragment (WHATWG URL, "no scheme state"). So ``/`` failed to
    parse, the iframe kept its initial ``about:blank``, and nothing was ever
    requested. The probe advertised in this file's own usage text as "tests the
    framing vector WITHOUT script" had been testing nothing.

    The script half never had the bug — it sets ``location.origin + '/'``,
    which is absolute — which is exactly why the static half could stay broken
    while every run still looked complete.

    So the client's origin has to be supplied. With none given, the frame is
    emitted WITHOUT a ``src`` and says so, in the document and in the printed
    guidance: a probe that is off and admits it is worth more than one that
    looks armed and is not.
    """
    if origin is None:
        return (
            '<iframe id="paper-static-frame" data-paper-origin="unset" aria-hidden="true"\n'
            '            style="width:1px;height:1px"></iframe>\n'
            "    <!-- No origin was given, so the script-free framing probe is OFF. A\n"
            "         relative `src` would be resolved against this document's `blob:`\n"
            "         URL, whose opaque path makes every one of them unresolvable, and\n"
            "         the frame would stay at about:blank having requested nothing.\n"
            "         (An XML comment may not contain two hyphens, so the argument that\n"
            "         arms this is spelled out in the script's usage rather than here.) -->"
        )
    src = f"{origin.rstrip('/')}/"
    quoted = escape(src, quote=True)
    return (
        f'<iframe id="paper-static-frame" src="{quoted}" data-paper-origin="{quoted}"\n'
        '            aria-hidden="true" style="width:1px;height:1px"></iframe>'
    )


def probe_document(origin: str | None) -> str:
    return PROBE.replace("__PAPER_STATIC_FRAME__", static_frame(origin))


def build(output: Path, origin: str | None = None) -> None:
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
        zf.writestr("OEBPS/probe.xhtml", probe_document(origin))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build the hostile EPUB fixture that probes Paper's renderer isolation."
    )
    parser.add_argument(
        "output",
        nargs="?",
        default="/tmp/paper-hostile.epub",
        type=Path,
        help="where to write the .epub (default: /tmp/paper-hostile.epub)",
    )
    parser.add_argument(
        "--origin",
        default=None,
        help=(
            "the client's origin, e.g. https://192.168.1.9:7433 or tauri://localhost. "
            "ABSOLUTE, because the book is loaded from a blob: URL and nothing "
            "relative can resolve against one. Without it the script-free framing "
            "probe is emitted disabled rather than emitted broken."
        ),
    )
    args = parser.parse_args()
    origin = args.origin
    if origin is not None:
        # Refused HERE rather than written into a fixture that would then be
        # silently inert — which is the whole defect this argument exists for.
        parsed = urlparse(origin)
        if not parsed.scheme or not (parsed.netloc or parsed.path):
            parser.error(f"--origin must be absolute, with a scheme; got {origin!r}")
    output = args.output
    build(output, origin)
    print(f"wrote {output}")
    print()
    print("Open it in Paper, then read the verdict paragraph (data-state=final):")
    print("  SCRIPT DID NOT RUN          -> the CSP blocked it. This is the pass.")
    print("  SCRIPT RAN, PROBES PENDING  -> a non-final reading; wait for data-state=final.")
    print("  SCRIPT RAN, REACHED NOTHING -> script ran but found no route out.")
    print("  REACHED: ...                -> it names what it got to. See below.")
    print()
    if origin is None:
        print("THE SCRIPT-FREE FRAMING PROBE IS OFF. Pass --origin <client url> to arm")
        print("it. It cannot be armed by default: the book is loaded from a blob: URL,")
        print("whose opaque path makes every relative reference — `/` included —")
        print("unresolvable, so a frame written without an absolute src requests")
        print("nothing and reports a pass it never earned.")
    else:
        print(f"The static <iframe src=\"{origin.rstrip('/')}/\"> tests the framing vector")
        print("WITHOUT script: inspect its browsing context directly — a loaded client")
        print("there is a `frame-src` regression even when SCRIPT DID NOT RUN. Check")
        print("`iframe.src` resolved to that origin before believing an empty frame.")
    print()
    print("data-observed lists BENIGN facts (parent.localStorage reachable, an")
    print("unreadable store) — not failures. Everything in a REACHED list is,")
    print("and these two most of all — a shared book reading the session")
    print("credential and speaking to the shelf as the reader:")
    print("  document.cookie / parent.document.cookie -> HttpOnly was dropped")
    print("  credential in storage                    -> it was moved to storage")
    print("WITH ONE EXCEPTION IN data-observed: an entry that begins")
    print("`credential-shaped:` is the DETAIL of that second failure — which")
    print("store and which key — not a benign fact. The key is matched on its")
    print("shape (session, token, auth, credential, secret, bearer, cookie) and")
    print("not on the cookie's exact name, because a credential moved to storage")
    print("`just for now` is never called `paper_session`. No key the client")
    print("writes matches: they are all `paper.*` or `sync:*`.")
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
