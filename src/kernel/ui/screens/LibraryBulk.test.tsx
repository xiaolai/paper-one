// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Library } from './Library'
import type { IndexedBook } from '../../core/bookIndex'

/**
 * WHAT A SELECTION CAN BE DONE TO — the bulk bar, and the sheet behind it.
 *
 * The shelf's bulk actions each fan one click out over every selected book,
 * and the failure they share is arithmetic that stops early: a reader selects
 * twelve, confirms, and one goes. That is a defect which LOOKS like success,
 * so the count is the assertion.
 *
 * The removal harness lets the shelf SHRINK as each removal lands, because a
 * fixed `books` prop cannot tell a correct loop from one that re-reads a live
 * derivation. It found something on the way in: `Library.tsx` credited its
 * `[...selectedBooks]` copy with preventing exactly that, and removing the
 * copy leaves these tests green — the list is captured by the render closure
 * and no later render can reach it. The comment there now says so.
 */

afterEach(cleanup)

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never

Element.prototype.getBoundingClientRect = function (): DOMRect {
  return { x: 40, y: 40, top: 40, left: 40, right: 140, bottom: 72, width: 100, height: 32, toJSON: () => ({}) } as DOMRect
}

const book = (over: Partial<IndexedBook> = {}): IndexedBook =>
  ({ bookId: 'bk1', title: 'Bad Blood', author: 'Carreyrou, John', addedAt: 1, progress: 0.5, ...over }) as IndexedBook

const BOOKS = [
  book(),
  book({ bookId: 'bk2', title: 'Seeing Like a State', author: 'Scott, James', tags: ['history'] }),
  book({ bookId: 'bk3', title: 'The Order of Time', author: 'Rovelli, Carlo' }),
]

const shelf = {
  books: BOOKS,
  platform: 'macos',
  onOpen: vi.fn(),
  onAddBooks: vi.fn(),
  onRemove: vi.fn(),
  onTagBooks: vi.fn(),
  onUntagBooks: vi.fn(),
  lastRemoval: null,
  onUndoRemoveTag: vi.fn(),
  onSetFinished: vi.fn(),
  onAddFolder: vi.fn(),
  importing: null,
  enriching: 0,
  importNotice: null,
  libraryQuery: '',
  onQueryChange: vi.fn(),
  bookActions: [],
  bookStatuses: [],
} as const

const selectAll = () =>
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }))
  })

describe('removing a selection', () => {
  it('asks first, and names how many', () => {
    render(<Library {...shelf} />)
    selectAll()
    fireEvent.click(screen.getByText('Remove…'))
    expect(screen.getByText(/Remove 3 books from the library\?/)).toBeTruthy()
  })

  it('removes every book that was selected, while the shelf shrinks underneath', () => {
    /* THE HARNESS REMOVES AS IT IS ASKED, which is what the real caller does
       — though React batches the state updates until the handler returns, so
       the shelf does not visibly shrink BETWEEN calls. What this pins is the
       observable contract either way: three books in, three callbacks out,
       none left on screen. */
    const removed: string[] = []
    function Shrinking() {
      const [books, setBooks] = useState(BOOKS)
      return (
        <Library
          {...shelf}
          books={books}
          onRemove={(entry) => {
            removed.push(entry.bookId)
            setBooks((held) => held.filter((one) => one.bookId !== entry.bookId))
          }}
        />
      )
    }
    render(<Shrinking />)
    selectAll()
    fireEvent.click(screen.getByText('Remove…'))
    fireEvent.click(screen.getByRole('button', { name: /^Remove$|Remove 3/i }))
    expect(removed.sort()).toEqual(['bk1', 'bk2', 'bk3'])
    expect(screen.queryByTitle('Open Bad Blood')).toBeNull()
  })

  it('takes Cancel for an answer, and removes nothing', () => {
    const onRemove = vi.fn()
    render(<Library {...shelf} onRemove={onRemove} />)
    selectAll()
    fireEvent.click(screen.getByText('Remove…'))
    fireEvent.click(screen.getByText('Cancel'))
    expect(onRemove).not.toHaveBeenCalled()
    expect(screen.queryByText(/from the library\?/)).toBeNull()
  })
})

describe('marking a selection finished', () => {
  it('sets every one of them', () => {
    const onSetFinished = vi.fn()
    render(<Library {...shelf} onSetFinished={onSetFinished} />)
    selectAll()
    fireEvent.click(screen.getByText('Mark as finished'))
    /* THE SET, not the count — calling one book three times would have
       satisfied a count. */
    expect(onSetFinished.mock.calls.map((c) => c[0]).sort()).toEqual(['bk1', 'bk2', 'bk3'])
    expect(onSetFinished.mock.calls.every((c) => c[1] === true)).toBe(true)
  })
})

/**
 * A SHELF A SESSION MAY ONLY READ DRAWS NO WAY TO CHANGE IT.
 *
 * `onRemove`, `onTagBooks`, `onUntagBooks` and `onSetFinished` were required
 * props, so the browser client had to pass them — and its session holds exactly
 * one grant, `readingGrant` (`capabilities/webhost/lib/pump.ts`). Each of those
 * reaches a write (`book.remove`, `tag.add`, `tag.remove`, `book.set`), so
 * every press applied optimistically, was refused, and undid itself. The bulk
 * bar offered all three over a whole selection at once.
 *
 * The bar itself stays: selecting is not a write, and the count and Done still
 * mean something. What goes is the three controls behind it.
 */
describe('a read-only host', () => {
  /** Every write callback withheld, exactly as `main.web.tsx` mounts it. */
  const readOnly = () => {
    const {
      onRemove: _r,
      onTagBooks: _t,
      onUntagBooks: _u,
      onSetFinished: _f,
      onAddBooks: _a,
      onAddFolder: _d,
      ...rest
    } = shelf
    return rest
  }

  it('offers no Remove…, Tags… or Mark as finished over a selection', () => {
    render(<Library {...readOnly()} />)
    selectAll()
    /* The selection itself still works — this is the control it no longer
       offers, not a shelf that stopped selecting. */
    expect(screen.getByText(/3 selected/)).toBeTruthy()
    expect(screen.queryByText('Remove…')).toBeNull()
    expect(screen.queryByText('Tags…')).toBeNull()
    expect(screen.queryByText(/Mark as (un)?finished/)).toBeNull()
  })

  it('tells an empty shelf the truth when it has no way to add a book', () => {
    render(<Library {...readOnly()} books={[]} />)
    /* "Add a book, or a folder of them" over a screen with neither button is
       an instruction the reader cannot follow. */
    expect(screen.queryByText(/Add a book, or a folder of them/)).toBeNull()
    expect(screen.getByText(/Books added on the shelf itself appear here/)).toBeTruthy()
  })

  /* Pinned so the guards above cannot be satisfied by removing the controls for
     every host, which would take the desktop's bulk bar with them. */
  it('still offers all three to a host that supplied the callbacks', () => {
    render(<Library {...shelf} />)
    selectAll()
    expect(screen.getByText('Remove…')).toBeTruthy()
    expect(screen.getByText('Tags…')).toBeTruthy()
    expect(screen.getByText(/Mark as (un)?finished/)).toBeTruthy()
  })
})
