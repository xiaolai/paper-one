// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Marginalia } from './Marginalia'
import { MAX_MARK_NOTE, type Annotation, type Bookmark, type Mark } from '../../core/marks'
import type { MarkControl } from '../../core/capability'
import type { MarksView } from '../hooks/useMarks'
import type { CardsView } from '../hooks/useCards'
import type { JumpTarget } from '../hooks/useJumps'

/**
 * The rows this panel draws across every book, and whether each one can be
 * reached.
 *
 * WHY THIS FILE DID NOT EXIST BEFORE, which is the thing worth saying: the
 * panel is the app's thesis — everything the reader put in a book, browsable
 * across all of them — and it had no test at all. What that cost was a
 * feature built and switched off: it went cross-book, and then disabled the
 * jump on every row but the open book's, because there was nowhere for those
 * rows to go. Nothing measured that most of the panel was inert.
 *
 * These assert the reachability rule and nothing else. Filtering, note
 * editing and card-making are separate subjects and are not tested here.
 */

afterEach(cleanup)

const ANNOTATION = (over: Partial<Mark> = {}): Annotation =>
  ({
    id: 'm1',
    bookId: 'open-book',
    cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:9)',
    sectionIndex: 0,
    text: 'call me ishmael',
    prefix: '',
    suffix: '',
    note: '',
    kind: 'highlight',
    tint: 'yellow',
    style: 'fill',
    chapter: 'Loomings',
    createdAt: 1,
    ...over,
  }) as Annotation

const BOOKMARK = (over: Partial<Mark> = {}): Bookmark =>
  ({
    ...ANNOTATION({ id: 'b1', kind: 'bookmark', text: '', ...over }),
    kind: 'bookmark',
  }) as Bookmark

function marksView(over: Partial<MarksView> = {}): MarksView {
  return {
    all: [],
    current: [],
    bookmarks: [],
    allBookmarks: [], allUnplaced: [],
    persistent: true,
    unreadable: false,
    scanFailed: false,
    ready: true,
    add: vi.fn(),
    remove: vi.fn(),
    setNote: vi.fn(),
    rekey: vi.fn(),
    loadAll: vi.fn(),
    ...over,
  } as unknown as MarksView
}

const cardsView = (): CardsView =>
  ({ all: [], persistent: true, make: vi.fn(), remove: vi.fn(), rekey: vi.fn() }) as unknown as CardsView

/** The panel, with only the props these assertions care about varied. */
function draw(over: {
  all?: readonly Annotation[]
  allBookmarks?: readonly Bookmark[]
  allUnplaced?: readonly Annotation[]
  onShelf?: (bookId: string) => boolean
  onGoTo?: (target: JumpTarget) => void
  unreadable?: boolean
  scanFailed?: boolean
  persistent?: boolean
  readOnly?: boolean
  markControls?: readonly MarkControl[]
}) {
  const onGoTo = over.onGoTo ?? vi.fn()
  const readOnly = (view: MarksView): MarksView => {
    const { setNote: _setNote, ...rest } = view
    return rest as MarksView
  }
  render(
    <Marginalia
      {...(over.markControls ? { markControls: over.markControls } : {})}
      marks={(over.readOnly ? readOnly : (view: MarksView) => view)(marksView({
        all: over.all ?? [],
        allBookmarks: over.allBookmarks ?? [],
        allUnplaced: over.allUnplaced ?? [],
        unreadable: over.unreadable ?? false,
        scanFailed: over.scanFailed ?? false,
        persistent: over.persistent ?? true,
      }))}
      cards={cardsView()}
      bookId="open-book"
      onDelete={vi.fn()}
      onDeleteBookmark={vi.fn()}
      platform="macos"
      titleOf={(id) => (id === 'other-book' ? 'Ulysses' : undefined)}
      {...(over.onShelf ? { onShelf: over.onShelf } : {})}
      onGoTo={onGoTo}
    />,
  )
  return { onGoTo }
}

/** The jump control on a mark row is the button carrying the mark's own text. */
const rowFor = (text: string) => screen.getByRole('button', { name: new RegExp(text, 'i') })

