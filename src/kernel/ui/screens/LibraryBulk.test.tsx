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

/* A LAYOUT, since jsdom has none — and the bulk editor gets a NARROWER one than
 * the button it hangs from, so that "under it, aligned to its leading edge" is
 * a different answer from centred or trailing. With one rect for everything,
 * all three alignments land on the same pixel and none of them is measured. */
Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
  const popover = this.getAttribute('aria-label')?.startsWith('Tags for') === true
  const width = popover ? 60 : 100
  return {
    x: 40, y: 40, top: 40, left: 40, right: 40 + width, bottom: 72, width, height: 32,
    toJSON: () => ({}),
  } as DOMRect
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

const press = (init: KeyboardEventInit, at: EventTarget = document.body) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => {
    at.dispatchEvent(event)
  })
  return event
}

/** The books currently in the selection, by title, as the shelf shows them. */
const selected = () =>
  [...document.querySelectorAll('[title^="Deselect "]')].map((el) =>
    el.getAttribute('title')?.replace('Deselect ', ''),
  )

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

  /* ⚠️ THE SHEET NAMES WHAT IT REMOVES FROM THE SELECTION, so the shelf's ⌘A
     answered inside it rewrote the question under the reader's hand: focus on
     Cancel, ⌘A, and "Remove 1 book" became "Remove 3 books". */
  it('keeps the question it asked when ⌘A is pressed inside it', () => {
    render(<Library {...shelf} />)
    fireEvent.click(screen.getByTitle('Open Bad Blood'), { metaKey: true })
    fireEvent.click(screen.getByText('Remove…'))
    expect(screen.getByText(/Remove 1 book from the library\?/)).toBeTruthy()

    const cancel = screen.getByText('Cancel')
    act(() => {
      cancel.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }))
    })

    expect(screen.getByText(/Remove 1 book from the library\?/)).toBeTruthy()
    expect(screen.queryByText(/Remove 3 books/)).toBeNull()
  })

  it('names the sheet for what it is about to do', () => {
    render(<Library {...shelf} />)
    selectAll()
    fireEvent.click(screen.getByText('Remove…'))
    expect(screen.getByRole('dialog', { name: 'Remove 3 books from the library' })).toBeTruthy()
  })

  it('names a handful and counts the rest, and says what survives', () => {
    /* Enough that a small mistake is visible; few enough that the list cannot
       push the buttons off the sheet. */
    const seven = Array.from({ length: 7 }, (_, i) =>
      book({ bookId: `bk${i}`, title: `Book ${i}`, addedAt: 7 - i }),
    )
    render(<Library {...shelf} books={seven} />)
    selectAll()
    fireEvent.click(screen.getByText('Remove…'))
    const named = [...document.querySelectorAll('li')].map((li) => li.textContent)
    expect(named).toEqual(['Book 0', 'Book 1', 'Book 2', 'Book 3', 'Book 4', 'and 2 more'])
    expect(screen.getByText(/kept where they are/).textContent).toBe(
      'The files you imported are kept where they are. This is recoverable for two weeks.',
    )
  })

  it('counts no remainder when the selection is exactly the handful', () => {
    const five = Array.from({ length: 5 }, (_, i) =>
      book({ bookId: `bk${i}`, title: `Book ${i}`, addedAt: 5 - i }),
    )
    render(<Library {...shelf} books={five} />)
    selectAll()
    fireEvent.click(screen.getByText('Remove…'))
    expect(screen.queryByText(/more$/)).toBeNull()
    expect([...document.querySelectorAll('li')].length).toBe(5)
  })

  it('says how many it is about to remove, in the reader’s own grammar', () => {
    render(<Library {...shelf} />)
    fireEvent.click(screen.getByTitle('Open Bad Blood'), { metaKey: true })
    fireEvent.click(screen.getByText('Remove…'))
    expect(screen.getByRole('button', { name: 'Remove 1 book' })).toBeTruthy()
    fireEvent.click(screen.getByText('Cancel'))

    selectAll()
    fireEvent.click(screen.getByText('Remove…'))
    expect(screen.getByRole('button', { name: 'Remove 3 books' })).toBeTruthy()
  })

  it('takes the scrim for an answer too', () => {
    const onRemove = vi.fn()
    render(<Library {...shelf} onRemove={onRemove} />)
    selectAll()
    fireEvent.click(screen.getByText('Remove…'))
    fireEvent.pointerDown(document.querySelector('[data-overlay-scrim]')!, { isPrimary: true, button: 0 })
    expect(screen.queryByText(/from the library\?/)).toBeNull()
    expect(onRemove).not.toHaveBeenCalled()
  })

  it('takes Escape for one, and keeps the gathering it was asking about', () => {
    /* ONE LAYER PER PRESS, topmost first: the sheet goes and the selection it
       named survives, so backing out of the ceremony costs nothing. */
    render(<Library {...shelf} />)
    selectAll()
    fireEvent.click(screen.getByText('Remove…'))
    const escape = press({ key: 'Escape' })
    expect(escape.defaultPrevented, 'the sheet answered the key').toBe(true)
    expect(screen.queryByText(/from the library\?/)).toBeNull()
    expect(screen.getByText(/3 selected/)).toBeTruthy()
  })

  it('lets the selection go once the removal is confirmed', () => {
    /* The books leave the library, so the shelf usually empties the selection
       underneath — but a host that refuses the removal must not leave the
       reader holding a gathering they have already acted on. */
    const onRemove = vi.fn()
    render(<Library {...shelf} onRemove={onRemove} />)
    selectAll()
    fireEvent.click(screen.getByText('Remove…'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove 3 books' }))
    expect(onRemove).toHaveBeenCalledTimes(3)
    expect(screen.queryByText(/selected/)).toBeNull()
    expect(screen.queryByText(/from the library\?/)).toBeNull()
  })

  it('never asks about no books, not even for a frame', () => {
    /* The selection can empty underneath an open sheet — the side pane narrows
       the shelf while the sheet is up — and the effect that closes the sheet
       runs a commit later. Without the guard the reader is asked, in that
       commit, whether to remove nothing. */
    const { rerender } = render(<Library {...shelf} />)
    selectAll()
    fireEvent.click(screen.getByText('Remove…'))

    const asked: string[] = []
    const watcher = new MutationObserver(() => {})
    watcher.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-label'],
      characterData: true,
    })
    rerender(<Library {...shelf} books={[]} />)
    for (const record of watcher.takeRecords()) {
      const node = record.target
      asked.push(node instanceof HTMLElement ? (node.getAttribute('aria-label') ?? '') : (node.textContent ?? ''))
      for (const added of record.addedNodes) asked.push(added.textContent ?? '')
    }
    watcher.disconnect()
    expect(asked.join(' ')).not.toMatch(/Remove 0/)
    expect(screen.queryByText(/from the library\?/)).toBeNull()
  })

  /* The sheet cannot outlive the selection it asks about. Narrowed to nothing
     while it is up — the side pane writes the query and the sheet does not cover
     the pane — the selection is pruned away, and a NEW selection made after the
     shelf comes back must not find the old question still standing over it. */
  it('lets the question go with the books it was asking about', () => {
    const { rerender } = render(<Library {...shelf} />)
    selectAll()
    fireEvent.click(screen.getByText('Remove…'))
    expect(screen.getByText(/Remove 3 books from the library\?/)).toBeTruthy()

    rerender(<Library {...shelf} libraryQuery="nothing on this shelf is called this" />)
    rerender(<Library {...shelf} />)
    expect(screen.queryByText(/from the library\?/)).toBeNull()

    fireEvent.click(screen.getByTitle('Open Bad Blood'), { metaKey: true })
    expect(screen.getByText(/1 selected/)).toBeTruthy()
    expect(screen.queryByText(/from the library\?/)).toBeNull()
  })
})

