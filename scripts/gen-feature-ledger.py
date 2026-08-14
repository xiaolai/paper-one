import html, pathlib

COMPARATORS = [("Rst","Readest"),("Fol","Foliate"),("Tho","Thorium"),("KOR","KOReader"),
                ("Cal","Calibre"),("ABk","Apple Books"),("Kdl","Kindle"),("Rdw","Readwise"),
                ("Zot","Zotero"),("Hgl","Highlights")]

TABLE_STAKES = [
 ("Reading position restored","o","••••••••••"),
 ("Reopenable library","o","••••••••••"),
 ("Bookmarks","o","••••••••••"),
 ("Multiple highlight colours","o","••••••••••"),
 ("Annotation export","o","•••••hh•••"),
 ("Dictionary lookup","o","••••••••oo"),
 ("Footnote popover","o","•••••••---"),
 ("Cross-device sync","o","•oo•h••••o"),
 ("Reading statistics","o","••o•h•••oo"),
 ("Translation","o","••o•o•••oo"),
]

CONTESTED = [
 ("Text to speech","•","••••••••oo"),
 ("Full-text search in book","•","••••••••••"),
 ("Library-wide search","o","hoo••h•••h"),
 ("OPDS / catalogs","o","•••••ooooo"),
 ("Collections / tags","o","•ho•••••••"),
 ("Auto-scroll","o","•oo•oooooo"),
 ("Parallel / split reading","o","•ooooooooo"),
 ("Per-book settings","o","••o••ooooo"),
 ("Spaced repetition","o","ooohooo•oo"),
 ("AI over the text","s","hoooooh•oo"),
 ("PDF and EPUB in one engine","•","••••hho••h"),
 ("Accessibility certification","o","oh•hh••hhh"),
]

DIFFERENTIATORS = [
 ("Reading ruler, keyboard line advance","•","oooooooooo"),
 ("Margin notes beside their own line","•","oooooooohh"),
 ("Per-size measure, enforced line grid","•","hhh•hooooo"),
 ("Cards typed apart from notes","•","ooooooohho"),
 ("Provenance mark for machine text","•","oooooooooo"),
 ("Spoken word followed on the page","•","hh•oh••ooo"),
]