describe('a row from the open book', () => {
  it('is enabled and jumps to its own place', () => {
    const { onGoTo } = draw({ all: [ANNOTATION()] })
    const row = rowFor('call me ishmael')
    expect(row.hasAttribute('disabled')).toBe(false)
    row.click()
    expect(onGoTo).toHaveBeenCalledWith({
      bookId: 'open-book',
      cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:9)',
    })
  })
})

describe('a row from another book', () => {
  const OTHER = ANNOTATION({ id: 'm2', bookId: 'other-book', text: 'stately plump buck' })

  it('is enabled when that book is on the shelf, and names the book it belongs to', () => {
    /* THE FEATURE THAT WAS BUILT AND SWITCHED OFF. The panel has listed these
       rows all along; what it lacked was anywhere for them to go. */
    const { onGoTo } = draw({ all: [OTHER], onShelf: (id) => id === 'other-book' })
    expect(screen.getByText('Ulysses')).toBeTruthy()
    const row = rowFor('stately plump buck')
    expect(row.hasAttribute('disabled')).toBe(false)
    row.click()
    expect(onGoTo).toHaveBeenCalledWith({
      bookId: 'other-book',
      cfi: OTHER.cfi,
    })
  })

  it('stays disabled when that book has left the shelf', () => {
    /* The rule did not go away, its subject narrowed. A book Paper no longer
       holds cannot be opened at a CFI, and a control that silently does
       nothing is still worse than none. */
    const gone = ANNOTATION({ id: 'm3', bookId: 'deleted-book', text: 'a lost passage' })
    draw({ all: [gone], onShelf: () => false })
    expect(rowFor('a lost passage').hasAttribute('disabled')).toBe(true)
  })

  it('stays disabled when nothing was asked about the shelf at all', () => {
    /* No `onShelf` means the host cannot say, and the honest answer to "can
       this be reached" is then no. Defaulting the other way would enable every
       row on a promise nobody made. */
    draw({ all: [OTHER] })
    expect(rowFor('stately plump buck').hasAttribute('disabled')).toBe(true)
  })
})

describe('a place row', () => {
  it('follows the same rule as a mark row, on all three cases at once', () => {
    /* ONE RENDER, THREE ROWS, because the point is that they DIFFER: the panel
       computes `reachable` once and hands it down, and a place row asking the
       question a second way is how the two came apart before. */
    const here = BOOKMARK({ id: 'b-open', bookId: 'open-book', chapter: 'Loomings' })
    const away = BOOKMARK({ id: 'b-away', bookId: 'other-book', chapter: 'Telemachus' })
    const gone = BOOKMARK({ id: 'b-gone', bookId: 'deleted-book', chapter: 'Nowhere' })
    const { onGoTo } = draw({
      allBookmarks: [here, away, gone], allUnplaced: [],
      onShelf: (id) => id !== 'deleted-book',
    })
    /* ANCHORED, because the delete button's `aria-label` is "Remove this
       bookmark — <chapter>" and a loose match finds both. The jump button's
       whole accessible name is the chapter when the place has no remembered
       line, which these deliberately do not. */
    const jump = (chapter: string) =>
      screen.getByRole('button', { name: new RegExp(`^${chapter}$`) })

    expect(jump('Loomings').hasAttribute('disabled')).toBe(false)
    expect(jump('Telemachus').hasAttribute('disabled')).toBe(false)
    expect(jump('Nowhere').hasAttribute('disabled')).toBe(true)

    jump('Telemachus').click()
    expect(onGoTo).toHaveBeenCalledWith({ bookId: 'other-book', cfi: away.cfi })
  })
})

