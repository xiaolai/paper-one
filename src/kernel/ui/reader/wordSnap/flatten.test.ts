import { describe, expect, it } from 'vitest'
import { isWordLike } from './classify'
import { buildFixture, elem, txt, type Fixture, type Spec } from './domFake.testkit'
import { flatten, snapInDom, SENTINEL, type DomPosition } from './flatten'
import { snapWordRange } from './snapWordRange'

/**
 * Block-aware DOM flattening.
 *
 * Every case here runs against `domFake.testkit.ts` — a hand-built tree, keyed
 * so that walking the wrong node changes the answer. **There is no in-process
 * alternative**: the `unit` lane has no DOM and no jsdom by design, and
 * foliate's own `text-walker` cannot answer this question at all — its default
 * `acceptNode` returns `FILTER_SKIP` for every element except `script` and
 * `style`, so `<br>` and block boundaries are invisible in its output and
 * hidden content is included. `flatten.ts` quotes the filter it verified.
 *
 * **The mock pairing is PARTLY MET.** Every case below is paired with a live
 * WebKit case, named in the case's own comment where the pairing is doing real
 * work. The `live` lane now exists — `.claude/tdd-guardian/config.json`,
 * `node scripts/word-snap-live.mjs` — and its `block-merge` and `br-merge`
 * checks flatten a real document with real computed styles, so blockification
 * and `<br>` are measured rather than assumed.
 *
 * The rest is still open, and under `policy-core` rule 6 still a finding:
 * inherited `visibility`, `display: contents`, and every claim about a real
 * EPUB section document or a real PDF text layer have no automated cover at
 * all. The lane is manual-only besides, so a green `pnpm test` says nothing
 * about whether it has been run — see `dev-docs/manual-selection-checklist.md`.
 */

/** The flattened text, as WI-3 will segment it. */
function flatText(root: Element, options?: Parameters<typeof flatten>[1]): string {
  return flatten(root, options).strs.join('')
}

/** The node table, in a shape a reader can check by eye: content, then the
 *  flat span it occupies. Nodes are named by their content because the fixture
 *  guarantees the content is unique. */
function table(root: Element): [string, number, number][] {
  return flatten(root).nodes.map((row) => [row.node.data, row.flatStart, row.flatEnd])
}

/** The word-like segments of a string, through the REAL `Intl.Segmenter` and
 *  WI-1's character-level test. Written out here rather than imported from the
 *  module under test, so it is an oracle and not an echo. */
function words(text: string): string[] {
  const segmenter = new Intl.Segmenter('en', { granularity: 'word' })
  return [...segmenter.segment(text)].map((part) => part.segment).filter(isWordLike)
}

const at = (fixture: Fixture, data: string, offset: number): DomPosition => ({
  node: fixture.text(data),
  offset,
})

/** The text a snapped pair of DOM positions covers, reconstructed from the
 *  nodes themselves rather than from anything the module returned. */
function textBetween(root: Element, start: DomPosition, end: DomPosition): string {
  const flat = flatten(root)
  const startEdge = flat.toFlat(start.node, start.offset)
  const endEdge = flat.toFlat(end.node, end.offset)
  if (!startEdge || !endEdge) throw new Error('textBetween: position is not in the flattened block')
  const before = (index: number, offset: number) =>
    flat.strs.slice(0, index).join('').length + offset
  return flat.strs
    .join('')
    .slice(before(startEdge.index, startEdge.offset), before(endEdge.index, endEdge.offset))
}