INVENTORY = [
 ("Reading surface", [
  ("EPUB rendering","shipped","reader/FoliateView.tsx","Open ?book=/sample.epub; text renders"),
  ("PDF rendering","shipped","reader/makePdf.ts","A canvas paints with a text layer over it"),
  ("PDF as a first-class book","shipped","reader/makePdf.ts","Marks, search, ruler and read-aloud all work on a PDF"),
  ("MOBI / AZW3 / CBZ / FB2","partial","lib/formats.ts","Offered and handled by foliate-js; never exercised by a test or a manual pass"),
  ("Scrolled and paginated flow","shipped","Settings, Flow","Toggle; the renderer's flow attribute changes"),
  ("7 reading sizes, 17-30px","shipped","lib/metrics.ts","Each size carries its own measure, 540-820px"),
  ("5 themes + follow OS","shipped","Settings, Appearance","Paper, Slate, Sepia, Sage, Night"),
  ("Injected book typography","shipped","reader/bookCss.ts","Book paragraphs compute to Literata at the step's size and line box"),
  ("Justification, hyphenation","partial","reader/FoliateView.tsx","Both hardcoded on; no control exposes them"),
  ("Fixed-layout annotation","shipped","patches/foliate-js@1.0.1.patch","Highlights draw on a PDF page; upstream has no overlay layer there"),
  ("Reading position restore","absent","session.ts: lastLocation null","Reopening a book starts at the beginning, every time"),
  ("Bookmarks","absent","not built","No model, no UI"),
  ("Footnote popover","absent","bookCss.ts styles noteref only","A footnote link is styled and does nothing"),
  ("Image / figure zoom","absent","not built","Was modelled in state, removed as dead"),
  ("Auto-scroll","absent","not built",""),
  ("Parallel / split reading","absent","not built",""),
  ("Per-book settings","absent","not built","Settings are global"),
  ("RTL, vertical writing","unknown","inherited from foliate-js","Never tested; do not claim it"),
 ]),
 ("Annotation", [
  ("Highlights anchored by CFI","shipped","lib/marks.ts, reader/session.ts","Mark a passage; it survives a reload"),
  ("Notes on a highlight","shipped","pane/Notes.tsx","Saves on blur, on unmount and when the window hides"),
  ("Margin notes beside their line","shipped","reader/MarginMarks.tsx","Level with its first line, clipped to the visible page"),
  ("Selection tools","shipped","reader/SelectionTools.tsx","Mark / Note / Copy / Remove, clamped inside the stage"),
  ("Companion provenance mark","stub","lib/marks.ts","The kind and its amber treatment exist; nothing produces one"),
  ("Multiple highlight colours","absent","not built","One style, plus a rule in Night where a fill would glare"),
  ("Underline / strikethrough / ink","absent","not built",""),
  ("Annotation export","absent","not built","Marks and cards leave only through localStorage"),
  ("Annotation search","absent","not built","Search covers book text, not notes"),
 ]),
 ("Cards", [
  ("Five card kinds","shipped","lib/cards.ts","Idea, Claim, Recall, Synthesis, Excerpt"),
  ("Make a card from a mark","shipped","pane/Notes.tsx","The one place a note becomes a card"),
  ("Cards panel with filters","shipped","pane/Cards.tsx","Filter chips, empty states named"),
  ("Spaced repetition / review","absent","not built","Recall cards carry a question and answer; nothing reviews them"),
  ("Export","absent","not built",""),
 ]),
 ("Navigation and library", [
  ("Table of contents","shipped","pane/Contents.tsx","Nested; non-linking headings render disabled"),
  ("Full-text search in book","shipped","pane/SearchPanel.tsx","Streams hits, capped at 200, each navigable by CFI"),
  ("Book switcher","shipped","overlays/BookSwitcher.tsx","Command palette, Switch book"),
  ("Recent books","shipped","lib/library.ts","Content-derived identity, so a renamed file keeps its marks"),
  ("Reopening a dropped file","absent","library.ts records url null","The row says so honestly, which does not make it work"),
  ("Library-wide search","absent","not built","The panel says so rather than pretending"),
  ("Collections, tags, shelves","absent","not built",""),
  ("OPDS / Calibre catalogs","absent","not built",""),
 ]),
 ("Reading aids", [
  ("Reading ruler","shipped","reader/ReadingRuler.tsx","Space pins and advances exactly one measured line"),
  ("Read aloud","shipped","reader/speech.ts","The spoken word is followed on the page"),
  ("Voice, rate, pitch control","absent","not built","Whatever the platform picks"),
  ("Dictionary lookup","absent","not built",""),
  ("Translation","absent","not built",""),
  ("Reading statistics","stub","pane/SidePane.tsx","The panel states that nothing is measured yet"),
 ]),
 ("Companion", [
  ("Provider interface","stub","lib/companion.ts","ask, Citation, AskContext exist; nothing calls them"),
  ("Conversation view","absent","pane/Companion.tsx","Says so on screen"),
  ("Grounded answers with citations","absent","not built","Deliberate: the voice rules require a location per claim"),
 ]),
 ("Shell", [
  ("Command palette","shipped","overlays/CommandPalette.tsx","Combos print Command on macOS, Ctrl elsewhere"),
  ("Keyboard map","shipped","App.tsx","Works from inside the book iframe, which is where focus goes"),
  ("Side pane, 8 panels, either side","shipped","pane/SidePane.tsx","Rail membership is checked at compile time"),
  ("Chrome fade","shipped","shell/TitleBar.tsx","Fades in the reader, returns on pointer-near"),
  ("Platform titlebars","shipped","shell/TitleBar.tsx","macOS overlay; drawn controls on Windows and Linux"),
  ("Liquid Glass app icon","shipped","src-tauri/icons/Paper.icon/","macOS 26 layered icon"),
  ("Drop a book anywhere","shipped","lib/useFileDrop.ts","Including onto an open book, which would otherwise replace the app"),
 ]),
 ("Data", [
  ("Local persistence","shipped","lib/useStoredCollection.ts","A failed write is reported to the reader"),
  ("Content-derived book identity","partial","lib/marks.ts","SHA-256 over size plus first and last 64KB; identical ends would collide"),
  ("Sync","absent","not built",""),
  ("Data import / export","absent","not built","No way to get marks off this machine"),
 ]),
]

