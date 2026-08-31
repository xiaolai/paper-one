import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_CHARS } from '../ui/reader/wordSnap/flatten'
import {
  BUILD_IDS,
  CORPUS_BUILDS,
  CORPUS_HAZARDS,
  CORPUS_PASSAGES,
  buildFile,
  contextOf,
  plainText,
  spineStepOf,
  type BuildId,
} from './markCorpus.testkit'

/**
 * The corpus's own suite (WI-21.P2).
 *
 * A fixture corpus is an instrument, and `scripts/corpus-fixtures.test.mjs`
 * says why one needs a suite of its own: *"a zero here is a broken instrument;
 * a zero on the real shelf is a fact about the shelf, and only this file can
 * tell the two apart."* The same argument applies one level up — a corpus whose
 * three builds have quietly converged still loads, still exports, and still
 * imports, and every test built on it goes on passing while proving nothing.
 *
 * So this file holds the corpus to the four things its acceptance criteria ask
 * for: it loads with no network and no shelf, every hazard is covered, every
 * hand-written label matches the document it claims to describe, and the three
 * builds differ.
 */

const digest = async (text: string): Promise<string> => {
  const bytes = new TextEncoder().encode(text)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

describe('the mark corpus', () => {
  it('loads with no network and no shelf', () => {
    /* The whole acceptance criterion, asserted rather than assumed: the module
       is data and pure functions, so importing it above is the test. What is
       checked here is that it is not EMPTY — an import that resolved to a stub
       would satisfy "it loaded" and nothing else. */
    expect(BUILD_IDS).toHaveLength(3)
    for (const id of BUILD_IDS) {
      const build = CORPUS_BUILDS[id]
      expect(build.id).toBe(id)
      expect(build.sections.length).toBeGreaterThan(2)
      expect(build.title).not.toBe('')
      expect(build.identifier).not.toBe('')
    }
  })

  it('covers every hazard the plan named, once each', () => {
    /* Named rather than counted, exactly as the CSS fixture corpus does: a
       failure says WHICH hazard stopped being covered. */
    expect(new Set(CORPUS_PASSAGES.map((one) => one.covers))).toEqual(new Set(CORPUS_HAZARDS))
    expect(CORPUS_PASSAGES).toHaveLength(CORPUS_HAZARDS.length)
  })

  it('gives every pair a human-read reason for being the same passage', () => {
    /* The acceptance criterion in one line. A pair with no reason is a pair
       nobody checked, and this corpus's entire value is that a person did. */
    for (const passage of CORPUS_PASSAGES) {
      expect(passage.sameBecause.length, passage.id).toBeGreaterThan(80)
    }
  })

  it('places every passage in every build, at the labelled offset', () => {
    for (const passage of CORPUS_PASSAGES) {
      for (const id of BUILD_IDS) {
        const place = passage.places[id]
        const section = CORPUS_BUILDS[id].sections[place.sectionIndex]
        expect(section, `${passage.id}/${id}: sectionIndex is off the end of the spine`).toBeDefined()
        const text = plainText(section!.xhtml)
        let at = -1
        for (let n = 0; n < place.occurrence; n++) at = text.indexOf(place.quote, at + 1)
        expect(at, `${passage.id}/${id}: occurrence ${place.occurrence} of ${place.quote}`).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('holds every hand-written context to the document it claims to describe', () => {
    /* ⚠️ THIS IS WHAT MAKES THE TABLE TRUSTWORTHY. The prefixes and suffixes are
       typed out by a person, so they can be wrong — and a wrong context is the
       quietest possible fault: every matcher test built on it would go on
       passing while measuring a passage that is not there. */
    for (const passage of CORPUS_PASSAGES) {
      for (const id of BUILD_IDS) {
        const place = passage.places[id]
        expect(contextOf(CORPUS_BUILDS[id], place), `${passage.id}/${id}`).toEqual({
          prefix: place.prefix,
          suffix: place.suffix,
        })
      }
    }
  })

  it('keeps each CFI on the spine step its section index names', () => {
    /* A section index and a CFI's spine step are two spellings of one fact.
       Letting them disagree is how a table sends a test down a path the app
       never takes — `findMark` compares the index first and would refuse the
       pair the CFI says matches. */
    for (const passage of CORPUS_PASSAGES) {
      for (const id of BUILD_IDS) {
        const place = passage.places[id]
        expect(spineStepOf(place.cfi), `${passage.id}/${id}`).toBe(2 * (place.sectionIndex + 1))
      }
    }
  })

  it('puts a passage past every build spine, more than once, and past the flatten bound', () => {
    /* The three hazards that are claims about NUMBERS rather than about shape,
       so they are asserted as numbers. Each was a bullet in WI-21.P2. */
    const spine = CORPUS_PASSAGES.find((one) => one.covers === 'spine-index-differs')!
    const indexes = BUILD_IDS.map((id) => spine.places[id].sectionIndex)
    expect(new Set(indexes).size, 'the spine-index passage must differ across builds').toBe(3)

    const repeated = CORPUS_PASSAGES.find((one) => one.covers === 'occurs-more-than-once')!
    for (const id of BUILD_IDS) {
      const place = repeated.places[id]
      const text = plainText(CORPUS_BUILDS[id].sections[place.sectionIndex]!.xhtml)
      expect(text.split(place.quote).length - 1, `${id}: occurrences of ${place.quote}`).toBeGreaterThan(1)
      expect(place.occurrence).toBeGreaterThan(1)
    }

    const far = CORPUS_PASSAGES.find((one) => one.covers === 'past-flatten-bound')!
    for (const id of BUILD_IDS) {
      const place = far.places[id]
      const text = plainText(CORPUS_BUILDS[id].sections[place.sectionIndex]!.xhtml)
      expect(text.indexOf(place.quote), `${id}: distance into the section`).toBeGreaterThan(DEFAULT_MAX_CHARS)
    }
  })

  it('sets the same words differently, so an exact quote match cannot carry a pair', () => {
    const typography = CORPUS_PASSAGES.find((one) => one.covers === 'typography')!
    const quotes = new Set(BUILD_IDS.map((id) => typography.places[id].quote))
    expect(quotes.size, 'the typography passage must be spelled two ways').toBeGreaterThan(1)
  })

  it('keeps a script in exactly one build of the section the script hazard names', () => {
    /* The hazard is the DISAGREEMENT between builds, not the presence of a
       script — a script in all three shifts every CFI equally and proves
       nothing about drift. */
    const scripted = CORPUS_PASSAGES.find((one) => one.covers === 'section-has-script')!
    const withScript = BUILD_IDS.filter((id) =>
      CORPUS_BUILDS[id].sections[scripted.places[id].sectionIndex]!.xhtml.includes('<script'),
    )
    expect(withScript).toEqual(['gutenberg'])
    /* And the script contributes no text, which is `flatten`'s SKIPPED_TAGS
       rule. Were it counted, every context in this section would be wrong. */
    const text = plainText(CORPUS_BUILDS.gutenberg.sections[1]!.xhtml)
    expect(text).not.toContain('reading-progress')
  })

  it('carries a passage in front matter every build has', () => {
    const boilerplate = CORPUS_PASSAGES.find((one) => one.covers === 'boilerplate')!
    for (const id of BUILD_IDS) {
      const place = boilerplate.places[id]
      /* Front matter, so ahead of the first chapter in every build — which is
         what makes it the text most likely to false-match. */
      const chapterOne = CORPUS_PASSAGES.find((one) => one.covers === 'spine-index-differs')!.places[id]
      expect(place.sectionIndex, `${id}`).toBeLessThan(chapterOne.sectionIndex)
    }
  })

  it('gives the three builds three different files — the falsifier', async () => {
    /* ⚠️ THE FALSIFIER WI-21.P2 NAMES, and it is the one assertion here that
       can retire the corpus: if two builds hash the same, the corpus proves
       nothing about drift and must be rebuilt. Two builds that agree are two
       copies of one fixture wearing two names, and every conclusion drawn from
       a "pair" across them would be a conclusion about one document. */
    const hashes = await Promise.all(BUILD_IDS.map((id) => digest(buildFile(CORPUS_BUILDS[id]))))
    expect(new Set(hashes).size, `two builds are byte-identical: ${hashes.join(' ')}`).toBe(3)
  })

  it('gives the three builds three different ids and three different identifiers', () => {
    /* The id is what an archive matches on, and the identifier is what WI-21.3
       persists. Two builds sharing either would make a name-match look like an
       id-match, which is the confusion Stage 1 exists to remove. */
    const ids = new Set(BUILD_IDS.map((id) => CORPUS_BUILDS[id].bookId))
    expect(ids.size).toBe(3)
    const identifiers = new Set(BUILD_IDS.map((id) => CORPUS_BUILDS[id].identifier))
    expect(identifiers.size).toBe(3)
  })

  it('names the same work in every build, so a name match is possible at all', () => {
    /* Title and author are how an archive from one build reaches another —
       `planImport` folds both. If the corpus's builds disagreed about the
       author, no cross-build import test could run at all. */
    for (const id of BUILD_IDS) expect(CORPUS_BUILDS[id].author).toBe('Herman Melville')
    const titles = BUILD_IDS.map((id: BuildId) => CORPUS_BUILDS[id].title)
    expect(titles.filter((one) => one === 'Moby-Dick; or, The Whale')).toHaveLength(2)
  })
})
