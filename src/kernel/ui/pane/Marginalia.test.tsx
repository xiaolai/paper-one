// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Marginalia } from './Marginalia'
import styles from './SidePane.module.css'
import { flushBeforeClose } from '../../core/beforeClose'
import { MAX_MARK_NOTE, type Annotation, type Bookmark, type Mark } from '../../core/marks'
import type { MarkControl } from '../../core/capability'
import { useMarks, type MarksView } from '../hooks/useMarks'
import type { MarkSnapshot, MarkStore } from '../../core/markStore'
import type { CardsView } from '../hooks/useCards'
import type { JumpTarget } from '../hooks/useJumps'
import type { GlossState } from '../hooks/useGloss'
import { cardFromLookup, type Lookup, type LookupOccurrence } from '../../core/lookups'

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
 * They began with the reachability rule and nothing else. Filtering, the note
 * editor, card-making and the scan have joined it since, each under its own
 * heading below.
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

/** Every row drawn, in order — each carries `data-focused`, and nothing else does. */
const rowsDrawn = () => [...document.querySelectorAll<HTMLElement>('[data-focused]')]

/** The rows drawn, in order, each by the words on its jump control. */
const listed = () => rowsDrawn().map((row) => row.querySelector('button')?.textContent ?? '')

/** Whether the chip of that name is the one on. */
const chipOn = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-pressed')

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

  /* THE RULE IS ASKED AGAIN WHEN ITS ANSWER CAN CHANGE — a book put back on the
     shelf, or another book opened — not remembered from the panel's first draw. */
  it('follows the shelf when the host’s answer changes, without the panel reopening', () => {
    const at = (onShelf: (bookId: string) => boolean) => (
      <Marginalia marks={marksView({ all: [OTHER] })} bookId="open-book" platform="macos" onShelf={onShelf} onGoTo={vi.fn()} />
    )
    const view = render(at(() => false))
    expect(rowFor('stately plump buck').hasAttribute('disabled')).toBe(true)

    view.rerender(at((id) => id === 'other-book'))
    expect(rowFor('stately plump buck').hasAttribute('disabled'), 'the row kept the shelf it was first drawn with').toBe(false)
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

  /* A REQUEST THE CHOSEN FILTER ALREADY SHOWS LEAVES THE FILTER ALONE: clearing
     it is for a mark the filter would hide, not for every request. */
  it('keeps the chosen filter when it already shows the mark asked for', () => {
    const { republish } = drawFocused([NOTED], { id: 'm1', edit: false, nonce: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Notes' }))

    republish([NOTED], { id: 'm1', edit: false, nonce: 2 })

    expect(screen.getByRole('button', { name: 'Notes' }).getAttribute('aria-pressed')).toBe('true')
  })

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

  /* §11 — what happened AND what to do, over nothing and above a list alike. */
  it('says what to do about it, over an empty panel and above a list', () => {
    draw({ scanFailed: true })
    expect(
      screen.getByText('Nothing on disk has been changed. Close and reopen the panel to try again.'),
    ).not.toBeNull()
    cleanup()

    draw({ all: [ANNOTATION()], scanFailed: true })
    expect(
      screen.getByText(
        'Your marks could not be read. Nothing on disk has been changed. Close and reopen the panel to try again.',
      ),
    ).not.toBeNull()
  })

  /* A SCAN STILL RUNNING IS NOT AN EMPTY SHELF EITHER — over nothing, it is
     said instead of "Nothing kept yet", which would stand over a library that
     has not finished being read. */
  it('is said to be still reading, over an empty panel, instead of nothing kept', () => {
    render(<Marginalia marks={marksView({ scanning: true })} bookId="open-book" platform="macos" />)
    expect(screen.getByText('Reading your marks…')).not.toBeNull()
    expect(screen.queryByText(/Nothing kept yet/u)).toBeNull()
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

/* ⚠️ **THE ONE SENTENCE THAT TELLS A READER HOW TO START WAS MEASURED BY
   NOTHING**, and a `Stryker disable … : copy` sat over the key it names — so
   "Press  to keep the place you are reading" would have read as a working
   empty state. The chord is the whole point of the sentence, and it is not the
   same chord on every keyboard. */
describe('the empty state', () => {
  const said = (platform: 'macos' | 'windows') => {
    render(<Marginalia marks={marksView()} bookId="open-book" platform={platform} />)
    return screen.getByText(/^Select a passage/u).textContent
  }

  it('names the key that keeps a place, as this keyboard spells it', () => {
    expect(said('macos')).toBe(
      'Select a passage and choose Mark — notes you write on a mark appear beside the line they belong to. Press ⌘B to keep the place you are reading.',
    )
    cleanup()
    expect(said('windows')).toContain('Press Ctrl+B to keep the place')
  })
})

describe('a marks file that could not be read, over an empty list', () => {
  it('does not claim the shelf is empty', () => {
    draw({ unreadable: true })
    expect(screen.queryByText(/Nothing kept yet/)).toBeNull()
    expect(screen.getByText(/could not be read/)).not.toBeNull()
  })
})

/**
 * THE DICTIONARY CHIP (phase 17, WI-17.3) — the lookup on now and the lookups
 * already made, in the panel that holds everything else the reader left in a
 * book, without a lookup ever becoming a mark.
 */
describe('the Dictionary view', () => {
  const PLACE = (over: Partial<LookupOccurrence> = {}): LookupOccurrence => ({
    bookId: 'open-book',
    cfi: 'epubcfi(/6/4!/4/2,/1:66,/1:73)',
    chapter: 'Loomings',
    spelled: 'wharves',
    sentence: 'Belted round by wharves as Indian isles by coral reefs.',
    gloss: 'Structures along a shore where ships dock.',
    language: 'en',
    at: 1_000,
    ...over,
  })
  const LOOKUP = (over: Partial<Lookup> = {}): Lookup => ({
    term: 'wharves',
    occurrences: [PLACE()],
    firstAt: 1_000,
    lastAt: 1_000,
    ...over,
  })

  /** What the host may change from one render to the next. */
  type Moment = {
    readonly live?: GlossState | undefined
    readonly all?: readonly Lookup[] | undefined
    readonly withLookups?: boolean | undefined
    readonly bookId?: string | null | undefined
    readonly focus?: { id: string; edit: boolean; nonce: number } | undefined
  }

  function drawLookups(over: {
    all?: readonly Lookup[]
    marks?: readonly Annotation[]
    persistent?: boolean
    live?: GlossState
    onShelf?: (bookId: string) => boolean
    withLookups?: boolean
  } = {}) {
    const onGoTo = vi.fn()
    const remove = vi.fn()
    const make = vi.fn()
    let moment: Moment = { live: over.live, all: over.all, withLookups: over.withLookups }
    const props = ({ live, all, withLookups, bookId, focus }: Moment) => (
      <Marginalia
        marks={marksView({ all: over.marks ?? [] })}
        cards={{ make, persistent: true } as unknown as CardsView}
        bookId={bookId === undefined ? 'open-book' : bookId}
        platform="macos"
        now={2_000}
        titleOf={(id) => (id === 'other-book' ? 'Ulysses' : undefined)}
        {...(over.onShelf ? { onShelf: over.onShelf } : {})}
        onGoTo={onGoTo}
        {...(withLookups === false
          ? {}
          : { lookups: { all: all ?? [LOOKUP()], persistent: over.persistent ?? true, remove } })}
        {...(live ? { liveLookUp: live } : {})}
        {...(focus ? { focus } : {})}
      />
    )
    const view = render(props(moment))
    /* A rerender with what `change` names changed and everything else as it was. */
    const redraw = (change: Moment) => {
      moment = { ...moment, ...change }
      view.rerender(props(moment))
    }
    const openDictionary = () => fireEvent.click(screen.getByRole('button', { name: 'Dictionary' }))
    return { onGoTo, remove, make, openDictionary, redraw, relive: (live: GlossState) => redraw({ live }) }
  }

  /** The count row under the title, whole — every clause, in order. */
  const counts = () => screen.getByText(/^\d+ marks? · /u).textContent

  /** Which kind chips are drawn, by name, in the order they are drawn. */
  const kindChips = () => within(screen.getByRole('group', { name: 'Filter by kind' })).getAllByRole('button')
  const pressed = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-pressed')

  /* ABSENT HISTORY, ABSENT CHIP — the browser client mounts this panel with no
     Look up, and a chip would name a feature that host does not have. */
  it('offers the chip only where there is a history', () => {
    drawLookups({ withLookups: false, marks: [ANNOTATION()] })
    expect(screen.queryByRole('button', { name: 'Dictionary' })).toBeNull()
    cleanup()

    drawLookups({ marks: [ANNOTATION()] })
    expect(screen.getByRole('button', { name: 'Dictionary' })).not.toBeNull()
  })

  /* A reader with lookups and no marks must still reach the chip — the empty
     state has no room for it. */
  it('is reachable with lookups and no marks at all', () => {
    const { openDictionary } = drawLookups()

    expect(screen.queryByText(/Nothing kept yet/)).toBeNull()
    openDictionary()
    expect(screen.getByText('wharves')).not.toBeNull()
  })

  it('shows each word with its sense and the sentence it was met in, which jumps there', () => {
    const { onGoTo, openDictionary } = drawLookups()
    openDictionary()

    expect(screen.getByText('Structures along a shore where ships dock.')).not.toBeNull()
    rowFor('Belted round by wharves').click()
    expect(onGoTo).toHaveBeenCalledWith({ bookId: 'open-book', cfi: 'epubcfi(/6/4!/4/2,/1:66,/1:73)' })
  })

  /* Marginalia's reachability rule, for a place: another book names itself,
     and a book that has left the shelf cannot be jumped to. */
  it('names another book, and disables a place whose book has left the shelf', () => {
    const { openDictionary } = drawLookups({
      all: [LOOKUP({ occurrences: [PLACE({ bookId: 'other-book', sentence: 'Stately, plump wharves.' })] })],
      onShelf: () => false,
    })
    openDictionary()

    expect(screen.getByText(/Ulysses/)).not.toBeNull()
    expect(rowFor('Stately, plump wharves').hasAttribute('disabled')).toBe(true)
  })

  it('narrows to this book’s places under This book, and hides a word with none', () => {
    const { openDictionary } = drawLookups({
      all: [
        LOOKUP(),
        LOOKUP({ term: 'gam', occurrences: [PLACE({ bookId: 'other-book', spelled: 'gam', sentence: 'A gam.' })] }),
      ],
    })
    openDictionary()
    expect(screen.getByText('gam')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'This book' }))

    expect(screen.queryByText('gam')).toBeNull()
    expect(screen.getByText('wharves')).not.toBeNull()
  })

  it('removes a word by its term', () => {
    const { remove, openDictionary } = drawLookups()
    openDictionary()

    fireEvent.click(screen.getByRole('button', { name: 'Remove “wharves” from your lookups' }))

    expect(remove).toHaveBeenCalledWith('wharves')
  })

  /* WI-17.6 — the one gesture between history and something kept. */
  it('makes a Recall card of a place — the word in its sentence, the sense behind it', () => {
    const { make, openDictionary } = drawLookups()
    openDictionary()

    fireEvent.click(screen.getByRole('button', { name: 'Make a card of “wharves”' }))

    expect(make).toHaveBeenCalledWith(cardFromLookup(PLACE()))
    expect(make.mock.calls[0]?.[0]).toMatchObject({ kind: 'Recall', answer: 'Structures along a shore where ships dock.' })
  })

  it('counts words beside the marks, and states what it keeps', () => {
    const { openDictionary } = drawLookups({ marks: [ANNOTATION()] })

    expect(screen.getByText(/1 word$/)).not.toBeNull()
    openDictionary()
    expect(screen.getByText(/Paper keeps the last 500 words you looked up, and 3 places for each/)).not.toBeNull()
  })

  it('says a history that is not being saved', () => {
    const { openDictionary } = drawLookups({ persistent: false })
    openDictionary()

    expect(screen.getByText(/lookups are not being saved/)).not.toBeNull()
  })

  /* NO MARK IS A LOOKUP: the view shows lookups and nothing of the mark list. */
  it('never lists a mark under Dictionary', () => {
    const { openDictionary } = drawLookups({ marks: [ANNOTATION({ text: 'call me ishmael' })] })
    openDictionary()

    expect(screen.queryByText('call me ishmael')).toBeNull()
  })

  /* THE LIVE ENTRY keeps the lookup face's doctrine: amber for a definition,
     never for a failure. */
  it('shows the lookup on now at the top — amber for a definition, not for a failure', () => {
    const { openDictionary, relive } = drawLookups({ live: { kind: 'ready', term: 'gam', text: 'A meeting of whaling ships.' } })
    openDictionary()
    expect(screen.getByRole('status').getAttribute('data-kind')).toBe('companion')

    relive({ kind: 'failed', term: 'gam', reason: 'The runtime stopped' })

    const failed = screen.getByRole('status')
    expect(failed.getAttribute('data-kind')).not.toBe('companion')
    expect(failed.textContent).toMatch(/couldn.t define “gam”\. The runtime stopped/)
  })

  /* "When looking up, show what is currently being looked up" — a lookup that
     STARTS with the panel open turns it to the Dictionary view, once. */
  it('turns to the Dictionary view when a lookup starts', () => {
    const { relive } = drawLookups({ marks: [ANNOTATION({ text: 'call me ishmael' })], live: { kind: 'idle' } })
    expect(screen.getByText('call me ishmael')).not.toBeNull()

    relive({ kind: 'asking', term: 'gam' })

    expect(screen.queryByText('call me ishmael')).toBeNull()
    expect(screen.getByText('Looking…')).not.toBeNull()
  })

  /* THE CHIPS, BY NAME AND IN ORDER — Dictionary last, after every kind a mark
     can be — and each one turns on itself and nothing else. */
  it('offers the kinds in order with Dictionary last, and each chip turns on only itself', () => {
    const { redraw } = drawLookups({ marks: [ANNOTATION()] })

    expect(kindChips().map((chip) => chip.getAttribute('aria-label'))).toEqual([
      'All',
      'Marks',
      'Notes',
      'Bookmarks',
      'Companion',
      'Dictionary',
    ])
    for (const name of ['Marks', 'Notes', 'Bookmarks', 'Companion', 'Dictionary', 'All']) {
      fireEvent.click(screen.getByRole('button', { name }))
      const on = kindChips().filter((chip) => chip.getAttribute('aria-pressed') === 'true')
      expect(on.map((chip) => chip.getAttribute('aria-label'))).toEqual([name])
    }

    redraw({ withLookups: false })
    expect(kindChips().map((chip) => chip.getAttribute('aria-label'))).toEqual([
      'All',
      'Marks',
      'Notes',
      'Bookmarks',
      'Companion',
    ])
  })

  /* A HOST THAT WITHDRAWS ITS HISTORY under the Dictionary chip takes the chip
     with it, and the panel falls back to All rather than go on drawing a choice
     the reader can neither see nor undo — which used to leave "No dictionary
     yet." over a list of marks nobody could reach. */
  it('falls back to All when the history is withdrawn under the Dictionary chip', () => {
    const { openDictionary, redraw } = drawLookups({ marks: [ANNOTATION({ text: 'call me ishmael' })] })
    openDictionary()
    expect(screen.getByText('wharves')).not.toBeNull()

    redraw({ withLookups: false })

    expect(counts()).toBe('1 mark · 0 notes · 0 bookmarks')
    expect(screen.queryByText('wharves')).toBeNull()
    expect(screen.getByText('call me ishmael')).not.toBeNull()
    expect(screen.queryByText(/No dictionary/)).toBeNull()
    expect(
      kindChips()
        .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
        .map((chip) => chip.getAttribute('aria-label')),
    ).toEqual(['All'])
  })

  /* A MARK ASKED FOR FROM THE PAGE TURNS THE PANEL BACK TO THE LIST: no mark is
     under Dictionary, so staying there would scroll to a row that is not drawn. */
  it('turns back to the mark list when a mark is asked for while Dictionary is on', () => {
    const { openDictionary, redraw } = drawLookups({ marks: [ANNOTATION({ text: 'call me ishmael' })] })
    openDictionary()
    expect(screen.queryByText('call me ishmael')).toBeNull()

    redraw({ focus: { id: 'm1', edit: false, nonce: 1 } })

    expect(screen.getByText('call me ishmael')).not.toBeNull()
    expect(pressed('All')).toBe('true')
  })

  /* A LOOKUP ALREADY ON WHEN THE PANEL OPENS HAS NOT STARTED — opening the pane
     is never a lookup's doing, and neither is choosing its view. */
  it('stays on its list when the panel opens onto a lookup already on', () => {
    drawLookups({ marks: [ANNOTATION({ text: 'call me ishmael' })], live: { kind: 'asking', term: 'gam' } })

    expect(screen.getByText('call me ishmael')).not.toBeNull()
    expect(pressed('All')).toBe('true')
    expect(pressed('Dictionary')).toBe('false')
  })

  it('turns once per lookup — not again while it stays on, and again for the next one', () => {
    const { relive } = drawLookups({ marks: [ANNOTATION({ text: 'call me ishmael' })], live: { kind: 'idle' } })
    relive({ kind: 'asking', term: 'gam' })
    expect(pressed('Dictionary')).toBe('true')

    /* The reader leaves; the lookup answers and stays on screen. */
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    relive({ kind: 'ready', term: 'gam', text: 'A meeting of whaling ships.' })
    expect(screen.getByText('call me ishmael')).not.toBeNull()
    expect(pressed('All')).toBe('true')

    relive({ kind: 'idle' })
    relive({ kind: 'asking', term: 'isles' })
    expect(pressed('Dictionary')).toBe('true')
    expect(screen.queryByText('call me ishmael')).toBeNull()
  })

  /* NO HISTORY, NOWHERE TO TURN: a host with no Dictionary chip keeps its list. */
  it('does not turn for a lookup where the host has no history', () => {
    const { relive } = drawLookups({
      withLookups: false,
      marks: [ANNOTATION({ text: 'call me ishmael' })],
      live: { kind: 'idle' },
    })

    relive({ kind: 'asking', term: 'gam' })

    expect(screen.getByText('call me ishmael')).not.toBeNull()
    expect(pressed('All')).toBe('true')
  })

  /* AND A HISTORY THAT ARRIVES LATER DOES NOT BRING A TURN WITH IT: the lookup
     started where there was nothing to turn to, so nothing was chosen — the
     panel shows All while the chip it could have turned to appears. */
  it('does not turn later for a lookup that started before there was a history', () => {
    const { relive, redraw } = drawLookups({
      withLookups: false,
      marks: [ANNOTATION({ text: 'call me ishmael' })],
      live: { kind: 'idle' },
    })
    relive({ kind: 'asking', term: 'gam' })

    redraw({ withLookups: true })

    expect(pressed('All')).toBe('true')
    expect(screen.getByText('call me ishmael')).not.toBeNull()
  })

  /* NOTHING KEPT IS NOT NOTHING HAPPENING: a lookup that starts over an empty
     shelf and an empty history is shown, not covered by the empty state. */
  it('gives up the empty state to a lookup that starts over nothing kept', () => {
    const { relive } = drawLookups({ all: [], live: { kind: 'idle' } })
    expect(screen.getByText('Nothing kept yet')).not.toBeNull()

    relive({ kind: 'asking', term: 'gam' })

    expect(screen.queryByText('Nothing kept yet')).toBeNull()
    expect(screen.getByText('Looking…')).not.toBeNull()
  })

  /* FOUR WORDS, THREE MET IN THE OPEN BOOK: `gam` only elsewhere, and `isles`
     in both — so "a place here", "every place here" and "a place elsewhere"
     each give a different number. */
  const SPREAD = [
    LOOKUP(),
    LOOKUP({ term: 'gam', occurrences: [PLACE({ bookId: 'other-book', spelled: 'gam', sentence: 'A gam.' })] }),
    LOOKUP({
      term: 'isles',
      occurrences: [
        PLACE({ spelled: 'isles', sentence: 'Indian isles.' }),
        PLACE({ bookId: 'other-book', spelled: 'isles', sentence: 'Other isles.' }),
      ],
    }),
    LOOKUP({ term: 'coral', occurrences: [PLACE({ spelled: 'coral', sentence: 'Coral reefs.' })] }),
  ]

  it('counts every word under All books, and under This book only the words met in it', () => {
    drawLookups({ all: SPREAD })
    expect(counts()).toBe('0 marks · 0 notes · 0 bookmarks · 4 words')

    fireEvent.click(screen.getByRole('button', { name: 'This book' }))

    expect(counts()).toBe('0 marks · 0 notes · 0 bookmarks · 3 words')
  })

  it('recounts for another book, for no book, and for a changed history — and one word is "1 word"', () => {
    const { redraw } = drawLookups({ all: SPREAD })
    fireEvent.click(screen.getByRole('button', { name: 'This book' }))

    redraw({ bookId: 'other-book' })
    expect(counts()).toBe('0 marks · 0 notes · 0 bookmarks · 2 words')

    /* "This book" names nothing with no book open, so every word is counted. */
    redraw({ bookId: null })
    expect(counts()).toBe('0 marks · 0 notes · 0 bookmarks · 4 words')

    redraw({ bookId: 'open-book', all: [LOOKUP()] })
    expect(counts()).toBe('0 marks · 0 notes · 0 bookmarks · 1 word')
  })

  it('says nothing of words for a host with no history', () => {
    drawLookups({ withLookups: false, marks: [ANNOTATION()] })

    expect(counts()).toBe('1 mark · 0 notes · 0 bookmarks')
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

  /* ALL IS SAID AS "marginalia", and the narrowed scope is said with it. */
  it('names All as marginalia, and says the book when the scope is narrowed', () => {
    draw({ all: [ANNOTATION({ id: 'm1', bookId: 'another-book' })] })

    fireEvent.click(screen.getByRole('button', { name: 'This book' }))

    expect(screen.getByText('No marginalia in this book yet.')).not.toBeNull()
  })

  /* AND NAMES NO BOOK WHEN NONE WAS CHOSEN — under All books the sentence is
     about the kind alone, whole. */
  it('says the kind alone, in one whole sentence, under All books', () => {
    draw({ all: [ANNOTATION({ id: 'm1', note: '' })] })
    fireEvent.click(screen.getByRole('button', { name: 'Notes' }))
    expect(screen.getByText(/^No notes/u).textContent).toBe('No notes yet.')
  })
})

describe('the note button', () => {
  it('shows the note trimmed, and offers to add one over a blank note', () => {
    draw({ all: [ANNOTATION({ id: 'm1', note: '  spaced  ' }), ANNOTATION({ id: 'm2', text: 'blank', note: '   ' })] })
    expect(screen.getByRole('button', { name: 'spaced' }).textContent).toBe('spaced')
    expect(screen.getByRole('button', { name: 'Add a note' })).not.toBeNull()
  })
})

/** What the window going to the background does — a save that leaves the editor open. */
const saveNow = () => document.dispatchEvent(new Event('visibilitychange'))

/**
 * ⚠️ **THE EDITOR NEVER LOOKED AT ITS NOTE AGAIN.** It read `initial` once, as
 * the textarea's default, so a newer note arriving while it was open — from
 * sync, or from another window — left the old text on screen, and the next
 * keystroke saved that old text over the newer note (2026-09-13 audit, #127).
 */
describe('a note editor whose note changes while it is open', () => {
  function open(note: string) {
    const setNote = vi.fn()
    const at = (current: string) => (
      <Marginalia
        marks={marksView({ all: [ANNOTATION({ id: 'm1', note: current })], setNote })}
        bookId="open-book"
        platform="macos"
        focus={{ id: 'm1', edit: true, nonce: 1 }}
        onGoTo={vi.fn()}
      />
    )
    const view = render(at(note))
    return {
      field: screen.getByPlaceholderText('Write a note') as HTMLTextAreaElement,
      arrives: (current: string) => view.rerender(at(current)),
      written: () => setNote.mock.calls.map(([, value]) => value as string),
    }
  }

  it('shows a newer note that arrives while it is untouched, and the reader writes on that', () => {
    const { field, arrives, written } = open('the old note')
    arrives('the newer note')
    expect(field.value, 'the editor went on showing the note it opened with').toBe('the newer note')

    fireEvent.change(field, { target: { value: 'the newer note, and mine' } })
    fireEvent.blur(field)
    expect(written()).toEqual(['the newer note, and mine'])
  })

  it('keeps what the reader is typing when a newer note arrives, and saves what it shows', () => {
    const { field, arrives, written } = open('the old note')
    fireEvent.change(field, { target: { value: 'the old note, half' } })
    arrives('the newer note')
    expect(field.value, 'a keystroke was thrown away for a note the reader never saw').toBe('the old note, half')

    /* Typed back to the note it opened with. The store holds the newer one, so
       what is on screen is still a change — and closing without saving it
       would show the reader a note they did not leave there. */
    fireEvent.change(field, { target: { value: 'the old note' } })
    fireEvent.blur(field)
    expect(written()).toEqual(['the old note'])
  })

  /* ⚠️ **AND IT SAID NOTHING** (decided 2026-09-14, #127). The reader's words
     stayed and were saved over the newer note, silently — so a note written on
     another device was replaced without its reader ever learning it existed.
     Keeping the draft stays the default; the newer version is one press away. */
  it('says a newer version arrived while the reader was typing, and offers it', () => {
    const { field, arrives, written } = open('the old note')
    fireEvent.change(field, { target: { value: 'the old note, half' } })
    arrives('the newer note')

    expect(screen.getByText(/A newer version of this note arrived while you were typing/u)).toBeTruthy()
    const offer = screen.getByRole('button', { name: 'Use that version' })
    fireEvent.mouseDown(offer)
    fireEvent.click(offer)

    expect(field.value, 'the newer version was offered and not taken').toBe('the newer note')
    expect(screen.queryByRole('button', { name: 'Use that version' }), 'the offer stayed after it was taken').toBeNull()
    fireEvent.blur(field)
    expect(written(), 'taking the version the store already holds wrote it again').toEqual([])
  })

  it('offers nothing when a newer note arrives over an untouched editor', () => {
    const { arrives } = open('the old note')
    arrives('the newer note')
    expect(screen.queryByRole('button', { name: 'Use that version' })).toBeNull()
  })

  it('takes its own saves coming back as its own, however late, and keeps what is typed', () => {
    const { field, arrives, written } = open('')
    fireEvent.change(field, { target: { value: 'a' } })
    saveNow()
    fireEvent.change(field, { target: { value: 'ab' } })
    saveNow()
    /* The first save, published after the second was made. */
    arrives('a')
    expect(field.value).toBe('ab')
    arrives('ab')
    expect(field.value).toBe('ab')
    expect(written()).toEqual(['a', 'ab'])
  })
})

/**
 * ⚠️ **A NOTE THAT DID NOT LAND WAS TREATED AS SAVED** (2026-09-13 audit, #131).
 * `stored` moved forward the moment the text was handed over, so a write that
 * failed left the editor believing the draft was on disk: the next timer, blur
 * and unmount all found it "unchanged" and wrote nothing, and closing the
 * editor took the last chance to try again with it.
 */
describe('a note whose write does not land', () => {
  function editing(setNote: MarksView['setNote']) {
    render(
      <Marginalia
        marks={marksView({ all: [ANNOTATION({ id: 'm1', note: '' })], setNote })}
        bookId="open-book"
        platform="macos"
        focus={{ id: 'm1', edit: true, nonce: 1 }}
        onGoTo={vi.fn()}
      />,
    )
    return screen.getByPlaceholderText('Write a note') as HTMLTextAreaElement
  }

  it('offers the draft again after a refused write, instead of dropping it', async () => {
    const setNote = vi.fn<(mark: unknown, note: string) => Promise<void>>(() => Promise.reject(new Error('EIO')))
    const field = editing(setNote as unknown as MarksView['setNote'])

    fireEvent.change(field, { target: { value: 'worth keeping' } })
    saveNow()
    /* Let the refusal come back before asking again — which is what a timer
       tick, a blur or an unmount does a moment later. */
    await act(async () => {})
    saveNow()

    expect(setNote.mock.calls.map(([, value]) => value)).toEqual([
      'worth keeping',
      'worth keeping',
    ])
  })

  it('does not write it again once it has landed', async () => {
    const setNote = vi.fn<(mark: unknown, note: string) => Promise<void>>(() => Promise.resolve())
    const field = editing(setNote as unknown as MarksView['setNote'])

    fireEvent.change(field, { target: { value: 'saved once' } })
    saveNow()
    await act(async () => {})
    saveNow()

    expect(setNote.mock.calls.map(([, value]) => value)).toEqual(['saved once'])
  })

  /* AND NOT WHILE THE FIRST IS STILL IN FLIGHT. Without that guard the
     one-second timer would hand the same text over again every tick until the
     write came back — a burst of whole-file writes for one note. */
  it('waits for the write it made rather than repeating it every tick', () => {
    const setNote = vi.fn<(mark: unknown, note: string) => Promise<void>>(() => new Promise<void>(() => {}))
    const field = editing(setNote as unknown as MarksView['setNote'])

    fireEvent.change(field, { target: { value: 'in flight' } })
    saveNow()
    saveNow()
    saveNow()

    expect(setNote).toHaveBeenCalledTimes(1)
  })

  /* ⚠️ **AND A REFUSAL THAT ARRIVES AFTER THE BLUR HAD NOTHING TO RETRY WITH**
     (2026-09-14, #131). The retry lives in the editor, and a blur unmounted the
     editor at once — so a write that failed a moment after the reader clicked
     away took the only copy of the text with it. */
  it('keeps the draft on screen when the write refused after the blur, and closes once a retry lands', async () => {
    const answers: { resolve(): void; reject(cause: Error): void }[] = []
    const setNote = vi.fn<(mark: unknown, note: string) => Promise<void>>(
      () => new Promise<void>((resolve, reject) => answers.push({ resolve, reject })),
    )
    const field = editing(setNote as unknown as MarksView['setNote'])

    fireEvent.change(field, { target: { value: 'worth keeping' } })
    fireEvent.blur(field)
    await act(async () => answers[0]!.reject(new Error('EIO')))

    const still = screen.queryByPlaceholderText('Write a note') as HTMLTextAreaElement | null
    expect(still, 'the reader’s text went with the editor').not.toBeNull()
    expect(still!.value).toBe('worth keeping')

    saveNow()
    expect(setNote.mock.calls.map(([, value]) => value)).toEqual(['worth keeping', 'worth keeping'])
    await act(async () => answers[1]!.resolve())
    expect(screen.queryByPlaceholderText('Write a note'), 'the editor stayed open over a note that landed').toBeNull()
  })

  /* WAITING TO CLOSE IS NOT CLOSING: a reader back in the field keeps it, and
     an editor already gone closes nothing — `onDone` would close whichever
     editor the panel opened since. */
  it('stays open for a reader who came back to it, and a late landing closes no other editor', async () => {
    const answers: (() => void)[] = []
    const setNote = vi.fn<(mark: unknown, note: string) => Promise<void>>(() => new Promise<void>((resolve) => answers.push(resolve)))
    render(
      <Marginalia
        marks={marksView({
          all: [ANNOTATION({ id: 'm1', note: '' }), ANNOTATION({ id: 'm2', text: 'a second passage', note: '' })],
          setNote: setNote as unknown as MarksView['setNote'],
        })}
        bookId="open-book"
        platform="macos"
        focus={{ id: 'm1', edit: true, nonce: 1 }}
        onGoTo={vi.fn()}
      />,
    )
    const field = () => screen.getByPlaceholderText('Write a note') as HTMLTextAreaElement

    fireEvent.change(field(), { target: { value: 'first' } })
    fireEvent.blur(field())
    fireEvent.focus(field())
    await act(async () => answers[0]!())
    expect(field().value, 'the editor closed under a reader who had come back to it').toBe('first')

    fireEvent.change(field(), { target: { value: 'first, again' } })
    fireEvent.blur(field())
    fireEvent.click(screen.getByRole('button', { name: 'Add a note' }))
    expect(field().value).toBe('')
    await act(async () => answers[1]!())
    expect(screen.queryByPlaceholderText('Write a note'), 'a write landing late closed the next editor').not.toBeNull()
  })
})

/**
 * ⚠️ **CLOSING THE PANE TOOK A DRAFT WHOSE WRITE THEN FAILED** (2026-09-14,
 * #131, round 4). A blur keeps the editor until its write lands, but closing
 * the pane unmounts it whatever is in flight — and its unmount save skips the
 * text already being written — so a refusal arriving after that had no editor
 * to retry in. Driven through the real `useMarks`, which outlives the pane.
 */
describe('a note whose write is refused after the pane has closed', () => {
  /** A store that answers each note write when told, and — as the real one does
   *  for the open book — shows the note before its write has landed. */
  function slowStore() {
    const listeners = new Set<() => void>()
    let snapshot: MarkSnapshot = {
      all: [ANNOTATION({ id: 'm1', note: '' })],
      current: [],
      unplaced: [],
      bookmarks: [],
      allBookmarks: [],
      allUnplaced: [],
      bookId: 'open-book',
      ready: true,
      persistent: true,
      unreadable: false,
      scanFailed: false,
    }
    const writes: { readonly note: string; resolve(): void; reject(cause: Error): void }[] = []
    const store = {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
      open: async () => {},
      loadAll: async () => {},
      updateNote: (id: string, note: string) => {
        snapshot = { ...snapshot, all: snapshot.all.map((mark) => (mark.id === id ? { ...mark, note } : mark)) }
        for (const listener of listeners) listener()
        return new Promise<void>((resolve, reject) => writes.push({ note, resolve, reject }))
      },
    } as unknown as MarkStore
    return { store, writes }
  }

  function Host({ store, open, focus }: { store: MarkStore; open: boolean; focus?: { id: string; edit: boolean; nonce: number } }) {
    const marks = useMarks(store, 'open-book')
    return open ? <Marginalia marks={marks} bookId="open-book" platform="macos" {...(focus ? { focus } : {})} onGoTo={() => {}} /> : null
  }

  /* ⚠️ **A DRAFT TYPED BACK TO THE SAVED NOTE WHILE ANOTHER WRITE IS OUT IS STILL
     THE READER'S** (2026-09-14 verify). The editor skipped a draft equal to the
     last CONFIRMED note, so: A saved → B handed over → the reader types A again →
     the pane closes → B lands, and the disk kept B. What the store will hold is
     the newest write asked for, not the last one confirmed. */
  /* ⚠️ **AND ONE REFUSED AFTER THE EDITOR WAS OPENED AGAIN** (2026-09-14
     verify). Reopened while its write was still out, the editor took the note
     the store drew — before that write had landed — for what the store held,
     and the refusal that followed never reset it: every save found the draft
     "unchanged", and a blur closed the editor over a note that was not saved. */
  it('writes a draft again when its write is refused after the editor was reopened', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { store, writes } = slowStore()
    const view = render(<Host store={store} open focus={{ id: 'm1', edit: true, nonce: 1 }} />)
    fireEvent.change(screen.getByPlaceholderText('Write a note'), { target: { value: 'worth keeping' } })
    act(() => void saveNow())

    view.rerender(<Host store={store} open={false} />)
    view.rerender(<Host store={store} open focus={{ id: 'm1', edit: true, nonce: 2 }} />)
    await act(async () => writes[0]!.reject(new Error('EIO')))
    act(() => void saveNow())

    expect(writes.map((write) => write.note), 'the refused draft was never written again').toEqual([
      'worth keeping',
      'worth keeping',
    ])
    quiet.mockRestore()
  })

  it('writes a draft typed back to the saved note while a newer write is still out', async () => {
    const { store, writes } = slowStore()
    const view = render(<Host store={store} open focus={{ id: 'm1', edit: true, nonce: 1 }} />)
    const field = () => screen.getByPlaceholderText('Write a note')

    fireEvent.change(field(), { target: { value: 'first' } })
    act(() => void saveNow())
    await act(async () => writes[0]!.resolve())
    fireEvent.change(field(), { target: { value: 'second' } })
    act(() => void saveNow())
    fireEvent.change(field(), { target: { value: 'first' } })
    act(() => void saveNow())

    view.rerender(<Host store={store} open={false} />)
    await act(async () => writes[1]!.resolve())

    expect(
      writes.map((write) => write.note),
      'the reader typed the saved note back while a newer write was out, and it was never handed over',
    ).toEqual(['first', 'second', 'first'])
  })

  it('offers the refused draft on its row when the pane opens again, and writes it once more', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { store, writes } = slowStore()
    const view = render(<Host store={store} open focus={{ id: 'm1', edit: true, nonce: 1 }} />)
    fireEvent.change(screen.getByPlaceholderText('Write a note'), { target: { value: 'worth keeping' } })
    act(() => void saveNow())
    expect(writes.map((write) => write.note)).toEqual(['worth keeping'])

    /* The pane closes with that write still out, and THEN it is refused. */
    view.rerender(<Host store={store} open={false} />)
    await act(async () => writes[0]!.reject(new Error('EIO')))
    view.rerender(<Host store={store} open />)

    const offered = screen.queryByRole('button', { name: /^Not saved/u })
    expect(offered, 'the refused draft was not offered again').not.toBeNull()
    expect(offered!.textContent).toContain('worth keeping')
    fireEvent.click(offered!)
    const field = screen.getByPlaceholderText('Write a note') as HTMLTextAreaElement
    expect(field.value).toBe('worth keeping')

    /* THE ROW ALREADY SHOWS THIS TEXT — the store drew it before the write — so
       an editor that took the row's note for what is stored has nothing to write. */
    act(() => void saveNow())
    expect(writes.map((write) => write.note), 'the refused draft was never written again').toEqual([
      'worth keeping',
      'worth keeping',
    ])
    await act(async () => writes[1]!.resolve())
    fireEvent.blur(field)
    expect(screen.queryByPlaceholderText('Write a note')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Not saved/u }), 'a note that landed is still said to be unsaved').toBeNull()
    quiet.mockRestore()
  })

  /* A refused write that CLEARED the note has no text to show, and the row's
     own note is the one the reader removed — so it is said, not left blank. */
  it('says a refused draft that cleared the note, instead of the note it cleared', () => {
    render(
      <Marginalia
        marks={marksView({ all: [ANNOTATION({ id: 'm1', note: 'the note it had' })], unsaved: new Map([['m1', '  ']]) })}
        bookId="open-book"
        platform="macos"
        onGoTo={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Not saved — the note was cleared' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'the note it had' })).toBeNull()
  })

  /* TRIMMED, as the note it would have been — the editor writes a draft
     trimmed, so the spaces around it were never going to be kept. */
  it('says a refused draft as the note it would have been, without the spaces around it', () => {
    render(
      <Marginalia
        marks={marksView({ all: [ANNOTATION({ id: 'm1', note: 'the note it had' })], unsaved: new Map([['m1', '  a refused draft  ']]) })}
        bookId="open-book"
        platform="macos"
        onGoTo={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /^Not saved/u }).textContent).toBe('Not saved — a refused draft')
  })
})

/**
 * ⚠️ **A CARD MADE STRAIGHT AFTER A NOTE CARRIED THE NOTE BEFORE IT.** The
 * pointer going down on "Make a card" blurs the editor, which saves — but a
 * mark in another book is republished only once its file is written, so the
 * click that follows built the card from the row's old note (#128).
 */
describe('a card made straight after writing a note', () => {
  function writing(note: string) {
    const make = vi.fn()
    const at = (current: string) => (
      <Marginalia
        marks={marksView({ all: [ANNOTATION({ id: 'm1', bookId: 'other-book', note: current })] })}
        cards={{ make, persistent: true } as unknown as CardsView}
        bookId="open-book"
        platform="macos"
        focus={{ id: 'm1', edit: true, nonce: 1 }}
      />
    )
    const view = render(at(note))
    return {
      field: () => screen.getByPlaceholderText('Write a note'),
      arrives: (current: string) => view.rerender(at(current)),
      card: () => {
        make.mockClear()
        fireEvent.click(screen.getByRole('button', { name: 'Make a card' }))
        return make.mock.calls[0]?.[0] as unknown
      },
    }
  }

  it('carries the note just written, before the list has caught up with it', () => {
    const { field, card } = writing('the old note')
    fireEvent.change(field(), { target: { value: 'the new note' } })
    fireEvent.blur(field())
    expect(card()).toMatchObject({ kind: 'Idea', body: 'the new note' })
  })

  it('follows the list once it has caught up, or has moved on to a note written elsewhere', () => {
    const { field, arrives, card } = writing('')
    fireEvent.change(field(), { target: { value: 'a' } })
    saveNow()
    fireEvent.change(field(), { target: { value: 'ab' } })
    fireEvent.blur(field())
    /* The first save, published after the second was made. */
    arrives('a')
    expect(card()).toMatchObject({ body: 'ab' })
    arrives('ab')
    expect(card()).toMatchObject({ body: 'ab' })
    arrives('written elsewhere')
    expect(card()).toMatchObject({ body: 'written elsewhere' })
  })

  /* THE ROW'S NOTE IS COMPARED AS IT READS — a note stored with spaces around
     it is the same note, before the write and while the list republishes it. */
  it('carries the note just written over one stored with spaces, while the list republishes it unchanged', () => {
    const { field, arrives, card } = writing('  the old note  ')
    fireEvent.change(field(), { target: { value: 'the new note' } })
    fireEvent.blur(field())
    expect(card()).toMatchObject({ body: 'the new note' })

    arrives('  the old note  ')
    expect(card(), 'a republish of the old note took the card back to it').toMatchObject({ body: 'the new note' })
  })

  /* ONCE CAUGHT UP, THE ENTRY GOES — so a note put back elsewhere afterwards is
     the answer, not taken for the list lagging behind this panel's write. */
  it('follows a note restored elsewhere after the list had caught up with the one written here', () => {
    const { field, arrives, card } = writing('the old note')
    fireEvent.change(field(), { target: { value: 'the new note' } })
    fireEvent.blur(field())
    arrives('the new note')
    arrives('the old note')
    expect(card(), 'a note written here outlived the list catching up with it').toMatchObject({ body: 'the old note' })
  })

  /* BY THE ROW'S OWN ID — another row leading the list says nothing about
     whether this one has caught up. */
  it('keeps the note written on one row while another row leads the list', () => {
    const make = vi.fn()
    const at = () => (
      <Marginalia
        marks={marksView({
          all: [
            ANNOTATION({ id: 'm0', bookId: 'other-book', text: 'a first passage', note: 'something else' }),
            ANNOTATION({ id: 'm1', bookId: 'other-book', note: 'the old note', createdAt: 2 }),
          ],
        })}
        cards={{ make, persistent: true } as unknown as CardsView}
        bookId="open-book"
        platform="macos"
        now={1}
        focus={{ id: 'm1', edit: true, nonce: 1 }}
      />
    )
    const view = render(at())
    fireEvent.change(screen.getByPlaceholderText('Write a note'), { target: { value: 'the new note' } })
    fireEvent.blur(screen.getByPlaceholderText('Write a note'))
    view.rerender(at())

    const row = rowsDrawn().find((one) => one.textContent?.includes('call me ishmael'))!
    fireEvent.click(within(row).getByRole('button', { name: 'Make a card' }))
    expect(make.mock.calls[0]?.[0]).toMatchObject({ body: 'the new note' })
  })

  /* A ROW THAT LEAVES THE LIST TAKES ITS ENTRY WITH IT, and does not take the
     panel down on the way: there is no row left to read a note from. */
  it('lets go of the note written on a row that has left the list', () => {
    const make = vi.fn()
    const other = ANNOTATION({ id: 'm2', bookId: 'other-book', text: 'a second passage' })
    const at = (rows: readonly Annotation[]) => (
      <Marginalia
        marks={marksView({ all: rows })}
        cards={{ make, persistent: true } as unknown as CardsView}
        bookId="open-book"
        platform="macos"
        now={1}
        focus={{ id: 'm1', edit: true, nonce: 1 }}
      />
    )
    const noted = () => ANNOTATION({ id: 'm1', bookId: 'other-book', note: 'the old note' })
    const view = render(at([noted(), other]))
    fireEvent.change(screen.getByPlaceholderText('Write a note'), { target: { value: 'the new note' } })
    fireEvent.blur(screen.getByPlaceholderText('Write a note'))

    view.rerender(at([other]))
    view.rerender(at([noted(), other]))

    const row = rowsDrawn().find((one) => one.textContent?.includes('call me ishmael'))!
    fireEvent.click(within(row).getByRole('button', { name: 'Make a card' }))
    expect(make.mock.calls[0]?.[0]).toMatchObject({ body: 'the old note' })
  })
})

/**
 * ⚠️ **THE SCAN WAS SAID ONLY OVER AN EMPTY PANEL.** "Reading your marks…" and
 * "Your marks could not be read" lived inside the nothing-at-all branch, so a
 * reader with a lookup history was told "No marginalia yet." over a scan that
 * had failed, and one with marks already listed was shown a running scan's
 * partial list as though it were final (#129, #130).
 */
describe('the cross-book scan, beside what is already listed', () => {
  const WORD: Lookup = {
    term: 'wharves',
    occurrences: [
      {
        bookId: 'open-book',
        cfi: 'epubcfi(/6/4!/4/2,/1:66,/1:73)',
        chapter: 'Loomings',
        spelled: 'wharves',
        sentence: 'Belted round by wharves.',
        gloss: 'Structures along a shore where ships dock.',
        language: 'en',
        at: 1_000,
      },
    ],
    firstAt: 1_000,
    lastAt: 1_000,
  }
  const panel = (over: Partial<MarksView>, lookups?: readonly Lookup[]) =>
    render(
      <Marginalia
        marks={marksView(over)}
        bookId="open-book"
        platform="macos"
        {...(lookups ? { lookups: { all: lookups, persistent: true } } : {})}
      />,
    )

  it('says a failed scan over a lookup history, and not that there is nothing', () => {
    panel({ scanFailed: true }, [WORD])
    expect(screen.getByText(/Your marks could not be read/u)).not.toBeNull()
    expect(screen.queryByText(/^No marginalia/u)).toBeNull()
  })

  it('says it is still reading beside the marks it has, and calls no filter empty until it is done', () => {
    panel({ all: [ANNOTATION()], scanning: true })
    expect(screen.getByText('Reading your marks…')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Notes' }))
    expect(screen.queryByText(/^No notes/u)).toBeNull()
  })

  it('says neither once the scan has landed', () => {
    panel({ all: [ANNOTATION()] })
    expect(screen.queryByText('Reading your marks…')).toBeNull()
    expect(screen.queryByText(/could not be read/u)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Notes' }))
    expect(screen.getByText(/^No notes/u)).not.toBeNull()
  })
})

/**
 * ⚠️ **A CARD THAT WAS NOT SAVED WAS NOT SAID, HERE.** The panel took `make`
 * alone, so the one surface that makes cards — from marks and from lookups —
 * could not see `persistent`, and the Cards panel, which can, is not offered to
 * a reader at all (#122, #132).
 */
describe('cards that are not being saved', () => {
  const notice = /Cards you make are not being saved/u
  const panel = (cards?: { persistent: boolean }) =>
    render(
      <Marginalia
        marks={marksView({ all: [ANNOTATION()] })}
        {...(cards ? { cards: { make: vi.fn(), ...cards } as unknown as CardsView } : {})}
        bookId="open-book"
        platform="macos"
        lookups={{ all: [], persistent: true }}
      />,
    )

  it('is said where cards are made, over the marks and over the Dictionary', () => {
    panel({ persistent: false })
    expect(screen.getByText(notice)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Dictionary' }))
    expect(screen.getByText(notice)).not.toBeNull()
  })

  it('is not said while cards save, nor by a host that makes none', () => {
    panel({ persistent: true })
    expect(screen.queryByText(notice)).toBeNull()
    cleanup()

    panel()
    expect(screen.queryByText(notice)).toBeNull()
  })
})

/**
 * WHAT EACH CHIP HOLDS, row by row.
 *
 * The chips were tested for which one is ON and never for what the list under
 * them then shows, so a chip that listed every mark — or none — pressed exactly
 * as a working one does.
 */
describe('a kind chip', () => {
  it('shows exactly the rows of its kind, and All shows every one', () => {
    draw({
      all: [
        ANNOTATION({ id: 'h-noted', text: 'a noted passage', note: 'a thought', createdAt: 1 }),
        ANNOTATION({ id: 'h-bare', text: 'a bare passage', createdAt: 2 }),
        ANNOTATION({ id: 'c1', kind: 'companion', text: 'a model claims this', createdAt: 3 }),
      ],
      allBookmarks: [BOOKMARK({ id: 'b1', chapter: 'Etymology', createdAt: 4 })],
    })
    const under = (chip: string) => {
      fireEvent.click(screen.getByRole('button', { name: chip }))
      return listed()
    }

    expect(under('Marks')).toEqual(['a noted passage', 'a bare passage'])
    expect(under('Notes')).toEqual(['a noted passage'])
    expect(under('Bookmarks')).toEqual(['Etymology'])
    expect(under('Companion')).toEqual(['a model claims this'])
    expect(under('All')).toEqual(['a noted passage', 'a bare passage', 'a model claims this', 'Etymology'])
  })
})

describe('the count under the title', () => {
  const counts = () => screen.getByText(/^\d+ marks? · /u).textContent

  it('counts one of each in the singular — a bookmark is not a mark', () => {
    draw({ all: [ANNOTATION({ note: 'a thought' })], allBookmarks: [BOOKMARK()] })
    expect(counts()).toBe('1 mark · 1 note · 1 bookmark')
  })

  it('counts more than one in the plural', () => {
    draw({
      all: [ANNOTATION({ note: 'a thought' }), ANNOTATION({ id: 'm2', text: 'the whale', note: 'another' })],
      allBookmarks: [BOOKMARK(), BOOKMARK({ id: 'b2', chapter: 'Etymology' })],
    })
    expect(counts()).toBe('2 marks · 2 notes · 2 bookmarks')
  })
})

describe('the list', () => {
  /* THE OPEN BOOK LEADS, the rest keep the order they were met in, and each
     book reads in its own order — the store's order is none of those. */
  it('leads with the open book, keeps the other books in the order met, and orders each book by place', () => {
    draw({
      all: [
        ANNOTATION({ id: 'x1', bookId: 'book-x', text: 'from book x' }),
        ANNOTATION({ id: 'o-late', text: 'late in the open book', sectionIndex: 3 }),
        ANNOTATION({ id: 'y1', bookId: 'book-y', text: 'from book y' }),
        ANNOTATION({ id: 'o-early', text: 'early in the open book', sectionIndex: 1 }),
      ],
    })
    expect(listed()).toEqual(['early in the open book', 'late in the open book', 'from book x', 'from book y'])
  })

  it('says what stands above the rows: a store that stopped saving, and only such a store', () => {
    draw({ all: [ANNOTATION()], persistent: false })
    expect(screen.getByText("Marginalia is not being saved — this device's storage is unavailable.")).not.toBeNull()
    cleanup()

    draw({ all: [ANNOTATION()] })
    expect(screen.queryByText(/Marginalia is not being saved/u)).toBeNull()
  })

  it('says what stands above the rows: a marks file that would not read, and only such a file', () => {
    draw({ all: [ANNOTATION()], unreadable: true })
    expect(
      screen.getByText(
        "This book's marks file could not be read. It is left as it is, and marks made now are not being saved over it.",
      ),
    ).not.toBeNull()
    cleanup()

    draw({ all: [ANNOTATION()] })
    expect(screen.queryByText(/marks file could not be read/u)).toBeNull()
  })
})

describe('the scope chips', () => {
  it('offer All books, chosen, and This book — each a named icon', () => {
    draw({ all: [ANNOTATION()] })
    const chips = within(screen.getByRole('group', { name: 'Filter by book' })).getAllByRole('button')
    expect(
      chips.map((chip) => [
        chip.getAttribute('aria-label'),
        chip.getAttribute('title'),
        chip.getAttribute('aria-pressed'),
        chip.querySelector('svg') !== null,
      ]),
    ).toEqual([
      ['All books', 'All books', 'true', true],
      ['This book', 'This book', 'false', true],
    ])
  })

  it('keep the open book’s rows under This book, and put the other books’ away', () => {
    draw({ all: [ANNOTATION(), ANNOTATION({ id: 'm2', bookId: 'other-book', text: 'stately plump buck' })] })
    fireEvent.click(screen.getByRole('button', { name: 'This book' }))
    expect(listed()).toEqual(['call me ishmael'])
  })
})

describe('a row’s parts', () => {
  it('marks a place row as a place, and a mark row as none', () => {
    draw({ all: [ANNOTATION()], allBookmarks: [BOOKMARK({ chapter: 'Etymology' })] })
    expect(rowsDrawn().map((row) => row.getAttribute('data-place'))).toEqual([null, 'true'])
  })

  /* THE BOOK LINE IS FOR OTHER BOOKS, always something — and never on the open
     book's own rows, where the book is the one being read. */
  it('names another book, as Another book when it has no title, and puts no book line on the open book’s rows', () => {
    draw({
      all: [
        ANNOTATION(),
        ANNOTATION({ id: 'm2', bookId: 'gone-book', text: 'a lost passage' }),
        ANNOTATION({ id: 'm3', bookId: 'other-book', text: 'stately plump buck' }),
      ],
    })
    expect(
      rowsDrawn().map((row) => (row.firstElementChild?.tagName === 'DIV' ? row.firstElementChild.textContent : null)),
    ).toEqual([null, 'Another book', 'Ulysses'])
  })

  it('labels a companion’s claim as the companion’s, and no other row', () => {
    draw({ all: [ANNOTATION(), ANNOTATION({ id: 'c1', kind: 'companion', text: 'a model claims this' })] })
    const labels = screen.getAllByText('Companion')
    expect(labels).toHaveLength(1)
    expect(labels[0]!.getAttribute('data-kind')).toBe('Companion')
    expect(labels[0]!.closest('[data-focused]')?.getAttribute('data-kind')).toBe('companion')
  })

  it('says a mark’s chapter, or that its chapter is not known', () => {
    draw({ all: [ANNOTATION(), ANNOTATION({ id: 'm2', text: 'the whale', chapter: '' })] })
    expect(screen.getByText('Loomings')).not.toBeNull()
    expect(screen.getByText('Unknown chapter')).not.toBeNull()
  })

  it('offers a card only where cards are made, and deletes the row’s own mark', () => {
    const onDelete = vi.fn()
    render(<Marginalia marks={marksView({ all: [ANNOTATION()] })} bookId="open-book" platform="macos" onDelete={onDelete} />)
    expect(screen.queryByRole('button', { name: 'Make a card' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Delete mark' }))
    expect(onDelete).toHaveBeenCalledWith(ANNOTATION())
  })
})

describe('a place row’s line', () => {
  /* ONE LINE, WHATEVER IT WAS WALKED OUT OF — rows written before
     `bookmarkFrom` collapsed whitespace carry the markup's newlines. */
  it('is collapsed to one line, names the place for its bin, and the bin removes that bookmark', () => {
    const onDeleteBookmark = vi.fn()
    const place = BOOKMARK({ text: '  Call  me\n   Ishmael  ' })
    render(
      <Marginalia
        marks={marksView({ allBookmarks: [place] })}
        bookId="open-book"
        platform="macos"
        onDeleteBookmark={onDeleteBookmark}
        onGoTo={vi.fn()}
      />,
    )
    const line = screen.getByText('Call me Ishmael')
    expect(line.tagName).toBe('SPAN')
    expect(line.textContent).toBe('Call me Ishmael')
    expect(line.className).toBe(`${styles.noteBody} ${styles.placeLine}`)

    const bin = screen.getByRole('button', { name: /^Remove this bookmark/u })
    expect(bin.getAttribute('aria-label')).toBe('Remove this bookmark — Call me Ishmael')
    fireEvent.click(bin)
    expect(onDeleteBookmark).toHaveBeenCalledWith(place)
  })

  it('is left out when there is none, and the place is named by its chapter — or as somewhere in the book', () => {
    render(
      <Marginalia
        marks={marksView({ allBookmarks: [BOOKMARK({ text: ' \n ', chapter: '' })] })}
        bookId="open-book"
        platform="macos"
        onDeleteBookmark={vi.fn()}
        onGoTo={vi.fn()}
      />,
    )
    const jump = screen.getByRole('button', { name: 'Somewhere in this book' })
    expect(jump.querySelectorAll('span'), 'an empty line was drawn').toHaveLength(1)
    expect(screen.getByRole('button', { name: /^Remove this bookmark/u }).getAttribute('aria-label')).toBe(
      'Remove this bookmark — Somewhere in this book',
    )
  })
})

describe('the ages on the rows', () => {
  const T0 = Date.UTC(2026, 8, 14, 12, 0, 0)
  const at = (now?: number) => (
    <Marginalia
      marks={marksView({ allBookmarks: [BOOKMARK({ createdAt: T0 })] })}
      bookId="open-book"
      platform="macos"
      onDeleteBookmark={vi.fn()}
      {...(now === undefined ? {} : { now })}
    />
  )
  /** A place row's age sits just before its bin. */
  const age = () => screen.getByRole('button', { name: /^Remove this bookmark/u }).previousElementSibling?.textContent

  afterEach(() => {
    vi.useRealTimers()
  })

  it('are measured against the clock, and move on with it a minute at a time', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(T0 + 30_000)
    render(at())
    expect(age()).toBe('Just now')

    act(() => void vi.advanceTimersByTime(60_000))
    expect(age(), 'the age stood still while the pane stayed open').toBe('1 min')
  })

  it('follow a clock the host hands in, including a later one', () => {
    const view = render(at(T0 + 30_000))
    expect(age()).toBe('Just now')

    view.rerender(at(T0 + 5 * 60_000))
    expect(age()).toBe('5 min')
  })

  it('keep time themselves once the host stops handing a clock in', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(T0 + 10 * 60_000)
    const view = render(at(T0 + 30_000))
    view.rerender(at())

    act(() => void vi.advanceTimersByTime(60_000))
    expect(age()).toBe('11 min')
  })

  /* A clock handed in is the only one read, so a timer of its own would only
     re-draw the panel for a value that cannot change — and one left running
     after the panel closed would go on doing it for nobody. */
  it('run no clock of their own when handed one, and leave none running when the panel closes', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    render(at(T0))
    expect(vi.getTimerCount(), 'a panel handed its clock started one of its own').toBe(0)
    cleanup()

    const view = render(at())
    expect(vi.getTimerCount()).toBe(1)
    view.unmount()
    expect(vi.getTimerCount(), 'the panel closed and left its clock running').toBe(0)
  })
})

describe('opening the panel', () => {
  /* One read per book is the price, so it is paid once — and paid again only
     for a store that is not the one already read. */
  it('reads every book’s marks once, and again only for a different store', () => {
    const loadAll = vi.fn()
    const at = (load: () => void) => (
      <Marginalia
        marks={marksView({ all: [ANNOTATION()], loadAll: load as unknown as MarksView['loadAll'] })}
        bookId="open-book"
        platform="macos"
      />
    )
    const view = render(at(loadAll))
    expect(loadAll).toHaveBeenCalledTimes(1)
    view.rerender(at(loadAll))
    expect(loadAll).toHaveBeenCalledTimes(1)

    const another = vi.fn()
    view.rerender(at(another))
    expect(another, 'a new store was never read').toHaveBeenCalledTimes(1)
  })
})

describe('a focus request, against the scope and the list', () => {
  const HERE = ANNOTATION({ id: 'here', text: 'call me ishmael' })
  const SECOND = ANNOTATION({ id: 'second', text: 'a second passage' })
  const AWAY = ANNOTATION({ id: 'away', bookId: 'other-book', text: 'stately plump buck' })
  type Moment = {
    readonly all?: readonly Annotation[]
    readonly bookId?: string | null
    readonly focus?: { id: string; edit: boolean; nonce: number }
  }

  function panel(first: Moment) {
    const onFocusDone = vi.fn()
    let moment = first
    const at = ({ all = [], bookId = 'open-book', focus }: Moment) => (
      <Marginalia
        marks={marksView({ all })}
        bookId={bookId}
        platform="macos"
        now={1}
        onFocusDone={onFocusDone}
        {...(focus ? { focus } : {})}
        onGoTo={vi.fn()}
      />
    )
    const view = render(at(moment))
    return {
      onFocusDone,
      redraw: (change: Moment) => {
        moment = { ...moment, ...change }
        view.rerender(at(moment))
      },
    }
  }

  it('widens This book to All books for a mark in another book, and shows it', () => {
    const { redraw } = panel({ all: [HERE, AWAY] })
    fireEvent.click(screen.getByRole('button', { name: 'This book' }))
    expect(listed()).toEqual(['call me ishmael'])

    redraw({ focus: { id: 'away', edit: false, nonce: 1 } })
    expect(chipOn('All books')).toBe('true')
    expect(listed()).toEqual(['call me ishmael', 'stately plump buck'])
  })

  it('leaves This book as it is for a mark in the open book', () => {
    const { redraw } = panel({ all: [HERE, AWAY] })
    fireEvent.click(screen.getByRole('button', { name: 'This book' }))

    redraw({ focus: { id: 'here', edit: false, nonce: 1 } })
    expect(chipOn('This book')).toBe('true')
    expect(listed()).toEqual(['call me ishmael'])
  })

  /* WITH NO BOOK OPEN NOTHING IS SCOPED, so there is nothing to widen — and the
     reader's This book is still theirs when a book opens again. */
  it('keeps This book for the next book when a request arrives with none open', () => {
    const { redraw } = panel({ all: [HERE, AWAY] })
    fireEvent.click(screen.getByRole('button', { name: 'This book' }))

    redraw({ bookId: null, focus: { id: 'away', edit: false, nonce: 1 } })
    redraw({ bookId: 'open-book' })
    expect(chipOn('This book')).toBe('true')
  })

  it('tints the row it revealed and no other, and opens no editor for a request to read', () => {
    const { redraw } = panel({ all: [HERE, SECOND] })
    redraw({ focus: { id: 'second', edit: false, nonce: 1 } })
    expect(rowsDrawn().map((row) => row.getAttribute('data-focused'))).toEqual(['false', 'true'])
    expect(screen.queryByPlaceholderText('Write a note')).toBeNull()
  })

  it('waits for the mark it names even while the list holds others', () => {
    const { redraw, onFocusDone } = panel({ all: [SECOND] })
    redraw({ focus: { id: 'here', edit: false, nonce: 1 } })
    expect(onFocusDone, 'a request was answered with a row it did not name').not.toHaveBeenCalled()
    expect(rowsDrawn().map((row) => row.getAttribute('data-focused'))).toEqual(['false'])

    redraw({ all: [HERE, SECOND] })
    expect(onFocusDone).toHaveBeenCalledWith(1)
  })

  /* AFTER PAINT, and only the latest request's row — and a frame whose row has
     gone does nothing at all. The frames are held here so each can be run, or
     seen cancelled, when the test says. */
  describe('scrolling to the row', () => {
    let frames: { readonly id: number; readonly run: FrameRequestCallback }[] = []
    let cancelled = new Set<number>()
    let scrolled: { readonly row: Element; readonly options: unknown }[] = []
    let spy: { mockRestore(): void } | null = null

    beforeEach(() => {
      frames = []
      cancelled = new Set()
      scrolled = []
      vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
        frames.push({ id: frames.length + 1, run })
        return frames.length
      })
      vi.stubGlobal('cancelAnimationFrame', (id: number) => void cancelled.add(id))
      spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element, options) {
        scrolled.push({ row: this, options })
      })
    })

    afterEach(() => {
      spy?.mockRestore()
      vi.unstubAllGlobals()
    })

    const paint = () =>
      act(() => {
        for (const frame of frames.splice(0)) if (!cancelled.has(frame.id)) frame.run(0)
      })

    it('scrolls the row asked for into view after paint, to its nearest edge', () => {
      const { redraw } = panel({ all: [HERE, SECOND] })
      redraw({ focus: { id: 'second', edit: false, nonce: 1 } })
      expect(scrolled, 'scrolled before the row was painted').toEqual([])

      paint()
      expect(scrolled).toEqual([{ row: rowsDrawn()[1], options: { block: 'nearest' } }])
    })

    it('scrolls only to the latest of two requests made before a paint', () => {
      const { redraw } = panel({ all: [HERE, SECOND] })
      redraw({ focus: { id: 'here', edit: false, nonce: 1 } })
      redraw({ focus: { id: 'second', edit: false, nonce: 2 } })

      paint()
      expect(scrolled.map(({ row }) => row)).toEqual([rowsDrawn()[1]])
    })

    it('scrolls to nothing when the row left the list before the paint', () => {
      const { redraw } = panel({ all: [HERE, SECOND] })
      redraw({ focus: { id: 'second', edit: false, nonce: 1 } })
      redraw({ all: [HERE] })

      paint()
      expect(scrolled, 'a row that had left the list was scrolled to').toEqual([])
    })
  })
})

/**
 * THE NOTE EDITOR, UNDER THE INTERLEAVINGS IT EXISTS FOR — a write still out
 * while the reader types, a refused write, a newer note arriving, and the
 * editor going away by every route that is not a blur.
 */
describe('a note editor, while its writes are out', () => {
  /** A host that answers each note write only when told. */
  function answering() {
    const answers: { readonly note: string; resolve(): void; reject(cause: Error): void }[] = []
    const setNote = vi.fn(
      (_mark: unknown, note: string) => new Promise<void>((resolve, reject) => answers.push({ note, resolve, reject })),
    )
    return { setNote, answers, written: () => answers.map((answer) => answer.note) }
  }

  /** An editor open on `m1`, beside a bookmark so a chip can filter the row away without emptying the panel. */
  function editorOn(
    note: string,
    setNote: (mark: never, note: string) => void | Promise<void>,
    unsaved?: ReadonlyMap<string, string>,
  ) {
    const at = (current: string) => (
      <Marginalia
        marks={marksView({
          all: [ANNOTATION({ id: 'm1', note: current })],
          allBookmarks: [BOOKMARK()],
          setNote: setNote as unknown as MarksView['setNote'],
          ...(unsaved ? { unsaved } : {}),
        })}
        bookId="open-book"
        platform="macos"
        now={1}
        focus={{ id: 'm1', edit: true, nonce: 1 }}
        onGoTo={vi.fn()}
      />
    )
    const view = render(at(note))
    return {
      field: () => screen.queryByPlaceholderText('Write a note') as HTMLTextAreaElement | null,
      arrives: (current: string) => view.rerender(at(current)),
    }
  }

  const values = (setNote: { mock: { calls: unknown[][] } }) => setNote.mock.calls.map(([, value]) => value)
  const offer = () => screen.queryByRole('button', { name: 'Use that version' })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens on the note, or on a refused draft in its place', () => {
    expect(editorOn('the old note', vi.fn()).field()!.value).toBe('the old note')
    cleanup()
    expect(editorOn('the old note', vi.fn(), new Map([['m1', 'a refused draft']])).field()!.value).toBe('a refused draft')
  })

  /* A NOTE STORED WITH SPACES AROUND IT IS THE NOTE IT READS AS — opening it
     calls nothing newer, and closing it untouched writes nothing. */
  it('opens a note stored with spaces around it without calling it newer, and closes it untouched without writing', () => {
    const setNote = vi.fn()
    const { field } = editorOn('  the whiteness of the whale  ', setNote)
    expect(offer(), 'the note it opened on was offered as a newer version of itself').toBeNull()

    fireEvent.blur(field()!)
    expect(setNote, 'an untouched note was written again').not.toHaveBeenCalled()
    expect(field()).toBeNull()
  })

  it('takes a newer note silently over an untouched note stored with spaces around it', () => {
    const { field, arrives } = editorOn('  the old note  ', vi.fn())
    arrives('the newer note')
    expect(field()!.value).toBe('the newer note')
    expect(offer()).toBeNull()
  })

  it('does not call a note newer that differs only in the spaces around it', () => {
    const { field, arrives } = editorOn('the note', vi.fn())
    fireEvent.change(field()!, { target: { value: 'the note, and more' } })
    arrives('  the note  ')
    expect(offer()).toBeNull()
    expect(field()!.value).toBe('the note, and more')
  })

  /* WRITTEN TRIMMED, and a host that answers nothing has it NOW — so the blur
     closes the editor itself, not a turn later. */
  it('writes the note trimmed, and closes on the blur itself for a host that answers nothing', () => {
    const setNote = vi.fn()
    const { field } = editorOn('', setNote)
    fireEvent.change(field()!, { target: { value: '  a padded thought  ' } })
    fireEvent.blur(field()!)
    expect(values(setNote)).toEqual(['a padded thought'])
    expect(field(), 'the editor waited for an answer nobody was going to give').toBeNull()
  })

  /* A SAVE IS NOT A BLUR. The editor closes on a landing only after the reader
     left it — and one that opened without the focus (a window in the
     background) has not been left either. */
  it('stays open when a save lands while the reader is still in it, even one that opened without the focus', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(() => {})
    try {
      const setNote = vi.fn()
      const { field } = editorOn('', setNote)
      fireEvent.change(field()!, { target: { value: 'still writing' } })
      /* In `act`, so a close this save might have caused has happened by the
         line below rather than being still queued when it is read. */
      act(() => void saveNow())
      expect(values(setNote)).toEqual(['still writing'])
      expect(field(), 'a save that landed closed an editor nobody had left').not.toBeNull()
    } finally {
      focus.mockRestore()
    }
  })

  /* THE NEWEST WRITE OWNS THE MARKER. An older one coming back — landed or
     refused — must not clear it, or the next tick hands the newest text over a
     second time while it is still out. */
  it('hands a pending note over once, even after an older write comes back landed or refused', async () => {
    for (const settle of ['landed', 'refused'] as const) {
      const { setNote, answers, written } = answering()
      const { field } = editorOn('', setNote)
      fireEvent.change(field()!, { target: { value: 'a' } })
      saveNow()
      fireEvent.change(field()!, { target: { value: 'ab' } })
      saveNow()
      await act(async () => (settle === 'landed' ? answers[0]!.resolve() : answers[0]!.reject(new Error('EIO'))))
      saveNow()
      expect(written(), `after the older write ${settle}`).toEqual(['a', 'ab'])
      cleanup()
    }
  })

  it('waits for the newest write before closing, when the saved note was typed back while another was out', async () => {
    const { setNote, answers, written } = answering()
    const { field } = editorOn('', setNote)
    fireEvent.change(field()!, { target: { value: 'first' } })
    saveNow()
    await act(async () => answers[0]!.resolve())
    fireEvent.change(field()!, { target: { value: 'second' } })
    saveNow()
    fireEvent.change(field()!, { target: { value: 'first' } })
    fireEvent.blur(field()!)
    expect(written()).toEqual(['first', 'second', 'first'])
    expect(field(), 'the editor closed while the note it shows was still being written').not.toBeNull()

    await act(async () => answers[1]!.resolve())
    expect(field(), 'an older write landing closed the editor').not.toBeNull()
    await act(async () => answers[2]!.resolve())
    expect(field()).toBeNull()
  })

  /* TAKEN AFTER THE BLUR, the newer version is what the field holds — so the
     reader's own write landing does not close an editor showing something else. */
  it('stays open when the newer version is taken after the blur, until that version is saved', async () => {
    const { setNote, answers, written } = answering()
    const { field, arrives } = editorOn('the old note', setNote)
    fireEvent.change(field()!, { target: { value: 'mine' } })
    arrives('theirs')
    fireEvent.blur(field()!)
    expect(written()).toEqual(['mine'])

    fireEvent.mouseDown(offer()!)
    fireEvent.click(offer()!)
    expect(field()!.value).toBe('theirs')
    await act(async () => answers[0]!.resolve())
    expect(field(), 'the editor closed on “mine” landing while it showed “theirs”').not.toBeNull()

    saveNow()
    expect(written()).toEqual(['mine', 'theirs'])
    await act(async () => answers[1]!.resolve())
    expect(field()).toBeNull()
  })

  /* ITS OWN SAVE, ONCE BACK, IS SPENT — the same words arriving again later
     came from somewhere else and are news like any other. */
  it('takes a note from elsewhere as news even when it repeats a save of its own that already came back', () => {
    const { field, arrives } = editorOn('', vi.fn())
    fireEvent.change(field()!, { target: { value: 'x' } })
    saveNow()
    arrives('x')
    fireEvent.change(field()!, { target: { value: 'xy' } })
    saveNow()
    arrives('xy')
    fireEvent.change(field()!, { target: { value: 'xyz' } })

    arrives('x')
    expect(offer(), 'a note from elsewhere was taken for an old save of this editor’s').not.toBeNull()
    expect(field()!.value).toBe('xyz')
  })

  it('says the newer version in one sentence beside its button, and pressing the button keeps the focus', () => {
    const { field, arrives } = editorOn('the old note', vi.fn())
    fireEvent.change(field()!, { target: { value: 'half' } })
    arrives('the newer note')
    expect(offer()!.parentElement!.textContent).toBe(
      'A newer version of this note arrived while you were typing. Use that version',
    )
    expect(fireEvent.mouseDown(offer()!), 'the press would take the focus, and the blur save over this version').toBe(false)
  })

  it('hands the draft over when the window is about to close', () => {
    const setNote = vi.fn()
    const { field } = editorOn('', setNote)
    fireEvent.change(field()!, { target: { value: 'before quitting' } })
    flushBeforeClose()
    expect(values(setNote)).toEqual(['before quitting'])
  })

  it('saves what is typed after a second’s pause', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const setNote = vi.fn()
    const { field } = editorOn('', setNote)
    fireEvent.change(field()!, { target: { value: 'mid-sentence' } })
    expect(setNote).not.toHaveBeenCalled()

    act(() => void vi.advanceTimersByTime(1000))
    expect(values(setNote)).toEqual(['mid-sentence'])
  })

  it('saves what is typed when the page is put away', () => {
    const setNote = vi.fn()
    const { field } = editorOn('', setNote)
    fireEvent.change(field()!, { target: { value: 'as the page goes' } })
    window.dispatchEvent(new Event('pagehide'))
    expect(values(setNote)).toEqual(['as the page goes'])
  })

  it('saves what it holds when its row is filtered away with no blur', () => {
    const setNote = vi.fn()
    const { field } = editorOn('', setNote)
    fireEvent.change(field()!, { target: { value: 'never blurred' } })
    fireEvent.click(screen.getByRole('button', { name: 'Bookmarks' }))
    expect(field()).toBeNull()
    expect(values(setNote)).toEqual(['never blurred'])
  })

  /* GONE IS GONE: nothing it registered goes on saving after it — not the
     timer, not the page's events — even for a draft whose last write failed. */
  it('asks nothing more once it has gone, though its last write was refused', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { setNote, answers, written } = answering()
    const { field } = editorOn('', setNote)
    fireEvent.change(field()!, { target: { value: 'refused at the close' } })
    fireEvent.click(screen.getByRole('button', { name: 'Bookmarks' }))
    expect(written()).toEqual(['refused at the close'])
    await act(async () => answers[0]!.reject(new Error('EIO')))

    act(() => void vi.advanceTimersByTime(5000))
    window.dispatchEvent(new Event('pagehide'))
    saveNow()
    flushBeforeClose()
    expect(written(), 'an editor that had gone went on writing').toEqual(['refused at the close'])
  })
})
