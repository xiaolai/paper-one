// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BookCell, readSelectClick } from './BookCell'
import { CANNOT_OPEN, CANNOT_OPEN_FETCHABLE } from '../../core/library'
import type { BookAction } from '../../core/capability'
import { BookRow } from './BookRow'
import { Library } from './Library'
import type { IndexedBook } from '../../core/bookIndex'

/**
 * ONE SELECTION MODEL, READ THE SAME WAY BY BOTH VIEWS.
 *
 * `readSelectClick` exists because the card and the row each carried this
 * chain, and two copies of what ⌘, ⇧ and a plain click mean is exactly how a
 * grid and a list come to disagree about one shelf's selection. It had no
 * test, so nothing held the two together except that they both happened to
 * call it — and nothing said what it should answer.
 *
 * The tests below pin the function AND the fact that each view routes its
 * click through it, which is the part a refactor can quietly undo.
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
  activity: null,
} as const

/* REACT'S MouseEvent, not the DOM's — `readSelectClick` is called from a JSX
   handler, and the two types differ enough that `tsc` refuses the swap even
   though the three fields read here are identical. */
const mouse = (over: Partial<React.MouseEvent> = {}) =>
  ({ metaKey: false, ctrlKey: false, shiftKey: false, ...over }) as React.MouseEvent

describe('what one click on a book means', () => {
  it('opens it, when nothing is selected and no key is held', () => {
    expect(readSelectClick(mouse(), false)).toBe('open')
  })

  it('toggles under ⌘ or Ctrl, whichever platform the reader is on', () => {
    expect(readSelectClick(mouse({ metaKey: true }), false)).toBe('toggle')
    expect(readSelectClick(mouse({ ctrlKey: true }), false)).toBe('toggle')
  })

  it('extends under ⇧', () => {
    expect(readSelectClick(mouse({ shiftKey: true }), false)).toBe('range')
  })

  it('toggles on a bare click once ANYTHING is selected', () => {
    /* Photos' model, and the reason it is worth having: a trackpad reader can
       gather ten books without holding a key down for the whole run. */
    expect(readSelectClick(mouse(), true)).toBe('toggle')
  })

  it('lets a modifier win over the selecting state', () => {
    /* ⇧ while selecting must still extend — otherwise a range is unreachable
       after the first book, which is when a reader wants one. */
    expect(readSelectClick(mouse({ shiftKey: true }), true)).toBe('range')
  })
})

describe('the row and the card route their click through it', () => {
  it('the row opens on a plain click', () => {
    const onOpen = vi.fn()
    const onSelect = vi.fn()
    render(<BookRow {...shared} book={book()} onOpen={onOpen} onSelect={onSelect} />)
    fireEvent.click(screen.getByTitle('Open Bad Blood'))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ bookId: 'bk1' }))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('the row selects under ⌘ instead of opening', () => {
    const onOpen = vi.fn()
    const onSelect = vi.fn()
    render(<BookRow {...shared} book={book()} onOpen={onOpen} onSelect={onSelect} />)
    fireEvent.click(screen.getByTitle('Open Bad Blood'), { metaKey: true })
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ bookId: 'bk1' }), 'toggle')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('the card agrees with the row on both', () => {
    const onOpen = vi.fn()
    const onSelect = vi.fn()
    render(<BookCell {...shared} setQuery={vi.fn()} book={book()} onOpen={onOpen} onSelect={onSelect} />)
    fireEvent.click(screen.getByTitle('Open Bad Blood'))
    expect(onOpen).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTitle('Open Bad Blood'), { shiftKey: true })
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ bookId: 'bk1' }), 'range')
  })
})

describe('dragging a book off the shelf', () => {
  it('tells the shelf which book left, from either view', () => {
    /* The shelf writes the drag payload, so a view that forgot to report the
       book would drag whatever was dragged last. */
    for (const view of ['row', 'cell'] as const) {
      const onDragStart = vi.fn()
      const { container } = render(
        view === 'row' ? (
          <BookRow {...shared} book={book()} onDragStart={onDragStart} />
        ) : (
          <BookCell {...shared} setQuery={vi.fn()} book={book()} onDragStart={onDragStart} />
        ),
      )
      const draggable = container.querySelector('[draggable]')
      expect(draggable, `${view} has a draggable`).toBeTruthy()
      fireEvent.dragStart(draggable!)
      expect(onDragStart, view).toHaveBeenCalledWith(expect.objectContaining({ bookId: 'bk1' }), expect.anything())
      cleanup()
    }
  })
})

/**
 * WHAT A ROW WITH NO BYTES TELLS THE READER TO DO.
 *
 * The row and the card both draw this, and the menu beneath them draws the
 * action it names — so the two must be one judgement. They were not: the
 * sentence said "add the file again" on every device while a satchel's menu
 * offered Download, which needs no original file at all. A remedy the reader
 * cannot perform reads as a lost book.
 */

