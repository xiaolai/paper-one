// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initialState, type AppDispatch, type AppState } from '../state'
import type { Book } from '../hooks/useBook'
import type { Bookmarking } from '../hooks/useBookmarking'
import type { SaveFailureView } from '../hooks/useLibrary'
import type { Marking } from '../hooks/useMarking'
import type { MarksView } from '../hooks/useMarks'
import type { SelectionSnapshot } from '../reader/session'
import { Reader } from './Reader'

/**
 * The import notice, on the screen the import was started from (WI-21.2).
 *
 * ⚠️ **THE NOTICE WAS INVISIBLE FROM THE READER, AND THE IMPORT IS OFFERED
 * THERE.** `marks:import` sits in the palette on the reader screen; the notice
 * expired after twelve seconds and only the conditionally mounted `Library`
 * rendered it. So a reader could import an archive mid-book, lose every
 * name-matched mark to Stage 1's refusal, and be told nothing at all.
 *
 * That is the case this file exists for, and it is asserted as VISIBLE TEXT
 * rather than as a prop reaching a component: a prop that arrives and is
 * rendered into a branch nobody takes fails this test and passes any check
 * made one level up.
 *
 * ## What can be mounted here
 *
 * `FoliateView.test.tsx` sets the rule and this follows it: a book cannot
 * actually open under jsdom — foliate's `View` is a custom element behind a
 * dynamic import and there is no layout to paginate into — so what is proven
 * is the chrome around the stage, which renders regardless.
 */

/* `useAvailableWidth` builds a `ResizeObserver` the moment the stage mounts,
   and jsdom has none — its absence throws before a single notice renders. The
   same stub the shelf's own suites carry, for the same reason. */
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never

afterEach(cleanup)

const book = (): Book =>
  ({
    error: null,
    /* A book is OPEN unless a case says otherwise. `bookOver: { source: null }`
       is the empty state, where the footer, the margin and the popup give way
       to "No book open" — and the notices at the foot of the column do not,
       which is what several cases below exist to say. A string source is
       enough; nothing here opens it. */
    source: 'moby.epub',
    bookId: 'book:moby',
    generation: 1,
    toc: [],
    position: { fraction: 0, chapterLabel: 'Loomings', chapterHref: 'ch1.xhtml', cfi: null, sectionIndex: 0, sectionExact: true },
    meta: null,
    doc: null,
    fixedLayout: false,
    direction: 'ltr',
    open: vi.fn(),
    close: vi.fn(),
    goTo: vi.fn(),
    goLeft: vi.fn(),
    goRight: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    fail: vi.fn(),
    deselect: vi.fn(),
    navigation: { canPrev: false, canNext: false },
    setCover: vi.fn(),
    setDirection: vi.fn(),
    setDoc: vi.fn(),
    setFixedLayout: vi.fn(),
    setFootnoteMount: vi.fn(),
    setMeta: vi.fn(),
    setNavigator: vi.fn(),
    setPosition: vi.fn(),
    setToc: vi.fn(),
    closeFootnote: vi.fn(),
  }) as unknown as Book

const marks = (): MarksView =>
  ({
    all: [],
    current: [],
    bookmarks: [],
    allBookmarks: [], allUnplaced: [],
    persistent: true,
    ready: true,
    unreadable: false,
    scanning: false,
    scanFailed: false,
    add: vi.fn(),
    addMany: vi.fn(),
    remove: vi.fn(),
    update: vi.fn(),
    loadAll: vi.fn(),
    loadAllNow: vi.fn(async () => []),
  }) as unknown as MarksView

const marking = (): Marking =>
  ({
    selection: null,
    setSelection: vi.fn(),
    ranges: [],
    onMarkDrawn: vi.fn(),
    selected: null,
    canMark: false,
    mark: vi.fn(),
    unmark: vi.fn(),
  }) as unknown as Marking

const bookmarking = (): Bookmarking =>
  ({ here: false, toggle: vi.fn(), marks: [] }) as unknown as Bookmarking

interface Over {
  importNotice?: string | null
  onDismissImportNotice?: () => void
  saveFailure?: SaveFailureView | null
  onDismissSaveFailure?: () => void
  bookOver?: Partial<Record<string, unknown>>
  stateOver?: Partial<AppState>
  marking?: Marking
  dispatch?: AppDispatch
}

