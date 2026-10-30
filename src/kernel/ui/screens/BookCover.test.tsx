// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BookCover } from './BookCover'
import type { IndexedBook } from '../../core/bookIndex'

/**
 * A jacket's LIFETIME — the async effect, and what it holds when it is
 * interrupted.
 *
 * ## Why this file did not exist
 *
 * `BookCover` is drawn once per row on a virtualised shelf that routinely holds
 * two thousand of them, and everything it does is a lifetime question: mint an
 * object URL, hand it to an `<img>`, revoke it when the cell points somewhere
 * else, and — since this component was generalised from "read the local vault"
 * to "call a `CoverSource`" — cancel the read when the cell goes.
 *
 * None of that was covered. The existing cover tests exercise `coverIn` and
 * `remoteCovers`, which are the SOURCES; nothing rendered the component that
 * decides when to ask and when to let go. So the read outliving the cell was
 * invisible: it produces no wrong picture, no error and no failing assertion,
 * only work and bytes that nobody asked for.
 *
 * A deferred promise per read is the whole apparatus. It is what lets a test
 * unmount a cell with a jacket genuinely in flight, which is the state the
 * defects live in and the one a resolved mock can never reach.
 */

afterEach(cleanup)

const book = (over: Partial<IndexedBook> = {}): IndexedBook =>
  ({ bookId: 'bk1', title: 'Bad Blood', author: 'Carreyrou, John', addedAt: 1, ...over }) as IndexedBook

/** Every URL minted, and whether it has been revoked. */
const minted: { url: string; revoked: boolean }[] = []
let next = 0
const globals = globalThis as unknown as { URL: typeof URL }
globals.URL.createObjectURL = ((): string => {
  const url = `blob:cover-${next++}`
  minted.push({ url, revoked: false })
  return url
}) as typeof URL.createObjectURL
globals.URL.revokeObjectURL = ((url: string) => {
  const held = minted.find((one) => one.url === url)
  if (held) held.revoked = true
}) as typeof URL.revokeObjectURL

afterEach(() => {
  minted.length = 0
  next = 0
})

/**
 * A `CoverSource` whose reads are held open until the test settles them.
 *
 * Records the signal it was handed for each call, which is the only way to ask
 * "was this read cancelled" — an `AbortSignal` is the source's to observe, and
 * a source that never sees one cannot be cancelled however tidy the caller is.
 */
function deferredSource() {
  const calls: { bookId: string; signal: AbortSignal | undefined; settle: (url: string | null) => void }[] = []
  const source = (bookId: string, signal?: AbortSignal): Promise<string | null> =>
    new Promise<string | null>((resolve) => {
      calls.push({ bookId, signal, settle: resolve })
    })
  return { calls, source }
}

/** Settle a held read with a freshly minted URL, inside `act`. */
async function arrive(call: { settle: (url: string | null) => void }) {
  await act(async () => {
    call.settle(URL.createObjectURL(new Blob()))
  })
}

describe('while the jacket is being read', () => {
  it('draws the tint, with the title, rather than an empty box', () => {
    const { source } = deferredSource()
    render(<BookCover book={book()} title="Bad Blood" coverFor={source} tintedClassName="tinted" />)
    expect(screen.getByText('Bad Blood')).toBeTruthy()
    expect(document.querySelector('img')).toBeNull()
  })

  it('draws the jacket once it arrives', async () => {
    const { calls, source } = deferredSource()
    render(<BookCover book={book()} title="Bad Blood" coverFor={source} />)
    await arrive(calls[0]!)
    expect(document.querySelector('img')?.getAttribute('src')).toBe(minted[0]?.url)
  })

  /* NO SOURCE IS NOT A PENDING READ. A browser before `cover.read` existed has
     nowhere to fetch from, and the tint is the answer rather than a promise
     that cannot resolve. */
  it('asks nothing at all when there is no source', () => {
    render(<BookCover book={book()} title="Bad Blood" tintedClassName="tinted" />)
    expect(screen.getByText('Bad Blood')).toBeTruthy()
    expect(minted).toHaveLength(0)
  })
})

describe('when the cell goes before the jacket arrives', () => {
  /**
   * ⚠️ **THE READ USED TO OUTLIVE THE CELL.**
   *
   * Cleanup revoked whatever URL eventually arrived, so there was no leak and
   * nothing to see — and the read itself kept going. On this shelf that is a
   * `cover.read` stream still pulling and decoding chunks for a row that is no
   * longer on screen, against a byte budget shared with the book being read. A
   * flick through two thousand rows started hundreds and cancelled none.
   */
  it('cancels the read', () => {
    const { calls, source } = deferredSource()
    const view = render(<BookCover book={book()} title="Bad Blood" coverFor={source} />)
    expect(calls[0]?.signal, 'the source must be HANDED a signal, or it cannot be cancelled').toBeInstanceOf(
      AbortSignal,
    )
    expect(calls[0]?.signal?.aborted).toBe(false)
    view.unmount()
    expect(calls[0]?.signal?.aborted, 'an unmounted cell left its cover read running').toBe(true)
  })

  /* AND STILL REVOKES. Both are needed: the signal stops work that has not
     happened, this catches a source that had already finished, or one that
     cannot honour a signal at all. */
  it('revokes a URL that arrives anyway', async () => {
    const { calls, source } = deferredSource()
    const view = render(<BookCover book={book()} title="Bad Blood" coverFor={source} />)
    view.unmount()
    await arrive(calls[0]!)
    expect(minted[0]?.revoked, 'a jacket that arrived after unmount was held for the document').toBe(true)
  })

  it('revokes a jacket it had already drawn', async () => {
    const { calls, source } = deferredSource()
    const view = render(<BookCover book={book()} title="Bad Blood" coverFor={source} />)
    await arrive(calls[0]!)
    expect(minted[0]?.revoked).toBe(false)
    view.unmount()
    expect(minted[0]?.revoked).toBe(true)
  })
})

