// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parse, toRange } from 'foliate-js/epubcfi.js'
import {
  BUILD_IDS,
  CORPUS_BUILDS,
  CORPUS_PASSAGES,
  type BuildId,
  type CorpusPassage,
} from '../../core/markCorpus.testkit'
import { canonicalise, cfiFor, indexText, reanchor } from './reanchor'

/**
 * WI-21.S — the spike's own evidence.
 *
 * The question the plan asks is one sentence: *"Can we produce a CORRECT ANCHOR
 * IN THE RENDERED DOM for a known passage from another build, at a cost that
 * does not disturb reading?"* This file answers the first half against the
 * corpus and measures the second.
 *
 * ⚠️ **WHAT A PASS HERE DOES AND DOES NOT MEAN.** It means the resolver finds
 * the right words in a document it has been handed, and that the CFI derived
 * from the range resolves back to those same words. It does NOT mean the
 * approach is shippable: the resolver only reaches sections that have been
 * rendered, and jsdom is not a paginating reader. Both limits are recorded in
 * the plan beside the verdict.
 */

const docOf = (build: BuildId, sectionIndex: number): Document =>
  new DOMParser().parseFromString(
    `<html><body>${CORPUS_BUILDS[build].sections[sectionIndex]!.xhtml}</body></html>`,
    'text/html',
  )

/** The passage as build A's archive would carry it. */
const asArchived = (passage: CorpusPassage, from: BuildId) => ({
  quote: passage.places[from].quote,
  prefix: passage.places[from].prefix,
  suffix: passage.places[from].suffix,
})

/** Every crossing where the same passage really is in both builds. */
const CROSSINGS: readonly (readonly [BuildId, BuildId])[] = [
  ['gutenberg', 'standard-ebooks'],
  ['standard-ebooks', 'gutenberg'],
  ['gutenberg', 'commercial'],
  ['commercial', 'standard-ebooks'],
]