/** The screen as a host hands it over — apart from `render`, so a case can `rerender` it. */
function reader(over: Over = {}) {
  const { bookOver, stateOver, marking: markingOver, dispatch, ...props } = over
  return (
    <Reader
      state={{ ...initialState, screen: 'reader', ...stateOver }}
      dispatch={dispatch ?? vi.fn()}
      platform="macos"
      book={{ ...book(), ...(bookOver ?? {}) } as unknown as Book}
      /* Nothing being looked up — this file is about the notice slot, and Look up
         is App's state since WI-17.2. */
      lookUp={{ state: { kind: 'idle' }, action: 'none', press: null, dismiss: vi.fn(), onInstall: undefined }}
      marks={marks()}
      marking={markingOver ?? marking()}
      bookmarking={bookmarking()}
      libraryCount={1}
      onOpenLibrary={vi.fn()}
      onAddBooks={vi.fn()}
      dragging={false}
      reducedMotion
      lastLocation={null}
      onLink={vi.fn()}
      onExternalLink={vi.fn()}
      onFootnote={vi.fn()}
      {...props}
    />
  )
}

function mount(over: Over = {}) {
  return render(reader(over))
}

describe('the reader says what an import just did', () => {
  it('shows the notice as text a reader can read', () => {
    /* The exact sentence Stage 1 produces for a name-matched book — `Not
       placed — a different edition here: …` is the half that would otherwise
       never reach anybody, because it is the half that reports a LOSS. */
    mount({ importNotice: 'Nothing to add. Not placed — a different edition here: Moby-Dick.' })
    expect(
      screen.getByText('Nothing to add. Not placed — a different edition here: Moby-Dick.'),
    ).toBeTruthy()
  })

  it('announces it, rather than drawing it silently', () => {
    /* `role="status"`, like every other notice on this screen. A sentence a
       screen reader never speaks is invisible to the reader who most needs the
       app to speak. */
    mount({ importNotice: 'Added 3 marks and 0 cards across 1 book.' })
    const statuses = screen.getAllByRole('status').map((one) => one.textContent)
    expect(statuses.some((text) => text?.includes('Added 3 marks'))).toBe(true)
  })

  it('offers a way to clear it when the host gives one', () => {
    const onDismissImportNotice = vi.fn()
    mount({ importNotice: 'Nothing to add.', onDismissImportNotice })
    const dismiss = screen
      .getAllByRole('button')
      .find((one) => one.textContent === 'Dismiss' && one.parentElement?.textContent?.startsWith('Nothing to add.'))
    expect(dismiss, 'the import notice needs its own Dismiss').toBeTruthy()
    dismiss!.click()
    expect(onDismissImportNotice).toHaveBeenCalled()
  })

  /**
   * ⚠️ **THE NOTICE WAS INSIDE THE OPEN-BOOK BRANCH, WHICH REPRODUCED THE
   * DEFECT ONE BRANCH NARROWER.** `Reader` renders three quite different
   * things — an open book, a book that would not open, and "No book open" —
   * and the first version of this fix put the notice inside only the first.
   * The palette does not care which is showing: `marks:import` is offered on
   * the reader screen either way, so an import begun from the empty state
   * reported into nothing at all. Found by an adversarial audit; these two
   * cases are why the notice now sits at the foot of the column instead.
   */
  it('shows the notice with no book open', () => {
    mount({ bookOver: { source: null }, importNotice: 'Not placed — a different edition here: Moby-Dick.' })
    expect(screen.getByText('No book open')).toBeTruthy()
    expect(screen.getByText('Not placed — a different edition here: Moby-Dick.')).toBeTruthy()
  })

  it('shows the notice over a book that would not open', () => {
    mount({ bookOver: { error: 'That book could not be opened.' }, importNotice: 'Added 3 marks and 0 cards across 1 book.' })
    expect(screen.getByText('That book could not be opened.')).toBeTruthy()
    expect(screen.getByText('Added 3 marks and 0 cards across 1 book.')).toBeTruthy()
  })

  it('draws nothing at all when there is nothing to say', () => {
    /* The notice slot sits over the footer. An empty one that still occupied
       the slot would push the page controls for the whole session.
     *
     * ⚠️ COUNTED AGAINST THE OTHER RENDER, not merely asserted absent. "No
     * element says 'Not placed'" is also true of a build where the notice is
     * never rendered at all, which is the state this whole item exists to
     * leave — so the assertion has to be that the sentence's presence CHANGES
     * the tree. */
    const { unmount } = mount({ importNotice: null })
    const quiet = screen.queryAllByRole('status').length
    unmount()
    mount({ importNotice: 'Not placed — a different edition here: Moby-Dick.' })
    expect(screen.queryAllByRole('status')).toHaveLength(quiet + 1)
  })
})

/**
 * A SAVE THE DISK REFUSED (WI-20.36), in all three of the screen's states. It sat
 * inside the open-book branch until 2026-09-13 — the defect the import notice
 * above was moved out of, one notice over — so closing the book, or a book that
 * would not open, hid the failure and the only Retry for it.
 */
