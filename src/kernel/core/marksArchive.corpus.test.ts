import { describe, expect, it } from 'vitest'
import type { IndexedBook } from './bookIndex'
import type { Mark } from './marks'
import { BUILD_IDS, CORPUS_BUILDS, CORPUS_PASSAGES, type BuildId } from './markCorpus.testkit'
import { exportMarks, planImport } from './marksArchive'

/**
 * One reader's archive, taken across two builds of the same book (WI-21.2).
 *
 * The unit tests beside this one use two-line fixtures and prove the RULE. This
 * one proves the rule holds on something shaped like the real case: a reader
 * who marked up the Gutenberg download, exported, and later imported that file
 * onto the Standard Ebooks or a commercial copy of the same work.
 *
 * ⚠️ **THAT IS THE SHIPPED DEFECT, END TO END.** The archive carries anchors
 * written against build A's spine and DOM. The shelf holds build B, where the
 * same chapter sits at a different spine index behind different wrappers — so
 * every one of those anchors is a valid path to the WRONG WORDS. `planImport`
 * must not let one through, and this asserts it against the corpus rather than
 * against a fixture written to make the point.
 *
 * The falsifier WI-21.2 names is *"any path from a name-matched `ArchivedMark`
 * to a stored `cfi`, INCLUDING DURING PRE-STORE FOLDING"* — so what is checked
 * is the whole plan, both lists, not merely the final additions.
 */

/** The corpus build as a shelf row. */
const shelfBook = (id: BuildId): IndexedBook =>
  ({
    bookId: CORPUS_BUILDS[id].bookId,
    title: CORPUS_BUILDS[id].title,
    author: CORPUS_BUILDS[id].author,
    contentHash: CORPUS_BUILDS[id].contentHash,
    addedAt: 1,
  }) as IndexedBook

/** Every labelled passage in one build, as marks that build's reader made. */
const marksMadeIn = (id: BuildId): Mark[] =>
  CORPUS_PASSAGES.map((passage, at) => {
    const place = passage.places[id]
    return {
      id: `m${at}`,
      bookId: CORPUS_BUILDS[id].bookId,
      cfi: place.cfi,
      sectionIndex: place.sectionIndex,
      text: place.quote,
      prefix: place.prefix,
      suffix: place.suffix,
      note: passage.id,
      kind: 'highlight',
      tint: 'yellow',
      style: 'fill',
      chapter: 'Loomings',
      createdAt: Date.UTC(2026, 0, 2) + at,
    } as Mark
  })

/** Every anchor the plan would put into the store. */
const anchorsIn = (plan: ReturnType<typeof planImport>): readonly string[] => [
  ...plan.additions.flatMap((one) => one.marks.map((mark) => mark.localAnchor.cfi)),
  ...plan.additions.flatMap((one) => one.cards.flatMap((card) => (card.localAnchor ? [card.localAnchor.cfi] : []))),
]

/** Every crossing, whichever route the shelf refuses it by. */
const CROSSINGS: readonly (readonly [BuildId, BuildId])[] = [
  ['gutenberg', 'standard-ebooks'],
  ['standard-ebooks', 'gutenberg'],
  ['gutenberg', 'commercial'],
  ['standard-ebooks', 'commercial'],
  ['commercial', 'gutenberg'],
  ['commercial', 'standard-ebooks'],
]

/**
 * The crossings that actually MATCH — same folded title, same folded author,
 * different bytes.
 *
 * ⚠️ The commercial build is not among them, and that is a fact about real
 * publishing rather than a gap in the corpus: it is titled `Moby-Dick` where
 * the other two are titled `Moby-Dick; or, The Whale`, so `nameKey` does not
 * join them at all. Both refusals are correct and they are DIFFERENT refusals
 * — one says "not on this shelf", the other says "here, but a different
 * edition" — so they are asserted apart.
 */
const NAME_MATCHING: readonly (readonly [BuildId, BuildId])[] = [
  ['gutenberg', 'standard-ebooks'],
  ['standard-ebooks', 'gutenberg'],
]

/** The crossings a differing title puts out of reach of a name match. */
const TITLED_APART: readonly (readonly [BuildId, BuildId])[] = [
  ['gutenberg', 'commercial'],
  ['standard-ebooks', 'commercial'],
  ['commercial', 'gutenberg'],
  ['commercial', 'standard-ebooks'],
]

