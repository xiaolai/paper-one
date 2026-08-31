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
    expect(curly).toContain(`"who ain't a slave?"`)
    expect(straight).toContain(`"who ain't a slave?"`)
  })

  it('reads no text out of a script, which is text the reader cannot see', () => {
    /* `flatten`'s `SKIPPED_TAGS` rule. A resolver that indexed script source
       would anchor a mark inside code — and, worse, would shift every offset
       after it. */
    const index = indexText(docOf('gutenberg', 1).body)
    expect(index.text).not.toContain('reading-progress')
    expect(index.text).toContain('call me ishmael')
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
      expect(index.to[i]!).toBeGreaterThan(index.from[i]!)
      expect(index.to[i]!).toBeLessThanOrEqual(node!.data.length)
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
    expect(each, `one resolution over a 22k section took ${each.toFixed(1)}ms`).toBeLessThan(250)
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
    expect(each, `one cold section took ${each.toFixed(1)}ms`).toBeLessThan(250)
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
