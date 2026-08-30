import { describe, expect, it } from 'vitest'
import { recentlyOpened } from './ContinueStrip'
import type { IndexedBook } from '../../kernel'

/**
 * WHAT THE CONTINUE STRIP OFFERS, and what it must not.
 *
 * The strip is the mockup's own: "Continue", three covers, most recent first.
 * Three of the four rules below are about what it LEAVES OUT, which is where a
 * strip like this goes wrong — a shelf sorted by recency and sliced is the
 * obvious implementation and it offers books you have finished and books you
 * have never opened.
 *
 * These cases were written against a second selection in the mobile shell
 * (`continueReading`), which filtered before handing books to a component that
 * filtered again by a different rule. There is one policy now and it lives
 * beside the component; the cases moved with it, and they cover BOTH clients
 * because both mount this strip.
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
    expect(recentlyOpened(shelf).map((b) => b.bookId)).toEqual(['newest', 'middle', 'old'])
  })

  it('offers three, because the mockup does', () => {
    const shelf = Array.from({ length: 9 }, (_, i) => book(`b${i}`, { openedAt: i }))
    expect(recentlyOpened(shelf)).toHaveLength(3)
  })

  /* A STRIP CALLED CONTINUE THAT OFFERS A FINISHED BOOK IS OFFERING THE WRONG
     VERB. The shelf below it is where a finished book is found again. */
  it('leaves out a book that is finished', () => {
    const shelf = [book('done', { finished: true }), book('reading')]
    expect(recentlyOpened(shelf).map((b) => b.bookId)).toEqual(['reading'])
  })

  /* NEVER OPENED IS NOT "CONTINUE" EITHER. `openedAt` is the signal the strip
     keys on, and a book added and never opened is not something to continue.

     ⚠️ **`progress` IS DELIBERATELY NOT PART OF THIS.** The removed
     `continueReading` also required `progress > 0`, and two cases here asserted
     that. They are gone with the rule rather than kept green some other way:
     a book you opened and closed at the cover IS the book you put down, and
     the strip's own header states `openedAt` as the signal. The stricter rule
     was the newer of the two and had no reason written down. */
  it.each([
    { why: 'was never opened', over: { openedAt: undefined } },
    { why: 'has openedAt zero', over: { openedAt: 0 } },
  ] as readonly { why: string; over: Overrides }[])('leaves out a book that $why', ({ over }) => {
    expect(recentlyOpened([book('candidate', over), book('reading')]).map((b) => b.bookId)).toEqual(['reading'])
  })

  /* AND A BOOK OPENED BUT NOT PROGRESSED IS STILL OFFERED, which is the other
     half of the rule above stated as behaviour rather than as an omission. */
  it('keeps a book that was opened but has no progress yet', () => {
    expect(recentlyOpened([book('just-opened', { progress: 0, openedAt: 5 })]).map((b) => b.bookId)).toEqual([
      'just-opened',
    ])
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
    recentlyOpened(shelf)
    expect(shelf.map((b) => b.bookId)).toEqual(order)
  })

  it('is empty for an empty shelf', () => {
    expect(recentlyOpened([])).toEqual([])
  })
})