describe("an archive from one build, imported onto another (WI-21.2)", () => {
  it.each(CROSSINGS)('lets no anchor from %s reach a shelf holding %s', (from, onto) => {
    const archive = exportMarks([shelfBook(from)], marksMadeIn(from), [])
    /* Every anchor the archive carries — what must NOT survive the crossing. */
    const foreign = new Set(archive.books.flatMap((one) => one.marks.map((mark) => mark.localAnchor.cfi)))
    expect(foreign.size, 'the corpus must give the archive anchors to carry').toBeGreaterThan(0)

    const plan = planImport(archive, [shelfBook(onto)], [], [])

    expect(plan.marksAdded).toBe(0)
    for (const anchor of anchorsIn(plan)) {
      expect(foreign.has(anchor), `an anchor from ${from} reached a ${onto} shelf: ${anchor}`).toBe(false)
    }
    expect(anchorsIn(plan)).toEqual([])
  })

  it.each(NAME_MATCHING)('finds the book rather than calling it missing (%s onto %s)', (from, onto) => {
    /* THE BOOK IS FOUND. Refusing the anchors is not the same as failing to
       match, and telling the reader "not on this shelf" about a book that is
       right there sends them to re-download something they already have. */
    const archive = exportMarks([shelfBook(from)], marksMadeIn(from), [])
    const plan = planImport(archive, [shelfBook(onto)], [], [])
    expect(plan.unmatched).toEqual([])
    expect(plan.unplacedBooks).toEqual([
      { title: CORPUS_BUILDS[onto].title, author: CORPUS_BUILDS[onto].author, marks: CORPUS_PASSAGES.length },
    ])
  })

  it.each(TITLED_APART)('says "not on this shelf" when the titles do not join either (%s onto %s)', (from, onto) => {
    /* THE OTHER REFUSAL, and it must not wear the same sentence. A commercial
       edition dropping the subtitle is enough to put two copies of one work
       out of `nameKey`'s reach, and the honest thing to tell the reader then
       is that nothing here matched — not that a different edition is on the
       shelf, which would send them looking for a match that does not exist. */
    const archive = exportMarks([shelfBook(from)], marksMadeIn(from), [])
    const plan = planImport(archive, [shelfBook(onto)], [], [])
    expect(plan.unplacedBooks).toEqual([])
    expect(plan.unmatched).toEqual([
      {
        title: CORPUS_BUILDS[from].title,
        author: CORPUS_BUILDS[from].author,
        marks: CORPUS_PASSAGES.length,
        cards: 0,
      },
    ])
  })

  it('imports every anchor when the archive came from the very same build', () => {
    /* The other side of the rule, and the one that would silently break if the
       partition were applied too widely: a re-import into the library that
       WROTE the archive is an id match with AGREEING full digests, so every
       anchor is exact — proved now rather than assumed. */
    for (const id of BUILD_IDS) {
      const archive = exportMarks([shelfBook(id)], marksMadeIn(id), [])
      const plan = planImport(archive, [shelfBook(id)], [], [])
      expect(plan.marksAdded, id).toBe(CORPUS_PASSAGES.length)
      expect(plan.unplacedBooks, id).toEqual([])
      expect(new Set(anchorsIn(plan)), id).toEqual(new Set(CORPUS_PASSAGES.map((one) => one.places[id].cfi)))
    }
  })

  it('refuses an id match whose full digests disagree — the sampled collision', () => {
    /* ⚠️ **THE CASE `bookId` CANNOT SEE.** `contentId` is sampled above 64 MiB,
       so two different files can share one id. Here two builds are given the
       SAME id and their own (differing) full digests: the row matches by id and
       its anchors are still foreign, and the digest is what says so. Without
       this rule the import would have written a Gutenberg CFI into a Standard
       Ebooks copy on the strength of a hash collision. */
    const from = CORPUS_BUILDS.gutenberg
    const onto = CORPUS_BUILDS['standard-ebooks']
    const sharedId = 'book:collided'
    const archived = { ...shelfBook('gutenberg'), bookId: sharedId } as IndexedBook
    const shelved = { ...shelfBook('standard-ebooks'), bookId: sharedId } as IndexedBook
    expect(from.contentHash).not.toBe(onto.contentHash)

    const archive = exportMarks([archived], marksMadeIn('gutenberg').map((one) => ({ ...one, bookId: sharedId })), [])
    const plan = planImport(archive, [shelved], [], [])
    expect(plan.marksAdded).toBe(0)
    expect(anchorsIn(plan)).toEqual([])
    expect(plan.unplacedBooks).toEqual([
      { title: onto.title, author: onto.author, marks: CORPUS_PASSAGES.length },
    ])
  })

  it('would have placed those marks on different words, which is why they are refused', () => {
    /* THE REASON, ASSERTED RATHER THAN ASSUMED. The refusal is only justified
       if the anchors really do disagree across builds — if every build wrote
       the same CFI for the same passage, Stage 1 would be throwing away
       working behaviour. The corpus says they disagree, and here is the
       count. */
    const disagreeing = CORPUS_PASSAGES.filter((passage) => {
      const cfis = new Set(BUILD_IDS.map((id) => passage.places[id].cfi))
      return cfis.size > 1
    })
    expect(disagreeing.length, 'every labelled passage should be anchored differently somewhere').toBe(
      CORPUS_PASSAGES.length,
    )
    /* And the section index alone differs for the spine passage, which
       `findMark` compares BEFORE it looks at a CFI at all. */
    const spine = CORPUS_PASSAGES.find((one) => one.covers === 'spine-index-differs')!
    expect(new Set(BUILD_IDS.map((id) => spine.places[id].sectionIndex)).size).toBe(3)
  })
})