describe('flatten — block boundaries', () => {
  /*
   * Live partner (WI-12): "flatten the live section document and compare its
   * sentinel positions against WebKit's own block layout". UNMET.
   */
  it('puts a sentinel between two block siblings', () => {
    const fixture = buildFixture(
      elem('div', {}, [elem('p', {}, [txt('all done')]), elem('p', {}, [txt('Start here')])]),
    )

    expect(flatText(fixture.root)).toBe('all done\nStart here')
  })

  /*
   * The pair that pins the rule, and neither half pins it alone. A tag list
   * calls the spans inline and gets (a) wrong; it calls the paragraphs blocks
   * and gets (b) wrong. Only reading the computed style gets both.
   *
   * `BLOCK_TAGS.has(el.tagName)` is the obvious optimisation here — it is
   * faster, and it is wrong for every EPUB that styles its own elements, which
   * is most of them.
   *
   * Live partner (WI-12): "a real EPUB section's computed display drives the
   * sentinel positions". UNMET.
   */
  it('reads block-ness from the computed style, not from a tag list', () => {
    const spans = buildFixture(
      elem('div', {}, [
        elem('span', { display: 'block' }, [txt('one')]),
        elem('span', { display: 'block' }, [txt('two')]),
      ]),
    )
    const paragraphs = buildFixture(
      elem('div', {}, [
        elem('p', { display: 'inline' }, [txt('three')]),
        elem('p', { display: 'inline' }, [txt('four')]),
      ]),
    )

    expect(flatText(spans.root)).toBe('one\ntwo')
    expect(flatText(paragraphs.root)).toBe('threefour')
  })

  /** `display: list-item` is block-level and is not the string `block`. An
   *  implementation comparing `display === 'block'` passes every other case
   *  here and fails this one. */
  it('treats a block-level display that is not the word `block` as a break', () => {
    const fixture = buildFixture(
      elem('ul', {}, [elem('li', {}, [txt('first')]), elem('li', {}, [txt('second')])]),
    )

    expect(flatText(fixture.root)).toBe('first\nsecond')
  })

  /*
   * `<br>` computes `display: inline`, so a purely display-driven
   * implementation has nothing to read and merges the two lines. Together with
   * the case above this pins BOTH rules: display alone fails here, tags alone
   * fail there.
   *
   * Live partner: `word-snap-live.mjs`'s `br-merge` check — `one<br>two` in a
   * live document, with real computed styles, yields a sentinel where
   * `range.toString()` yields `'onetwo'`. **MET.**
   */
  it('puts a sentinel at a <br>, whose display is inline', () => {
    const fixture = buildFixture(elem('p', {}, [txt('one'), elem('br'), txt('two')]))

    expect(flatText(fixture.root)).toBe('one\ntwo')
    expect(flatText(fixture.root)).not.toBe('onetwo')
  })

  it('emits no sentinel for inline markup splitting a word', () => {
    const fixture = buildFixture(elem('p', {}, [txt('wo'), elem('em', {}, [txt('r')]), txt('d here')]))

    expect(flatText(fixture.root)).toBe('word here')
  })

  it('emits no leading or trailing sentinel', () => {
    const fixture = buildFixture(elem('div', {}, [elem('p', {}, [txt('alone')])]))

    expect(flatText(fixture.root)).toBe('alone')
  })

  it('collapses a nest of block boundaries into one sentinel', () => {
    const fixture = buildFixture(
      elem('div', {}, [
        elem('section', {}, [elem('p', {}, [txt('end of one')])]),
        elem('section', {}, [elem('p', {}, [txt('start of two')])]),
      ]),
    )

    expect(flatText(fixture.root)).toBe('end of one\nstart of two')
  })
})

describe('flatten — the sentinel itself', () => {
  /*
   * The trap that looks solved and is not. U+2060 WORD JOINER is General
   * Category `Cf`, UAX #29 WB4 ignores it, and `done<U+2060>Start` segments as
   * ONE word — so an "invisible" sentinel silently lets a snap expand across a
   * paragraph boundary. Asserting `SENTINEL === '\n'` would not catch that;
   * asserting the SEGMENTATION does, and it is the property that matters.
   *
   * Live partner: `word-snap-live.mjs` runs the WI-4 corpus in WebKit and diffs
   * it against this engine row for row, and its `word-joiner` check segments
   * `done<U+2060>Start` there directly. **MET** — and it is the pairing that
   * matters most, because Node and WebKit are backed by different ICU builds
   * and a macOS upgrade moves one of them.
   */
  it('breaks words apart, which a Format character would not', () => {
    const fixture = buildFixture(
      elem('div', {}, [elem('p', {}, [txt('all done')]), elem('p', {}, [txt('Start here')])]),
    )

    expect(words(flatText(fixture.root))).toEqual(['all', 'done', 'Start', 'here'])
    expect(/\p{Cf}/u.test(SENTINEL)).toBe(false)
  })

  it('is the character U+2060 is not: joining with WORD JOINER makes one word', () => {
    /* Named, not pasted: the character is invisible, and a reviewer must be
     * able to see which one is meant. */
    const WORD_JOINER = String.fromCodePoint(0x2060)
    const joined = `done${WORD_JOINER}Start`
    expect(words(joined)).toEqual([joined])
    expect(words(`done${SENTINEL}Start`)).toEqual(['done', 'Start'])
  })
})

