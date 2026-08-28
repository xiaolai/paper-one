#!/usr/bin/env python3
"""Render the companion HTML view of dev-docs/feature-ledger.md.

This script holds NO feature data. It parses the Markdown and renders it, which
is the only arrangement under which the page's own footer — "generated from the
same table" — is true.

It did not start that way. The first version carried its own copy of all 61
inventory rows and all three matrices, and the claim was made anyway. An audit
reconciled the two and found 44 records already differing: two capability
names, 27 "Where" fields and 21 "How to confirm" fields. Nothing had failed,
because nothing compared them. A duplicated table does not stay a copy; it
becomes a second opinion.
"""

import html
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'dev-docs' / 'feature-ledger.md'
OUTPUT = ROOT / 'dev-docs' / 'artifacts' / 'feature-ledger.html'

# The states the ledger defines. A row carrying anything else is a typo that
# would otherwise render unstyled, escape the filters, and be tallied under a
# heading nobody reads — so it fails the build instead.
STATES = ('shipped', 'partial', 'stub', 'absent', 'unknown')

# Matrix cell glyphs, mapped to the class that colours them.
MARKS = {
    '●': ('full', '&#9679;'),
    '◐': ('half', '&#9680;'),
    '○': ('none', '&#9675;'),
    '–': ('na', '&#8211;'),
    '-': ('na', '&#8211;'),
    'stub': ('stub', '&#9678;'),
    # The glyph the ledger actually writes for a stub — the word above is the
    # legacy spelling. It fell through the old na-fallback and rendered as
    # "not applicable", which is a different claim.
    '◍': ('stub', '&#9677;'),
}

# Tables the ledger keeps for the READER, not for this generator: drift logs,
# not-done lists, the state legend. Named so a renamed inventory or matrix
# header cannot be mistaken for one of them and silently dropped.
INFORMATIONAL_HEADERS = (
    ['row', 'was', 'is'],
    ['row', 'what has not been done'],
    ['state', 'meaning'],
)


def cells(row: str) -> list[str]:
    """The cells of one Markdown table row, honouring escaped pipes.

    A naive `split('|')` breaks on `\\|`, which is how a Markdown table writes a
    literal pipe — and the ledger has one, in a cell reading
    `MarkKind is highlight \\| companion`. Splitting there silently truncated
    that cell in the generated page: no error, no missing row, just a sentence
    that stops halfway. Exactly the failure this parser was written to prevent,
    reintroduced by the parser itself.
    """
    parts = re.split(r'(?<!\\)\|', row.strip().strip('|'))
    return [c.strip().replace('\\|', '|') for c in parts]


def plain(text: str) -> str:
    """Markdown emphasis and code ticks removed, for a value we key on."""
    return text.replace('**', '').replace('`', '').strip()


def parse(md: str):
    """Pull the comparators, the inventory and the matrices out of the ledger.

    Deliberately structural rather than clever: a table is recognised by its
    header row, and everything until the next blank line belongs to it. The
    ledger is written by hand, so the parser fails loudly on a shape it does
    not recognise rather than silently dropping rows.
    """
    comparators: list[tuple[str, str]] = []
    inventory: list[tuple[str, list[tuple[str, str, str, str]]]] = []
    matrices: list[tuple[str, str, list[tuple[str, list[str]]]]] = []

    lines = md.split('\n')
    section = ''
    blurb = ''
    i = 0
    while i < len(lines):
        line = lines[i]

        if line.startswith('### '):
            section = line[4:].strip()
            blurb = ''
        elif line.startswith('|') and '---' not in line:
            header = [c.lower() for c in cells(line)]
            # The row after a header must be the delimiter. Skipped blind, a
            # missing delimiter silently ate the first data row instead.
            if i + 1 >= len(lines) or not (lines[i + 1].startswith('|') and '---' in lines[i + 1]):
                raise SystemExit(f"{SOURCE}: table '{' | '.join(header)}' has no delimiter row under its header")
            body: list[list[str]] = []
            j = i + 2  # past the validated delimiter
            while j < len(lines) and lines[j].startswith('|'):
                r = cells(lines[j])
                # Exactly the header's width: zip() would silently drop a
                # surplus cell, and a short row would blame the wrong column.
                if len(r) != len(header):
                    raise SystemExit(
                        f"{SOURCE}: row '{plain(r[0]) if r else ''}' has {len(r)} cells against "
                        f"{len(header)} columns in '{' | '.join(header)}'"
                    )
                body.append(r)
                j += 1

            if header[:2] == ['code', 'reader']:
                comparators = [(plain(r[0]), plain(r[1])) for r in body]
            elif header[:4] == ['capability', 'state', 'where', 'how to confirm']:
                rows = []
                for r in body:
                    state = plain(r[1]).lower()
                    if state not in STATES:
                        raise SystemExit(
                            f"{SOURCE}: row '{plain(r[0])}' has unknown state '{state}'. "
                            f"Allowed: {', '.join(STATES)}"
                        )
                    rows.append((plain(r[0]), state, plain(r[2]), plain(r[3])))
                inventory.append((section, rows))
            elif header[:2] == ['capability', 'paper']:
                # Keyed by the codes in THIS table's own header, not by
                # position in a list parsed elsewhere. Positionally, reordering
                # the comparator table silently reassigned every result to the
                # wrong reader — a change with no error and no visible symptom
                # beyond a matrix that quietly lies.
                codes = [c for c in header[1:]]
                rows = [
                    (plain(r[0]), dict(zip(codes, (plain(c) for c in r[1:]))))
                    for r in body
                ]
                matrices.append((section, blurb, rows))
            elif [c for c in header] not in [list(h) for h in INFORMATIONAL_HEADERS] and not any(
                header[: len(h)] == list(h) for h in INFORMATIONAL_HEADERS
            ):
                # A table this parser does not recognise is either a renamed
                # target table — which used to be DROPPED, whole — or a new
                # informational one, which belongs in the list above.
                raise SystemExit(
                    f"{SOURCE}: unrecognised table header '{' | '.join(header)}' — a renamed target table "
                    "would be silently dropped; name it in INFORMATIONAL_HEADERS if it is prose"
                )
            i = j
            continue
        elif line.strip() and not line.startswith('#') and section and not blurb:
            blurb = line.strip()

        i += 1

    if not comparators or not inventory or not matrices:
        raise SystemExit(f"{SOURCE}: parsed nothing — has the ledger's shape changed?")
    return comparators, inventory, matrices