describe('the canonical index', () => {
  it('gives a spaced em-dash and an unspaced one the same canonical form', () => {
    /* THE LENGTH-CHANGING FOLD, and the reason the origin map exists at all.
       `A — B` and `A—B` are the same words set two ways; a character-for-
       character normaliser cannot make them equal, so the map has to survive a
       fold that does not preserve length. */
    const spaced = indexText(docOf('standard-ebooks', 3).body)
    const unspaced = indexText(docOf('gutenberg', 2).body)
    expect(spaced.text).toContain('looked at—and not read about')
    expect(unspaced.text).toContain('looked at—and not read about')
  })

  it('gives curly and straight quotation marks the same canonical form', () => {
    const curly = indexText(docOf('standard-ebooks', 2).body).text
    const straight = indexText(docOf('gutenberg', 1).body).text
    expect(curly).toContain(`"Who ain't a slave?"`)
    expect(straight).toContain(`"Who ain't a slave?"`)
  })

  it('does NOT fold case, which is the decision WI-22.A0 restored', () => {
    /* ⚠️ **THE ASSERTION THAT PINS A0, and it is deliberately a WHOLE STRING
       rather than a substring.** `canonicalChar` ended in `.toLowerCase()` in
       shipped code while `phase-21-the-circle.md` had decided *"no case
       folding, because case is meaningful in a quote"* —
       `docs/design/circle/review.md` found the contradiction by running the
       check. The plan's falsifier for A0 is that the corpus stops anchoring
       across builds, which the crossing tests below answer; this is the other
       half, and without it the fold can come back looking green.

       `'US'` against `'us'` is the concrete cost of folding: a passage about a
       country would anchor on a pronoun, and `reanchor`'s gate is EXACT
       canonical equality — so a character the fold drops is evidence the gate
       no longer has. */
    expect(canonicalise('US')).not.toBe(canonicalise('us'))
    expect(canonicalise('US')).toBe('US')

    /* The other four folds are UNCHANGED, which is the rest of A0's acceptance.
       Whole strings, so a fold that quietly stopped folding fails here. */
    expect(canonicalise('\u2018quoted\u2019')).toBe(`'quoted'`)
    expect(canonicalise('\u201Cquoted\u201D')).toBe(`"quoted"`)
    expect(canonicalise('en\u2013dash')).toBe('en\u2014dash')
    expect(canonicalise('A \u2014 B')).toBe('A\u2014B')
    expect(canonicalise('a  \n b')).toBe('a b')
    expect(canonicalise('soft\u00ADhyphen')).toBe('softhyphen')
  })

  it('reads no text out of a script, which is text the reader cannot see', () => {
    /* `flatten`'s `SKIPPED_TAGS` rule. A resolver that indexed script source
       would anchor a mark inside code — and, worse, would shift every offset
       after it. */
    const index = indexText(docOf('gutenberg', 1).body)
    expect(index.text).not.toContain('reading-progress')
    expect(index.text).toContain('Call me Ishmael')
  })

  it('is NOT bounded, which is the thing flatten could not give route B', () => {
    /* ⚠️ `flatten` stops at 20 000 characters and *"can be incomplete while
       reporting `truncatedEnd === false`"*. The corpus's Cetology section is
       over 22 800, and its last passage is past the bound on purpose. A
       resolver that gave up there would report "not in this build" for a
       passage that is plainly in it. */
    const index = indexText(docOf('gutenberg', 2).body)
    expect(index.text.length).toBeGreaterThan(20_000)
    expect(index.text).toContain('a thing to be looked at')
  })

  it('maps every canonical character back to a real source offset', () => {
    const index = indexText(docOf('commercial', 3).body)
    for (let i = 0; i < index.text.length; i += 1) {
      const node = index.nodes[index.node[i]!]
      expect(node, `character ${i} has no node`).toBeDefined()
      expect(index.from[i]!).toBeGreaterThanOrEqual(0)
      expect(index.to[i]!).toBeLessThanOrEqual(node!.data.length)
      /* ⚠️ **A SPACE MAY BE ZERO-WIDTH; EVERY OTHER CHARACTER MAY NOT.** This
         asserted `to > from` for all of them, which was right until the walk
         started emitting a break at block edges: a boundary between `</p>` and
         `<p>` has NO source character behind it, and its honest origin is the
         zero-width position just past the last real one. The first attempt gave
         it `lastOff..lastOff + 1` to satisfy the old assertion and that offset
         is one past the node's length — this test caught it, which is what it
         is for. */
      if (index.text[i] === ' ') expect(index.to[i]!).toBeGreaterThanOrEqual(index.from[i]!)
      else expect(index.to[i]!).toBeGreaterThan(index.from[i]!)
    }
  })

  it('never begins or ends a canonical quote with a space', () => {
    /* ⚠️ **WHAT MAKES THE ZERO-WIDTH BOUNDARY SAFE FOR THE RANGE.** The range's
       ends are `from[best]` and `to[last]`, so a zero-width origin would matter
       if a match could start or end on one. It cannot: `canonicalise` never
       leads with a space (nothing is emitted while the output is empty) and
       never trails with one (a pending space at the end is simply dropped), and
       a match is an exact substring of that canonical quote.

       Asserted rather than reasoned about in a comment, because it is the
       premise the whole boundary change rests on. */
    for (const passage of CORPUS_PASSAGES) {
      for (const build of BUILD_IDS) {
        const quote = canonicalise(passage.places[build].quote)
        if (quote === '') continue
        expect(quote.startsWith(' '), `${passage.id}/${build}`).toBe(false)
        expect(quote.endsWith(' '), `${passage.id}/${build}`).toBe(false)
      }
    }
    expect(canonicalise('   leading and trailing   ')).toBe('leading and trailing')
  })

  it('breaks the text at a block edge, so two paragraphs do not run together', () => {
    /* ⚠️ **`<p>done</p><p>Start</p>` INDEXED AS `doneStart`** — a word in
       neither paragraph, which invents matches across a break and loses every
       real one. The other side of the comparison already had the boundary:
       `markContext` captures through `flatten`, which emits `SENTINEL` at
       exactly these edges. The defect was the asymmetry between the two walks. */
    const doc = new DOMParser().parseFromString(
      '<html><body><p>done</p><p>Start</p><p>a<br>b</p></body></html>',
      'text/html',
    )
    const index = indexText(doc.body)
    expect(index.text).toBe('done Start a b')
    expect(index.text).not.toContain('doneStart')
  })

  /**
   * ⚠️ **ONE CASE PER TAG, AND THE LIST IS WRITTEN OUT RATHER THAN READ.** The
   * set is a list of literals in the module, so a test that imports it and loops
   * agrees with whatever the module says — including with a tag somebody deleted.
   * Written here it is a second statement of the same contract, and the two have
   * to be edited together to change it.
   *
   * ⚠️ **AND THE DOM IS BUILT, NOT PARSED.** An HTML parser foster-parents a
   * stray `<td>` out of the body and drops it, so half of these tags cannot be
   * written as markup outside their own container — and a fixture that silently
   * loses its element passes for the wrong reason. `createElement` is the same
   * tree without the parser's opinion of it.
   */
  it.each([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'CAPTION', 'DD', 'DIV', 'DL', 'DT',
    'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD',
    'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
  ])('breaks the text at a <%s> edge, on both sides of it', (tag) => {
    const doc = new DOMParser().parseFromString('<html><body></body></html>', 'text/html')
    const block = doc.createElement(tag)
    block.textContent = 'Start'
    doc.body.append(doc.createTextNode('done'), block, doc.createTextNode('after'))
    expect(indexText(doc.body).text).toBe('done Start after')
  })

  it('and does not break at an inline one, which is what makes that a test', () => {
    /* The known negative. Every case above asserts a space appears; without
       this, a walk that broke at EVERY element would pass all thirty-seven of
       them and split every word an `<em>` divides. */
    const doc = new DOMParser().parseFromString('<html><body></body></html>', 'text/html')
    const inline = doc.createElement('em')
    inline.textContent = 'oper'
    doc.body.append(doc.createTextNode('co'), inline, doc.createTextNode('ate'))
    expect(indexText(doc.body).text).toBe('cooperate')
  })

  /**
   * The fold table, one case per entry.
   *
   * ⚠️ **BUILT FROM CODE POINTS, NOT TYPED.** These characters are invisible to
   * a reviewer as themselves — a right single quotation mark and an apostrophe
   * are one pixel apart in most fonts — and this repository has already had an
   * escape typed into an edit arrive as the character itself. A code point says
   * which one it is and cannot be mistyped into its neighbour.
   */
  it.each([
    [0x2018, "'"],
    [0x2019, "'"],
    [0x201a, "'"],
    [0x201b, "'"],
    [0x201c, '"'],
    [0x201d, '"'],
    [0x201e, '"'],
    [0x201f, '"'],
    [0x2013, String.fromCodePoint(0x2014)],
    [0x2012, String.fromCodePoint(0x2014)],
    [0x2015, String.fromCodePoint(0x2014)],
  ] as const)('folds U+%s to its canonical form', (from, to) => {
    expect(canonicalise(`a${String.fromCodePoint(from)}b`)).toBe(`a${to}b`)
  })

  it('leaves the character it folds TO alone, and everything outside the table', () => {
    /* The other known negative: a fold table whose values were all empty would
       pass nothing above, but one that mapped everything to the same character
       would pass every case and destroy the text. */
    for (const ch of ["'", '"', String.fromCodePoint(0x2014), 'a', ' ']) {
      expect(canonicalise(`x${ch}y`)).toBe(`x${ch}y`)
    }
  })
})