describe('flatten — hidden content', () => {
  /*
   * Each hidden string is distinct, so a partial fix — `display: none` caught,
   * `visibility: hidden` missed — fails on a named row instead of a lumped
   * assertion.
   *
   * Live partner (WI-12): "a `display:none` note in a real EPUB contributes no
   * text to the flattened block". UNMET.
   */
  it('excludes a display:none subtree', () => {
    const fixture = buildFixture(
      elem('p', {}, [
        txt('visible'),
        elem('span', { display: 'none' }, [txt('HIDDENA')]),
        txt('text'),
      ]),
    )

    expect(flatText(fixture.root)).toBe('visibletext')
    expect(flatText(fixture.root)).not.toMatch(/HIDDEN[A-D]/)
  })

  it('excludes a visibility:hidden subtree', () => {
    const fixture = buildFixture(
      elem('p', {}, [
        txt('shown'),
        elem('span', { visibility: 'hidden' }, [txt('HIDDENB')]),
        txt('after'),
      ]),
    )

    expect(flatText(fixture.root)).toBe('shownafter')
    expect(flatText(fixture.root)).not.toMatch(/HIDDEN[A-D]/)
  })

  it('excludes script and style content', () => {
    const fixture = buildFixture(
      elem('p', {}, [
        txt('seen'),
        elem('script', {}, [txt('var HIDDENC=1')]),
        elem('style', {}, [txt('.x{content:"HIDDEND"}')]),
        txt('more'),
      ]),
    )

    expect(flatText(fixture.root)).toBe('seenmore')
    expect(flatText(fixture.root)).not.toMatch(/HIDDEN[A-D]/)
  })

  /** The author-override case, and the reason the script gate is a tag rule
   *  rather than a `display` rule: `script { display: block }` is a real trick
   *  for showing source, and it must still contribute no text. */
  it('excludes a script even when its own display says otherwise', () => {
    const fixture = buildFixture(
      elem('p', {}, [
        txt('kept'),
        elem('script', { display: 'inline' }, [txt('var HIDDENE=2')]),
        txt('together'),
      ]),
    )

    expect(flatText(fixture.root)).toBe('kepttogether')
  })

  /*
   * A judgment call, pinned here so it cannot change silently: CSS says the
   * inner span is visible and WebKit's own selection agrees, so each element
   * is tested rather than the outer subtree pruned. The cheaper "prune on
   * hidden" rule is defensible; it is simply not what this does.
   *
   * Live partner (WI-12): "WebKit's own selection includes the re-shown span".
   * UNMET.
   */
  it('shows a visibility:visible element inside a hidden one', () => {
    const fixture = buildFixture(
      elem('p', {}, [
        elem('span', { visibility: 'hidden' }, [
          txt('A'),
          elem('span', { visibility: 'visible' }, [txt('B')]),
          txt('C'),
        ]),
      ]),
    )

    expect(flatText(fixture.root)).toBe('B')
  })

  it('emits no sentinel around hidden content', () => {
    const fixture = buildFixture(
      elem('p', {}, [txt('wo'), elem('span', { display: 'none' }, [txt('NOPE')]), txt('rd')]),
    )

    expect(flatText(fixture.root)).toBe('word')
  })
})

describe('flatten — the node table', () => {
  /*
   * The flat string is unchanged by skipping empty nodes, which is exactly why
   * the TABLE is the assertion. A test on the string alone passes for the
   * broken version, and the breakage surfaces later as a mis-anchored
   * selection with nothing to point at.
   *
   * Live partner (WI-12): "a real section with empty text nodes flattens with
   * the same table". UNMET.
   */
  it('keeps empty and whitespace-only nodes in the table, without shifting it', () => {
    const fixture = buildFixture(
      elem('p', {}, [
        txt('a'),
        elem('span', {}, [txt('')]),
        elem('span', {}, [txt('   ')]),
        txt('b'),
      ]),
    )

    expect(flatText(fixture.root)).toBe('a   b')
    expect(table(fixture.root)).toEqual([
      ['a', 0, 1],
      ['', 1, 1],
      ['   ', 1, 4],
      ['b', 4, 5],
    ])
  })

  it('counts the sentinel in the flat offsets of the nodes after it', () => {
    const fixture = buildFixture(
      elem('div', {}, [elem('p', {}, [txt('one')]), elem('p', {}, [txt('two')])]),
    )

    expect(table(fixture.root)).toEqual([
      ['one', 0, 3],
      ['two', 4, 7],
    ])
  })
})

/**
 * The round-trip fixture: nine text nodes of differing lengths, including an
 * empty one and a whitespace-only one, across three blocks.
 *
 * The expected flat text is transcribed by hand below rather than derived from
 * the module, so it is an oracle. Every position in the tree is enumerated and
 * checked, which is what a hardcoded implementation cannot survive: the
 * expected answer differs for all 52 of them.
 */
const ROUND_TRIP: Spec = elem('div', {}, [
  elem('p', {}, [txt('Chapter one'), elem('em', {}, [txt('!')])]),
  elem('p', {}, [txt('a'), elem('span', {}, [txt('')]), elem('span', {}, [txt('   ')]), txt('bc')]),
  elem('p', {}, [txt('the quick brown'), elem('a', {}, [txt(' fox')]), txt(' jumps')]),
])

/** The same tree as a flat list of contributions, in document order, with the
 *  block boundaries written in by hand. */