def mark_cell(value: str, extra: str = '') -> str:
    key = value.lower() if value.lower() == 'stub' else value
    if key not in MARKS:
        # The fallback used to render any typo — and the ◍ stub glyph, for a
        # while — as "not applicable", which is a claim, not an absence.
        raise SystemExit(f"{SOURCE}: unknown matrix mark '{value}'. Allowed: {', '.join(MARKS)}")
    cls, glyph = MARKS[key]
    return f'<td class="{extra}"><span class="m {cls}">{glyph}</span></td>'


def render_matrix(title: str, blurb: str, rows, comparators) -> str:
    head = ''.join(
        f'<th><abbr title="{html.escape(name)}">{html.escape(code)}</abbr></th>'
        for code, name in comparators
    )
    body = []
    for capability, values in rows:
        expected = ['paper'] + [code.lower() for code, _ in comparators]
        if list(values) != expected:
            raise SystemExit(
                f"{SOURCE}: '{capability}' has columns {list(values)}, "
                f"but the comparator table declares {expected}"
            )
        cs = mark_cell(values['paper'], 'paper') + ''.join(
            mark_cell(values[code.lower()]) for code, _ in comparators
        )
        body.append(f'<tr><th scope="row">{html.escape(capability)}</th>{cs}</tr>')
    lede = f'\n<p class="lede">{html.escape(blurb)}</p>' if blurb else ''
    return f"""<section class="block">
<h3>{html.escape(title)}</h3>{lede}
<div class="scroller"><table class="matrix">
<thead><tr><th scope="col">Capability</th><th class="paper">Paper</th>{head}</tr></thead>
<tbody>{''.join(body)}</tbody></table></div></section>"""


def render_inventory(inventory) -> str:
    out = []
    for group, rows in inventory:
        body = ''.join(
            f'<tr data-state="{s}"><th scope="row">{html.escape(n)}</th>'
            f'<td><span class="pill {s}">{s}</span></td>'
            f'<td><code>{html.escape(w)}</code></td>'
            f'<td class="how">{html.escape(h)}</td></tr>'
            for n, s, w, h in rows
        )
        out.append(f"""<section class="block">
<h3>{html.escape(group)}</h3>
<div class="scroller"><table class="inv">
<thead><tr><th scope="col">Capability</th><th scope="col">State</th>
<th scope="col">Where</th><th scope="col">How to confirm</th></tr></thead>
<tbody>{body}</tbody></table></div></section>""")
    return ''.join(out)


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


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"{SOURCE} not found — the ledger is the source of truth.")
    comparators, inventory, matrices = parse(SOURCE.read_text())

    counts: dict[str, int] = {}
    for _, rows in inventory:
        for _, state, _, _ in rows:
            counts[state] = counts.get(state, 0) + 1
    total = sum(counts.values())

    # Filters are derived from the states actually present, so a state that
    # exists in the ledger can never be un-filterable.
    present = [s for s in STATES if counts.get(s)]
    filters = ''.join(
        f'<button type="button" data-f="{s}" aria-pressed="false">{s.title()}</button>'
        for s in present
    )
    tally = ''.join(f'<li><b>{counts[s]}</b> {s}</li>' for s in present)

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
  <p class="sub">What is built, what is a stub, and where Paper stands against
  {len(comparators)} other readers. A stub is not a feature: where this says stub,
  the app should not be described as having the thing.</p>
  <ul class="tally">{tally}<li>{total} tracked</li></ul>
</header>

<h2>1 &mdash; What Paper has</h2>
<p class="lede">Walk this with the app open. Every row says where it lives and how to confirm it.</p>
<div class="filters" role="group" aria-label="Filter by state">
  <button type="button" data-f="all" aria-pressed="true">All</button>{filters}
</div>
{render_inventory(inventory)}

<h2>2 &mdash; The gap matrix</h2>
<ul class="legend">
  <li><span class="m full">&#9679;</span> has it</li>
  <li><span class="m half">&#9680;</span> partial</li>
  <li><span class="m none">&#9675;</span> lacks it</li>
  <li><span class="m stub">&#9678;</span> stub</li>
  <li><span class="m na">&#8211;</span> not applicable</li>
</ul>
{''.join(render_matrix(t, b, r, comparators) for t, b, r in matrices)}

<footer>
  <p>Generated from <code>dev-docs/feature-ledger.md</code> by
  <code>scripts/gen-feature-ledger.py</code>, which parses that file and holds no
  feature data of its own. Regenerate after editing the ledger.</p>
</footer>
</div>
<script>{JS}</script>
</body>
</html>"""

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(doc)
    print(f"written: {OUTPUT.relative_to(ROOT)}  {len(doc) / 1024:.1f} KB")
    print(f"parsed:  {total} capabilities, {len(matrices)} matrices, "
          f"{len(comparators)} comparators")
    print(f"states:  {counts}")


if __name__ == '__main__':
    sys.exit(main())