describe('re-anchoring a foreign passage (WI-21.S, route B)', () => {
  it.each(CROSSINGS)('lands every corpus passage from %s in %s', (from, onto) => {
    /* THE SPIKE'S CENTRAL CLAIM, over the whole corpus rather than one
       passage: every labelled passage, carried from one build's archive, is
       found in another build's rendered document — and the range covers the
       words that build sets, not the words the archive carried. */
    for (const passage of CORPUS_PASSAGES) {
      const target = passage.places[onto]
      const doc = docOf(onto, target.sectionIndex)
      const found = reanchor(doc.body, asArchived(passage, from))
      expect(found, `${passage.id}: ${from} -> ${onto}`).not.toBeNull()
      /* ⚠️ COMPARED THROUGH THE MODULE'S OWN CANONICALISER, not a hand-rolled
         one. The range holds the TARGET build's raw text — curly quotes, its
         own dash spacing — and the first version of this assertion folded the
         two sides by different rules and failed on the typography passage,
         which is the one passage it most needed to get right. */
      expect(canonicalise(found!.range.toString())).toBe(canonicalise(target.quote))
    }
  })

  it('picks the SECOND "the whale", which is what the context is for', () => {
    /* ⚠️ THE CASE A QUOTE ALONE CANNOT DECIDE. "the whale" occurs three times
       in Cetology; the archive carries nine characters and thirty-two either
       side, and only the second is what the reader marked. A resolver that
       took the first occurrence would be wrong two thirds of the time here and
       would look like it was working. */
    const passage = CORPUS_PASSAGES.find((one) => one.covers === 'occurs-more-than-once')!
    const onto: BuildId = 'standard-ebooks'
    const target = passage.places[onto]
    const doc = docOf(onto, target.sectionIndex)
    const found = reanchor(doc.body, asArchived(passage, 'gutenberg'))
    expect(found).not.toBeNull()
    expect(found!.occurrences).toBeGreaterThan(1)
    /* ⚠️ ASKED OF THE RANGE'S OWN CONTAINER, not of `indexOf` over the section.
       The first version searched the whole text for the range's STRING — which
       is "the whale" — and so found occurrence ONE every time, and would have
       passed against a resolver that always picked the first. The range knows
       where it is; the string does not. */
    const paragraph = found!.range.startContainer.parentElement!.textContent!
    expect(paragraph).toContain('Yet the whale is no fish')
    expect(paragraph).not.toContain('the ancients said so')
    expect(found!.confidence).toBeGreaterThan(0.5)
  })

  it('finds a passage past flatten’s bound', () => {
    const passage = CORPUS_PASSAGES.find((one) => one.covers === 'past-flatten-bound')!
    const target = passage.places['standard-ebooks']
    const doc = docOf('standard-ebooks', target.sectionIndex)
    const found = reanchor(doc.body, asArchived(passage, 'gutenberg'))
    expect(found).not.toBeNull()
    expect(found!.range.toString()).toContain('a thing to be looked at')
  })

  it('refuses a passage that is not in this build at all', () => {
    /* NULL RATHER THAN A GUESS. The whole point of Stage 1 was that a wrong
       anchor is worse than none, and a resolver that always answers has simply
       moved the defect. */
    const doc = docOf('gutenberg', 1)
    expect(reanchor(doc.body, { quote: 'the pequod sank at dawn', prefix: '', suffix: '' })).toBeNull()
  })

  it('refuses when the quote repeats and nothing in the context agrees', () => {
    /* The hard gate is on the QUOTE; the context only chooses between exact
       matches. With several matches and no agreement there is nothing to
       choose on, and choosing anyway is how the wrong sentence gets marked. */
    const doc = new DOMParser().parseFromString(
      '<html><body><p>alpha the whale omega</p><p>zulu the whale yankee</p></body></html>',
      'text/html',
    )
    expect(
      reanchor(doc.body, { quote: 'the whale', prefix: 'nothing like this', suffix: 'nor this either' }),
    ).toBeNull()
  })
})