const ROUND_TRIP_PIECES: readonly (readonly [string, boolean])[] = [
  ['Chapter one', false],
  ['!', false],
  ['a', true],
  ['', false],
  ['   ', false],
  ['bc', false],
  ['the quick brown', true],
  [' fox', false],
  [' jumps', false],
]

/** Flat start offsets, computed from the oracle above — the sentinel counts
 *  for one character wherever the hand-written table says a block begins. */
function expectedFlatStarts(): Map<string, number> {
  const starts = new Map<string, number>()
  let flat = 0
  for (const [data, breakBefore] of ROUND_TRIP_PIECES) {
    if (breakBefore) flat += SENTINEL.length
    starts.set(data, flat)
    flat += data.length
  }
  return starts
}

const ROUND_TRIP_POSITIONS: [string, number][] = ROUND_TRIP_PIECES.flatMap(([data]) =>
  Array.from({ length: data.length + 1 }, (_, offset): [string, number] => [data, offset]),
)

describe('flatten — the position mapping', () => {
  it('flattens the round-trip fixture to the hand-written oracle', () => {
    const fixture = buildFixture(ROUND_TRIP)

    expect(flatText(fixture.root)).toBe('Chapter one!\na   bc\nthe quick brown fox jumps')
  })

  /*
   * Live partner (WI-12): "the round-trip holds over a real section's text
   * nodes". UNMET.
   */
  it.each(ROUND_TRIP_POSITIONS)('round-trips %j at offset %i', (data, offset) => {
    const fixture = buildFixture(ROUND_TRIP)
    const flat = flatten(fixture.root)
    const node = fixture.text(data)

    const edge = flat.toFlat(node, offset)
    expect(edge).not.toBeNull()
    const back = flat.fromFlat(edge!.index, edge!.offset)

    expect(back?.node).toBe(node)
    expect(back?.offset).toBe(offset)
  })

  /** The same positions against the hand-written oracle rather than against
   *  the round trip: an implementation whose table is internally consistent but
   *  wrong about where the sentinels fall survives the identity above and dies
   *  here. */
  it.each(ROUND_TRIP_POSITIONS)('places %j at offset %i where the oracle says', (data, offset) => {
    const fixture = buildFixture(ROUND_TRIP)
    const flat = flatten(fixture.root)
    const edge = flat.toFlat(fixture.text(data), offset)
    const charOffset = flat.strs.slice(0, edge!.index).join('').length + edge!.offset

    expect(charOffset).toBe((expectedFlatStarts().get(data) ?? -1) + offset)
    expect(flat.nodes.find((row) => row.node === fixture.text(data))?.flatStart).toBe(
      expectedFlatStarts().get(data),
    )
  })

  /*
   * A seam has two spellings — the end of one node and the start of the next —
   * and they denote the same place. `snapWordRange` picks the later spelling
   * for a start edge and the earlier one for an end edge, so BOTH have to map
   * back to a live position; excluding the seam from the property is what lets
   * the ambiguity ship.
   */
  it.each([
    ['a', ''],
    ['', '   '],
    ['   ', 'bc'],
    ['the quick brown', ' fox'],
    [' fox', ' jumps'],
  ])('gives the seam after %j and before %j one flat position', (before, after) => {
    const fixture = buildFixture(ROUND_TRIP)
    const flat = flatten(fixture.root)
    const asEnd = flat.toFlat(fixture.text(before), before.length)
    const asStart = flat.toFlat(fixture.text(after), 0)
    const charOffset = (edge: { index: number; offset: number }) =>
      flat.strs.slice(0, edge.index).join('').length + edge.offset

    expect(charOffset(asEnd!)).toBe(charOffset(asStart!))
    expect(flat.fromFlat(asEnd!.index, asEnd!.offset)?.node).toBe(fixture.text(before))
    expect(flat.fromFlat(asStart!.index, asStart!.offset)?.node).toBe(fixture.text(after))
  })

  /** A sentinel occupies no DOM. A flat position inside one still has to name
   *  a live place, or an edge that lands on a block boundary has nowhere to
   *  go. */
  it('maps a position inside a sentinel to the node beside it', () => {
    const fixture = buildFixture(
      elem('div', {}, [elem('p', {}, [txt('one')]), elem('p', {}, [txt('two')])]),
    )
    const flat = flatten(fixture.root)
    const sentinel = flat.strs.indexOf(SENTINEL)

    expect(flat.fromFlat(sentinel, 0)).toEqual({ node: fixture.text('one'), offset: 3 })
    expect(flat.fromFlat(sentinel, 1)).toEqual({ node: fixture.text('two'), offset: 0 })
  })

  it('refuses a node it never walked, and an offset past the node', () => {
    const fixture = buildFixture(elem('p', {}, [txt('inside')]))
    const other = buildFixture(elem('p', {}, [txt('elsewhere')]))
    const flat = flatten(fixture.root)

    expect(flat.toFlat(other.text('elsewhere'), 0)).toBeNull()
    expect(flat.toFlat(fixture.text('inside'), 7)).toBeNull()
    expect(flat.fromFlat(9, 0)).toBeNull()
  })
})

