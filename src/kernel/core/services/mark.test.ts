import { describe, expect, it } from 'vitest'
import { markList, markSet } from './mark'
import type { Mark } from '../marks'
import type { ServiceContext } from '../capability'
import type { ServiceEnvironment } from './environment'

/**
 * WHAT `mark.*` MEANS BY "EVERY MARK" (WI-21.7).
 *
 * The store publishes THREE classes of mark at its one door — placed
 * annotations, unplaced annotations and bookmarks — and every surface that
 * composes "every mark" by hand has to name all three. Two of them named two,
 * and both comments claiming completeness were written when there were only
 * two to name.
 *
 * The cost was not an error anywhere. An imported mark was stored, listed in
 * the desktop's Marginalia, exported and synced, and simply absent over the
 * wire — so the browser client, which already parses `unplaced` and already
 * splits three ways, showed a reader nothing where their own quote and note
 * should be. `mark.cancel.test.ts` covers the same handler's cancellation.
 */

/** Drain a stream into its rows. */
async function drain(iterable: AsyncIterable<readonly unknown[]>): Promise<unknown[]> {
  const rows: unknown[] = []
  for await (const page of iterable) rows.push(...page)
  return rows
}

const ctxOf = (signal: AbortSignal) => ({ peer: 'p', signal, input: null }) as unknown as ServiceContext

/**
 * A shelf holding these three classes.
 *
 * ⚠️ **NAMES EVERY CLASS, even the empty ones.** This double is cast past
 * `MarkSnapshot`, so TypeScript does not hold it to the real shape — a partial
 * one surfaces as a `TypeError` from spreading `undefined`, or worse teaches
 * the handler to be defensive about a shape the store always supplies in full.
 */
function shelfOf(classes: {
  all?: readonly Mark[]
  unplaced?: readonly Mark[]
  bookmarks?: readonly Mark[]
}) {
  return {
    services: {
      marks: {
        loadAll: async () => {},
        forBook: async () => [],
        getSnapshot: () => ({
          all: classes.all ?? [],
          allUnplaced: classes.unplaced ?? [],
          allBookmarks: classes.bookmarks ?? [],
        }),
      },
    },
  } as unknown as ServiceEnvironment
}

/**
 * ⚠️ **"EVERY MARK ON THE SHELF" HAS TO MEAN EVERY CLASS OF MARK.**
 *
 * `mark.list` composed its whole-shelf answer as `all + allBookmarks`, and its
 * own comment called that "BOTH HALVES" — true when it was written, and left
 * standing when `allUnplaced` became the third (WI-21.7). So a mark imported
 * from another build of a book was stored, listed in the desktop's Marginalia,
 * exported and synced, and INVISIBLE to `paper mark list` and to the browser
 * client, which cannot show what it is never sent.
 *
 * The per-book branch never had the bug: `forBook` reads the file, and the file
 * holds all three. Only the whole-shelf call composed the answer by hand.
 */
describe('every mark on the shelf', () => {
  const plain = (id: string, over: Partial<Mark> = {}): Mark =>
    ({
      id,
      bookId: 'book:a',
      cfi: 'epubcfi(/6/4!/4/2)',
      sectionIndex: 0,
      text: 'a passage',
      prefix: '',
      suffix: '',
      note: '',
      kind: 'highlight',
      tint: 'yellow',
      style: 'fill',
      chapter: 'Ch. 1',
      createdAt: 1,
      ...over,
    }) as Mark

  const stranded = plain('stranded', {
    cfi: '',
    unplaced: { reason: 'foreign-build', fromBook: 'book:elsewhere' },
  })
  const place = plain('place', { kind: 'bookmark' })

  it('includes the unplaced marks, not only the placed ones and the places', async () => {
    const env = shelfOf({ all: [plain('placed')], unplaced: [stranded], bookmarks: [place] })

    const rows = (await drain(markList(env)({}, ctxOf(new AbortController().signal)))) as { id: string }[]

    expect(rows.map((one) => one.id).sort()).toEqual(['place', 'placed', 'stranded'])
  })

  it('sends the reason with it, or the other end drops the row', async () => {
    /* A row with `cfi: ''` and no discriminator is refused by every parser —
       that is what a mark which LOST its anchor looks like. Sending the mark
       without its reason is therefore not a smaller answer, it is no answer. */
    const env = shelfOf({ unplaced: [stranded] })

    const rows = (await drain(markList(env)({}, ctxOf(new AbortController().signal)))) as {
      cfi: string
      unplaced?: unknown
    }[]

    expect(rows).toHaveLength(1)
    expect(rows[0]?.cfi).toBe('')
    expect(rows[0]?.unplaced).toEqual({ reason: 'foreign-build', fromBook: 'book:elsewhere' })
  })
})

/**
 * ⚠️ **AND `mark.set` LOOKED IN TWO OF THE THREE PLACES.**
 *
 * `locate` searched `all + allBookmarks`, so an unplaced mark was reported
 * `notFound` — a reader could see their imported note in the desktop panel and
 * be told over the wire that the mark does not exist when they tried to edit
 * it. Nothing about writing a note needs an anchor.
 */
describe('editing a mark that has no anchor here', () => {
  const stranded = {
    id: 'stranded',
    bookId: 'book:a',
    cfi: '',
    sectionIndex: 0,
    text: 'a passage',
    prefix: '',
    suffix: '',
    note: '',
    kind: 'highlight',
    tint: 'yellow',
    style: 'fill',
    chapter: 'Ch. 1',
    createdAt: 1,
    unplaced: { reason: 'foreign-build', fromBook: 'book:elsewhere' },
  } as unknown as Mark

  /** A store that holds `stranded` ONLY in its unplaced class, as the real one does. */
  function envOf() {
    const notes: { id: string; note: string; book: string }[] = []
    let held = stranded
    const env = {
      services: {
        marks: {
          loadAll: async () => {},
          /* EMPTY, deliberately: the caller gives no `book` hint, so the only
             route to this mark is the snapshot's unplaced list. */
          forBook: async () => [],
          getSnapshot: () => ({ all: [], allUnplaced: [held], allBookmarks: [] }),
          updateNote: async (id: string, note: string, book: string) => {
            notes.push({ id, note, book })
            held = { ...held, note } as Mark
          },
          setTint: async () => {},
        },
      },
    } as unknown as ServiceEnvironment
    return { env, notes }
  }

  it('finds it and writes the note, instead of refusing as notFound', async () => {
    const { env, notes } = envOf()

    const row = (await markSet(env)({ mark: 'stranded', note: 'written later' })) as {
      id: string
      note: string
      unplaced?: unknown
    }

    expect(notes).toEqual([{ id: 'stranded', note: 'written later', book: 'book:a' }])
    expect(row.id).toBe('stranded')
    expect(row.note).toBe('written later')
    expect(row.unplaced, 'the answer must still say the mark has no place').toEqual({
      reason: 'foreign-build',
      fromBook: 'book:elsewhere',
    })
  })
})
