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