describe('snapInDom — the whole pipeline', () => {
  /*
   * The strongest single case in the section: it runs WI-5 and WI-3 together
   * over three text nodes carrying DIFFERENT strings, precisely so that
   * returning the wrong node is visible. With `'x'`/`'x'`/`'x'` this would
   * pass for a mapping that returned any node at all.
   *
   * Live partner (WI-12): "a word split by `<em>` in the live document snaps
   * to the whole word". UNMET.
   */
  it('snaps a word split by inline markup back to whole nodes', () => {
    const fixture = buildFixture(elem('p', {}, [txt('wo'), elem('em', {}, [txt('r')]), txt('d here')]))

    const snapped = snapInDom(fixture.root, at(fixture, 'r', 0), at(fixture, 'r', 1))

    expect(snapped?.start.node).toBe(fixture.text('wo'))
    expect(snapped?.start.offset).toBe(0)
    expect(snapped?.end.node).toBe(fixture.text('d here'))
    expect(snapped?.end.offset).toBe(1)
    expect(textBetween(fixture.root, snapped!.start, snapped!.end)).toBe('word')
  })

  /** The sentinel doing its job end to end: an edge in the last word of one
   *  block cannot drag the first word of the next one in with it. */
  it('never expands a word across a block boundary', () => {
    const fixture = buildFixture(
      elem('div', {}, [elem('p', {}, [txt('all done')]), elem('p', {}, [txt('Start here')])]),
    )

    const snapped = snapInDom(fixture.root, at(fixture, 'all done', 5), at(fixture, 'Start here', 2))

    expect(textBetween(fixture.root, snapped!.start, snapped!.end)).toBe('done\nStart')
  })

  it('leaves the selection alone when there is no word to snap to', () => {
    const fixture = buildFixture(elem('p', {}, [txt('   ')]))

    expect(snapInDom(fixture.root, at(fixture, '   ', 0), at(fixture, '   ', 2))).toBeNull()
  })
})

describe('flatten — the PDF text layer', () => {
  /*
   * pdf.js gives every run its own absolutely-positioned span with no block
   * wrapper between them, and CSS blockifies an out-of-flow box — so these
   * spans report `display: block` (the fake models that; `domFake.test.ts`
   * asserts it). Treating that as a block boundary makes every run on a PDF
   * page its own block and snapping stops working on PDFs entirely.
   *
   * Live partner (WI-12): "snap a word on a real PDF page's text layer".
   * UNMET — and the blockification this depends on is WebKit's behaviour, not
   * this fixture's.
   */
  it('emits no sentinel between two positioned spans', () => {
    const fixture = buildFixture(
      elem('div', {}, [
        elem('span', { position: 'absolute' }, [txt('Hello ')]),
        elem('span', { position: 'absolute' }, [txt('world')]),
      ]),
    )

    expect(flatText(fixture.root)).toBe('Hello world')
    expect(flatText(fixture.root)).not.toContain(SENTINEL)
  })

  it('snaps a word split across two positioned spans', () => {
    const fixture = buildFixture(
      elem('div', {}, [
        elem('span', { position: 'absolute' }, [txt('inter')]),
        elem('span', { position: 'absolute' }, [txt('national')]),
      ]),
    )

    const snapped = snapInDom(fixture.root, at(fixture, 'national', 2), at(fixture, 'national', 4))

    expect(snapped?.start.node).toBe(fixture.text('inter'))
    expect(textBetween(fixture.root, snapped!.start, snapped!.end)).toBe('international')
  })

  /*
   * Confirmed against the pdf.js this repository ships, not taken from the
   * matrix's word: `TextLayer` appends `document.createElement("br")` with
   * `setAttribute("role", "presentation")` whenever an item reports `hasEOL`.
   * `makePdf.ts:243` mirrors it for the search document.
   *
   * That makes a PDF line end a block break, which is a DECISION and not an
   * inheritance: a word hyphenated across a PDF line will not expand across
   * the break. Consistent with `<br>` everywhere else, and pinned here.
   *
   * Live partner (WI-12): "a word at a PDF line end does not snap across the
   * line". UNMET.
   */
  it('treats pdf.js’s end-of-line <br role="presentation"> as a break', () => {
    const fixture = buildFixture(
      elem('div', {}, [
        elem('span', { position: 'absolute' }, [txt('Hello ')]),
        elem('br'),
        elem('span', { position: 'absolute' }, [txt('world')]),
      ]),
    )

    expect(flatText(fixture.root)).toBe('Hello \nworld')
  })
})