describe('the CFI the spike derives', () => {
  it.each(CROSSINGS)('resolves back to the same words it was derived from (%s -> %s)', (from, onto) => {
    /* ⚠️ **"CORRECT BY CONSTRUCTION" IS A CLAIM, AND THIS IS THE CHECK.** The
       range is built in the document the reader is looking at, so the CFI
       derived from it should address the words it was derived from. Asserted
       by round-tripping through foliate's own `fromRange`/`toRange` rather
       than by inspecting the string — the string is not the contract. */
    for (const passage of CORPUS_PASSAGES) {
      const target = passage.places[onto]
      const doc = docOf(onto, target.sectionIndex)
      const found = reanchor(doc.body, asArchived(passage, from))!
      const local = cfiFor(target.sectionIndex, found.range).replace(/^epubcfi\(\/6\/\d+!/u, 'epubcfi(')
      const back = toRange(doc, parse(local))
      expect(back.toString(), `${passage.id}: ${from} -> ${onto}`).toBe(found.range.toString())
    }
  })

  it('opens on the spine step the section index names', () => {
    const doc = docOf('commercial', 3)
    const passage = CORPUS_PASSAGES.find((one) => one.covers === 'spine-index-differs')!
    const found = reanchor(doc.body, asArchived(passage, 'gutenberg'))!
    /* Section 3 → `/6/8`, the same arithmetic the corpus's own labels use. */
    expect(cfiFor(3, found.range)).toMatch(/^epubcfi\(\/6\/8!/u)
  })
})

describe('a section the reader has never opened', () => {
  /**
   * ⚠️ **ROUTE B'S "UNSOLVED PIECE" WAS NOT A PIECE, AND I COPIED THE CLAIM
   * WITHOUT CHECKING IT.**
   *
   * The plan says route B *"only reaches RENDERED sections"*, because
   * `renderer.getContents()` is the only way past foliate's closed shadow
   * roots. That is true of the LIVE document — and anchoring does not need the
   * live document. A CFI is a PATH, not a node reference: it is valid in any
   * document with the same structure.
   *
   * `book.sections[i].createDocument()` parses any section, opened or not, and
   * `refuseBookScripts` wraps every one of them so the strip is applied there
   * too — which is precisely what WI-21.P1 fixed, and what
   * `bookScripts.test.ts`'s *"address the same passage by the same path"*
   * asserts. Nothing else mutates the rendered body: `setStyles` writes to the
   * head and the loader sets a `lang` ATTRIBUTE, and neither shifts a child
   * index.
   *
   * So a mark in chapter 40 of a book opened at chapter 1 CAN be anchored. This
   * suite was in fact already proving it and did not say so: `docOf` parses a
   * fresh document exactly as `createDocument()` does, and never touched a
   * renderer.
   */
  const createDocument = async (build: BuildId, sectionIndex: number): Promise<Document> =>
    /* The shape foliate hands back — async, a freshly parsed document, no
       renderer anywhere near it. */
    docOf(build, sectionIndex)

  it('anchors a passage in a section that was never laid out', async () => {
    const passage = CORPUS_PASSAGES.find((one) => one.covers === 'past-flatten-bound')!
    const onto: BuildId = 'standard-ebooks'
    const target = passage.places[onto]
    const cold = await createDocument(onto, target.sectionIndex)
    const found = reanchor(cold.body, asArchived(passage, 'gutenberg'))
    expect(found).not.toBeNull()
    expect(canonicalise(found!.range.toString())).toBe(canonicalise(target.quote))
  })

  it('anchors every passage in every section of every build, cold', async () => {
    /* The whole spine, not one chapter — the case a reader importing an
       archive actually presents, where nothing has been opened yet. */
    for (const passage of CORPUS_PASSAGES) {
      for (const onto of BUILD_IDS) {
        const target = passage.places[onto]
        const cold = await createDocument(onto, target.sectionIndex)
        const found = reanchor(cold.body, asArchived(passage, 'gutenberg'))
        expect(found, `${passage.id} in ${onto} §${target.sectionIndex}`).not.toBeNull()
        expect(canonicalise(found!.range.toString())).toBe(canonicalise(target.quote))
      }
    }
  })

  it('derives a CFI from the cold document that resolves in it', async () => {
    /* The claim that matters: the anchor produced without a renderer is a real
       anchor. Round-tripped through foliate's own parser, as the rendered case
       is. */
    const passage = CORPUS_PASSAGES.find((one) => one.covers === 'spine-index-differs')!
    const target = passage.places.commercial
    const cold = await createDocument('commercial', target.sectionIndex)
    const found = reanchor(cold.body, asArchived(passage, 'gutenberg'))!
    const local = cfiFor(target.sectionIndex, found.range).replace(/^epubcfi\(\/6\/\d+!/u, 'epubcfi(')
    expect(toRange(cold, parse(local)).toString()).toBe(found.range.toString())
  })
})

/**
 * The ceiling both cost checks assert against.
 *
 * ⚠️ **IT IS A COMPLEXITY DETECTOR, NOT A PERFORMANCE BUDGET, and 250 ms was
 * the wrong number for that job.** Both tests below already say what they are
 * for: *"The bound is deliberately loose for that reason: it fails on a
 * resolver that became quadratic, and on nothing else."* 250 ms against a
 * 3.46 ms measurement is a 70× margin, which sounds generous and is not — under
 * jsdom, v8 coverage instrumentation and a loaded machine the same work
 * measured **383 ms** and failed, in a run whose `setup` and `transform` times
 * had both doubled against the previous green one. Nothing about the resolver
 * had changed.
 *
 * ⚠️ **THIS IS THE THIRD BOUND IN THIS SUITE SIZED ON AN IDLE MACHINE AND
 * EVALUATED ON A BUSY ONE** — after the `scripts` project's 15 s `testTimeout`
 * and Testing Library's 1 s `asyncUtilTimeout`. The mechanism is one mechanism,
 * and it is worth naming: a number measured once, on a quiet laptop, becomes a
 * gate that decides on load.
 *
 * 2 000 ms keeps a ~570× margin over the idle measurement. A genuinely
 * quadratic resolver on a 22 904-character section is seconds to minutes, not
 * hundreds of milliseconds, so nothing this test exists to catch escapes.
 */
const COMPLEXITY_CEILING_MS = 2_000

describe('what it costs', () => {
  it('resolves a whole 22 000-character section well inside a frame', () => {
    /* ⚠️ **NOT AN ACCEPTANCE CRITERION.** The plan is explicit that a
       measurement is a dated reading, and this one is taken under jsdom on
       whatever machine ran the suite — it is a SHAPE check, not the
       "longest-section input latency on a named device against a recorded
       baseline" the spike's falsifier calls for. What it can rule out is an
       approach that is orders of magnitude wrong.
       The bound is deliberately loose for that reason: it fails on a resolver
       that became quadratic, and on nothing else. */
    const doc = docOf('gutenberg', 2)
    const passage = CORPUS_PASSAGES.find((one) => one.covers === 'past-flatten-bound')!
    const started = performance.now()
    const runs = 10
    for (let i = 0; i < runs; i += 1) {
      expect(reanchor(doc.body, asArchived(passage, 'standard-ebooks'))).not.toBeNull()
    }
    const each = (performance.now() - started) / runs
    expect(each, `one resolution over a 22k section took ${each.toFixed(1)}ms`).toBeLessThan(COMPLEXITY_CEILING_MS)
  })

  it('parses and resolves a COLD section inside a frame', () => {
    /* The cost of reaching a section nobody has opened — the parse plus the
       walk plus the search — because that is the whole cost of route B once
       `createDocument()` removes the rendered-only limit. Measured at 3.46 ms
       for a 22 904-character section, so forty unopened sections are ~139 ms:
       a one-off at import time, not a cost on the reading path.

       The bound is loose for `what it costs`'s stated reason — it fails on an
       approach that became quadratic, and on nothing else. */
    const xhtml = `<html><body>${CORPUS_BUILDS.gutenberg.sections[2]!.xhtml}</body></html>`
    const passage = CORPUS_PASSAGES.find((one) => one.covers === 'past-flatten-bound')!
    const started = performance.now()
    const runs = 10
    for (let i = 0; i < runs; i += 1) {
      const cold = new DOMParser().parseFromString(xhtml, 'text/html')
      expect(reanchor(cold.body, asArchived(passage, 'standard-ebooks'))).not.toBeNull()
    }
    const each = (performance.now() - started) / runs
    expect(each, `one cold section took ${each.toFixed(1)}ms`).toBeLessThan(COMPLEXITY_CEILING_MS)
  })

  it('indexes every build’s every section without a bound', () => {
    /* The walk is the cost, and it is linear in the section. Asserted over the
       whole corpus so a build with an unusual shape cannot be the one nobody
       measured. */
    for (const id of BUILD_IDS) {
      for (const [at] of CORPUS_BUILDS[id].sections.entries()) {
        const index = indexText(docOf(id, at).body)
        expect(index.node.length).toBe(index.text.length)
        expect(index.from.length).toBe(index.text.length)
      }
    }
  })
})

describe('ResolvedCfi, the painter\'s door', () => {
  it('mints from a live range, which is the evidence a foreign passage lacks', () => {
    /* `cfiFor`'s soundness is its ARGUMENT. A resolved passage produces a
       Range in this document; the three strings a foreign passage arrives as
       produce nothing, so there is no way to reach the mint without first
       having found the words. */
    const doc = docOf('gutenberg', 1)
    const found = reanchor(doc.body, asArchived(CORPUS_PASSAGES[0]!, 'standard-ebooks'))
    expect(found).not.toBeNull()
    expect(cfiFor(1, found!.range)).toMatch(/^epubcfi\(\/6\/4!/)
  })
})