MARK = {"•":('full','&#9679;'), "h":('half','&#9680;'), "o":('none','&#9675;'),
        "-":('na','&#8211;'), "s":('stub','&#9678;')}

def norm(s):
    out = [c for c in s if c in "•ho-s"]
    if len(out) != 10:
        raise SystemExit(f"row has {len(out)} marks, expected 10: {s!r}")
    return out

def cells(paper, others):
    k, g = MARK[paper]
    out = [f'<td class="paper"><span class="m {k}" title="Paper">{g}</span></td>']
    for c in norm(others):
        k, g = MARK[c]
        out.append(f'<td><span class="m {k}">{g}</span></td>')
    return "".join(out)

def matrix(title, blurb, rows):
    head = "".join(f'<th><abbr title="{html.escape(n)}">{a}</abbr></th>' for a, n in COMPARATORS)
    body = "".join(f'<tr><th scope="row">{html.escape(t)}</th>{cells(p, o)}</tr>' for t, p, o in rows)
    return f"""<section class="block">
<h3>{html.escape(title)}</h3>
<p class="lede">{html.escape(blurb)}</p>
<div class="scroller"><table class="matrix">
<thead><tr><th scope="col" class="rowhead">Capability</th><th class="paper">Paper</th>{head}</tr></thead>
<tbody>{body}</tbody></table></div></section>"""

def inventory():
    out = []
    for group, rows in INVENTORY:
        body = "".join(
            f'<tr data-state="{s}"><th scope="row">{html.escape(n)}</th>'
            f'<td><span class="pill {s}">{s}</span></td>'
            f'<td><code>{html.escape(w)}</code></td>'
            f'<td class="how">{html.escape(h)}</td></tr>'
            for n, s, w, h in rows)
        out.append(f"""<section class="block">
<h3>{html.escape(group)}</h3>
<div class="scroller"><table class="inv">
<thead><tr><th scope="col">Capability</th><th scope="col">State</th><th scope="col">Where</th><th scope="col">How to confirm</th></tr></thead>
<tbody>{body}</tbody></table></div></section>""")
    return "".join(out)

counts = {}
for _, rows in INVENTORY:
    for _, s, _, _ in rows:
        counts[s] = counts.get(s, 0) + 1
total = sum(counts.values())