/** A block of `count` inline spans, each holding a distinct run of `width`
 *  characters and no whitespace anywhere — so the whole block is one
 *  unbroken word and a bounded walk has nowhere safe to stop. */
function unbrokenSpans(count: number, width: number): { spec: Spec; texts: string[] } {
  const texts = Array.from({ length: count }, (_, i) => `w${String(i).padStart(width - 1, '0')}`)
  return { spec: elem('div', {}, texts.map((data) => elem('span', {}, [txt(data)]))), texts }
}

describe('flatten — the bounded walk', () => {
  /*
   * The bound exists because a chapter in one `<div>` is common, and an
   * unbounded walk turns every word snap into a whole-chapter traversal. The
   * observable is the VISIT COUNT, not the clock: a wall-clock threshold is
   * flaky and proves nothing on a loaded machine.
   *
   * Live partner (WI-12): "snapping a word in a single-`<div>` chapter
   * completes without a visible pause". UNMET — and the bound's VALUE is a
   * guess until it is measured on a real book.
   */
  it('stops early, keeps the anchor, and says it truncated', () => {
    const { spec, texts } = unbrokenSpans(5000, 8)
    const fixture = buildFixture(spec)
    const anchorText = texts[3]!

    const flat = flatten(fixture.root, {
      maxChars: 4000,
      anchors: [{ node: fixture.text(anchorText), offset: 1 }],
    })

    expect(flat.strs.join('').length).toBeLessThanOrEqual(4000)
    expect(flat.toFlat(fixture.text(anchorText), 1)).not.toBeNull()
    expect(flat.truncatedEnd).toBe(true)
    expect(fixture.visits).toBeLessThan(5000)
    expect(fixture.visits).toBeLessThan(fixture.nodeCount)
  })

  it('walks the whole block when it fits, and reports no truncation', () => {
    const fixture = buildFixture(
      elem('div', {}, [elem('p', {}, [txt('short enough')]), elem('p', {}, [txt('by far')])]),
    )

    const flat = flatten(fixture.root, { maxChars: 4000 })

    expect(flat.truncatedStart).toBe(false)
    expect(flat.truncatedEnd).toBe(false)
    expect(flat.strs.join('')).toBe('short enough\nby far')
  })

  /*
   * A truncation that cuts mid-word is indistinguishable from a word boundary,
   * so the snap would return a confidently wrong answer with nothing anywhere
   * reporting a problem. Decisions §2: fail closed. A partial word is a
   * visible, self-correcting annoyance; a wrong boundary is not.
   *
   * The second half of this case is what makes the flag load-bearing rather
   * than decorative: composing the same window naively — ignoring
   * `truncatedEnd` — moves the end edge to the truncation point, which is not
   * where the word ends.
   *
   * Live partner (WI-12): "a word near the chapter bound snaps or is left
   * alone, never truncated". UNMET.
   */
  it('declines to snap a word that straddles the bound', () => {
    const { spec, texts } = unbrokenSpans(40, 10)
    const fixture = buildFixture(spec)
    const anchor = { node: fixture.text(texts[1]!), offset: 3 }

    const flat = flatten(fixture.root, { maxChars: 100, anchors: [anchor] })
    expect(flat.truncatedEnd).toBe(true)

    expect(snapInDom(fixture.root, anchor, { node: anchor.node, offset: 5 }, { maxChars: 100 })).toBeNull()

    const start = flat.toFlat(anchor.node, anchor.offset)!
    const end = flat.toFlat(anchor.node, 5)!
    const naive = snapWordRange(flat.strs, start, end, {})
    const naiveEnd = flat.strs.slice(0, naive!.end.index).join('').length + naive!.end.offset

    /* The naive answer lands exactly ON the cut — which is not where the word
     * ends, and nothing in the result says so. That is the whole argument for
     * failing closed. */
    expect(naiveEnd).toBe(flat.strs.join('').length)
    expect(naiveEnd).toBeLessThan(texts.join('').length)
  })

  /*
   * The other half of the bound, and the reason it does not simply disable
   * snapping in long chapters: when the walk can retreat to a boundary no word
   * can span — a space, or a block break — the window is sound and the snap
   * goes ahead. Without this the fail-closed rule would make the feature stop
   * working in exactly the documents that motivated the bound.
   */
  it('retreats to a safe boundary rather than truncating, when there is one', () => {
    const fixture = buildFixture(
      elem('div', {}, [
        elem('span', {}, [txt('alpha beta ')]),
        elem('span', {}, [txt('gamma delta ')]),
        elem('span', {}, [txt('epsilon zeta ')]),
        elem('span', {}, [txt('eta theta ')]),
      ]),
    )
    const anchor = at(fixture, 'alpha beta ', 2)

    const flat = flatten(fixture.root, { maxChars: 30, anchors: [anchor] })

    expect(flat.truncatedEnd).toBe(false)
    expect(flat.strs.join('')).toBe('alpha beta gamma delta ')
    expect(snapInDom(fixture.root, anchor, at(fixture, 'alpha beta ', 3), { maxChars: 30 })).toEqual({
      start: at(fixture, 'alpha beta ', 0),
      end: at(fixture, 'alpha beta ', 5),
    })
  })

  /*
   * The retreat has to keep LOOKING as it drops pieces, and this is the shape
   * that shows it: a window ending `['alpha ', 'Hello ', 'world']`. The piece
   * the walk stopped on carries no whitespace at either end, so the first two
   * things `trim` asks are both `false` — and cutting after `'Hello '` is
   * nonetheless perfectly safe, because that piece ends in a space.
   *
   * `<p>Hello <em>world</em>…</p>` is the commonest inline shape in an EPUB, so
   * an early give-up here is not an exotic case: it is most of them. The
   * original loop only re-asked whether the piece it had just DROPPED began
   * with whitespace, never whether the piece now at the end finished with it,
   * and abandoned the whole window.
   *
   * Two mutants died when this case was added — `while (!safe && …)` →
   * `while (false && …)`, and reducing the disjunction to `dropped.gapBreak` —
   * so the loop is genuinely exercised rather than merely executed.
   */
  it('keeps retreating until the piece left at the end is one no word spans', () => {
    const fixture = buildFixture(
      elem('div', {}, [
        elem('span', {}, [txt('alpha ')]),
        elem('span', {}, [txt('Hello ')]),
        elem('em', {}, [txt('world')]),
        elem('span', {}, [txt('zulu')]),
      ]),
    )
    const anchor = at(fixture, 'alpha ', 2)

    /* 18 leaves 12 characters ahead of the 6-character seed: `'Hello '` and
     * `'world'` fit, `'zulu'` does not — so the walk stops mid-`'world'`-ish,
     * with a last piece that has no safe edge of its own. */
    const flat = flatten(fixture.root, { maxChars: 18, anchors: [anchor] })

    expect(flat.truncatedEnd).toBe(false)
    expect(flat.strs.join('')).toBe('alpha Hello ')
    // And the retained piece is really in the window: the end edge snaps
    // forward to the end of `Hello`, which only exists if it survived.
    expect(
      snapInDom(fixture.root, anchor, at(fixture, 'Hello ', 2), { maxChars: 18 }),
    ).toEqual({ start: at(fixture, 'alpha ', 0), end: at(fixture, 'Hello ', 5) })
  })

  /* The other disjunct of the same loop: the dropped piece BEGINS with
   * whitespace, so the cut in front of it is safe without looking further
   * back. Same geometry, one space moved across the seam — which is what makes
   * it a pair with the case above rather than a repeat of it. */
  it('retreats to a cut in front of a piece that starts with whitespace', () => {
    const fixture = buildFixture(
      elem('div', {}, [
        elem('span', {}, [txt('alpha ')]),
        elem('span', {}, [txt('Hello')]),
        elem('em', {}, [txt(' world')]),
        elem('span', {}, [txt('zulu')]),
      ]),
    )
    const anchor = at(fixture, 'alpha ', 2)

    const flat = flatten(fixture.root, { maxChars: 18, anchors: [anchor] })

    expect(flat.truncatedEnd).toBe(false)
    expect(flat.strs.join('')).toBe('alpha Hello')
    expect(
      snapInDom(fixture.root, anchor, at(fixture, 'Hello', 2), { maxChars: 18 }),
    ).toEqual({ start: at(fixture, 'alpha ', 0), end: at(fixture, 'Hello', 5) })
  })

  /*
   * §16 E1, first half. **`maxChars` is a budget, not a bound.** A single text
   * node is never split (`gather` takes it whole or not at all), so an anchor
   * sitting in a 5 000-character node comes back with all 5 000 of them
   * however small the budget was.
   *
   * Written down as a case rather than as a comment because the number reads
   * like a ceiling everywhere it is passed: `sentenceAt` hands `flatten` 4 000
   * and a caller reasoning about prompt size from that alone would be wrong by
   * whatever the anchor's own node happens to hold.
   */
  it('returns the anchor’s own node whole, however small the budget', () => {
    const long = 'x'.repeat(5_000)
    const fixture = buildFixture(
      elem('div', {}, [elem('p', {}, [txt(long)]), elem('p', {}, [txt('the next block')])]),
    )
    const anchor = at(fixture, long, 2_500)

    const flat = flatten(fixture.root, { maxChars: 100, anchors: [anchor] })

    expect(flat.strs.join('')).toBe(long)
    expect(flat.strs.join('').length).toBeGreaterThan(100)
    expect(flat.toFlat(anchor.node, anchor.offset)).not.toBeNull()
  })

  /*
   * §16 E1, second half, and this is the one that costs a sentence its head.
   * The per-node test is `used + text.length > budget` — ALL OR NOTHING — and
   * the backward budget is a quarter of `maxChars`. So at 4 000, a
   * 1 001-character node sitting immediately behind the anchor contributes
   * **nothing at all**: the window starts at the anchor's own node, and
   * everything before it in the same block is gone.
   *
   * `truncatedStart` does say so here. What it cannot say is whether the run
   * that survived is a block or the tail of one, which is why `sentenceAt`
   * reads none of these flags and gates on where the segmenter found a
   * boundary instead.
   */
  it('drops a node behind the anchor whole when it exceeds the backward quarter', () => {
    const justOver = 'b'.repeat(1_001)
    const justUnder = 'c'.repeat(1_000)
    const over = buildFixture(elem('p', {}, [txt(justOver), txt('the anchor node')]))
    const under = buildFixture(elem('p', {}, [txt(justUnder), txt('another anchor node')]))

    const lost = flatten(over.root, { maxChars: 4_000, anchors: [at(over, 'the anchor node', 4)] })
    const kept = flatten(under.root, {
      maxChars: 4_000,
      anchors: [at(under, 'another anchor node', 4)],
    })

    expect(lost.strs.join('')).toBe('the anchor node')
    expect(lost.truncatedStart).toBe(true)
    /* One character less and the whole node arrives — the cliff is the node's
     * length against the quarter-budget, not a gradual squeeze. */
    expect(kept.strs.join('')).toBe(`${justUnder}another anchor node`)
    expect(kept.truncatedStart).toBe(false)
  })

  /** Characters are not the only way a document is pathological: a tree can
   *  be mostly empty elements. The node bound fails closed the same way. */
  it('fails closed when the node bound is reached before the character bound', () => {
    const { spec, texts } = unbrokenSpans(200, 6)
    const fixture = buildFixture(spec)
    const anchor = { node: fixture.text(texts[0]!), offset: 1 }

    const flat = flatten(fixture.root, { maxChars: 100000, maxNodes: 30, anchors: [anchor] })

    expect(flat.truncatedEnd).toBe(true)
    expect(fixture.visits).toBeLessThanOrEqual(40)
  })
})