/**
 * A SESSION THAT MAY ONLY READ MARKS IS DRAWN AS ONE.
 *
 * `onDelete`, `onDeleteBookmark` and `marks.setNote` were required props, so
 * every host had to supply them — including the browser client, whose session
 * holds exactly one grant and it is `readingGrant` (`webhost/lib/pump.ts`).
 * `mark.remove` and `mark.set` are `mark:write`, so each call was refused after
 * the panel had already applied it optimistically: the row vanished and came
 * back, and a note was typed, committed, and thrown away with nothing said.
 *
 * A control that cannot work is worse than an absent one — this file's own
 * opening paragraph is about a feature that was inert and unmeasured. These
 * assert the absence, so restoring the requirement is a red test rather than a
 * button that undoes itself.
 */
describe('a read-only host', () => {
  /** The panel with every write callback withheld, as the browser mounts it. */
  function readOnly(all: readonly Annotation[], allBookmarks: readonly Bookmark[] = []) {
    const view = marksView({ all, allBookmarks })
    render(
      <Marginalia
        marks={{ ...view, setNote: undefined } as unknown as MarksView}
        bookId="open-book"
        platform="macos"
        onGoTo={vi.fn()}
      />,
    )
    return view
  }

  it('draws no delete control on a mark or on a bookmark', () => {
    readOnly([ANNOTATION()], [BOOKMARK()])
    expect(screen.queryByRole('button', { name: /delete mark/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /remove this bookmark/i })).toBeNull()
  })

  it('shows an existing note as text, with no editor to lose it in', () => {
    readOnly([ANNOTATION({ note: 'the whiteness of the whale' })])
    /* THE NOTE IS STILL READABLE — this is a read-only panel, not a blank one. */
    expect(screen.getByText('the whiteness of the whale')).toBeTruthy()
    /* …and it is not a button, so there is no editor to open. */
    expect(screen.queryByRole('button', { name: /the whiteness of the whale/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /add a note/i })).toBeNull()
  })

  it('offers no "Add a note" on a mark that has none', () => {
    readOnly([ANNOTATION({ note: '' })])
    expect(screen.queryByRole('button', { name: /add a note/i })).toBeNull()
  })

  /* THE WRITABLE HOST IS UNCHANGED, pinned here so the guards above cannot be
     satisfied by removing the controls for everybody. */
  it('still draws both controls for a host that supplied them', () => {
    draw({ all: [ANNOTATION({ note: '' })], allBookmarks: [BOOKMARK()] })
    expect(screen.getByRole('button', { name: /delete mark/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /remove this bookmark/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /add a note/i })).toBeTruthy()
  })
})

/**
 * A FOCUS REQUEST IS HONOURED ONCE.
 *
 * The reveal effect depended on the whole list of marks, and the list
 * republishes after every write — including the note's own save. So the
 * editor the reader had just closed re-opened on the next render, and any
 * mark made anywhere afterwards re-opened it again, pulling keyboard focus out
 * of the book each time. "The first blur doesn't stick" was the symptom; a
 * request that was never consumed was the cause.
 *
 * jsdom has no `scrollIntoView`; the panel's reveal calls it after paint, and
 * these mount with a request, so the stub is what lets the effect run at all.
 */
Element.prototype.scrollIntoView = vi.fn()