/**
 * A RUN IS THE SHELF AS SHOWN, between the anchor and the click.
 *
 * The three edges that have each been wrong at some point: a run that ends on
 * the first book on the shelf, an anchor the shelf has stopped showing, and a
 * ⌘-click that must stay a toggle however much of a run it could have been.
 */
describe('a run, and the edges of one', () => {
  /* Ids in shelf order — every book ties on recency, so the shelf falls back
     to the id, and the titles run with it. */
  /* No author carries the letter the narrowing test searches for, or the query
     would match every row through its author and narrow nothing. */
  const run = [
    book({ bookId: 'a', title: 'Anna', author: 'Zeta' }),
    book({ bookId: 'b', title: 'Bede', author: 'Zeta' }),
    book({ bookId: 'c', title: 'Cato', author: 'Zeta' }),
    book({ bookId: 'd', title: 'Dido', author: 'Zeta' }),
    book({ bookId: 'e', title: 'Edda', author: 'Zeta' }),
  ]

  it('runs back to the first book on the shelf', () => {
    render(<Library {...shelf} books={run} />)
    fireEvent.click(screen.getByTitle('Open Cato'), { metaKey: true })
    fireEvent.click(screen.getByTitle('Select Anna'), { shiftKey: true })
    expect(selected()).toEqual(['Anna', 'Bede', 'Cato'])
  })

  it('is a plain toggle under ⌘, whatever anchor is behind it', () => {
    /* ⌘ adds one book. With the anchor read as a run, the two clicks below
       would gather everything between them. */
    render(<Library {...shelf} books={run} />)
    fireEvent.click(screen.getByTitle('Open Anna'), { metaKey: true })
    fireEvent.click(screen.getByTitle('Select Dido'), { metaKey: true })
    expect(selected()).toEqual(['Anna', 'Dido'])
  })

  it('lets a ⌘-click take a book back out again', () => {
    render(<Library {...shelf} books={run} />)
    fireEvent.click(screen.getByTitle('Open Anna'), { metaKey: true })
    fireEvent.click(screen.getByTitle('Select Bede'), { metaKey: true })
    fireEvent.click(screen.getByTitle('Deselect Anna'), { metaKey: true })
    expect(selected()).toEqual(['Bede'])
  })

  it('is a toggle again when the anchor is no longer on the shelf', () => {
    /* The shelf narrows under a selection: the books that are left stay
       selected, and the anchor can be one of the ones that went. A run from an
       index the shelf does not have is not a run — it is this one click. */
    const { rerender } = render(<Library {...shelf} books={run} />)
    fireEvent.click(screen.getByTitle('Open Bede'), { metaKey: true })
    fireEvent.click(screen.getByTitle('Select Anna'), { metaKey: true })
    expect(selected()).toEqual(['Anna', 'Bede'])

    rerender(<Library {...shelf} books={run} libraryQuery="d" />)
    expect(screen.queryByTitle(/Anna/), 'the anchor went with the narrowing').toBeNull()
    expect(selected()).toEqual(['Bede'])

    fireEvent.click(screen.getByTitle('Select Dido'), { shiftKey: true })
    expect(selected()).toEqual(['Bede', 'Dido'])
  })

  it('keeps only what the shelf still shows, once it has narrowed', () => {
    /* PRUNED, not merely hidden. A selection that came back when the shelf did
       would let a bulk action reach books the reader narrowed away and forgot. */
    const { rerender } = render(<Library {...shelf} books={run} />)
    selectAll()
    expect(selected().length).toBe(5)
    rerender(<Library {...shelf} books={run} libraryQuery="Dido" />)
    expect(selected()).toEqual(['Dido'])
    rerender(<Library {...shelf} books={run} />)
    expect(selected()).toEqual(['Dido'])
  })

  /**
   * ⚠️ **AND IT READS NOTHING TO DO IT WHEN THERE IS NOTHING TO PRUNE**, which
   * is what makes the shortcut a branch the gate can hold rather than one it
   * must exempt.
   *
   * The shortcut was deleted once as an equivalent mutant — an empty selection
   * keeps nothing, so the size comparison below it answers the same question —
   * and a review then COUNTED the work: it answers it only after walking every
   * row on the shelf. At about two thousand books that is a second pass over
   * the whole library on every keystroke that changes the query. Counted here,
   * the same way `pinnedFirst`'s is.
   */
  it('reads no book’s id when nothing is selected', () => {
    /* The watched book sorts LAST by recency and last by title, so no render
       reaches it — what reads its id is the shelf being walked. Every other
       book carries a distinct title and timestamp, so neither ordering falls
       through to the id tie-break. */
    let reads = 0
    const watched = {
      ...book({ title: 'Zzz', addedAt: 0 }),
      get bookId() {
        reads += 1
        return 'zz'
      },
    } as IndexedBook
    const long = [
      ...Array.from({ length: 80 }, (_, at) =>
        book({ bookId: `bk${at}`, title: `Book ${at}`, addedAt: 100 - at }),
      ),
      watched,
    ]
    render(<Library {...shelf} books={long} />)

    reads = 0
    fireEvent.click(screen.getByLabelText(/^Sort: /))
    fireEvent.click(screen.getByText('Title'))
    /* ONE read, and it is the derivation the bar and every bulk action share:
       `selectedBooks` intersects the shelf with the selection on every change,
       whatever is selected. A prune that walked as well would be the second
       pass over the same rows for an answer it already has. */
    expect(reads, 'the shelf was walked to prune a selection that is empty').toBeLessThan(2)

    /* Non-vacuous: with a selection the walk does happen, through the same
       getter — an instrument that never fires proves nothing. */
    const before = reads
    selectAll()
    expect(reads).toBeGreaterThan(before)
  })

  it('lets the anchor go when the selection goes', () => {
    /* Done clears the anchor as well as the books. Left behind, the next
       ⇧-click ran from a book the reader had already let go of. */
    render(<Library {...shelf} books={run} />)
    fireEvent.click(screen.getByTitle('Open Anna'), { metaKey: true })
    fireEvent.click(screen.getByLabelText('Clear the selection'))
    fireEvent.click(screen.getByTitle('Open Dido'), { shiftKey: true })
    expect(selected()).toEqual(['Dido'])
  })
})