CSS = """
:root {
  color-scheme: light dark;
  --ink:#17191B; --ink-2:#4A4F53; --muted:#6E7479;
  --surface:#FFFFFF; --wash:#F4F5F3; --line:#E2E5E0;
  --accent:#1B3A6B; --amber:#9E5A16;
  --full:#2F6B4F; --half:#9E5A16; --none:#B04A3A; --na:#9AA0A5;
  --measure:34rem;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ink:#E9EAE8; --ink-2:#B9BEC2; --muted:#8A9096;
    --surface:#16191C; --wash:#1E2226; --line:#2C3237;
    --accent:#8FB4E8; --amber:#D9A25E;
    --full:#7FC0A0; --half:#D9A25E; --none:#E08878; --na:#6A7176;
  }
}
* { box-sizing:border-box; }
html { -webkit-text-size-adjust:100%; }
body {
  margin:0; padding:0 1.25rem 6rem;
  background:var(--surface); color:var(--ink);
  font-family:'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif;
  font-size:17px; line-height:1.6; -webkit-font-smoothing:antialiased;
}
.wrap { max-width:68rem; margin:0 auto; }
header { padding:4rem 0 2rem; border-bottom:1px solid var(--line); margin-bottom:2.5rem; }
h1 { font-size:clamp(2rem,5vw,3rem); line-height:1.1; margin:0 0 .75rem; letter-spacing:-.02em; }
h2 { font-size:1.6rem; margin:3.5rem 0 .5rem; letter-spacing:-.01em; }
h3 { font-size:1.1rem; margin:2.25rem 0 .5rem; }
p { max-width:var(--measure); }
.sub { color:var(--muted); font-size:1.05rem; max-width:var(--measure); margin:0; }
.lede { color:var(--ink-2); margin:0 0 1rem; }
.tally { display:flex; flex-wrap:wrap; gap:.5rem; margin:1.75rem 0 0; padding:0; list-style:none; }
.tally li { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.8rem;
  border:1px solid var(--line); border-radius:999px; padding:.3rem .8rem; color:var(--ink-2); }
.tally b { color:var(--ink); }
.scroller { overflow-x:auto; margin:0 -1.25rem; padding:0 1.25rem; }
table { border-collapse:collapse; width:100%; font-size:.88rem; }
th, td { text-align:left; padding:.5rem .6rem; border-bottom:1px solid var(--line); vertical-align:top; }
thead th { position:sticky; top:0; background:var(--surface); z-index:2;
  font-size:.75rem; text-transform:uppercase; letter-spacing:.06em; color:var(--muted);
  font-weight:600; white-space:nowrap; }
tbody th { font-weight:400; min-width:15rem; }
.matrix td { text-align:center; width:3.2rem; }
.matrix .paper { background:var(--wash); }
.matrix thead .paper { color:var(--ink); }
.m { font-size:1.05rem; line-height:1; }
.m.full { color:var(--full); }
.m.half { color:var(--half); }
.m.none { color:var(--none); }
.m.na, .m.stub { color:var(--na); }
abbr { text-decoration:none; border-bottom:1px dotted var(--muted); cursor:help; }
code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.8rem; color:var(--muted); }
.how { color:var(--ink-2); min-width:18rem; }
.pill { display:inline-block; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:.68rem; text-transform:uppercase; letter-spacing:.05em;
  padding:.15rem .5rem; border-radius:999px; border:1px solid currentColor; white-space:nowrap; }
.pill.shipped { color:var(--full); }
.pill.partial { color:var(--half); }
.pill.stub { color:var(--amber); }
.pill.absent { color:var(--none); }
.pill.unknown { color:var(--na); }
.filters { display:flex; flex-wrap:wrap; gap:.4rem; margin:1.25rem 0 0; }
.filters button { font:inherit; font-size:.8rem; cursor:pointer; background:var(--surface);
  color:var(--ink-2); border:1px solid var(--line); border-radius:999px; padding:.3rem .85rem; }
.filters button[aria-pressed="true"] { background:var(--ink); color:var(--surface); border-color:var(--ink); }
.filters button:focus-visible { outline:3px solid var(--accent); outline-offset:2px; }
.legend { display:flex; flex-wrap:wrap; gap:1.25rem; margin:1rem 0 0; padding:0; list-style:none;
  font-size:.82rem; color:var(--muted); }
.finding { border-left:3px solid var(--amber); padding:.1rem 0 .1rem 1.1rem; margin:1.5rem 0; }
.finding h4 { margin:0 0 .35rem; font-size:1rem; }
.finding p { margin:0; color:var(--ink-2); }
footer { margin-top:4rem; padding-top:1.5rem; border-top:1px solid var(--line);
  color:var(--muted); font-size:.85rem; }
@media print { .filters { display:none; } body { font-size:11pt; } }
"""

JS = """
(function () {
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.filters button'));
  var rows = Array.prototype.slice.call(document.querySelectorAll('.inv tbody tr'));
  buttons.forEach(function (b) {
    b.addEventListener('click', function () {
      var f = b.dataset.f;
      buttons.forEach(function (o) { o.setAttribute('aria-pressed', String(o === b)); });
      rows.forEach(function (r) { r.hidden = f !== 'all' && r.dataset.state !== f; });
      Array.prototype.forEach.call(document.querySelectorAll('.inv'), function (t) {
        var any = Array.prototype.slice.call(t.querySelectorAll('tbody tr'))
          .some(function (r) { return !r.hidden; });
        t.closest('.block').hidden = !any;
      });
    });
  });
})();
"""

