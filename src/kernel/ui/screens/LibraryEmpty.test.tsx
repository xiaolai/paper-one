// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Library } from './Library'
import styles from './Library.module.css'
import type { IndexedBook } from '../../core/bookIndex'

/**
 * WHAT THE SHELF SAYS WHEN IT IS SHOWING NOTHING — and what its foot says while
 * the app is busy.
 *
 * These are the same screen in six states that read almost alike and mean
 * entirely different things: a library with nothing in it, one that could not
 * be READ, one filling up from an import, a search that matched nothing, and a
 * tag scope that matched nothing. Saying "Your library is empty" over a status
 * bar reading "Importing 861 of 1,959" is the app contradicting itself about
 * the same moment, and it is the state a reader is most likely to be looking
 * at — so each of the five names its own scope, and the foot is a ladder with
 * one rung showing.
 */

afterEach(cleanup)

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never

const book = (over: Partial<IndexedBook> = {}): IndexedBook =>
  ({
    bookId: 'bk1',
    title: 'Bad Blood',
    author: 'Carreyrou, John',
    addedAt: 1,
    progress: 0.5,
    ...over,
  }) as IndexedBook

const BOOKS = [
  book(),
  book({ bookId: 'bk2', title: 'Seeing Like a State', author: 'Scott, James', tags: ['history'] }),
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

/** The whole foot, as one line — the count and whatever holds the work slot. */
const foot = () => document.querySelector(`.${styles.status}`)?.textContent ?? ''

describe('a library with nothing in it', () => {
  it('draws no toolbar over a shelf there is nothing to search or sort', () => {
    render(<Library {...shelf} books={[]} />)
    expect(screen.queryByLabelText('Search the library')).toBeNull()
    expect(screen.queryByLabelText(/^Sort: /)).toBeNull()
    expect(screen.queryByLabelText('Add books'), 'the everyday +').toBeNull()
  })

  it('draws no filter chip over it, even with a filter left in the query', () => {
    /* The query outlives the books — it is app state, and a library emptied
       under `tag:history` still carries the term. A chip offering to lift a
       filter over a shelf with nothing on it answers a question nobody can be
       asking, and it would sit above "Your library is empty". */
    render(<Library {...shelf} books={[]} libraryQuery="tag:history" />)
    expect(screen.queryByRole('button', { name: 'history ✕' })).toBeNull()
    expect(screen.getByText('Your library is empty')).toBeTruthy()
  })

  it('says so, points at both ways in, and counts nothing in the foot', () => {
    const onAddBooks = vi.fn()
    const onAddFolder = vi.fn()
    render(<Library {...shelf} books={[]} onAddBooks={onAddBooks} onAddFolder={onAddFolder} />)
    expect(screen.getByText('Your library is empty')).toBeTruthy()
    expect(
      screen.getByText(
        'Add a book, or a folder of them — everything you highlight and tag stays with it.',
      ),
    ).toBeTruthy()
    expect(foot()).toBe('No books yet')

    fireEvent.click(screen.getByRole('button', { name: 'Add books…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Import a folder…' }))
    expect(onAddBooks).toHaveBeenCalledTimes(1)
    expect(onAddFolder).toHaveBeenCalledTimes(1)
  })

  it('offers only the route its host actually gave it', () => {
    /* The two are optional independently, so the copy and the buttons are both
       built from the ones that are there. */
    const { onAddFolder: _d, ...booksOnly } = shelf
    const { unmount } = render(<Library {...booksOnly} books={[]} />)
    expect(screen.getByRole('button', { name: 'Add books…' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Import a folder…' })).toBeNull()
    unmount()

    const { onAddBooks: _a, ...folderOnly } = shelf
    render(<Library {...folderOnly} books={[]} />)
    expect(screen.getByRole('button', { name: 'Import a folder…' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add books…' })).toBeNull()
  })

  it('draws no row of buttons for a host that gave neither', () => {
    const { onAddBooks: _a, onAddFolder: _d, ...readOnly } = shelf
    const { container } = render(<Library {...readOnly} books={[]} />)
    /* Not merely no buttons: no ROW, which would otherwise carry its own gap
       and margin and read as something that failed to load. */
    expect(container.querySelector(`.${styles.emptyActions}`)).toBeNull()
  })
})

describe('a library that could not be read', () => {
  it('says nothing has been changed, and offers nothing to add to it', () => {
    render(<Library {...shelf} books={[]} shelfUnread />)
    expect(screen.getByText('Your library could not be read')).toBeTruthy()
    expect(
      screen.getByText(
        'Nothing has been changed. Your books are still on disk — try reopening Paper.',
      ),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add books…' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Import a folder…' })).toBeNull()
    expect(foot()).toBe('Library could not be read')
  })
})

describe('a library filling up from an import', () => {
  it('says the books are arriving, and counts them in the foot', () => {
    render(<Library {...shelf} books={[]} importing={{ done: 861, total: 1959 }} />)
    expect(screen.getByText('Adding your books')).toBeTruthy()
    expect(
      screen.getByText('They appear here as they arrive — the count at the foot is the progress.'),
    ).toBeTruthy()
    /* Localised, because "Importing 1412 of 1959" is a number nobody reads at
       a glance and this line is read at a glance or not at all. */
    expect(screen.getByRole('status').textContent).toBe('Importing 861 of 1,959')
    expect(screen.queryByRole('button', { name: 'Add books…' }), 'not while books are arriving').toBeNull()
  })

  it('says it is still reading the folder before there is a total to count to', () => {
    render(<Library {...shelf} books={[]} importing={{ done: 0, total: 0 }} />)
    expect(screen.getByRole('status').textContent).toBe('Reading the folder…')
  })

  it('gives the slot back to what the import did, once it has stopped', () => {
    render(<Library {...shelf} importNotice="Added 3 books." />)
    expect(screen.getByRole('status').textContent).toBe('Added 3 books.')
  })
})

describe('a shelf narrowed to nothing', () => {
  it('names the tags that are in the way', () => {
    /* "No books" while a tag is narrowing a full library is the most confusing
       state this design can produce. */
    render(<Library {...shelf} libraryQuery="tag:history tag:sea" />)
    expect(screen.getByText('Nothing tagged history and sea matches')).toBeTruthy()
    expect(screen.getByText('Try a different search, or clear the filter.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add books…' }), 'a full library needs no way in').toBeNull()
  })

  it('says plainly that nothing matches when the scope is a search', () => {
    render(<Library {...shelf} libraryQuery="nothing on this shelf is called this" />)
    expect(screen.getByText('Nothing matches')).toBeTruthy()
    expect(screen.getByText('Try a different search, or clear the filter.')).toBeTruthy()
  })
})

describe('the count in the foot', () => {
  it('counts the library, and reads it as a fraction while anything narrows it', () => {
    const { rerender } = render(<Library {...shelf} />)
    expect(foot()).toBe('2 books')

    rerender(<Library {...shelf} books={[book()]} />)
    expect(foot(), 'one book is not one books').toBe('1 book')

    rerender(<Library {...shelf} libraryQuery="seeing" />)
    expect(foot(), 'the question "24 books" leaves open').toBe('1 of 2 books')
  })
})

/**
 * ONE SLOT, IN PRIORITY ORDER: what the reader asked for, then what it did,
 * then what the app is doing on its own. They cannot be shown at once and must
 * never be given a second line — a status bar that grows moves the shelf.
 */
describe('the ladder in the foot', () => {
  it('puts a live import above what boot had to say about the store', () => {
    render(
      <Library
        {...shelf}
        importing={{ done: 2, total: 4 }}
        bootNotice="The store could not be read."
      />,
    )
    expect(screen.getByRole('status').textContent).toBe('Importing 2 of 4')
  })

  it('puts a model download below the import and above the parse pass', () => {
    const { rerender } = render(
      <Library {...shelf} download="Downloading Qwen3-4B — 412 MB of 2.5 GB" enriching={12} />,
    )
    expect(screen.getByRole('status').textContent).toBe('Downloading Qwen3-4B — 412 MB of 2.5 GB')

    rerender(<Library {...shelf} importNotice="Added 3 books." download="Downloading Qwen3-4B" enriching={12} />)
    expect(screen.getByRole('status').textContent).toBe('Added 3 books.')
  })

  it('reports the parse pass when nothing the reader asked for is running', () => {
    /* NO LIVE REGION on this one: it changes once per book for as long as the
       pass runs, and announcing a countdown from two thousand is noise. */
    render(<Library {...shelf} enriching={12} />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(foot()).toBe('2 booksReading books for their titles and covers — 12 to go')
  })

  it('holds nothing at all at rest', () => {
    render(<Library {...shelf} />)
    expect(foot()).toBe('2 books')
  })
})
