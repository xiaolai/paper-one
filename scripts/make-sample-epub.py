#!/usr/bin/env python3
"""Build a small, valid EPUB 3 for development.

The reader needs a real book to verify against — the baseline grid, the TOC,
relocation and the ruler all behave differently on a genuine spine than on
markup pasted into the host document. Generating one keeps that fixture
offline, deterministic and out of git, rather than depending on a download
that may be slow or blocked.

The text is the opening of Moby-Dick (Melville, 1851), public domain.

Usage:  python3 scripts/make-sample-epub.py [output-path]
Default output: public/sample.epub
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path

CHAPTERS: list[tuple[str, str, list[str]]] = [
    (
        "chapter-1",
        "Loomings",
        [
            "Call me Ishmael. Some years ago—never mind how long precisely—having "
            "little or no money in my purse, and nothing particular to interest me "
            "on shore, I thought I would sail about a little and see the watery part "
            "of the world. It is a way I have of driving off the spleen and "
            "regulating the circulation.",
            "Whenever I find myself growing grim about the mouth; whenever it is a "
            "damp, drizzly November in my soul; whenever I find myself involuntarily "
            "pausing before coffin warehouses, and bringing up the rear of every "
            "funeral I meet; and especially whenever my hypos get such an upper hand "
            "of me, that it requires a strong moral principle to prevent me from "
            "deliberately stepping into the street, and methodically knocking "
            "people's hats off—then, I account it high time to get to sea as soon as "
            "I can.",
            "This is my substitute for pistol and ball. With a philosophical flourish "
            "Cato throws himself upon his sword; I quietly take to the ship. There is "
            "nothing surprising in this. If they but knew it, almost all men in their "
            "degree, some time or other, cherish very nearly the same feelings "
            "towards the ocean with me.",
            "There now is your insular city of the Manhattoes, belted round by "
            "wharves as Indian isles by coral reefs—commerce surrounds it with her "
            "surf. Right and left, the streets take you waterward. Its extreme "
            "downtown is the battery, where that noble mole is washed by waves, and "
            "cooled by breezes, which a few hours previous were out of sight of land.",
            "Look at the crowds of water-gazers there. Circumambulate the city of a "
            "dreamy Sabbath afternoon. Go from Corlears Hook to Coenties Slip, and "
            "from thence, by Whitehall, northward. What do you see?—Posted like "
            "silent sentinels all around the town, stand thousands upon thousands of "
            "mortal men fixed in ocean reveries.",
        ],
    ),
    (
        "chapter-2",
        "The Carpet-Bag",
        [
            "I stuffed a shirt or two into my old carpet-bag, tucked it under my arm, "
            "and started for Cape Horn and the Pacific. Quitting the good city of old "
            "Manhatto, I duly arrived in New Bedford. It was on a Saturday night in "
            "December.",
            "Much was I disappointed upon learning that the little packet for Nantucket "
            "had already sailed, and that no way of reaching that place would offer, "
            "till the following Monday.",
            "As most young candidates for the pains and penalties of whaling stop at "
            "this same New Bedford, thence to embark on their voyage, it may as well "
            "be related that I, for one, had no idea of so doing.",
        ],
    ),
    (
        "chapter-3",
        "The Spouter-Inn",
        [
            "Entering that gable-ended Spouter-Inn, you found yourself in a wide, low, "
            "straggling entry with old-fashioned wainscots, reminding one of the "
            "bulwarks of some condemned old craft.",
            "On one side hung a very large oil-painting so thoroughly besmoked, and "
            "every way defaced, that in the unequal cross-lights by which you viewed "
            "it, it was only by diligent study and a series of systematic visits to "
            "it, that you could any way arrive at an understanding of its purpose.",
        ],
    ),
]

CONTAINER_XML = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

# Deliberately minimal: the book brings almost no styling of its own, so what
# renders is the stylesheet Paper injects. A book that fought back would be a
# better stress test, but a worse baseline.
STYLE_CSS = """body { margin: 0; }
h1 { font-size: 1.6em; }
"""


def chapter_xhtml(title: str, paragraphs: list[str]) -> str:
    body = "\n    ".join(f"<p>{p}</p>" for p in paragraphs)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head>
    <title>{title}</title>
    <link rel="stylesheet" type="text/css" href="style.css"/>
  </head>
  <body>
    <section epub:type="chapter">
    <h1>{title}</h1>
    {body}
    </section>
  </body>
</html>
"""


def build(output: Path) -> None:
    manifest = "\n    ".join(
        f'<item id="{cid}" href="{cid}.xhtml" media-type="application/xhtml+xml"/>'
        for cid, _, _ in CHAPTERS
    )
    spine = "\n    ".join(f'<itemref idref="{cid}"/>' for cid, _, _ in CHAPTERS)
    nav_items = "\n      ".join(
        f'<li><a href="{cid}.xhtml">{title}</a></li>' for cid, title, _ in CHAPTERS
    )

    opf = f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:paper-sample-moby-dick</dc:identifier>
    <dc:title>Moby-Dick</dc:title>
    <dc:creator>Herman Melville</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="style" href="style.css" media-type="text/css"/>
    {manifest}
  </manifest>
  <spine>
    {spine}
  </spine>
</package>
"""

    nav = f"""<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Contents</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>Contents</h1>
      <ol>
      {nav_items}
      </ol>
    </nav>
  </body>
</html>
"""

    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w") as zf:
        # The mimetype entry must come first and be STORED, not deflated —
        # a compressed mimetype is the classic reason a reader rejects an EPUB.
        zf.writestr(
            zipfile.ZipInfo("mimetype"),
            "application/epub+zip",
            compress_type=zipfile.ZIP_STORED,
        )
        zf.writestr("META-INF/container.xml", CONTAINER_XML)
        zf.writestr("OEBPS/content.opf", opf)
        zf.writestr("OEBPS/nav.xhtml", nav)
        zf.writestr("OEBPS/style.css", STYLE_CSS)
        for cid, title, paragraphs in CHAPTERS:
            zf.writestr(f"OEBPS/{cid}.xhtml", chapter_xhtml(title, paragraphs))

    print(f"wrote {output} ({output.stat().st_size} bytes)")


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("public/sample.epub")
    build(target)
