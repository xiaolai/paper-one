import { describe, expect, it } from 'vitest'
import { isWordLike } from './classify'
import { buildFixture, comment, elem, txt, type Fixture, type Spec } from './domFake.testkit'
import { flatten, snapInDom, SENTINEL, walkRoot, type DomPosition } from './flatten'
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
 * about whether it has been run — see the manual selection checklist.
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

/**
 * Phase 17, L8. `sentenceAt` has to tell the first sentence of a DOCUMENT from
 * the first sentence of a WINDOW, and `truncatedStart` cannot: it is word-safety,
 * and a budget cut that lands on a space reports it `false`. These two flags say
 * whether the walk ran out of tree.
 */
describe('flatten — whether the window reached the tree’s own edges', () => {
  it('says so at both ends when the whole tree fits', () => {
    const fixture = buildFixture(
      elem('div', {}, [elem('p', {}, [txt('first block')]), elem('p', {}, [txt('second block')])]),
    )

    const flat = flatten(fixture.root, { anchors: [at(fixture, 'second block', 1)] })

    expect([flat.reachedStart, flat.reachedEnd]).toEqual([true, true])
  })

  /* The word-safe cut: `truncatedEnd` is false, and the tree did NOT end there. */
  it('says the budget ended the window, even where the cut was safe for words', () => {
    const fixture = buildFixture(
      elem('div', {}, [
        elem('span', {}, [txt('alpha beta ')]),
        elem('span', {}, [txt('gamma delta ')]),
        elem('span', {}, [txt('epsilon zeta ')]),
      ]),
    )

    const flat = flatten(fixture.root, { maxChars: 30, anchors: [at(fixture, 'alpha beta ', 2)] })

    expect(flat.truncatedEnd).toBe(false)
    expect([flat.reachedStart, flat.reachedEnd]).toEqual([true, false])
  })

  it('says the budget ended the window behind the anchor', () => {
    const behind = buildFixture(elem('p', {}, [txt('b'.repeat(1_001)), txt('the anchor node')]))

    const flat = flatten(behind.root, { maxChars: 4_000, anchors: [at(behind, 'the anchor node', 4)] })

    expect([flat.reachedStart, flat.reachedEnd]).toEqual([false, true])
  })

  /* With no anchor the walk starts AT the first text, so there is nothing
     before it to have missed — whatever the budget did to the end. */
  it('reaches the start by construction when there is no anchor', () => {
    const fixture = buildFixture(elem('p', {}, [txt('from the top '), elem('span', {}, [txt('and onward')])]))

    const flat = flatten(fixture.root, { maxChars: 5 })

    expect([flat.reachedStart, flat.reachedEnd]).toEqual([true, false])
  })

  it('vouches for no edge when it read nothing', () => {
    const fixture = buildFixture(elem('p', {}, [txt('the block')]))
    const elsewhere = buildFixture(elem('p', {}, [txt('another document')]))
    const empty = buildFixture(elem('div', {}, [elem('p', {}, [])]))

    for (const flat of [
      flatten(fixture.root, { anchors: [{ node: elsewhere.text('another document'), offset: 0 }] }),
      flatten(empty.root),
    ]) {
      expect([flat.reachedStart, flat.reachedEnd]).toEqual([false, false])
    }
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

  /* NOTHING MEANS NOTHING: no rows, and no position either way — not an
     `undefined` a caller comparing against `null` would read as an answer. */
  it('answers a walk that read nothing with no rows and no positions', () => {
    const fixture = buildFixture(elem('p', {}, [txt('present')]))
    const elsewhere = buildFixture(elem('p', {}, [txt('absent')]))

    const flat = flatten(fixture.root, { anchors: [{ node: elsewhere.text('absent'), offset: 0 }] })

    expect(flat.nodes).toEqual([])
    expect(flat.toFlat(fixture.text('present'), 0)).toBeNull()
    expect(flat.fromFlat(0, 0)).toBeNull()
  })

  it('walks nothing from an anchor that is not a text node', () => {
    const fixture = buildFixture(elem('div', {}, [elem('p', { id: 'para' }, [txt('some text')])]))

    const flat = flatten(fixture.root, {
      anchors: [{ node: fixture.element('para') as unknown as Text, offset: 0 }],
    })

    expect(flat.strs).toEqual([])
    expect([flat.truncatedStart, flat.truncatedEnd]).toEqual([true, true])
  })

  /* A text node under a fragment rather than an element has no computed style
     above it to read, and must be refused rather than asked for one. */
  it('walks nothing from a text node whose parent is not an element', () => {
    const fixture = buildFixture(elem('p', {}, [txt('in the tree')]))
    const loose = { nodeType: 3, data: 'loose', parentNode: { nodeType: 11, parentNode: null } } as unknown as Text

    const flat = flatten(fixture.root, { anchors: [{ node: loose, offset: 0 }] })

    expect(flat.strs).toEqual([])
    expect(flat.truncatedEnd).toBe(true)
  })

  /* `visibility` inherits and can be undone, so only the anchor's OWN parent
     says whether its text is drawn. */
  it('walks from a visible text node inside a hidden ancestor, as CSS draws it', () => {
    const fixture = buildFixture(
      elem('div', { visibility: 'hidden' }, [elem('span', { visibility: 'visible' }, [txt('shown anyway')])]),
    )

    expect(flatten(fixture.root, { anchors: [at(fixture, 'shown anyway', 2)] }).strs).toEqual(['shown anyway'])
  })

  it('walks nothing from a text node that is itself hidden', () => {
    const fixture = buildFixture(
      elem('p', {}, [txt('seen '), elem('span', { visibility: 'hidden' }, [txt('unseen')])]),
    )

    const flat = flatten(fixture.root, { anchors: [at(fixture, 'unseen', 2)] })

    expect(flat.strs).toEqual([])
    expect(flat.truncatedEnd).toBe(true)
  })
})

/**
 * What mutation testing found the cases above could not tell apart. Each case
 * names the rule it holds, on the smallest tree that shows it.
 */
describe('flatten — what its mutants found', () => {
  /* BY NAME, like `<script>`: a style or template given a display is still not text. */
  it('skips a style and a template by name, whatever display they are given', () => {
    const fixture = buildFixture(
      elem('p', {}, [
        txt('kept'),
        elem('style', { display: 'inline' }, [txt('.HIDDENF{}')]),
        elem('template', { display: 'inline' }, [txt('HIDDENG')]),
        txt('together'),
      ]),
    )

    expect(flatText(fixture.root)).toBe('kepttogether')
  })

  /* A comment is neither text nor an element, and has no style to give. */
  it('steps over a comment without asking it for a style', () => {
    const fixture = buildFixture(elem('p', {}, [txt('before '), comment('a note to the typesetter'), txt('after')]))

    expect(flatText(fixture.root)).toBe('before after')
  })

  /* ONCE PER ELEMENT: climbing out of a block asks the facts the way in read. */
  it('reads each element’s style once, climbing out as well as in', () => {
    const fixture = buildFixture(
      elem('div', {}, [elem('p', {}, [txt('one')]), elem('p', {}, [txt('two')]), elem('p', {}, [txt('three')])]),
    )
    fixture.resetCounters()

    expect(flatText(fixture.root)).toBe('one\ntwo\nthree')
    expect(fixture.styleReads).toBe(4)
  })

  it('excludes a visibility:collapse subtree as it excludes a hidden one', () => {
    const fixture = buildFixture(
      elem('p', {}, [txt('shown '), elem('span', { visibility: 'collapse' }, [txt('HIDDENH')]), txt('after')]),
    )

    expect(flatText(fixture.root)).toBe('shown after')
  })

  /* Not one of these is a block box, and a `display` read by the wrong end of
     its name — `inline-block`, `ruby-base` — would say otherwise. */
  it('breaks at none of the displays that are not block boxes', () => {
    const fixture = buildFixture(
      elem('p', {}, [
        txt('one '),
        elem('span', { display: 'contents' }, [txt('two ')]),
        elem('span', { display: 'inline-block' }, [txt('three ')]),
        elem('span', { display: 'ruby-base' }, [txt('four ')]),
        elem('span', { display: '' }, [txt('five ')]),
        elem('span', { position: 'fixed' }, [txt('six')]),
      ]),
    )

    expect(flatText(fixture.root)).toBe('one two three four five six')
  })

  /* Entering a block is a boundary, not only leaving one — and leaving one is
     a boundary with no block after it. */
  it('puts a sentinel where inline text meets a block after it, and where a block meets text', () => {
    const into = buildFixture(elem('div', {}, [txt('before'), elem('p', {}, [txt('inside')])]))
    const out = buildFixture(elem('div', {}, [elem('p', {}, [txt('within')]), txt('after')]))

    expect(flatText(into.root)).toBe('before\ninside')
    expect(flatText(out.root)).toBe('within\nafter')
  })

  /* A walk that ran out of TREE has nothing to retreat from, however its last
     piece ends — there is no bound it could have cut a word at. */
  it('keeps everything a complete walk found, under an inline root ending mid-word', () => {
    const fixture = buildFixture(elem('span', {}, [txt('alpha '), elem('em', {}, [txt('beta')])]))

    const flat = flatten(fixture.root)

    expect([flat.strs.join(''), flat.truncatedEnd]).toEqual(['alpha beta', false])
  })

  /* Whitespace INSIDE a dropped piece is not a safe cut: the cut is at its edge. */
  it('does not take whitespace inside a dropped piece for a safe cut', () => {
    const fixture = buildFixture(
      elem('div', {}, [
        elem('span', {}, [txt('alpha ')]),
        elem('span', {}, [txt('Hel')]),
        elem('span', {}, [txt('lo wor')]),
        elem('span', {}, [txt('ld')]),
        elem('span', {}, [txt('zulu')]),
      ]),
    )

    expect(flatText(fixture.root, { maxChars: 18, anchors: [at(fixture, 'alpha ', 2)] })).toBe('alpha ')
  })

  it('does not take whitespace inside a dropped piece for a safe cut, walking back', () => {
    const fixture = buildFixture(
      elem('div', {}, [
        elem('span', {}, [txt('alpha')]),
        elem('span', {}, [txt('Hel')]),
        elem('span', {}, [txt('lo wor')]),
        elem('span', {}, [txt('ld')]),
        elem('span', {}, [txt(' omega')]),
      ]),
    )

    expect(flatText(fixture.root, { maxChars: 48, anchors: [at(fixture, ' omega', 2)] })).toBe(' omega')
  })

  /* Four visits exactly: the paragraph, its text, the span, the span's text. */
  it('walks exactly as many nodes as it is allowed, and not one more', () => {
    const fixture = buildFixture(elem('p', {}, [txt('a b'), elem('span', {}, [txt('c')])]))

    const fits = flatten(fixture.root, { maxNodes: 4 })
    const short = flatten(fixture.root, { maxNodes: 3 })

    expect([fits.strs.join(''), fits.truncatedEnd]).toEqual(['a bc', false])
    expect([short.strs.join(''), short.truncatedEnd]).toEqual(['a b', true])
  })

  /* The budget ahead is what is left after the seed AND what the walk behind
     actually took — nine characters here, out of a quarter of forty. */
  it('gives the walk ahead what the walk behind did not use, and no more', () => {
    const fixture = buildFixture(
      elem('div', {}, [
        elem('span', {}, [txt('aaaa ')]),
        elem('span', {}, [txt('bbb ')]),
        elem('span', {}, [txt('Seed ')]),
        elem('span', {}, [txt(`${'c'.repeat(13)} `)]),
        elem('span', {}, [txt(`${'d'.repeat(14)} `)]),
        elem('span', {}, [txt(`${'e'.repeat(14)} `)]),
      ]),
    )

    expect(flatText(fixture.root, { maxChars: 40, anchors: [at(fixture, 'Seed ', 1)] })).toBe(
      `aaaa bbb Seed ${'c'.repeat(13)} `,
    )
  })

  /* A backward piece's break belongs to the gap on its LATER side, so each
     sentinel behind the anchor has exactly one right place. */
  it('writes each sentinel behind the anchor into the gap it was found in', () => {
    const fixture = buildFixture(
      elem('div', {}, [
        elem('p', {}, [txt('first '), elem('em', {}, [txt('block')])]),
        elem('p', {}, [txt('second')]),
        elem('p', {}, [txt('third')]),
      ]),
    )

    expect(flatten(fixture.root, { anchors: [at(fixture, 'third', 2)] }).strs).toEqual([
      'first ',
      'block',
      SENTINEL,
      'second',
      SENTINEL,
      'third',
    ])
  })

  it('writes no leading sentinel behind an anchor whose block has one before it', () => {
    const fixture = buildFixture(elem('div', {}, [elem('p', {}, [txt('earlier')]), elem('p', {}, [txt('later')])]))

    expect(flatten(fixture.root, { anchors: [at(fixture, 'later', 1)] }).strs[0]).toBe('earlier')
  })

  /* The second sentinel, so the node before it does not start at zero and its
     length is its end MINUS its start. */
  it('maps a later sentinel to the nodes on either side of it', () => {
    const fixture = buildFixture(
      elem('div', {}, [elem('p', {}, [txt('aa')]), elem('p', {}, [txt('bbb')]), elem('p', {}, [txt('cccc')])]),
    )
    const flat = flatten(fixture.root)

    expect(flat.strs[3]).toBe(SENTINEL)
    expect(flat.fromFlat(3, 0)).toEqual({ node: fixture.text('bbb'), offset: 3 })
    expect(flat.fromFlat(3, 1)).toEqual({ node: fixture.text('cccc'), offset: 0 })
  })

  it('refuses a position that is not a whole number inside what it names', () => {
    const fixture = buildFixture(elem('div', {}, [elem('p', {}, [txt('aa')]), elem('p', {}, [txt('bbb')])]))
    const flat = flatten(fixture.root)
    const bbb = fixture.text('bbb')

    expect(flat.strs).toEqual(['aa', SENTINEL, 'bbb'])
    /* toFlat, on a node whose flat start is not zero. */
    expect(flat.toFlat(bbb, 3)).toEqual({ index: 2, offset: 3 })
    expect([flat.toFlat(bbb, 4), flat.toFlat(bbb, -1), flat.toFlat(bbb, 1.5)]).toEqual([null, null, null])
    /* fromFlat, the entry. */
    expect(flat.fromFlat(2, 3)).toEqual({ node: bbb, offset: 3 })
    expect([flat.fromFlat(3, 0), flat.fromFlat(-1, 0), flat.fromFlat(0.5, 0)]).toEqual([null, null, null])
    /* fromFlat, the offset inside a node's entry. */
    expect([flat.fromFlat(2, 4), flat.fromFlat(2, -1), flat.fromFlat(2, 1.5)]).toEqual([null, null, null])
  })
})

describe('snapInDom — what its mutants found', () => {
  /* The window is CENTRED on the selection: walked from the top, a paragraph
     longer than the whole budget hides everything after it. */
  it('snaps a word deep in a long chapter, which only a window centred on it can reach', () => {
    const far = 'the whale surfaced'
    const fixture = buildFixture(
      elem('div', {}, [elem('p', {}, [txt('Long ago. '.repeat(2_500))]), elem('p', {}, [txt(far)])]),
    )

    expect(snapInDom(fixture.root, at(fixture, far, 5), at(fixture, far, 7))).toEqual({
      start: at(fixture, far, 4),
      end: at(fixture, far, 9),
    })
  })

  it('leaves a selection alone when its end is outside the window', () => {
    const fixture = buildFixture(
      elem('div', {}, [
        elem('p', {}, [txt('near words')]),
        elem('p', {}, [txt('Far away. '.repeat(3_000))]),
        elem('p', {}, [txt('the end')]),
      ]),
    )

    expect(snapInDom(fixture.root, at(fixture, 'near words', 1), at(fixture, 'the end', 2))).toBeNull()
  })
})

const PLAIN_DOCUMENT = {
  defaultView: { getComputedStyle: () => ({ display: 'inline', visibility: 'visible', position: 'static' }) },
}

/** A plain-object node: the few fields `flatten` reads and nothing else. Two
 *  cases below need what `domFake.testkit.ts` does not give — a tree deeper
 *  than its recursive builder survives, and a count of sibling reads — and a
 *  tree this small reads more plainly than a new capability in the fake. */
type PlainNode = Record<string, unknown>

function plainElement(parentNode: PlainNode | null): PlainNode {
  return {
    nodeType: 1,
    tagName: 'SPAN',
    parentNode,
    firstChild: null,
    lastChild: null,
    nextSibling: null,
    previousSibling: null,
    ownerDocument: PLAIN_DOCUMENT,
  }
}

/**
 * What an audit found. Each case names the rule it holds, on the smallest tree
 * that shows it.
 */
describe('flatten — what an audit found', () => {
  /*
   * NOT EVERY `\s` IS A PLACE NO WORD SPANS. U+FEFF is Format and U+202F is
   * ExtendNumLet, and UAX #29 joins letters across both — so a window ending
   * `abc<U+FEFF>` was called safe and snapped `abc`, where the whole walk
   * selects the word. Asked of the segmenter for EVERY `\s` member rather than
   * listed, the way the sentinel is pinned; four cuts per character, beside it
   * on either side, walking either way.
   */
  it('takes no whitespace the word segmenter joins into a word for a safe cut, in either direction', () => {
    const whitespace = Array.from({ length: 0x1_0000 }, (_, unit) => String.fromCharCode(unit)).filter((c) =>
      /\s/.test(c),
    )
    const code = (c: string): string => c.charCodeAt(0).toString(16)
    /* Whether a word runs across offset `cut` of `text`. */
    const joins = (text: string, cut: number): boolean =>
      [...new Intl.Segmenter('en', { granularity: 'word' }).segment(text)].some(
        (part) => isWordLike(part.segment) && part.index < cut && cut < part.index + part.segment.length,
      )

    const measured = whitespace.map((c) => {
      const trailing = buildFixture(elem('div', {}, [elem('span', {}, [txt(`abc${c}`)]), elem('span', {}, [txt('defgh')])]))
      const leading = buildFixture(elem('div', {}, [elem('span', {}, [txt('abc')]), elem('span', {}, [txt(`${c}defgh`)])]))
      return {
        code: code(c),
        aheadAfter: flatten(trailing.root, { maxChars: 4, anchors: [at(trailing, `abc${c}`, 1)] }).truncatedEnd,
        aheadBefore: flatten(leading.root, { maxChars: 3, anchors: [at(leading, 'abc', 1)] }).truncatedEnd,
        behindBefore: flatten(leading.root, { maxChars: 8, anchors: [at(leading, `${c}defgh`, 2)] }).truncatedStart,
        behindAfter: flatten(trailing.root, { maxChars: 4, anchors: [at(trailing, 'defgh', 1)] }).truncatedStart,
      }
    })

    expect(measured).toEqual(
      whitespace.map((c) => ({
        code: code(c),
        aheadAfter: joins(`abc${c}defgh`, 4),
        aheadBefore: joins(`abc${c}defgh`, 3),
        behindBefore: joins(`abc${c}defgh`, 3),
        behindAfter: joins(`abc${c}defgh`, 4),
      })),
    )
    /* Non-vacuity for the oracle: it finds the two this was found on, and only those. */
    expect(whitespace.filter((c) => joins(`abc${c}defgh`, 4)).map(code)).toEqual(['202f', 'feff'])
  })

  /*
   * A NODE THE BUDGET REFUSES IS STILL EVIDENCE. It was read, and whitespace at
   * the edge the walk arrived at makes the cut in front of it safe — so
   * `['word', ' next sentence']` under a four-character budget was declined
   * against a cut beside a space.
   */
  it('takes whitespace at the near edge of a node the budget refused for a safe cut', () => {
    const ahead = buildFixture(elem('p', {}, [txt('word'), elem('span', {}, [txt(' next sentence')])]))
    const behind = buildFixture(elem('p', {}, [elem('span', {}, [txt('earlier words ')]), txt('mot')]))

    const forward = flatten(ahead.root, { maxChars: 4, anchors: [at(ahead, 'word', 1)] })
    const backward = flatten(behind.root, { maxChars: 3, anchors: [at(behind, 'mot', 1)] })

    expect([forward.strs, forward.truncatedEnd]).toEqual([['word'], false])
    expect([backward.strs, backward.truncatedStart]).toEqual([['mot'], false])
    expect(snapInDom(ahead.root, at(ahead, 'word', 1), at(ahead, 'word', 2), { maxChars: 4 })).toEqual({
      start: at(ahead, 'word', 0),
      end: at(ahead, 'word', 4),
    })
    /* Non-vacuity: a refused node that begins with a letter is no evidence. */
    const welded = buildFixture(elem('p', {}, [txt('term'), elem('span', {}, [txt('inal words')])]))
    expect(flatten(welded.root, { maxChars: 4, anchors: [at(welded, 'term', 1)] }).truncatedEnd).toBe(true)
  })

  /*
   * ONCE THE BUDGET IS SPENT, NOTHING MORE IS READ — not a child, and not the
   * pointer to the next one. Every call past the budget refused at its first
   * line, which read as "touches nothing", while the loop making those calls
   * stepped through every remaining sibling.
   */
  it('stops stepping through siblings the moment the node budget is spent', () => {
    const root = plainElement(null)
    const children = Array.from({ length: 10_000 }, () => plainElement(root))
    let siblingReads = 0
    children.forEach((child, i) => {
      Object.defineProperty(child, 'nextSibling', {
        get: () => {
          siblingReads += 1
          return children[i + 1] ?? null
        },
      })
    })
    root['firstChild'] = children[0]
    root['lastChild'] = children[children.length - 1]

    const flat = flatten(root as unknown as Element, { maxNodes: 2 })

    expect(flat.truncatedEnd).toBe(true)
    expect(siblingReads).toBeLessThanOrEqual(2)
  })

  /*
   * A LOOP, NOT RECURSION. Nesting ten thousand deep threw `RangeError: Maximum
   * call stack size exceeded` out of a walk whose contract is to decline, long
   * before the node budget could. Fifty thousand, so the case does not depend
   * on how large this machine's stack happens to be.
   */
  it('walks a tree nested far deeper than the stack, without throwing', () => {
    const root = plainElement(null)
    let deepest = root
    for (let level = 0; level < 50_000; level += 1) {
      const child = plainElement(deepest)
      deepest['firstChild'] = child
      deepest['lastChild'] = child
      deepest = child
    }
    const leaf = { nodeType: 3, data: 'at the bottom', parentNode: deepest, nextSibling: null, previousSibling: null }
    deepest['firstChild'] = leaf
    deepest['lastChild'] = leaf

    expect(flatten(root as unknown as Element, { maxNodes: 100_000 }).strs).toEqual(['at the bottom'])
    /* And the budget still refuses the same tree when it is the smaller of the two. */
    expect(flatten(root as unknown as Element, { maxNodes: 1_000 })).toMatchObject({ strs: [], truncatedEnd: true })
  })

  /*
   * THE CLIMB FROM THE ANCHOR IS CHARGED TO THE BUDGET. It reads a style at
   * every level on the way up, and reading them free let a one-node budget read
   * a hundred and one.
   */
  it('charges the climb from the anchor to the node budget', () => {
    let spec: Spec = txt('deep text')
    for (let level = 0; level < 100; level += 1) spec = elem('span', {}, [spec])
    const fixture = buildFixture(elem('div', {}, [spec]))
    const anchor = at(fixture, 'deep text', 1)

    fixture.resetCounters()
    const refused = flatten(fixture.root, { maxNodes: 50, anchors: [anchor] })

    expect(fixture.styleReads).toBeLessThanOrEqual(50)
    expect([refused.strs, refused.truncatedStart, refused.truncatedEnd]).toEqual([[], true, true])
    /* Non-vacuity: with room for the climb, the same anchor is read. */
    expect(flatten(fixture.root, { maxNodes: 200, anchors: [anchor] }).strs).toEqual(['deep text'])
  })

  /* A sentinel's offset is held to the sentinel, as a node's is to the node. It was clamped. */
  it('refuses an offset into a sentinel that is not 0 or 1', () => {
    const fixture = buildFixture(elem('div', {}, [elem('p', {}, [txt('left')]), elem('p', {}, [txt('right')])]))
    const flat = flatten(fixture.root)

    expect(flat.strs).toEqual(['left', SENTINEL, 'right'])
    expect(
      [-1, 0.5, 2, Number.NaN, Number.POSITIVE_INFINITY].map((offset) => flat.fromFlat(1, offset)),
    ).toEqual([null, null, null, null, null])
    expect([flat.fromFlat(1, 0), flat.fromFlat(1, 1)]).toEqual([at(fixture, 'left', 4), at(fixture, 'right', 0)])
  })
})

describe('walkRoot', () => {
  it('climbs to the topmost element above a node', () => {
    const fixture = buildFixture(elem('div', {}, [elem('p', {}, [elem('em', {}, [txt('deep')])])]))

    expect(walkRoot(fixture.text('deep'))).toBe(fixture.root)
    expect(walkRoot(fixture.root)).toBe(fixture.root)
  })

  /* The topmost ELEMENT: a fragment or document above it is not one. */
  it('stops at the topmost element, stepping past a parent that is not one', () => {
    const top = { nodeType: 11, parentNode: null }
    const el = { nodeType: 1, parentNode: top }
    const text = { nodeType: 3, parentNode: el }

    expect(walkRoot(text as unknown as Node)).toBe(el)
  })

  it('answers null for a node with no element above it', () => {
    expect(walkRoot({ nodeType: 3, parentNode: null } as unknown as Node)).toBeNull()
  })
})