/* The messages are TWO LINES, and Testing Library normalises whitespace in
   the DOM but not in the query — so a raw constant never matches. Collapsing
   the query is the honest way round: it asserts the same words. */
const oneLine = (message: string) => message.replace(/\n/g, ' ')

const noBytes = () => book({ hasContent: false })

const downloadAction: BookAction = {
  id: 'sync:download',
  label: 'Download',
  fetchesContent: true,
  when: (b) => b.hasContent !== true,
  run: () => {},
}

describe('a book this device has no copy of', () => {
  it('tells a lone shelf to re-import, because nothing can fetch it', () => {
    render(<BookRow {...shared} book={noBytes()} />)
    expect(screen.getByTitle(oneLine(CANNOT_OPEN))).toBeTruthy()
  })

  it('tells a satchel to download, because that is the actual repair', () => {
    render(<BookRow {...shared} book={noBytes()} actions={[downloadAction]} />)
    expect(screen.getByTitle(oneLine(CANNOT_OPEN_FETCHABLE))).toBeTruthy()
    expect(screen.queryByTitle(oneLine(CANNOT_OPEN))).toBeNull()
  })

  it('says the same thing on the card, including its "no copy" mark', () => {
    /* Two places on one card carry this sentence. They disagreed for as long
       as there were two literals. */
    render(<BookCell {...shared} setQuery={vi.fn()} book={noBytes()} actions={[downloadAction]} />)
    expect(screen.getAllByTitle(oneLine(CANNOT_OPEN_FETCHABLE)).length).toBe(2)
  })

  it('does not promise a download the menu would not offer', () => {
    /* Same `when` as the menu. An action filtered out for this book must not
       change what the tooltip promises. */
    const shelfSide = { ...downloadAction, when: () => false }
    render(<BookRow {...shared} book={noBytes()} actions={[shelfSide]} />)
    expect(screen.getByTitle(oneLine(CANNOT_OPEN))).toBeTruthy()
  })

  it('says nothing of the sort about a book that is here', () => {
    render(<BookRow {...shared} book={book()} actions={[downloadAction]} />)
    expect(screen.getByTitle('Open Bad Blood')).toBeTruthy()
  })
})