describe('flatten — failing closed', () => {
  it('walks nothing when the anchor is not under the root', () => {
    const fixture = buildFixture(elem('p', {}, [txt('the block')]))
    const elsewhere = buildFixture(elem('p', {}, [txt('another document')]))

    const flat = flatten(fixture.root, {
      anchors: [{ node: elsewhere.text('another document'), offset: 0 }],
    })

    expect(flat.truncatedStart).toBe(true)
    expect(flat.truncatedEnd).toBe(true)
    expect(flat.strs).toEqual([])
    expect(fixture.visits).toBe(0)
  })

  it('fails closed when the anchor is inside hidden content', () => {
    const fixture = buildFixture(
      elem('p', {}, [txt('shown here'), elem('span', { display: 'none' }, [txt('hidden here')])]),
    )
    const anchor = at(fixture, 'hidden here', 2)

    expect(flatten(fixture.root, { anchors: [anchor] }).truncatedEnd).toBe(true)
    expect(snapInDom(fixture.root, anchor, at(fixture, 'hidden here', 4))).toBeNull()
  })

  /** `document.implementation.createHTMLDocument()` — which `makePdf.ts` uses
   *  for the search document — has no view and therefore no computed styles.
   *  Guessing at block-ness without them would be a fabrication. */
  it('fails closed in a document with no view to compute styles from', () => {
    const fixture = buildFixture(elem('p', {}, [txt('no view here')]), { detachedView: true })

    const flat = flatten(fixture.root)

    expect(flat.strs).toEqual([])
    expect(flat.truncatedStart).toBe(true)
    expect(flat.truncatedEnd).toBe(true)
    expect(snapInDom(fixture.root, at(fixture, 'no view here', 1), at(fixture, 'no view here', 3))).toBeNull()
  })

  it('flattens an empty block to nothing, without calling it truncated', () => {
    const fixture = buildFixture(elem('div', {}, [elem('p', {}, [])]))

    const flat = flatten(fixture.root)

    expect(flat.strs).toEqual([])
    expect(flat.truncatedStart).toBe(false)
    expect(flat.truncatedEnd).toBe(false)
  })
})
