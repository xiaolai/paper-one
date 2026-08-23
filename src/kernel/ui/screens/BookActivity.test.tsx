// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BookRow } from './BookRow'
import { BookCell } from './BookCell'
import { Library } from './Library'
import type { BookStatus } from '../../core/capability'
import type { IndexedBook } from '../../core/bookIndex'

/**
 * WHAT A CAPABILITY SAYS IS HAPPENING TO A BOOK, drawn on the book.
 *
 * The kernel half of the `BookStatus` contribution. Sync's half — matching a
 * transfer to the book that asked for it — is covered in
 * `sync/lib/downloads.test.ts`, and the plugin's half, that every transfer
 * event names its blob folder, is asserted over a real 20 MB transfer in
 * `blobs.rs`. This is the piece between them: that the row actually draws the
 * answer, and that it does not draw over something that matters.
 *
 * It replaced a list in Settings reading "Transfer 1 — done". Progress belongs
 * where the reader clicked Download, and the row is that place.
 *
 * A REAL RENDER, because the thing being asserted is what a reader sees. The
 * `status`/`activity` collision below is the specific reason: both are strings
 * about the same book in the same component, and only a render says which one
 * reached the screen.
 */

afterEach(cleanup)

const book = (over: Partial<IndexedBook> = {}): IndexedBook =>
  ({
    bookId: 'bk1',
    title: 'Bad Blood',
    author: 'Carreyrou, John',
    addedAt: 1,
    progress: 0.5,
    ...over,
  }) as IndexedBook

const shared = {
  now: Date.now(),
  menuFor: null,
  setMenuFor: vi.fn(),
  confirming: null,
  setConfirming: vi.fn(),
  tagging: null,
  setTagging: vi.fn(),
  shelfTags: [],
  selected: false,
  selecting: false,
  onSelect: vi.fn(),
  onDragStart: vi.fn(),
  onTagBooks: vi.fn(),
  onUntagBooks: vi.fn(),
  onOpen: vi.fn(),
  onRemove: vi.fn(),
  onSetFinished: vi.fn(),
  actions: [],
} as const

describe('a book with something happening to it', () => {
  it('says so on the list row', () => {
    render(<BookRow {...shared} book={book()} activity={{ label: 'Downloading 25%', fraction: 0.25 }} />)
    expect(screen.getByText('Downloading 25%')).toBeTruthy()
  })

  it('says so on the grid cell', () => {
    render(<BookCell {...shared} setQuery={vi.fn()} book={book()} activity={{ label: 'Downloading 25%' }} />)
    expect(screen.getByText('Downloading 25%')).toBeTruthy()
  })

  it('takes the progress slot rather than crowding in beside it', () => {
    /* Two bars in one row, one for reading and one for bytes, would make the
       reader work out which is which on every row forever to solve a collision
       that lasts a minute. The reading progress is not going anywhere. */
    render(<BookRow {...shared} book={book({ progress: 0.5 })} activity={{ label: 'Downloading 25%' }} />)
    expect(screen.queryByText('50%')).toBeNull()
  })

  it('gives the row back when nothing is happening', () => {
    /* The activity is transient; the row's usual answer must return, and this
       is what would break if a future edit cached the status per book. */
    render(<BookRow {...shared} book={book({ progress: 0.5 })} activity={null} />)
    expect(screen.getByText('50%')).toBeTruthy()
    expect(screen.queryByText(/Downloading/)).toBeNull()
  })

  it('draws a label with no fraction, because an unknown size is honest', () => {
    /* A fetch that has registered and had no event yet has no total. "0%"
       would say it has stalled at the start rather than that it has begun. */
    const { container } = render(
      <BookRow {...shared} book={book({ progress: 0 })} activity={{ label: 'Downloading…' }} />,
    )
    expect(screen.getByText('Downloading…')).toBeTruthy()
    expect(container.querySelector('[style*="inline-size"]')).toBeNull()
  })
})

/**
 * WHICH CAPABILITY GETS THE SLOT when more than one has something to say.
 *
 * There is one line per book and any number of capabilities, so the shelf
 * takes the FIRST status that answers and stops. Sync's own list is ordered
 * against this rule — downloading before arrived-from, so a transfer is never
 * shadowed by a note with no deadline — and `sync/bookStatuses.test.ts` pins
 * that end. This is the rule itself, which that ordering would be meaningless
 * without.
 */

/* The id is namespaced BY TYPE — `${owner}:${what}` — so a capability
   cannot claim a bare word the kernel or another capability might want. */
const status = (id: `${string}:${string}`, label: string | null): BookStatus => ({
  id,
  subscribe: () => () => {},
  of: () => (label === null ? null : { label }),
})

const shelf = {
  books: [book()],
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
} as const

describe('two capabilities with something to say about one book', () => {
  it('draws the first one that answers', () => {
    render(<Library {...shelf} bookStatuses={[status('t:down', 'Downloading 25%'), status('t:from', 'Added from Laptop')]} />)
    expect(screen.getByText('Downloading 25%')).toBeTruthy()
    expect(screen.queryByText('Added from Laptop')).toBeNull()
  })

  it('falls through the ones with nothing to say', () => {
    /* The common case: every capability but one returns null on any given
       book. A shelf that stopped at the first ENTRY rather than the first
       ANSWER would draw nothing here. */
    render(<Library {...shelf} bookStatuses={[status('t:down', null), status('t:from', 'Added from Laptop')]} />)
    expect(screen.getByText('Added from Laptop')).toBeTruthy()
  })
})