describe('tagging a selection', () => {
  /* A REAL PRESS IS A POINTERDOWN BEFORE ITS CLICK, and the pointerdown is the
     half that went wrong: the editor's outside-click handler did not know the
     button was its trigger, closed the editor, and the click reopened it. */
  it('puts the editor away when its own button is pressed again', () => {
    render(<Library {...shelf} />)
    selectAll()
    const tags = screen.getByRole('button', { name: /Tags…/ })

    fireEvent.click(tags)
    expect(screen.getByRole('dialog', { name: 'Tags for 3 selected books' })).toBeTruthy()

    fireEvent.pointerDown(tags)
    fireEvent.click(tags)
    expect(screen.queryByRole('dialog', { name: /^Tags for/ })).toBeNull()
  })
})

describe('the tag editor over a selection', () => {
  const open = () => {
    selectAll()
    fireEvent.click(screen.getByRole('button', { name: /Tags…/ }))
    return screen.getByRole('dialog', { name: /^Tags for/ })
  }

  it('hangs under the button it opened from, on its leading edge', () => {
    render(<Library {...shelf} />)
    const editor = open()
    /* The anchor is 100 wide at (40, 40) and 32 tall; the editor is 60 wide.
       Under it is 40 + 32 + the 4px gap; aligned to its start is its own left. */
    expect(editor.style.top).toBe('76px')
    expect(editor.style.left).toBe('40px')
  })

  it('closes on a press outside it', () => {
    render(<Library {...shelf} />)
    open()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog', { name: /^Tags for/ })).toBeNull()
  })

  it('goes away with the selection it was editing', () => {
    /* The editor is ABOUT the selection, so Done takes both. Left open, it came
       back over the next gathering as though the reader had asked for it. */
    render(<Library {...shelf} />)
    open()
    fireEvent.click(screen.getByLabelText('Clear the selection'))
    selectAll()
    expect(screen.queryByRole('dialog', { name: /^Tags for/ })).toBeNull()
  })

  it('offers the way back from the last removal, and takes it', () => {
    const onUndoRemoveTag = vi.fn()
    render(
      <Library
        {...shelf}
        lastRemoval={{ tag: 'history', bookIds: ['bk1', 'bk2'] }}
        onUndoRemoveTag={onUndoRemoveTag}
      />,
    )
    open()
    expect(screen.getByText(/Removed history from 2 books/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Undo/ }))
    expect(onUndoRemoveTag).toHaveBeenCalledTimes(1)
  })

  it('draws no Undo for a host that has no way back to offer', () => {
    /* Passed THROUGH rather than defaulted to a no-op: a stand-in made the
       editor draw a working-looking button that did nothing. */
    const { onUndoRemoveTag: _u, ...noUndo } = shelf
    render(<Library {...noUndo} lastRemoval={{ tag: 'history', bookIds: ['bk1'] }} />)
    open()
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull()
  })

  it('draws no editor for a host that has withdrawn the two verbs', () => {
    /* The popover's own guard. The bar's Tags… button goes when the host takes
       the callbacks away, and an editor already open must not stay behind
       offering an Add it cannot perform. */
    const { rerender } = render(<Library {...shelf} />)
    open()
    expect(screen.getByLabelText(/^Add a tag to/)).toBeTruthy()
    const { onTagBooks: _t, onUntagBooks: _u, ...readOnly } = shelf
    rerender(<Library {...readOnly} />)
    expect(screen.queryByLabelText(/^Add a tag to/)).toBeNull()
  })

  it('draws no editor for a host that has withdrawn only one of them', () => {
    /* BOTH OR NEITHER, inside the popover as on the bar. Withdrawing both says
       nothing about the `&&`: an editor kept for either verb alone passes that
       test too, and draws a panel half of which does nothing. */
    for (const kept of ['onTagBooks', 'onUntagBooks'] as const) {
      const { rerender, unmount } = render(<Library {...shelf} />)
      open()
      expect(screen.getByLabelText(/^Add a tag to/)).toBeTruthy()
      const half = { ...shelf, onTagBooks: undefined, onUntagBooks: undefined, [kept]: shelf[kept] }
      rerender(<Library {...half} />)
      expect(screen.queryByLabelText(/^Add a tag to/), `only ${kept} left`).toBeNull()
      unmount()
    }
  })

  it('needs both verbs before it offers the bar’s button at all', () => {
    /* Add and remove are one surface, so half of them is a panel half of which
       does nothing. */
    const { onUntagBooks: _u, ...half } = shelf
    render(<Library {...half} />)
    selectAll()
    expect(screen.queryByRole('button', { name: /Tags…/ })).toBeNull()
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

  it('offers the way back when every book in the selection is done', () => {
    /* "Unfinished", not "unread": clearing `finished` keeps each book's
       position. The label is true of the whole selection or it is a lie about
       some of it. */
    const onSetFinished = vi.fn()
    const done = BOOKS.map((one) => ({ ...one, finished: true }))
    render(<Library {...shelf} books={done} onSetFinished={onSetFinished} />)
    selectAll()
    fireEvent.click(screen.getByText('Mark as unfinished'))
    expect(onSetFinished.mock.calls.map((c) => c[0]).sort()).toEqual(['bk1', 'bk2', 'bk3'])
    expect(onSetFinished.mock.calls.every((c) => c[1] === false)).toBe(true)
  })

  it('still offers to finish a selection only part of which is', () => {
    const mixed = BOOKS.map((one, at) => (at === 0 ? { ...one, finished: true } : one))
    render(<Library {...shelf} books={mixed} />)
    selectAll()
    expect(screen.getByText('Mark as finished')).toBeTruthy()
    expect(screen.queryByText('Mark as unfinished')).toBeNull()
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

  /* The two routes in are optional ONE AT A TIME, so the sentence has to be
     built from the ones that are there — either alone used to be offered as
     "a book, or a folder of them". */
  it('names only the way in a host gave, when it gave one', () => {
    const { onAddFolder: _d, ...booksOnly } = shelf
    const { unmount } = render(<Library {...booksOnly} books={[]} />)
    expect(screen.getByText(/^Add a book — /)).toBeTruthy()
    expect(screen.queryByText(/folder/)).toBeNull()
    unmount()

    const { onAddBooks: _a, ...folderOnly } = shelf
    render(<Library {...folderOnly} books={[]} />)
    expect(screen.getByText(/^Add a folder of books — /)).toBeTruthy()
    expect(screen.queryByText(/Add a book/)).toBeNull()
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
