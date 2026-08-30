import { describe, expect, it } from 'vitest'
import { continueReading } from './MobileApp'
import type { IndexedBook } from '../../kernel'

/**
 * WHAT THE CONTINUE STRIP OFFERS, and what it must not.
 *
 * The strip is the mockup's own: "Continue", three covers, most recent first.
 * Three of the four rules below are about what it LEAVES OUT, which is where a
 * strip like this goes wrong — a shelf sorted by recency and sliced is the
 * obvious implementation and it offers books you have finished, books you have
 * never opened, and books whose progress is zero.
 */

/* `exactOptionalPropertyTypes` is on, so `Partial<IndexedBook>` refuses an
   EXPLICIT `undefined` — and "the field is absent" is exactly what two of the
   cases below are about. This spelling allows it where `Partial` cannot. */
type Overrides = { [K in keyof IndexedBook]?: IndexedBook[K] | undefined }

const book = (id: string, over: Overrides = {}): IndexedBook =>
  ({ bookId: id, title: id, author: 'A', progress: 0.5, openedAt: 1, ...over }) as IndexedBook

describe('what the Continue strip offers', () => {
  it('is the most recently opened first', () => {
    const shelf = [
      book('old', { openedAt: 100 }),
      book('newest', { openedAt: 300 }),
      book('middle', { openedAt: 200 }),
    ]
    expect(continueReading(shelf).map((b) => b.bookId)).toEqual(['newest', 'middle', 'old'])
  })

  it('offers three, because the mockup does', () => {
    const shelf = Array.from({ length: 9 }, (_, i) => book(`b${i}`, { openedAt: i }))
    expect(continueReading(shelf)).toHaveLength(3)
  })

  /* A STRIP CALLED CONTINUE THAT OFFERS A FINISHED BOOK IS OFFERING THE WRONG
     VERB. The shelf below it is where a finished book is found again. */
  it('leaves out a book that is finished', () => {
    const shelf = [book('done', { finished: true }), book('reading')]
    expect(continueReading(shelf).map((b) => b.bookId)).toEqual(['reading'])
  })

  /* NEVER STARTED IS NOT "CONTINUE" EITHER, and both spellings of it occur: a
     book added and never opened has no `openedAt`, and one opened at the cover
     and closed again has `openedAt` with no progress. */
  const unstarted: readonly { why: string; over: Overrides }[] = [
    { why: 'never opened', over: { openedAt: undefined } },
    { why: 'opened but not started', over: { progress: 0 } },
    { why: 'has no progress recorded at all', over: { progress: undefined } },
  ]
  it.each(unstarted)('leaves out a book $why', ({ over }) => {
    expect(continueReading([book('candidate', over), book('reading')]).map((b) => b.bookId)).toEqual(['reading'])
  })

  /* ⚠️ **DOES NOT REORDER THE CALLER'S ARRAY.** `library.books` is the shelf's
     own snapshot, and sorting it in place would reorder the Library screen
     below — a strip that silently re-sorts the list under it.
     What makes it safe is that `.filter` returns a NEW array before `.sort`
     ever runs. This case cannot fail while that is true, and it is kept for
     the refactor that stops it being true — sorting `books` directly, or
     filtering after sorting. */
  it('does not sort the shelf it was given', () => {
    const shelf = [book('a', { openedAt: 1 }), book('b', { openedAt: 9 })]
    const order = shelf.map((b) => b.bookId)
    continueReading(shelf)
    expect(shelf.map((b) => b.bookId)).toEqual(order)
  })

  it('is empty for an empty shelf', () => {
    expect(continueReading([])).toEqual([])
  })
})
