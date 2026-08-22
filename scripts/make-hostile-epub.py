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
      var el = document.getElementById('paper-isolation-verdict');
      el.textContent = reached.length
        ? 'REACHED: ' + reached.join(', ')
        : 'SCRIPT RAN, REACHED NOTHING';
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
    print("  REACHED: ...               -> FAIL, and it names what it got to.")


if __name__ == "__main__":
    main()