describe('a focus request', () => {
  const NOTED = ANNOTATION({ id: 'm1', note: 'the whiteness of the whale' })
  const editor = () => screen.queryByPlaceholderText('Write a note')

  /** The panel, with the request and the list varied across a rerender. */
  function drawFocused(all: readonly Annotation[], focus: { id: string; edit: boolean; nonce: number }) {
    const onFocusDone = vi.fn()
    const view = (rows: readonly Annotation[]) => marksView({ all: rows })
    const props = (rows: readonly Annotation[], request: typeof focus) => (
      <Marginalia
        marks={view(rows)}
        cards={cardsView()}
        bookId="open-book"
        onDelete={vi.fn()}
        onDeleteBookmark={vi.fn()}
        platform="macos"
        focus={request}
        onFocusDone={onFocusDone}
        onGoTo={vi.fn()}
      />
    )
    const mounted = render(props(all, focus))
    return {
      onFocusDone,
      /* A NEW `marks` VIEW EACH TIME, which is what the store hands out after
         any write: the list's identity changes even when its rows do not. */
      republish: (rows: readonly Annotation[] = all, request: typeof focus = focus) =>
        mounted.rerender(props(rows, request)),
    }
  }

  it('opens the editor once, and the marks republishing after the save leaves it closed', () => {
    const { republish, onFocusDone } = drawFocused([NOTED], { id: 'm1', edit: true, nonce: 1 })
    expect(editor()).not.toBeNull()
    expect(onFocusDone).toHaveBeenCalledWith(1)

    fireEvent.blur(editor()!)
    expect(editor()).toBeNull()

    /* The save itself republishes the list — this is the render that used to
       re-open the editor the reader had just left. */
    republish([ANNOTATION({ id: 'm1', note: 'the whiteness of the whale, revised' })])
    expect(editor()).toBeNull()
  })

  it('does not re-open the old editor when a mark is made somewhere else', () => {
    const { republish } = drawFocused([NOTED], { id: 'm1', edit: true, nonce: 1 })
    fireEvent.blur(editor()!)
    expect(editor()).toBeNull()

    republish([NOTED, ANNOTATION({ id: 'm2', text: 'a second passage' })])
    expect(editor()).toBeNull()
  })

  it('still opens twice when asked twice for the same mark', () => {
    /* Keyed on the nonce, so the second request is a request and not a
       repeat of the first: clicking the same margin note again brings it back. */
    const { republish } = drawFocused([NOTED], { id: 'm1', edit: true, nonce: 1 })
    fireEvent.blur(editor()!)
    expect(editor()).toBeNull()

    republish([NOTED], { id: 'm1', edit: true, nonce: 2 })
    expect(editor()).not.toBeNull()
  })

  it('closes for good when its row leaves the list, and stays closed when the row returns', () => {
    const { republish } = drawFocused([NOTED], { id: 'm1', edit: true, nonce: 1 })
    expect(editor()).not.toBeNull()
    /* The row unmounts without a blur — filtered out, scoped out, or the
       list re-read — so nothing tells the editor it closed. Another row is
       still there, so the list is not simply empty. */
    const other = ANNOTATION({ id: 'm2', text: 'a second passage' })
    republish([other])
    expect(editor()).toBeNull()
    republish([NOTED, other])
    expect(editor()).toBeNull()
  })

  it('stays open while its row is still listed among others', () => {
    const other = ANNOTATION({ id: 'm2', text: 'a second passage' })
    const { republish } = drawFocused([NOTED, other], { id: 'm1', edit: true, nonce: 1 })
    expect(editor()).not.toBeNull()
    republish([NOTED, other])
    expect(editor()).not.toBeNull()
  })

  it('stops the note at the length the store keeps', () => {
    drawFocused([NOTED], { id: 'm1', edit: true, nonce: 1 })
    expect(editor()!.getAttribute('maxlength')).toBe(String(MAX_MARK_NOTE))
  })

  it('waits for a mark the cross-book list has not loaded yet', () => {
    /* `marks.all` is empty until `loadAll` has run, and the panel mounts on the
       very click that asks for the mark — so on a first open the request
       arrives BEFORE the row it names. It has to wait for the list, which is
       why the list stays a dependency of the reveal: a request honoured once
       is not the same as a request that can only be looked at once. */
    const { republish, onFocusDone } = drawFocused([], { id: 'm1', edit: true, nonce: 1 })
    expect(editor()).toBeNull()
    expect(onFocusDone).not.toHaveBeenCalled()

    republish([NOTED])
    expect(editor()).not.toBeNull()
    expect(onFocusDone).toHaveBeenCalledWith(1)
  })
})

/* A file that is there and will not read is a different fact from a store
   that will not write, and the panel says which (WI-20.36): the reader whose
   marks vanished from the list deserves to hear that the file is damaged and
   is being left alone, not that "storage is unavailable". */
describe('a marks file that could not be read', () => {
  it('is said so, in the panel', () => {
    draw({ unreadable: true })
    expect(screen.getByText(/could not be read/).textContent).toContain('left as it is')
  })

  it('is not said of a book whose file read', () => {
    draw({})
    expect(screen.queryByText(/could not be read/)).toBeNull()
  })
})