describe('a save that did not land', () => {
  it.each([
    ['over an open book', {}],
    ['with no book open', { source: null }],
    ['over a book that would not open', { error: 'That book could not be opened.' }],
  ])('is said, with its Retry, %s', (_where, bookOver) => {
    const retry = vi.fn()
    mount({ bookOver, saveFailure: { message: 'Couldn’t save “Moby-Dick”', retry }, onDismissSaveFailure: vi.fn() })

    expect(screen.getByText('Couldn’t save “Moby-Dick”')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })
})

describe('the page-turn chevrons', () => {
  /* ⚠️ `tabIndex={-1}` KEEPS A BUTTON OUT OF TAB, NOT OUT OF FOCUS. A click
     focuses a button in a Chromium webview, and App will not turn a page from a
     focused control — so one press of a chevron stopped ← and → working. jsdom
     moves no focus on a pointerdown, so what is asserted is the default that
     would: `fireEvent` answers false when it was cancelled. */
  it.each(['Page to the left', 'Page to the right'])('%s does not take focus from the book', (name) => {
    mount({ stateOver: { pageLayout: 'paginated' } })

    expect(fireEvent.pointerDown(screen.getByRole('button', { name }))).toBe(false)
  })
})

/**
 * A live selection the popup can actually be drawn over — `SelectionTools.test`'s
 * scene, inside the whole screen. jsdom lays nothing out, so every element
 * answers as a 1000×800 box at the origin (see the `beforeEach` below) and the
 * selected line is given one of its own.
 *
 * ⚠️ **THE CFI WAS `''` HERE, AND THAT IS NO LONGER A PASSAGE THE POPUP OFFERS
 * MARK FOR.** `useMarking.canMark` is false for it, so the popup draws neither
 * Mark nor Note (2026-09-13 audit, #202) — see the case at the end of this
 * block. The refusals below are the ones `canMark` cannot foresee, and `mark`
 * is mocked to return null to stand for them: a store that drops the anchor
 * it was handed (`isPlaced` in `mark`), or a selection gone between the draw
 * and the press. The notice has to speak for those either way.
 */
function selecting(over: Partial<Record<keyof Marking, unknown>> = {}): Marking {
  const box = (left: number, top: number, width: number, height: number) =>
    ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect
  const frame = { getBoundingClientRect: () => box(0, 0, 1000, 800), offsetWidth: 1000, offsetHeight: 800 }
  const view = { frameElement: frame, addEventListener() {}, removeEventListener() {} }
  const range = {
    startContainer: { ownerDocument: { defaultView: view, body: null } },
    getClientRects: () => [box(400, 300, 200, 20)],
  }
  const selection: SelectionSnapshot = {
    cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:4)',
    sectionIndex: 0,
    text: 'gams',
    prefix: '',
    suffix: '',
    range: range as unknown as Range,
  }
  return { ...marking(), selection, canMark: true, ...over } as unknown as Marking
}

