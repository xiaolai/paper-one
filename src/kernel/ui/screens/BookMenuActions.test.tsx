// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Library } from './Library'
import type { IndexedBook } from '../../core/bookIndex'

/**
 * THE FOUR THINGS A BOOK'S `⋯` OFFERS, driven from the shelf that draws it.
 *
 * Finish, tag, select, remove — the menu's own tooltip lists them, and each
 * is a different kind of edit to the library. They were reachable only
 * through a real window before this: the menu is positioned by
 * `usePlacement`, which reads a layout jsdom does not have, so nothing here
 * could be opened in a test and none of it was.
 */

afterEach(cleanup)

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never

/* See `LibraryShelf.test.tsx` — a zero-sized anchor reads as off screen, and
   `useRowMenu` closes a detached menu in the tick it opened. */
Element.prototype.getBoundingClientRect = function (): DOMRect {
  return { x: 40, y: 40, top: 40, left: 40, right: 140, bottom: 72, width: 100, height: 32, toJSON: () => ({}) } as DOMRect
}

const book = (over: Partial<IndexedBook> = {}): IndexedBook =>
  ({ bookId: 'bk1', title: 'Bad Blood', author: 'Carreyrou, John', addedAt: 1, progress: 0.5, ...over }) as IndexedBook

const shelf = {
  books: [book(), book({ bookId: 'bk2', title: 'Seeing Like a State', tags: ['history'] })],
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

const openMenu = () => fireEvent.click(screen.getByLabelText('More for Bad Blood'))

describe("a book's own menu", () => {
  it('opens as a menu, named for its book', () => {
    /* `role="menu"` with a label is what a screen reader announces, and the
       label carries the title because "Actions" alone on a shelf of two
       thousand rows says nothing about which row is being acted on. */
    render(<Library {...shelf} />)
    openMenu()
    expect(screen.getByRole('menu', { name: 'Actions for Bad Blood' })).toBeTruthy()
  })

  it('marks the book finished', () => {
    const onSetFinished = vi.fn()
    render(<Library {...shelf} onSetFinished={onSetFinished} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark as finished' }))
    expect(onSetFinished).toHaveBeenCalledWith('bk1', true)
  })

  it('offers the way back once it is finished', () => {
    /* The same row, the opposite verb — a one-way action would leave a
       mis-click permanent. */
    const onSetFinished = vi.fn()
    render(<Library {...shelf} books={[book({ finished: true })]} onSetFinished={onSetFinished} />)
    openMenu()
    /* ONE EXACT LABEL. A regex offering three alternatives passed whichever
       the menu happened to say, so the wrong word for this state — a book
       with no saved position — could not have been caught. */
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark as unread' }))
    expect(onSetFinished).toHaveBeenCalledWith('bk1', false)
  })

  it('starts a selection from one book', () => {
    /* The pointer-only route into the selection model — a reader who does not
       know ⌘-click still needs a way in. */
    render(<Library {...shelf} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Select' }))
    expect(screen.getByLabelText('Clear the selection')).toBeTruthy()
    expect(screen.getByTitle('Deselect Bad Blood')).toBeTruthy()
  })

  it('opens the tag editor', () => {
    render(<Library {...shelf} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Tags…' }))
    expect(screen.getByLabelText('Add a tag')).toBeTruthy()
  })

  it('tags the book with what was typed', () => {
    const onTagBooks = vi.fn()
    render(<Library {...shelf} onTagBooks={onTagBooks} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Tags…' }))
    const field = screen.getByLabelText('Add a tag')
    fireEvent.change(field, { target: { value: 'medicine' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onTagBooks).toHaveBeenCalledWith(['bk1'], ['medicine'])
  })

  it('asks twice before removing the book', () => {
    /* The row arms itself rather than opening a sheet: one click changes the
       label to "Remove? — click again", and only the second removes. A single
       click here would put a destructive action one slip from the menu that
       also contains "Select". */
    const onRemove = vi.fn()
    render(<Library {...shelf} onRemove={onRemove} />)
    openMenu()
    fireEvent.click(screen.getByLabelText('Remove Bad Blood'))
    expect(onRemove).not.toHaveBeenCalled()
    /* The armed label spells out what is recoverable, which is the whole
       point of arming rather than removing — so it is a DIFFERENT label. */
    expect(screen.getByText('Remove? — click again')).toBeTruthy()
    fireEvent.click(screen.getByLabelText(/^Remove Bad Blood — the file you imported is kept/))
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ bookId: 'bk1' }))
  })
})
