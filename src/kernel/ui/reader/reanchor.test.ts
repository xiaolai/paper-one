// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
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
  /* ⚠️ **WI-22.A1's FALSIFIER, RUN AS A TEST rather than left as a `rg` in a
     plan nobody re-runs.** The plan states it as *"`rg` for the brand cast
     across `src/` returns any hit outside the resolver — if a second minting
     site exists, the type is decoration"*, and a falsifier that lives in a
     document fires once, on the day somebody remembers it.

     It names a WHOLE SET rather than a count, which is the plan's own stated
     preference: a count passes when one mint is added and another deleted in
     the same change, and the set says which file. */

  /* `process.cwd()` is the repo root under vitest — the config lives there and
     vitest does not change directory. Not `import.meta.url`: this suite runs in
     the jsdom environment, where it is not a `file:` URL and `readFileSync`
     refuses it. */
  const REPO_ROOT = process.cwd()

  /* ⚠️ **ASSEMBLED, NOT WRITTEN OUT, and the first version was written out.**
     A test that searches the tree for a string is in the tree, so spelling the
     needle literally made this file match itself — the walk returned three
     paths and the failure looked like a real second mint. Any check of this
     shape has the same trap; joining the halves is the whole fix, and it is
     why no path is excluded from the walk below. Excluding this file would
     have hidden a genuine mint added to it later. */
  const NEEDLE = ['as', 'ResolvedCfi'].join(' ')

  /**
   * The OTHER spelling of the same cast, and it is the one that got past.
   *
   * ⚠️ **`x as never` MINTS A `ResolvedCfi` JUST AS WELL AS `x as ResolvedCfi`,
   * and an audit found one in production while this test was green.** The
   * circle capability widened the resolver's answer with `fresh.cfi as never`
   * — so any string reaching that seam reached the painter, and the falsifier
   * that exists to make that impossible could not see it.
   *
   * `never` is assignable to every type, which is exactly what makes it a
   * universal cast and exactly why a brand check must look for it. The real
   * fix was to type the seam so no cast is needed at all; this is what stops
   * the next one being invisible.
   */
  const ANY_CAST = ['as', 'never'].join(' ')

  /**
   * The file with its comments removed.
   *
   * ⚠️ **PROSE ABOUT A CAST IS NOT A CAST, and the second thing this check did
   * was report three files that describe the rule.** `core/resolvedCfi.ts`
   * explains where the one cast lives, and this suite explains what the grep
   * can and cannot see — both by writing the cast out. Deleting the sentences
   * would have worked and would have been the wrong fix: the check would go on
   * failing for the next person who explains the rule, and the pressure would
   * be to stop explaining it.
   *
   * `check-browser-safe.mjs` learned the identical lesson and AGENTS.md records
   * it — it counted `@tauri-apps` inside doc comments, because `bookVault.ts`
   * names the package three times to say it does NOT import it.
   *
   * Deliberately crude: block and line comments, no string-literal awareness. A
   * cast inside a string is not a cast either, and this suite's `NEEDLE` is
   * itself assembled from halves precisely so it is not one.
   */
  const code = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/\/\/[^\n]*/gu, ' ')

  /* ⚠️ **THE CAST IS NOT THE ONLY WAY A `ResolvedCfi` COMES INTO BEING, and a
     grep for the cast cannot see the other one.** `isPlaced` in `core/marks.ts`
     is a TYPE PREDICATE — no cast, so it is invisible to the set below — and it
     narrows to `Placed<T>`, whose `cfi` is branded. That is deliberate and it is
     the weaker of the two mints: it establishes that no foreign path was carried
     across an import and that a path exists, not that the path was re-derived
     this session.

     Named here so the plan's falsifier is not read as saying more than it can.
     `rg 'as ResolvedCfi'` answers "where is the brand asserted without a check";
     it does not answer "where does a branded value come from". */
  const CHECKED_MINT = 'src/kernel/core/marks.ts'

  const MINTS = new Set([
    /* The production mint. Sound because of its ARGUMENT — a live `Range` is
       the evidence the document is here and has the structure the path is
       derived from. */
    'src/kernel/ui/reader/reanchor.ts',
    /* The test mint, reachable only through `src/kernel/testkit.ts`, which
       `kernel-testkit-in-tests-only` refuses to production code. That rule is
       what makes this entry not a hole; see the module's own header. */
    'src/kernel/core/resolvedCfi.testkit.ts',
  ])

  it('is minted in exactly two files, one of which tests cannot escape', async () => {
    const { readdirSync } = await import('node:fs')

    /* A REAL WALK OF `src/`, not `git grep`. The first version used git, and
       git reads the INDEX — so the testkit above was invisible to it until it
       was staged, and the test passed over the very file it exists to account
       for. That failure mode points the wrong way: an UNTRACKED file carrying
       a mint is exactly the case worth failing on, because it is what an
       experiment left behind looks like the moment before it is committed. */
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const at = `${dir}/${entry.name}`
        if (entry.isDirectory()) return walk(at)
        return /\.tsx?$/u.test(entry.name) ? [at] : []
      })

    const found = walk(`${REPO_ROOT}/src`)
      .filter((at) => code(readFileSync(at, 'utf8')).includes(NEEDLE))
      .map((at) => at.slice(REPO_ROOT.length + 1))

    /* NOT `toHaveLength(2)`. A count passes when one mint is added and another
       deleted in the same change; the set says which file, which is the thing
       a reader of a failure needs. */
    expect(new Set(found)).toEqual(MINTS)
  })

  it('has exactly one CHECKED mint, which no cast-grep can see', async () => {
    /* The predicate that narrows to `Placed<T>` without a cast. One, and it is
       `isPlaced` — a second would be a second unaudited way for a bare string
       to acquire the brand, and nothing above would notice. */
    const { readdirSync } = await import('node:fs')
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const at = `${dir}/${entry.name}`
        if (entry.isDirectory()) return walk(at)
        return /\.tsx?$/u.test(entry.name) ? [at] : []
      })
    /* ⚠️ **`is Placed<`, NOT `mark is Placed<`, and the narrower spelling could
       barely fire.** The first version named the parameter, so a predicate
       written `(m: Mark): m is Placed<Mark>` — which is what a second one would
       plausibly look like — slipped straight past. Verified by planting exactly
       that: it went unreported until the needle stopped assuming the argument's
       name. A detector that finds nothing looks exactly like a clean result. */
    const needle = [' is', 'Placed<'].join(' ')
    const found = walk(`${REPO_ROOT}/src`)
      .filter((at) => code(readFileSync(at, 'utf8')).includes(needle))
      .map((at) => at.slice(REPO_ROOT.length + 1))
    expect(found).toEqual([CHECKED_MINT])
  })

  it('has no universal cast in the modules that carry the brand', async () => {
    /* ⚠️ Scoped to the files that HANDLE a `ResolvedCfi`, not the whole tree:
       `as never` is a legitimate idiom for a fake context in a test, and a
       repo-wide ban would be noise nobody keeps. What must not contain one is
       any module through which a cfi travels — because there it is a silent
       mint. */
    const { readdirSync } = await import('node:fs')
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const at = `${dir}/${entry.name}`
        if (entry.isDirectory()) return walk(at)
        return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) ? [at] : []
      })

    const carriers = walk(`${REPO_ROOT}/src`).filter((at) => {
      const source = code(readFileSync(at, 'utf8'))
      return source.includes('ResolvedCfi') || source.includes('ForeignAnnotation')
    })
    expect(carriers.length, 'no carrier modules found — the filter is wrong').toBeGreaterThan(3)

    const offenders = carriers
      .filter((at) => code(readFileSync(at, 'utf8')).includes(ANY_CAST))
      .map((at) => at.slice(REPO_ROOT.length + 1))
    expect(offenders).toEqual([])
  })

  it('finds the mint it is looking for, which is what makes the walk evidence', async () => {
    /* ⚠️ **THE KNOWN POSITIVE.** `check-browser-safe.mjs` shipped two confident
       wrong answers before it worked, and AGENTS.md draws the rule from it: a
       detector that finds nothing looks exactly like a clean result. The test
       above asserts a SET, so a walk that read no files and a walk that found
       the two real mints are told apart only by this — that the needle really
       does match the resolver's own source. */
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(`${REPO_ROOT}/src`).length).toBeGreaterThan(0)
    expect(readFileSync(`${REPO_ROOT}/src/kernel/ui/reader/reanchor.ts`, 'utf8')).toContain(NEEDLE)
  })

  it('cannot be spelled by a module that does not import it', () => {
    /* The brand is a `declare const` symbol that is never exported, so
       `ResolvedCfi` has no structural spelling anywhere else — this is what
       makes it nominal rather than a naming convention. The check is that the
       source declares it that way, because a later edit to
       `{ readonly __brand: 'resolved' }` would compile, would keep every test
       above green, and would silently make the type forgeable. */
    const src = readFileSync(`${REPO_ROOT}/src/kernel/core/resolvedCfi.ts`, 'utf8')
    expect(src).toContain('declare const RESOLVED: unique symbol')
    expect(src).toContain('export type ResolvedCfi = string & { readonly [RESOLVED]: true }')
    /* ⚠️ The brand lives in `core/`, not here. It was declared in this module,
       which made `core/marks.ts` import from `ui/` in order to name it —
       backwards, and flagged by review. The MINT stayed here; only the
       vocabulary moved. */
    expect(code(readFileSync(`${REPO_ROOT}/src/kernel/ui/reader/reanchor.ts`, 'utf8'))).not.toContain(
      'declare const RESOLVED',
    )
  })

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