/* The cross-book scan can FAIL, and until the store said so its catch
   installed `[]` — indistinguishable from an empty library, so this panel
   said "Nothing kept yet" over marks that were there and could not be read
   (the 2026-08-28 audit, #101/#477). */
describe('a cross-book scan that failed', () => {
  it('is said instead of the empty state, never beside it', () => {
    draw({ scanFailed: true })
    expect(screen.getByText(/Your marks could not be read/)).not.toBeNull()
    expect(screen.queryByText(/Nothing kept yet/)).toBeNull()
  })

  it('gives way to the empty state once a scan has landed', () => {
    draw({ scanFailed: false })
    expect(screen.queryByText(/Your marks could not be read/)).toBeNull()
    expect(screen.getByText(/Nothing kept yet/)).not.toBeNull()
  })
})

/**
 * A control that does nothing must say why — on BOTH row types.
 *
 * ⚠️ **THE PLACE ROW WAS DISABLED IN SILENCE.** An imported bookmark is an
 * unplaced mark of the bookmark class, and `PlaceRow` is its own row rather
 * than a variant of the annotation row — so the sentence the annotation row
 * carries never reached it. MEASURED in the running app on a name-matched
 * import: `title` and `aria-description` both null on the bookmark row, while
 * the annotation beside it explained itself. The reader sees the book open in
 * front of them and a control that silently refuses.
 */
describe('an unplaced row explains its disabled jump', () => {
  const UNPLACED = { reason: 'foreign-build' as const, fromBook: 'book:elsewhere' }
  const said = 'From another edition of this book — Paper has not found this passage here yet.'

  it('on a mark row', () => {
    draw({
      allUnplaced: [ANNOTATION({ id: 'u1', cfi: '', text: 'driving off the spleen', unplaced: UNPLACED })],
    })
    const row = rowFor('driving off the spleen')
    expect(row.hasAttribute('disabled')).toBe(true)
    expect(row.getAttribute('title')).toBe(said)
    expect(row.getAttribute('aria-description')).toBe(said)
  })

  it('on a place row', () => {
    draw({
      allBookmarks: [BOOKMARK({ id: 'u2', cfi: '', text: 'Call me Ishmael', unplaced: UNPLACED })],
    })
    const row = rowFor('Loomings')
    expect(row.hasAttribute('disabled')).toBe(true)
    expect(row.getAttribute('title'), 'a place row was disabled with no reason given').toBe(said)
    expect(row.getAttribute('aria-description')).toBe(said)
  })

  it('and a PLACED bookmark from the open book carries no such excuse', () => {
    /* The narrowing must not put the sentence on rows that work — a control
       that explains why it is disabled while being enabled reads as a defect
       of its own. */
    draw({ allBookmarks: [BOOKMARK({ id: 'b9', text: 'Call me Ishmael' })] })
    const row = rowFor('Loomings')
    expect(row.hasAttribute('disabled')).toBe(false)
    expect(row.getAttribute('title')).toBeNull()
  })
})

