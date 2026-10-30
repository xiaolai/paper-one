import { describe, expect, it, vi } from 'vitest'
import { asCard, createRemoteCards, parseCards } from './cards'
import type { ShelfChannel } from './channel'

/**
 * The browser client's deck.
 *
 * ## Why this file did not exist
 *
 * It is the only one of the four remote stores that had no tests — parsing,
 * ordering, subscription identity, disposal and the read-only grant were all
 * uncovered. That is how `parseCards` came to check `id` and cast the rest:
 * nothing was holding it to reading a row.
 *
 * The parsing cases below are the ones that mattered. A `body` that arrives as
 * an object reaches JSX, which renders an object child by throwing; a
 * `createdAt` that arrives as a string sorts lexically against numbers, so the
 * newest-first order silently stops being newest-first; a `kind` outside the
 * five the deck knows falls through every filter to nothing.
 */

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'c1',
  bookId: 'b1',
  kind: 'Idea',
  body: 'who narrates',
  answer: 'Ishmael',
  source: 'Loomings',
  cfi: 'epubcfi(/6/4)',
  createdAt: 10,
  ...over,
})

/** A shelf that answers `card.list` with these rows, one page. */
function shelfOf(rows: readonly Record<string, unknown>[]) {
  return {
    call: async () => null,
    stream: () => ({
      [Symbol.asyncIterator]: async function* () {
        yield rows
      },
    }),
    close: () => {},
  } as unknown as ShelfChannel
}

const settled = () => new Promise((r) => setTimeout(r, 0))

describe('parseCards', () => {
  it('reads the rows a page carries', () => {
    expect(parseCards([row(), row({ id: 'c2' })]).map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  it('survives an answer that is not a list', () => {
    for (const junk of [null, undefined, 7, 'rows', { rows: [] }]) expect(parseCards(junk)).toEqual([])
  })

  it('drops a row with no id — React keys on it', () => {
    expect(parseCards([row({ id: '' }), row({ id: undefined }), row()]).map((c) => c.id)).toEqual(['c1'])
  })

  /**
   * ⚠️ **EVERY FIELD IS READ, AND ONE USED TO BE.** `parseCards` checked `id`
   * and cast the rest into `CardRow`, so the wrong type in any other field went
   * straight into sorting and rendering.
   */
  it('drops a row whose field is the wrong type', () => {
    for (const bad of [
      row({ body: { toString: () => 'no' } }),
      row({ createdAt: '10' }),
      row({ answer: 7 }),
      row({ source: null }),
    ]) {
      expect(parseCards([bad]), JSON.stringify(Object.keys(bad))).toEqual([])
    }
  })

  it('drops a row whose kind is not one of the five', () => {
    expect(parseCards([row({ kind: 'Doodle' })])).toEqual([])
  })

  /* `null` MEANS "FROM NO BOOK" ON THE WIRE, and the store's sentinel is `''`.
     That is a translation, not a repair — see `asCard`. */
  it('reads a card that came from no book', () => {
    expect(parseCards([row({ bookId: null })])[0]?.bookId).toBe('')
    expect(parseCards([row({ bookId: undefined })])[0]?.bookId).toBe('')
  })

  it('keeps the first of two rows sharing an id', () => {
    const rows = parseCards([row({ body: 'first' }), row({ body: 'second' })])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.body).toBe('first')
  })
})

describe('asCard', () => {
  it('folds the wire’s null book to the store’s empty string', () => {
    const wire = { ...row(), bookId: null } as unknown as Parameters<typeof asCard>[0]
    expect(asCard(wire).bookId).toBe('')
  })
})

describe('createRemoteCards', () => {
  it('reads the deck and orders it newest first', async () => {
    const store = createRemoteCards(
      shelfOf([row({ id: 'old', createdAt: 1 }), row({ id: 'new', createdAt: 99 })]),
    )
    await settled()
    expect(store.all.map((c) => c.id)).toEqual(['new', 'old'])
    store.dispose()
  })

  it('wakes its subscribers when the deck arrives, and stops after dispose', async () => {
    const store = createRemoteCards(shelfOf([row()]))
    const heard = vi.fn()
    const off = store.subscribe(heard)
    await settled()
    expect(heard).toHaveBeenCalled()

    heard.mockClear()
    store.dispose()
    store.refresh()
    await settled()
    expect(heard, 'a disposed store must not publish').not.toHaveBeenCalled()
    off()
  })

  it('unsubscribes the listener it was given', async () => {
    const store = createRemoteCards(shelfOf([row()]))
    const heard = vi.fn()
    store.subscribe(heard)()
    await settled()
    expect(heard).not.toHaveBeenCalled()
    store.dispose()
  })

  /**
   * ⚠️ **THE BROWSER'S DECK IS READ-ONLY**, and the store used to offer a
   * `discard` that could never work.
   *
   * `card.remove` is `card:write`; a browser session holds a read grant alone.
   * So a discard removed the card optimistically, was refused, and put it
   * back — a delete button that undoes itself. `pane/Cards.tsx` draws no
   * control without the callback, and this store no longer has one to give.
   */
  it('offers no mutation the session could not perform', async () => {
    const store = createRemoteCards(shelfOf([row()]))
    await settled()
    expect((store as unknown as Record<string, unknown>)['discard']).toBeUndefined()
    expect((store as unknown as Record<string, unknown>)['make']).toBeUndefined()
    store.dispose()
  })

  it('keeps the cards it had when a read fails, rather than emptying the deck', async () => {
    let fail = false
    const flaky = {
      call: async () => null,
      stream: () => ({
        [Symbol.asyncIterator]: async function* () {
          if (fail) throw new Error('the channel went')
          yield [row()]
        },
      }),
      close: () => {},
    } as unknown as ShelfChannel

    const store = createRemoteCards(flaky)
    await settled()
    expect(store.all).toHaveLength(1)

    fail = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
    store.refresh()
    await settled()
    expect(store.all, 'an empty deck would say the cards were deleted, which is false').toHaveLength(1)
    vi.restoreAllMocks()
    store.dispose()
  })
})