describe('the corner mark on a book with no bytes here', () => {
  /* The words became a glyph — "no copy" needed a quarter of the jacket to
     say what an icon says in 15px, on the one surface whose purpose is that
     the artwork is legible — and the glyph became the download, because a
     reader told "not on this device" wants it on this device and the cloud is
     where they will press. */
  const mark = (container: HTMLElement) => container.querySelector('[class*="noCopy"]')

  it('draws a cloud on a book that is not here', () => {
    const { container } = render(
      <BookCell {...shared} setQuery={vi.fn()} book={noBytes()} actions={[downloadAction]} />,
    )
    expect(mark(container)?.querySelector('svg')?.getAttribute('class')).toContain('cloud-download')
  })

  it('marks nothing on a book that is here', () => {
    const { container } = render(<BookCell {...shared} setQuery={vi.fn()} book={book()} />)
    expect(mark(container)).toBeNull()
  })

  it('runs the download when pressed, naming the book', () => {
    /* THE SAME ACTION THE MENU LISTS, found by the same rule. A second route
       to the download that called something else is how the two come to mean
       different things. */
    const run = vi.fn()
    const { container } = render(
      <BookCell {...shared} setQuery={vi.fn()} book={noBytes()} actions={[{ ...downloadAction, run }]} />,
    )
    fireEvent.click(mark(container)!)
    expect(run).toHaveBeenCalledWith('bk1')
  })

  it('is a real button, so a keyboard reaches it', () => {
    const { container } = render(
      <BookCell {...shared} setQuery={vi.fn()} book={noBytes()} actions={[downloadAction]} />,
    )
    expect(mark(container)?.tagName).toBe('BUTTON')
  })

  it('is NOT pressable when nothing can fetch the bytes', () => {
    /* A lone shelf whose record lost its bytes. Re-importing is the repair,
       and a control that does nothing is worse than no control. */
    const { container } = render(<BookCell {...shared} setQuery={vi.fn()} book={noBytes()} />)
    expect(mark(container)?.tagName).toBe('SPAN')
  })

  it('does not open or select the book it sits on', () => {
    /* It used to live INSIDE the open button, where a click would have done
       both — and where, as a button, the browser would have dropped it
       entirely and the download would never have fired. */
    const onOpen = vi.fn()
    const onSelect = vi.fn()
    const { container } = render(
      <BookCell
        {...shared}
        setQuery={vi.fn()}
        book={noBytes()}
        actions={[downloadAction]}
        onOpen={onOpen}
        onSelect={onSelect}
      />,
    )
    fireEvent.click(mark(container)!)
    expect(onOpen).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('will not take a second press while the first is still running', () => {
    /* The capability coalesces duplicate downloads, but a control that keeps
       accepting clicks while doing the thing it was clicked for reads as one
       that did not hear the first. */
    let release = () => {}
    const run = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const { container } = render(
      <BookCell {...shared} setQuery={vi.fn()} book={noBytes()} actions={[{ ...downloadAction, run }]} />,
    )
    const mark = container.querySelector('[class*="noCopy"]') as HTMLButtonElement
    fireEvent.click(mark)
    expect(run).toHaveBeenCalledTimes(1)
    expect(mark.disabled).toBe(true)
    fireEvent.click(mark)
    expect(run).toHaveBeenCalledTimes(1)
    release()
  })

  it('comes back when the action fails before it returns a promise', async () => {
    /* A SYNCHRONOUS throw never reaches `.finally`, so the button stayed
       disabled for the life of the card — the reader's only route to the
       bytes, dead, because the failure was too early. */
    const run = vi.fn(() => {
      throw new Error('no session')
    })
    const { container } = render(
      <BookCell {...shared} setQuery={vi.fn()} book={noBytes()} actions={[{ ...downloadAction, run }]} />,
    )
    const mark = container.querySelector('[class*="noCopy"]') as HTMLButtonElement
    /* The control must come back whichever way the action failed, and a
       synchronous throw is the one that used to escape `.finally`. Reporting
       belongs to the action — sync's download sets `degraded` — so what is
       asserted here is the button, not the message. */
    fireEvent.click(mark)
    expect(run).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(mark.disabled, 'the control released itself').toBe(false))
  })

  it('still says it in words, for a reader who cannot see the glyph', () => {
    /* An `svg` with a `title` attribute is announced by no screen reader, and
       this is the button's whole accessible name. */
    render(<BookCell {...shared} setQuery={vi.fn()} book={noBytes()} actions={[downloadAction]} />)
    expect(screen.getByText(oneLine(CANNOT_OPEN_FETCHABLE))).toBeTruthy()
  })
})

describe('extending a selection across the shelf', () => {
  /* `readSelectClick` only decides that ⇧ MEANS range. What a range IS — the
     anchor, the two indices, the slice, and what happens with no anchor —
     lives in `Library.select` and nothing exercised it, so a reversed range,
     a missing anchor or an off-by-one could regress silently. Driven through
     the shelf, because the indices are into the shelf AS SHOWN: whatever the
     sort and filter have made of it, not the order the books arrived in. */
  /* Authors share no letter with the queried one, so a filter test narrows by
     TITLE and the shelf actually shrinks. */
  const shelfBooks = [
    book({ bookId: 'a', title: 'Anna', author: 'Zed' }),
    book({ bookId: 'b', title: 'Bede', author: 'Zed' }),
    book({ bookId: 'c', title: 'Cato', author: 'Zed' }),
    book({ bookId: 'd', title: 'Dido', author: 'Zed' }),
  ]

  const shelf = {
    books: shelfBooks,
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

  const selected = () =>
    [...document.querySelectorAll('[title^="Deselect "]')].map((el) =>
      el.getAttribute('title')?.replace('Deselect ', ''),
    )

  it('takes everything between the anchor and the click', () => {
    render(<Library {...shelf} />)
    fireEvent.click(screen.getByTitle('Open Anna'), { metaKey: true })
    /* An UNselected card offers "Select" while a selection is running; only
       the ones already in say "Deselect". */
    fireEvent.click(screen.getByTitle('Select Cato'), { shiftKey: true })
    expect(selected()).toEqual(['Anna', 'Bede', 'Cato'])
  })

  it('runs backwards just as well', () => {
    /* `Math.min`/`Math.max` are what make this true; a naive slice from the
       anchor forwards selects nothing when the reader clicks upwards. */
    render(<Library {...shelf} />)
    fireEvent.click(screen.getByTitle('Open Dido'), { metaKey: true })
    fireEvent.click(screen.getByTitle('Select Bede'), { shiftKey: true })
    expect(selected()).toEqual(['Bede', 'Cato', 'Dido'])
  })

  it('is a plain toggle when there is no anchor to run from', () => {
    /* The documented fallback. Without it the first ⇧-click on a fresh shelf
       does nothing at all, which reads as a broken modifier. */
    render(<Library {...shelf} />)
    fireEvent.click(screen.getByTitle('Open Cato'), { shiftKey: true })
    expect(selected()).toEqual(['Cato'])
  })

  it('extends across the shelf AS SHOWN, not as it was given', () => {
    /* The indices are into the filtered shelf. A range computed against the
       unfiltered list would select books the reader cannot see. */
    render(<Library {...shelf} libraryQuery="a" />)
    const shown = [...document.querySelectorAll('[title^="Open "]')].map((el) =>
      el.getAttribute('title')?.replace('Open ', ''),
    )
    expect(shown.length, 'the query narrowed the shelf').toBeLessThan(shelfBooks.length)
    fireEvent.click(screen.getByTitle(`Open ${shown[0]}`), { metaKey: true })
    fireEvent.click(screen.getByTitle(`Select ${shown[shown.length - 1]}`), { shiftKey: true })
    expect(selected()).toEqual(shown)
  })
})