describe('when the cell is pointed at another book', () => {
  it('cancels the first read and starts a second', () => {
    const { calls, source } = deferredSource()
    const view = render(<BookCover book={book()} title="Bad Blood" coverFor={source} />)
    view.rerender(<BookCover book={book({ bookId: 'bk2' })} title="Seeing Like a State" coverFor={source} />)
    expect(calls.map((one) => one.bookId)).toEqual(['bk1', 'bk2'])
    expect(calls[0]?.signal?.aborted, 'the jacket of the book it no longer shows').toBe(true)
    expect(calls[1]?.signal?.aborted).toBe(false)
  })

  /**
   * ⚠️ **THE FIRST BOOK'S JACKET MUST NOT LAND ON THE SECOND.** These resolve
   * out of order on purpose: a fast scroll is exactly the case where an earlier,
   * slower read finishes after a later one, and a cell that took whatever
   * arrived last would show a jacket belonging to another book.
   */
  it('never shows the jacket of the book it has moved on from', async () => {
    const { calls, source } = deferredSource()
    const view = render(<BookCover book={book()} title="Bad Blood" coverFor={source} />)
    view.rerender(<BookCover book={book({ bookId: 'bk2' })} title="Seeing Like a State" coverFor={source} />)

    await arrive(calls[1]!) // the book on screen
    await arrive(calls[0]!) // the one it moved on from, arriving late

    const shown = document.querySelector('img')?.getAttribute('src')
    expect(shown, 'the second book’s own jacket').toBe(minted[0]?.url)
    expect(minted[1]?.revoked, 'the abandoned book’s jacket was held for the document').toBe(true)
  })
})

describe('when the jacket will not load', () => {
  /* A SOURCE THAT ANSWERS `null` is a book with no artwork — most of them —
     and the tint is the answer, not an error. */
  it('keeps the tint when the source has no jacket', async () => {
    const { calls, source } = deferredSource()
    render(<BookCover book={book()} title="Bad Blood" coverFor={source} tintedClassName="tinted" />)
    await act(async () => calls[0]!.settle(null))
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('Bad Blood')).toBeTruthy()
  })

  /**
   * ⚠️ **BYTES THAT WILL NOT DECODE USED TO BE HELD UNTIL UNMOUNT.** The effect
   * does not re-run on a decode failure, so its own `mine` is unreachable from
   * the error handler — which is why the component keeps a ref. Without it,
   * every unreadable cover on the shelf stayed in memory for as long as its row
   * existed.
   */
  it('releases bytes the browser could not decode', async () => {
    const { calls, source } = deferredSource()
    render(<BookCover book={book()} title="Bad Blood" coverFor={source} tintedClassName="tinted" />)
    await arrive(calls[0]!)
    const img = document.querySelector('img')!
    await act(async () => {
      img.dispatchEvent(new Event('error'))
    })
    expect(minted[0]?.revoked, 'an undecodable jacket was held for the life of the row').toBe(true)
    expect(document.querySelector('img'), 'and the tint takes over').toBeNull()
  })
})

describe('the source identity', () => {
  /**
   * ⚠️ **`coverFor` MUST BE STABLE**, and this is what a caller that gets it
   * wrong costs. It is a dependency of the effect — it has to be, or the first
   * one is captured forever — so an inline arrow is a refetch and a revoked
   * object URL per row per render, on a shelf of two thousand rows.
   */
  it('refetches when the source identity changes, which is why callers bind once', () => {
    const first = deferredSource()
    const second = deferredSource()
    const view = render(<BookCover book={book()} title="Bad Blood" coverFor={first.source} />)
    view.rerender(<BookCover book={book()} title="Bad Blood" coverFor={second.source} />)
    expect(first.calls[0]?.signal?.aborted, 'the old source’s read is at least cancelled').toBe(true)
    expect(second.calls, 'a new identity is a new read — bind it once').toHaveLength(1)
  })

  it('does not refetch when nothing changed', () => {
    const { calls, source } = deferredSource()
    const view = render(<BookCover book={book()} title="Bad Blood" coverFor={source} />)
    view.rerender(<BookCover book={book()} title="Bad Blood" coverFor={source} />)
    expect(calls).toHaveLength(1)
  })
})

/* The tint is DERIVED from the book, so two cells for the same book agree and
   a cell for another book differs — the shelf's colour is not random. */
describe('the tint', () => {
  it('is the same for a book and different between books', () => {
    const one = render(<BookCover book={book()} title="Bad Blood" tintedClassName="tinted" />)
    const again = render(<BookCover book={book()} title="Bad Blood" tintedClassName="tinted" />)
    const other = render(<BookCover book={book({ bookId: 'bk2' })} title="Other" tintedClassName="tinted" />)
    const tintOf = (view: { container: HTMLElement }) =>
      (view.container.querySelector('[style]') as HTMLElement | null)?.getAttribute('style')
    expect(tintOf(one)).toBe(tintOf(again))
    expect(tintOf(one)).not.toBe(tintOf(other))
    vi.restoreAllMocks()
  })
})