describe('with a passage selected', () => {
  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ x: 0, y: 0, left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800, toJSON: () => ({}) }) as DOMRect,
    )
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const markButton = () => screen.getByRole('button', { name: /^Mark this passage — / })
  const unmarked = 'That passage could not be marked.'

  /* ⚠️ A MARK THAT WAS NOT MADE WAS SILENT. `mark` answers null for a selection it
     cannot anchor, and the popup's Mark button ignored the answer. */
  it('says so when the passage could not be marked', () => {
    const mark = vi.fn(() => null)
    mount({ marking: selecting({ mark }) })

    fireEvent.click(markButton())

    expect(mark).toHaveBeenCalledTimes(1)
    expect(screen.getByText(unmarked)).toBeTruthy()
  })

  /* ⚠️ AND THE NOTE BUTTON OPENED NOTES ON NOTHING — no mark to focus, no editor,
     and no word about why. */
  it('does not open Notes for a note it had no mark to write on', () => {
    const dispatch = vi.fn()
    mount({ dispatch, marking: selecting({ mark: vi.fn(() => null) }) })

    fireEvent.click(screen.getByRole('button', { name: 'Write a note on this passage' }))

    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'openPane' }))
    expect(screen.getByText(unmarked)).toBeTruthy()
  })

  /* ⚠️ **AND A PASSAGE THAT CANNOT BE MARKED IS NOT OFFERED MARK OR NOTE AT
     ALL** (#202). What the hook says about the selection is what the popup
     draws; this is the wiring between the two, which neither's own test sees. */
  it('draws neither Mark nor Note where the marking says the passage cannot hold one', () => {
    mount({ marking: selecting({ canMark: false }) })

    expect(screen.queryByRole('button', { name: /^Mark this passage — / })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Write a note on this passage' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy this passage' })).toBeTruthy()
  })

  /* The other half, so neither case above can pass by the note route never
     opening Notes at all. */
  it('opens Notes on the mark it made, and says nothing', () => {
    const dispatch = vi.fn()
    const focusMark = vi.fn()
    mount({ dispatch, marking: selecting({ mark: vi.fn(() => ({ id: 'mk1' })), focusMark }) })

    fireEvent.click(screen.getByRole('button', { name: 'Write a note on this passage' }))

    expect(focusMark).toHaveBeenCalledWith('mk1', true)
    expect(dispatch).toHaveBeenCalledWith({ type: 'openPane', pane: 'marginalia' })
    expect(screen.queryByText(unmarked)).toBeNull()
  })

  describe('and copied', () => {
    /** Every clipboard write asked for, in order, each settled by the case. */
    let writes: { readonly resolve: () => void; readonly reject: (cause: unknown) => void }[]
    beforeEach(() => {
      writes = []
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: () =>
            new Promise<void>((resolve, reject) => {
              writes.push({ resolve, reject })
            }),
        },
      })
    })
    afterEach(() => {
      Reflect.deleteProperty(navigator, 'clipboard')
    })

    const refused = 'That could not be copied to the clipboard.'
    const copy = () => fireEvent.click(screen.getByRole('button', { name: 'Copy this passage' }))
    /* The outcome reaches the screen several promise hops after the write
       settles; a macrotask inside `act` is past all of them. */
    const settle = async (at: number, how: 'works' | 'refused') => {
      await act(async () => {
        const write = writes[at]
        if (!write) throw new Error(`no clipboard write #${at} was asked for`)
        if (how === 'works') write.resolve()
        else write.reject(new Error('NotAllowedError'))
        await new Promise((done) => setTimeout(done, 0))
      })
    }

    it('takes a refusal down once a copy works', async () => {
      mount({ marking: selecting() })
      copy()
      await settle(0, 'refused')
      expect(screen.getByText(refused)).toBeTruthy()

      copy()
      await settle(1, 'works')
      expect(screen.queryByText(refused)).toBeNull()
    })

    it('does not let an older refusal speak over a newer copy that worked', async () => {
      mount({ marking: selecting() })
      copy()
      copy()

      await settle(1, 'works')
      await settle(0, 'refused')

      expect(screen.queryByText(refused)).toBeNull()
    })

    /* A NEW BOOK IS A NEW GENERATION, and the id follows it — `useBook` bumps
       the generation on every open and close, and only then resolves the id.
       The fixture moved the id alone until 2026-09-14, which is a transition the
       hook never makes. */
    it('leaves a failure with the book it happened in', async () => {
      const held = selecting()
      const { rerender } = mount({ marking: held })
      copy()
      await settle(0, 'refused')
      expect(screen.getByText(refused)).toBeTruthy()

      rerender(reader({ marking: held, bookOver: { bookId: 'book:pequod', generation: 2 } }))

      expect(screen.queryByText(refused)).toBeNull()
    })

    /* ⚠️ **KEYED ON THE ID, A BOOK WITH NO ID NEVER CHANGED** (2026-09-13 audit,
       #204, round 3). The id is null until `bookIdFor` answers, and stays null
       for a book it could not identify, so one such book replacing another left
       the id where it was: the last book's refusal stood over the next, and a
       copy still in flight when it changed reported into it. */
    it('leaves a failure with its book when neither book has an id yet', async () => {
      const held = selecting()
      const { rerender } = mount({ marking: held, bookOver: { bookId: null, generation: 1 } })
      copy()
      await settle(0, 'refused')
      expect(screen.getByText(refused)).toBeTruthy()

      copy()
      rerender(reader({ marking: held, bookOver: { bookId: null, generation: 2 } }))
      expect(screen.queryByText(refused), 'the last book’s refusal stood over the next').toBeNull()

      await settle(1, 'refused')
      expect(screen.queryByText(refused), 'a copy from the last book reported into the next').toBeNull()
    })

    /* AND THE ID ARRIVING IS NOT A NEW BOOK. The same open resolves its id a
       moment after it starts, and a copy made in that moment is still this
       book's — keyed on the id, its refusal was silenced by the id it waited for. */
    it('still reports a copy made before this book’s id arrived', async () => {
      const held = selecting()
      const { rerender } = mount({ marking: held, bookOver: { bookId: null, generation: 1 } })
      copy()
      rerender(reader({ marking: held, bookOver: { bookId: 'book:moby', generation: 1 } }))

      await settle(0, 'refused')
      expect(screen.getByText(refused)).toBeTruthy()
    })

    /* The slot holds one failure of each kind apart: a copy that worked says
       nothing about a mark that did not. */
    it('leaves a mark that failed standing when a copy works', async () => {
      mount({ marking: selecting({ mark: vi.fn(() => null) }) })
      fireEvent.click(markButton())
      copy()
      await settle(0, 'works')

      expect(screen.getByText(unmarked)).toBeTruthy()
    })
  })
})