doc = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Paper &mdash; feature ledger</title>
<style>{CSS}</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>Paper &mdash; feature ledger</h1>
  <p class="sub">What is built, what is a stub, and where Paper stands against ten other readers. A stub is not a feature: where this says stub, the app should not be described as having the thing.</p>
  <ul class="tally">
    <li><b>{counts.get('shipped',0)}</b> shipped</li>
    <li><b>{counts.get('partial',0)}</b> partial</li>
    <li><b>{counts.get('stub',0)}</b> stub</li>
    <li><b>{counts.get('absent',0)}</b> absent</li>
    <li><b>{counts.get('unknown',0)}</b> unverified</li>
    <li>{total} tracked</li>
  </ul>
</header>

<h2>1 &mdash; What Paper has</h2>
<p class="lede">Walk this with the app open. Every row says where it lives and how to confirm it.</p>
<div class="filters" role="group" aria-label="Filter by state">
  <button type="button" data-f="all" aria-pressed="true">All</button>
  <button type="button" data-f="shipped" aria-pressed="false">Shipped</button>
  <button type="button" data-f="partial" aria-pressed="false">Partial</button>
  <button type="button" data-f="stub" aria-pressed="false">Stub</button>
  <button type="button" data-f="absent" aria-pressed="false">Absent</button>
</div>
{inventory()}

<h2>2 &mdash; The gap matrix</h2>
<ul class="legend">
  <li><span class="m full">&#9679;</span> has it</li>
  <li><span class="m half">&#9680;</span> partial</li>
  <li><span class="m none">&#9675;</span> lacks it</li>
  <li><span class="m na">&#9678;</span> stub</li>
  <li><span class="m na">&#8211;</span> not applicable</li>
</ul>
{matrix("Table stakes Paper is missing", "Everything here is a gap against almost every comparator, sorted by how universal it is.", TABLE_STAKES)}
{matrix("Contested", "Real features, but not universal. Absence here can be a position rather than a gap.", CONTESTED)}
{matrix("What Paper has that most do not", "The rows worth protecting.", DIFFERENTIATORS)}

<h2>3 &mdash; Reading the matrix</h2>
<div class="finding"><h4>One gap dominates the rest</h4><p>Paper does not remember where you were. Every comparator does, without exception, and it is not a feature readers notice &mdash; it is one they notice the absence of, immediately, on the second launch.</p></div>
<div class="finding"><h4>A library that cannot reopen its books</h4><p>A dropped file records no path, because a browser <code>File</code> is a handle granted for one session. Paper is a Tauri app and could ask for a real path; it does not. The shelf fills with rows that honestly say they will not open.</p></div>
<div class="finding"><h4>Nothing gets out</h4><p>No export of marks, notes or cards in any format. Foliate writes plain JSON; KOReader exports to Markdown, Joplin and Readwise; Zotero and Highlights are largely defined by it.</p></div>
<div class="finding"><h4>These three are one idea</h4><p>Position, reopening and export are the same missing assumption: Paper treats a session as the unit, and readers treat the book &mdash; and their accumulated marginalia &mdash; as the unit.</p></div>
<div class="finding"><h4>What is genuinely Paper's</h4><p>The ruler with a keyboard line advance, margin notes beside the line they annotate rather than in a list, and a grid where every size carries its own measure. None of the ten do all three.</p></div>
<div class="finding"><h4>The companion is a stub</h4><p>The provenance mark for machine-written text is original and it is the part that is built. What is not built is anything that produces one.</p></div>

<footer>
  <p>Paper's column was read from the repository and the shipped rows were driven in the running app. Readest, Foliate, Thorium, KOReader, Readwise, Zotero and Highlights were checked against current sources in August 2026. <strong>Apple Books, Kindle and the Calibre viewer are from general knowledge and were not re-verified</strong> &mdash; treat those three columns as the softest here.</p>
  <p>Source of truth: <code>docs/feature-ledger.md</code>. This page is generated from the same table by <code>scripts/gen-feature-ledger.py</code>.</p>
</footer>
</div>
<script>{JS}</script>
</body>
</html>"""

out = pathlib.Path('dev-docs/artifacts/feature-ledger.html')
out.write_text(doc)
print("written:", out, f"{len(doc)/1024:.1f} KB")
print("counts:", counts, "total:", total)
