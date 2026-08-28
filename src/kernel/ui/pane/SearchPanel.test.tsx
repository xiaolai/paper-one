// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SearchPanel, type SearchableBook } from './SearchPanel'
import type { SearchHit } from '../hooks/useBook'

/**
 * Where a search hit sends the reader, and through what.
 *
 * WHY THIS FILE DID NOT EXIST BEFORE — the same reason as Marginalia's: the
 * panel had no test, and what that hid was a promise. The ledger's "Back after
 * a jump" row names search hits explicitly among the panels that push onto the
 * jump stack, and every other panel does; this one called `book.goTo` on its
 * own, so a hit moved the reader with no ⌘[ back and no "← Back to" line. It
 * looked exactly like a jump, which is why nothing noticed.
 *
 * The rendering of results — streaming, the cap, the failed-mid-spine notice
 * — is a separate subject and is not asserted here.
 */

afterEach(cleanup)

const HIT: SearchHit = {
  cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:9)',
  label: 'Loomings',
  pre: 'Call me ',
  match: 'Ishmael',
  post: '.',
}

/** A book that answers every query with one hit, and records where it was sent. */
function searchable(): SearchableBook & { goTo: ReturnType<typeof vi.fn> } {
  return {
    source: 'book.epub',
    meta: { title: 'Moby-Dick' } as unknown as SearchableBook['meta'],
    error: null,
    search: async function* () {
      yield HIT
    },
    goTo: vi.fn(),
  } as unknown as SearchableBook & { goTo: ReturnType<typeof vi.fn> }
}

/** Type a query and wait for the hit's row to appear past the debounce. */
async function findHit(): Promise<HTMLElement> {
  fireEvent.change(screen.getByLabelText('Search this book'), { target: { value: 'Ishmael' } })
  return screen.findByRole('button', { name: /Ishmael/ })
}

describe('a search hit', () => {
  it('goes through the host\'s jump when there is one, and not through the book directly', async () => {
    const book = searchable()
    const onGoTo = vi.fn()
    render(<SearchPanel book={book} onGoTo={onGoTo} />)
    ;(await findHit()).click()
    /* THE STRING FORM of a `JumpTarget`: the open book, which is the only book
       a search covers. The host records the departure and navigates, so the
       reader gets the same ⌘[ a mark row or a contents entry gives them. */
    expect(onGoTo).toHaveBeenCalledWith(HIT.cfi)
    /* NOT BOTH. Navigating here as well would move the reader twice — once by
       the panel, once by the host — and stack the origin against a page that
       had already turned. */
    expect(book.goTo).not.toHaveBeenCalled()
  })

  it('falls back to the book\'s own goTo for a host with no jump stack', async () => {
    /* The browser client mounts this panel over a navigator and nothing else —
       it has no jump stack to push onto. A hit there still has to move the
       reader, so the fallback is pinned rather than left to be tidied away. */
    const book = searchable()
    render(<SearchPanel book={book} />)
    ;(await findHit()).click()
    expect(book.goTo).toHaveBeenCalledWith(HIT.cfi)
  })
})