describe('a contributed mark control', () => {
  /* ⚠️ **THE SEAM WI-23.A1 NEEDS, PROVEN FROM THE PANEL'S SIDE.** A capability
     draws its element on the reader's own mark; the kernel places it and
     never learns what it does. What has to be true here is WHERE it lands —
     under every annotation, never on a bookmark — and that the mark handed
     over is the row's own. */
  const seen: string[] = []
  const control = {
    id: 'circle:share' as const,
    render: (mark: Annotation) => {
      seen.push(mark.id)
      return <button type="button">Share {mark.id}</button>
    },
  }

  it('is drawn on every annotation row, with that row’s own mark', () => {
    seen.length = 0
    render(
      <Marginalia
        marks={marksView({ all: [ANNOTATION({ id: 'm1' }), ANNOTATION({ id: 'm2', text: 'the whale' })] })}
        cards={cardsView()}
        bookId="open-book"
        platform="macos"
        markControls={[control]}
      />,
    )
    expect(screen.getByRole('button', { name: 'Share m1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Share m2' })).toBeTruthy()
    expect([...seen].sort()).toEqual(['m1', 'm2'])
  })

  it('is never drawn on a bookmark, which is a place and not a passage', () => {
    seen.length = 0
    render(
      <Marginalia
        marks={marksView({ allBookmarks: [BOOKMARK({ id: 'b1' })] })}
        cards={cardsView()}
        bookId="open-book"
        platform="macos"
        markControls={[control]}
      />,
    )
    expect(screen.queryByRole('button', { name: /^Share/u })).toBeNull()
    expect(seen).toEqual([])
  })

  it('draws nothing when the host contributes none', () => {
    render(
      <Marginalia
        marks={marksView({ all: [ANNOTATION({ id: 'm1' })] })}
        cards={cardsView()}
        bookId="open-book"
        platform="macos"
      />,
    )
    expect(screen.queryByRole('button', { name: /^Share/u })).toBeNull()
  })
})

describe('a mark control — on the reader’s own highlights, inside a boundary', () => {
  const control = (render: (mark: Annotation) => unknown): MarkControl => ({ id: 'circle:share', render })

  it('is drawn on a highlight and not on a companion annotation', () => {
    draw({
      all: [ANNOTATION(), ANNOTATION({ id: 'm2', kind: 'companion', text: 'a model claims this' })],
      markControls: [control((mark) => <button type="button">{`share ${mark.id}`}</button>)],
    })
    expect(screen.getByRole('button', { name: 'share m1' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'share m2' })).toBeNull()
    expect(document.querySelectorAll('[data-mark-control]')).toHaveLength(1)
  })

  it('cannot take the row with it when it throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    draw({
      all: [ANNOTATION()],
      markControls: [
        control(() => {
          throw new Error('port gone')
        }),
      ],
    })
    expect(screen.getByText(/A mark control could not be drawn/u)).toBeTruthy()
    expect(rowFor('call me ishmael')).toBeTruthy()
    spy.mockRestore()
  })
})

describe('a store that stopped saving, over an empty list', () => {
  it('is said in the empty state, not only over rows', () => {
    draw({ persistent: false })
    expect(screen.getByText(/not being saved/)).not.toBeNull()
  })

  it('is not said of a store that saves', () => {
    draw({})
    expect(screen.queryByText(/not being saved/)).toBeNull()
  })
})

describe('a marks file that could not be read, over an empty list', () => {
  it('does not claim the shelf is empty', () => {
    draw({ unreadable: true })
    expect(screen.queryByText(/Nothing kept yet/)).toBeNull()
    expect(screen.getByText(/could not be read/)).not.toBeNull()
  })
})

describe('a note read without an editor', () => {
  it('is drawn trimmed, and a whitespace note is not drawn at all', () => {
    draw({ readOnly: true, all: [ANNOTATION({ id: 'm1', note: '  spaced  ' }), ANNOTATION({ id: 'm2', text: 'blank', note: '   ' })] })
    expect(screen.getByText('spaced').textContent).toBe('spaced')
    expect(screen.queryByText(/^\s+$/)).toBeNull()
  })
})

describe('a filter with nothing under it', () => {
  it('says which filter is empty, and says nothing when rows are shown', () => {
    draw({ all: [ANNOTATION({ id: 'm1', note: '' })] })
    expect(screen.queryByText(/^No /)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Notes' }))
    expect(screen.getByText(/^No notes/)).not.toBeNull()
  })
})

describe('the note button', () => {
  it('shows the note trimmed, and offers to add one over a blank note', () => {
    draw({ all: [ANNOTATION({ id: 'm1', note: '  spaced  ' }), ANNOTATION({ id: 'm2', text: 'blank', note: '   ' })] })
    expect(screen.getByRole('button', { name: 'spaced' }).textContent).toBe('spaced')
    expect(screen.getByRole('button', { name: 'Add a note' })).not.toBeNull()
  })
})
