// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

describe('a fraction a capability got wrong', () => {
  /* A contribution is untrusted input to the kernel. These went straight into
     `inline-size`, so a capability's arithmetic bug rendered as a broken row
     rather than as its own bug. */
  const width = (container: HTMLElement) =>
    (container.querySelector('[style*="inline-size"]') as HTMLElement | null)?.style.inlineSize ?? null

  it('draws no bar for NaN, rather than "NaN%"', () => {
    /* `received / total` with a zero total. */
    const { container } = render(
      <BookRow {...shared} book={book()} activity={{ label: 'Downloading…', fraction: Number.NaN }} />,
    )
    expect(width(container)).toBeNull()
  })

  it('draws no bar for Infinity', () => {
    const { container } = render(
      <BookRow {...shared} book={book()} activity={{ label: 'Downloading…', fraction: Infinity }} />,
    )
    expect(width(container)).toBeNull()
  })

  it('never draws past the whole', () => {
    /* A resumed transfer counts bytes already on disk; the arithmetic can
       exceed the expected size. */
    const { container } = render(
      <BookRow {...shared} book={book()} activity={{ label: 'Downloading 103%', fraction: 1.03 }} />,
    )
    expect(width(container)).toBe('100%')
  })

  it('never draws a negative width', () => {
    const { container } = render(
      <BookRow {...shared} book={book()} activity={{ label: 'Downloading…', fraction: -0.5 }} />,
    )
    expect(width(container)).toBe('0%')
  })

  it('still draws an honest one', () => {
    const { container } = render(
      <BookRow {...shared} book={book()} activity={{ label: 'Downloading 25%', fraction: 0.25 }} />,
    )
    expect(width(container)).toBe('25%')
  })
})

describe('activity belongs to one book, and arrives through the subscription', () => {
  /* Two holes the first version of these tests had, both of which let a real
     regression pass: the fake never EMITTED, so a broken subscription looked
     identical to a working one; and the shelf held a single book while the
     fixture ignored its argument, so a status leaking onto every row was
     indistinguishable from one landing on the right row. */
  const twoBooks = [
    book({ bookId: 'bk1', title: 'Bad Blood' }),
    book({ bookId: 'bk2', title: 'Seeing Like a State' }),
  ]

  it('draws on the book it names and no other', async () => {
    let answer: { label: string } | null = null
    let fire = () => {}
    const status: BookStatus = {
      id: 'test:one',
      subscribe: (listener) => {
        fire = listener
        return () => {}
      },
      of: (b) => (b.bookId === 'bk1' ? answer : null),
    }
    render(<Library {...shelf} books={twoBooks} bookStatuses={[status]} />)
    answer = { label: 'Downloading 25%' }
    await act(async () => { fire() })
    /* Exactly one row, and it is bk1's. Two would mean the status leaked. */
    expect(screen.getAllByText('Downloading 25%').length).toBe(1)
    expect(screen.getByTitle('Open Seeing Like a State')).toBeTruthy()
  })

  it('takes the row back through the same subscription', async () => {
    /* The transient half. A store that publishes the arrival of activity but
       never its departure leaves the row claiming a finished download. */
    let answer: { label: string } | null = { label: 'Downloading 25%' }
    let fire = () => {}
    const status: BookStatus = {
      id: 'test:one',
      subscribe: (listener) => {
        fire = listener
        return () => {}
      },
      of: () => answer,
    }
    render(<Library {...shelf} books={[book({ progress: 0.5 })]} bookStatuses={[status]} />)
    /* THE LIST, because the percentage is the list row's answer — the grid
       card draws a bar. Asserting the reading progress RETURNS is the point:
       activity takes that slot, and a store that never publishes the
       departure leaves the row claiming a finished download for ever. */
    fireEvent.click(screen.getByLabelText('Switch to list view'))
    expect(screen.getByText('Downloading 25%')).toBeTruthy()
    answer = null
    await act(async () => { fire() })
    expect(screen.queryByText('Downloading 25%')).toBeNull()
    expect(screen.getByText('50%')).toBeTruthy()
  })
})

describe('a store that publishes on every frame', () => {
  it('costs the shelf one render, not one per frame', async () => {
    /* A transfer publishes per FRAME, and each notification re-renders the
       shelf and re-asks `of` for every visible row — so one book coming down
       drove thousands of shelf-wide renders to move one percentage. Counted
       through `of`, which is the work each render actually causes. */
    let fire = () => {}
    const of = vi.fn(() => null)
    const status: BookStatus = {
      id: 'test:busy',
      subscribe: (listener) => {
        fire = listener
        return () => {}
      },
      of,
    }
    render(<Library {...shelf} books={[book()]} bookStatuses={[status]} />)
    of.mockClear()

    await act(async () => {
      for (let i = 0; i < 50; i++) fire()
    })

    /* One book on the shelf, so one `of` per render. Fifty publishes in a
       tick must not be fifty renders. */
    expect(of.mock.calls.length).toBeLessThan(5)
    expect(of.mock.calls.length, 'but it did re-ask').toBeGreaterThan(0)
  })
})
