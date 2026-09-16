// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bookAccent } from '../../core/bookAccent'
import {
  PANE_TRACK,
  STAGE_PADDING_X,
  measureForStep,
  pageMargins,
  proseGrid,
} from '../../core/metrics'
import { initialState, type AppDispatch, type AppState } from '../state'
import type { Book } from '../hooks/useBook'
import type { Bookmarking } from '../hooks/useBookmarking'
import type { SaveFailureView } from '../hooks/useLibrary'
import type { Marking } from '../hooks/useMarking'
import type { MarksView } from '../hooks/useMarks'
import type { FootnoteRender, SelectionSnapshot } from '../reader/session'
import { Reader } from './Reader'
import styles from './Reader.module.css'

/**
 * The reader screen itself — the page, the chrome around it, and what it hands
 * the renderer.
 *
 * APART FROM `Reader.notice.test.tsx`, which owns the notice slot at the foot
 * of the column and mounts the REAL `FoliateView` to prove the chrome renders
 * beside it. This file stands in for the view at its boundary instead, for the
 * reason that file's own header gives from the other side: a book cannot open
 * under jsdom, so every decision the screen makes ABOUT the book — the measure
 * it lays the page out in, whether the flow is paginated, which way a gesture
 * turns the page — is invisible while the real view is mounted. The stand-in
 * records what it was handed, which is exactly what the screen decides.
 *
 * `src/app/web/Reader.test.tsx` does the same at the same seam, and for the
 * same reason; this is that arrangement one layer down.
 */
const view = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }))

vi.mock('../reader/FoliateView', () => ({
  FoliateView: (props: Record<string, unknown>) => {
    view.props = props
    return null
  },
}))

/** What the renderer was last handed. Loud when the view never mounted. */
function handedOver(): Record<string, unknown> {
  const props = view.props
  if (!props) throw new Error('the reader never rendered a view')
  return props
}

/* `useAvailableWidth` and `useElementWidth` both reach for a `ResizeObserver`
   the moment the stage mounts, and jsdom has none. The same stub the shelf's
   suites and the notice suite carry — and it never REPORTS, deliberately: an
   element with no measured width is what the reader meets on its first render,
   which is the one where `estimated` decides the grid. */
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never

/** The window the reader is laying out in. jsdom's own default is 1024. */
function windowWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
}

afterEach(() => {
  cleanup()
  view.props = null
  windowWidth(1024)
})

const book = (): Book =>
  ({
    error: null,
    source: 'moby.epub',
    bookId: 'book:moby',
    generation: 1,
    toc: [],
    position: {
      fraction: 0,
      chapterLabel: 'Loomings',
      chapterHref: 'ch1.xhtml',
      cfi: null,
      sectionIndex: 0,
      sectionExact: true,
    },
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
    allBookmarks: [],
    allUnplaced: [],
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
    ranges: new Map<string, Range>(),
    onMarkDrawn: vi.fn(),
    selected: null,
    canMark: false,
    mark: vi.fn(),
    unmark: vi.fn(),
    focusMark: vi.fn(),
  }) as unknown as Marking

const bookmarking = (): Bookmarking =>
  ({ here: null, canBookmark: true, toggle: vi.fn(), marks: [] }) as unknown as Bookmarking

interface Over {
  bookOver?: Record<string, unknown>
  stateOver?: Partial<AppState>
  marks?: MarksView
  marking?: Marking
  bookmarking?: Bookmarking
  dispatch?: AppDispatch
  overlays?: readonly never[]
  footnote?: FootnoteRender | null
  onDismissFootnote?: () => void
  returnTo?: { label: string; nonce: number } | null
  onReturn?: () => void
  onReturnDone?: () => void
  libraryCount?: number
  shelfUnread?: boolean
  saveFailure?: SaveFailureView | null
  onDismissSaveFailure?: () => void
  importNotice?: string | null
  inert?: boolean
  reducedMotion?: boolean
  platform?: 'macos' | 'windows'
  onOpenLibrary?: () => void
  onAddBooks?: () => void
}

/** The screen as a host hands it over — apart from `render`, so a case can `rerender`. */
function reader(over: Over = {}) {
  const {
    bookOver,
    stateOver,
    marks: marksOver,
    marking: markingOver,
    bookmarking: bookmarkingOver,
    dispatch,
    platform,
    libraryCount,
    ...props
  } = over
  return (
    <Reader
      state={{ ...initialState, screen: 'reader', pane: null, ...stateOver }}
      dispatch={dispatch ?? vi.fn()}
      platform={platform ?? 'macos'}
      book={{ ...book(), ...(bookOver ?? {}) } as unknown as Book}
      /* Nothing being looked up: Look up is App's state since WI-17.2, and this
         file is about what the screen around it decides. */
      lookUp={{ state: { kind: 'idle' }, action: 'none', press: null, dismiss: vi.fn(), onInstall: undefined }}
      marks={marksOver ?? marks()}
      marking={markingOver ?? marking()}
      bookmarking={bookmarkingOver ?? bookmarking()}
      libraryCount={libraryCount ?? 1}
      onOpenLibrary={vi.fn()}
      onAddBooks={vi.fn()}
      dragging={false}
      reducedMotion={false}
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

/** The stage the grid is published on, and one of its track widths. */
function track(container: HTMLElement, name: string): string {
  const stage = container.querySelector(`.${styles.stage}`)
  if (!(stage instanceof HTMLElement)) throw new Error('the reader drew no stage')
  return stage.style.getPropertyValue(name).trim()
}

/**
 * THE WIDTH THE STAGE LEAVES THE PAGE, and every number the grid takes from it.
 *
 * The pane is a TRACK beside the book above §06's threshold and a SHEET over it
 * below, and the reader reserves the track only in the first case — reserving it
 * in the second gave 412px away to nothing. Measured from the window rather
 * than from the stage on this first render, because the stage has no box until
 * it is attached; the `ResizeObserver` stub above is what keeps every case here
 * on that first reading.
 */
describe('the width the reader lays the book out in', () => {
  /** What the grid would be, given the stage width the case says it should get. */
  const gridFor = (available: number, showMargin = false) =>
    proseGrid(available, showMargin, measureForStep(initialState.stepIdx))

  it('gives the grid the stage the open pane leaves it', () => {
    /* 1280 is above §06's threshold, so the pane takes a track of its own —
       and narrow enough that the margin column has to yield for it, which is
       what makes the two answers below different numbers rather than one. */
    windowWidth(1280)
    const { container } = mount({ stateOver: { pane: 'marginalia' } })

    const beside = gridFor(1280 - PANE_TRACK - STAGE_PADDING_X * 2)
    expect(track(container, '--track-margin')).toBe(`${beside.marginCol}px`)
    expect(handedOver()['pageMargins']).toBe(pageMargins(beside))
    // Non-vacuity: the whole stage would be a different grid at this width.
    expect(pageMargins(beside)).not.toBe(pageMargins(gridFor(1280 - STAGE_PADDING_X * 2)))
  })

  it('gives it the whole stage when no pane is open', () => {
    windowWidth(1280)
    const { container } = mount()

    const whole = gridFor(1280 - STAGE_PADDING_X * 2)
    expect(track(container, '--track-margin')).toBe(`${whole.marginCol}px`)
    expect(handedOver()['pageMargins']).toBe(pageMargins(whole))
  })

  it('reserves nothing for a pane that is a sheet over the book', () => {
    /* Below the threshold the pane covers the page instead of standing beside
       it, so the stage keeps its whole width — the same predicate `WindowShell`
       draws it with. */
    windowWidth(1000)
    const { container } = mount({ stateOver: { pane: 'marginalia' } })

    const whole = gridFor(1000 - STAGE_PADDING_X * 2)
    expect(track(container, '--track-margin')).toBe(`${whole.marginCol}px`)
    expect(handedOver()['pageMargins']).toBe(pageMargins(whole))
  })

  it('opens the margin column only once a mark belongs in it', () => {
    windowWidth(1400)
    const noted = {
      ...marks(),
      current: [{ id: 'mk1', cfi: 'epubcfi(/6/4!/4/2)', kind: 'highlight', note: 'a note', text: 'gams' }],
    } as unknown as MarksView
    const { container, rerender } = mount()

    expect(track(container, '--track-margin')).toBe(`${gridFor(1400 - STAGE_PADDING_X * 2).marginCol}px`)

    rerender(reader({ marks: noted }))

    expect(track(container, '--track-margin')).toBe(
      `${gridFor(1400 - STAGE_PADDING_X * 2, true).marginCol}px`,
    )
    // Non-vacuity: a collapsed column and an open one are different widths.
    expect(gridFor(1376).marginCol).not.toBe(gridFor(1376, true).marginCol)
  })
})

/**
 * A wheel gesture or a swipe, which is `wheelPaging`'s policy half — the guards
 * live here because only the screen knows all three facts they turn on.
 */
describe('a gesture that turns the page', () => {
  const turn = (intent: string) => {
    const onPageIntent = handedOver()['onPageIntent'] as (intent: string) => void
    act(() => onPageIntent(intent))
  }

  /** Every way the book can be moved, and how often each was asked for. */
  const moves = (open: Book) => ({
    left: (open.goLeft as ReturnType<typeof vi.fn>).mock.calls.length,
    right: (open.goRight as ReturnType<typeof vi.fn>).mock.calls.length,
    next: (open.next as ReturnType<typeof vi.fn>).mock.calls.length,
    prev: (open.prev as ReturnType<typeof vi.fn>).mock.calls.length,
  })

  const paged = { pageLayout: 'paginated' } as Partial<AppState>

  it('sends a sideways gesture to the side the reader pushed', () => {
    const open = book()
    const held = marking()
    mount({ bookOver: open as unknown as Record<string, unknown>, marking: held, stateOver: paged })

    turn('left')

    expect(moves(open)).toEqual({ left: 1, right: 0, next: 0, prev: 0 })
    /* The toolbar is anchored to a passage on the page being left, so the
       teardown is unconditional — the book's selection and React's both. */
    expect(open.deselect).toHaveBeenCalledTimes(1)
    expect(held.setSelection).toHaveBeenCalledWith(null)
  })

  it('sends the other side to the other side', () => {
    const open = book()
    mount({ bookOver: open as unknown as Record<string, unknown>, stateOver: paged })

    turn('right')

    expect(moves(open)).toEqual({ left: 0, right: 1, next: 0, prev: 0 })
  })

  it('sends a vertical gesture through the book, never to a side', () => {
    /* A SIDE is resolved by foliate against the book's own direction; a
       DIRECTION OF TRAVEL must not be, or the wheel reverses in a
       right-to-left book. */
    const open = book()
    mount({ bookOver: open as unknown as Record<string, unknown>, stateOver: paged })

    turn('next')
    expect(moves(open)).toEqual({ left: 0, right: 0, next: 1, prev: 0 })

    turn('prev')
    expect(moves(open)).toEqual({ left: 0, right: 0, next: 1, prev: 1 })
  })

  it('refuses a gesture in scrolled flow, where there is no page to turn', () => {
    const open = book()
    mount({ bookOver: open as unknown as Record<string, unknown>, stateOver: { pageLayout: 'scrolled' } })

    turn('left')

    expect(moves(open)).toEqual({ left: 0, right: 0, next: 0, prev: 0 })
    expect(open.deselect).not.toHaveBeenCalled()
  })

  it('takes one in a fixed-layout book whichever flow the setting names', () => {
    /* `foliate-fxl` never reads `flow`; the setting reaches it as `zoom`, so a
       PDF is paged in one mode and scrolled in the other. Asking the setting
       alone dropped every PDF gesture. */
    const open = { ...book(), fixedLayout: true } as unknown as Book
    mount({
      bookOver: open as unknown as Record<string, unknown>,
      stateOver: { pageLayout: 'scrolled' },
    })

    turn('left')

    expect(moves(open)).toEqual({ left: 1, right: 0, next: 0, prev: 0 })
  })

  it('refuses one while another screen has the reader', () => {
    const open = book()
    mount({
      bookOver: open as unknown as Record<string, unknown>,
      stateOver: { ...paged, screen: 'library' },
    })

    turn('left')

    expect(moves(open)).toEqual({ left: 0, right: 0, next: 0, prev: 0 })
  })

  it('refuses one while the pane is a sheet over the book, and takes one beside it', () => {
    /* #207: the reader and App assembled this differently, so below §06's
       threshold a wheel was refused and an arrow key turned the page under the
       sheet. One question now, asked here with the width this screen measured. */
    windowWidth(1000)
    const covered = book()
    mount({
      bookOver: covered as unknown as Record<string, unknown>,
      stateOver: { ...paged, pane: 'marginalia' },
    })
    turn('left')
    expect(moves(covered)).toEqual({ left: 0, right: 0, next: 0, prev: 0 })

    cleanup()
    windowWidth(1280)
    const beside = book()
    mount({
      bookOver: beside as unknown as Record<string, unknown>,
      stateOver: { ...paged, pane: 'marginalia' },
    })
    turn('left')
    expect(moves(beside)).toEqual({ left: 1, right: 0, next: 0, prev: 0 })
  })

  it('answers the flow the reader is in now, not the one they opened in', () => {
    const open = book()
    const { rerender } = mount({
      bookOver: open as unknown as Record<string, unknown>,
      stateOver: { pageLayout: 'scrolled' },
    })

    rerender(reader({ bookOver: open as unknown as Record<string, unknown>, stateOver: paged }))
    turn('left')

    expect(moves(open)).toEqual({ left: 1, right: 0, next: 0, prev: 0 })
  })
})

describe('the chevrons beside the page', () => {
  const paged = { pageLayout: 'paginated' } as Partial<AppState>

  it('turns the page to the side each one names', () => {
    const open = book()
    mount({ bookOver: open as unknown as Record<string, unknown>, stateOver: paged })

    fireEvent.click(screen.getByRole('button', { name: 'Page to the left' }))
    expect(open.goLeft).toHaveBeenCalledTimes(1)
    expect(open.goRight).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Page to the right' }))
    expect(open.goRight).toHaveBeenCalledTimes(1)
    expect(open.goLeft).toHaveBeenCalledTimes(1)
  })

  it('keeps both out of the tab order, so the arrow keys keep working', () => {
    mount({ stateOver: paged })

    for (const name of ['Page to the left', 'Page to the right']) {
      expect(screen.getByRole('button', { name }).getAttribute('tabindex')).toBe('-1')
    }
  })

  it('is drawn only where the page it describes is really there', () => {
    /* Reflowable and paged. `--page-margin` comes off the prose grid and
       `foliate-fxl` reads none of it, so on a PDF these lanes describe a page
       that is not there. */
    const { rerender } = mount({ stateOver: { pageLayout: 'scrolled' } })
    expect(screen.queryByRole('button', { name: 'Page to the left' })).toBeNull()

    rerender(reader({ stateOver: paged, bookOver: { fixedLayout: true } }))
    expect(screen.queryByRole('button', { name: 'Page to the left' })).toBeNull()

    rerender(reader({ stateOver: paged }))
    expect(screen.getByRole('button', { name: 'Page to the left' })).toBeTruthy()
  })
})

describe('what the renderer is told about the book', () => {
  it('animates a page turn unless the reader asked for less movement', () => {
    const { rerender } = mount({ reducedMotion: false })
    expect(handedOver()['animated']).toBe(true)

    rerender(reader({ reducedMotion: true }))
    expect(handedOver()['animated']).toBe(false)
  })

  it('paginates in paged flow and not in scrolled', () => {
    const { rerender } = mount({ stateOver: { pageLayout: 'paginated' } })
    expect(handedOver()['paginated']).toBe(true)

    rerender(reader({ stateOver: { pageLayout: 'scrolled' } }))
    expect(handedOver()['paginated']).toBe(false)
  })

  it('hands over the passages other readers shared, and says nothing at all without them', () => {
    /* SPREAD RATHER THAN PASSED: a host with no circle capability must hand
       the reader what it handed it before, not an explicit `undefined`. */
    mount()
    expect('overlays' in handedOver()).toBe(false)

    cleanup()
    const shared = [] as readonly never[]
    mount({ overlays: shared })
    expect(handedOver()['overlays']).toBe(shared)
  })
})

describe('the rule down the edge of the page', () => {
  const rule = () => document.querySelector(`.${styles.progressTrack}`)
  const fill = () => document.querySelector(`.${styles.progressFill}`)

  it('is drawn when the reader asked for it, and not otherwise', () => {
    const { rerender } = mount({ stateOver: { progressLineOn: true } })
    expect(rule()).not.toBeNull()

    rerender(reader({ stateOver: { progressLineOn: false } }))
    expect(rule()).toBeNull()
  })

  it('is not drawn for a book with no accent to draw it in', () => {
    // `bookAccent` is null until the book has an id — nothing to colour with.
    mount({ stateOver: { progressLineOn: true }, bookOver: { bookId: null } })

    expect(rule()).toBeNull()
  })

  it('fills to how far through the book the reader is', () => {
    mount({
      stateOver: { progressLineOn: true },
      bookOver: { position: { ...book().position, fraction: 0.25 } },
    })

    expect((fill() as HTMLElement).style.height).toBe('25%')
  })

  it('takes the book’s own accent, and the night one at night', () => {
    /** The colour as jsdom normalises it, so the two can be compared at all. */
    const asDrawn = (colour: string | null) => {
      const probe = document.createElement('div')
      probe.style.background = colour ?? ''
      return probe.style.background
    }
    const { rerender } = mount({ stateOver: { progressLineOn: true, theme: 'paper' } })
    expect((fill() as HTMLElement).style.background).toBe(asDrawn(bookAccent('book:moby', false)))

    rerender(reader({ stateOver: { progressLineOn: true, theme: 'night' } }))
    expect((fill() as HTMLElement).style.background).toBe(asDrawn(bookAccent('book:moby', true)))
    // Non-vacuity: the two accents are different colours.
    expect(asDrawn(bookAccent('book:moby', true))).not.toBe(asDrawn(bookAccent('book:moby', false)))
  })

  it('sits on the edge the pane is not on', () => {
    const { rerender } = mount({ stateOver: { progressLineOn: true, side: 'right' } })
    expect(rule()?.getAttribute('data-edge')).toBe('start')

    rerender(reader({ stateOver: { progressLineOn: true, side: 'left' } }))
    expect(rule()?.getAttribute('data-edge')).toBe('end')
  })
})

describe('the footer under the page', () => {
  const footer = () => {
    const found = document.querySelector(`.${styles.footer}`)
    if (!(found instanceof HTMLElement)) throw new Error('the reader drew no footer')
    return found
  }

  it.each([
    [0.5, '50%'],
    [1.4, '100%'],
    [-0.3, '0%'],
    [Number.NaN, '0%'],
  ])('reports %s of the book as %s', (fraction, said) => {
    mount({ bookOver: { position: { ...book().position, fraction } } })

    expect(footer().textContent).toBe(`Loomings·${said}`)
  })

  it('drops the dot with the chapter it separates', () => {
    mount({ bookOver: { position: { ...book().position, chapterLabel: '', fraction: 0.5 } } })

    expect(footer().textContent).toBe('50%')
  })

  it('sets the percentage in figures that do not jog as it counts', () => {
    mount()

    const percent = footer().querySelector('span[style]')
    expect((percent as HTMLElement).style.fontVariantNumeric).toBe('tabular-nums')
  })

  it.each([
    ['the reader asked for the chrome', { chromeOn: true, pane: null }, true],
    ['a pane is open beside it', { chromeOn: false, pane: 'marginalia' }, true],
    ['neither', { chromeOn: false, pane: null }, false],
  ])('is shown when %s', (_case, stateOver, shown) => {
    mount({ stateOver: stateOver as Partial<AppState> })

    expect(footer().style.opacity).toBe(shown ? '1' : '0')
    expect(footer().dataset['visible']).toBe(String(shown))
    /* AND ITS FOCUS: `pointer-events: none` stops the mouse and nothing else,
       so Tab walked into an invisible control that acted when pressed. */
    expect(footer().hasAttribute('inert')).toBe(!shown)
  })
})

describe('the bookmark control', () => {
  const toggle = (name: string) => screen.getByRole('button', { name })

  it('says which of the two things pressing it does', () => {
    const { rerender } = mount()
    const place = toggle('Bookmark this place')
    expect(place.getAttribute('aria-pressed')).toBe('false')
    expect(place.querySelector('svg')?.getAttribute('fill')).toBe('none')

    rerender(reader({ bookmarking: { ...bookmarking(), here: { id: 'bm1' } } as unknown as Bookmarking }))

    const remove = toggle('Remove this bookmark')
    expect(remove.getAttribute('aria-pressed')).toBe('true')
    expect(remove.querySelector('svg')?.getAttribute('fill')).toBe('currentColor')
  })

  it('keeps the place when it is pressed', () => {
    const keeping = bookmarking()
    mount({ bookmarking: keeping })

    fireEvent.click(toggle('Bookmark this place'))

    expect(keeping.toggle).toHaveBeenCalledTimes(1)
  })

  it('is unavailable until the renderer has reported a position', () => {
    /* Disabled rather than absent: a control that disappears for a second on
       every book open is worse than one that is briefly unavailable. */
    const { rerender } = mount({
      bookmarking: { ...bookmarking(), canBookmark: false } as unknown as Bookmarking,
    })
    expect((toggle('Bookmark this place') as HTMLButtonElement).disabled).toBe(true)

    rerender(reader())
    expect((toggle('Bookmark this place') as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('the ribbon on a kept page', () => {
  const ribbon = () => document.querySelector(`.${styles.ribbon}`)
  const kept = { ...bookmarking(), here: { id: 'bm1' } } as unknown as Bookmarking

  it('is drawn on the page that is kept, in the book’s own direction', () => {
    mount({ bookmarking: kept, bookOver: { direction: 'rtl' } })

    /* THE BOOK'S DIRECTION, NOT THE APP'S: `inset-inline-end` resolves against
       whatever the element inherits, which is the shell's LTR. */
    expect(ribbon()?.getAttribute('dir')).toBe('rtl')
  })

  it('is not drawn on a page that is not kept', () => {
    mount()

    expect(ribbon()).toBeNull()
  })

  it('is not drawn on a fixed-layout page, whose corner it cannot find', () => {
    mount({ bookmarking: kept, bookOver: { fixedLayout: true } })

    expect(ribbon()).toBeNull()
  })
})

/**
 * A live selection the popup can be drawn over — `Reader.notice.test.tsx`'s
 * scene, and its reasoning: jsdom lays nothing out, so every element answers as
 * a 1000×800 box at the origin and the selected line is given one of its own.
 */
function box(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect
}

const frame = {
  getBoundingClientRect: () => box(0, 0, 1000, 800),
  offsetWidth: 1000,
  offsetHeight: 800,
}
const bookView = { frameElement: frame, addEventListener() {}, removeEventListener() {} }
const bookDoc = { defaultView: bookView, body: null } as unknown as Document

/** A range in the book's document, on its own line. */
function rangeAt(top: number): Range {
  return {
    startContainer: { ownerDocument: bookDoc },
    getClientRects: () => [box(400, top, 200, 20)],
  } as unknown as Range
}

function selecting(over: Partial<Record<keyof Marking, unknown>> = {}): Marking {
  const selection: SelectionSnapshot = {
    cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:4)',
    sectionIndex: 0,
    text: 'gams',
    prefix: '',
    suffix: '',
    range: rangeAt(300),
  }
  return { ...marking(), selection, canMark: true, ...over } as unknown as Marking
}

describe('the passage in hand', () => {
  /** Every clipboard write asked for, each settled by the case. */
  let writes: { readonly resolve: () => void; readonly reject: (cause: unknown) => void }[]
  let written: string[]

  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() =>
      box(0, 0, 1000, 800),
    )
    writes = []
    written = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) =>
          new Promise<void>((resolve, reject) => {
            written.push(text)
            writes.push({ resolve, reject })
          }),
      },
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  const markButton = () => screen.getByRole('button', { name: /^Mark this passage — / })
  const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

  it('lays down the appearance the app is set to, and remembers it', () => {
    const dispatch = vi.fn()
    const mark = vi.fn(() => ({ id: 'mk1' }))
    mount({ dispatch, marking: selecting({ mark }) })

    fireEvent.click(markButton())

    /* Acted on with the value the popup passed, and dispatched so the next
       passage takes the same appearance. */
    expect(mark).toHaveBeenCalledWith('', { tint: 'yellow', style: 'fill' }, false)
    expect(dispatch).toHaveBeenCalledWith({ type: 'setMarkTint', tint: 'yellow' })
    expect(dispatch).toHaveBeenCalledWith({ type: 'setMarkStyle', style: 'fill' })
    // A mark that was made says nothing at all.
    expect(screen.queryByText('That passage could not be marked.')).toBeNull()
  })

  it('lays down the appearance the app has moved to since it opened', () => {
    const mark = vi.fn(() => ({ id: 'mk1' }))
    const held = selecting({ mark })
    const { rerender } = mount({ marking: held })

    rerender(reader({ marking: held, stateOver: { markTint: 'green', markStyle: 'wave' } }))
    fireEvent.click(markButton())

    expect(mark).toHaveBeenCalledWith('', { tint: 'green', style: 'wave' }, false)
  })

  it('keeps the note a marked passage already carries', () => {
    /* Re-marking must not empty the note that belongs to the passage. */
    const mark = vi.fn(() => ({ id: 'mk1' }))
    const selected = { id: 'mk1', kind: 'highlight', tint: 'purple', style: 'fill', note: 'a note' }
    mount({ marking: selecting({ mark, selected }) })

    fireEvent.click(markButton())

    expect(mark).toHaveBeenCalledWith('a note', { tint: 'purple', style: 'fill' }, false)
  })

  it('copies the passage, and takes the selection down with it', () => {
    const open = book()
    const held = selecting()
    mount({ bookOver: open as unknown as Record<string, unknown>, marking: held })

    press('Copy this passage')

    expect(written).toEqual(['gams'])
    expect(open.deselect).toHaveBeenCalledTimes(1)
    expect(held.setSelection).toHaveBeenCalledWith(null)
  })

  it('copies through the teardown the book has now, not the one it opened with', () => {
    /* `clearSelection` is rebuilt when the book's own `deselect` changes; a
       callback that outlived its book cleared a selection in the previous one. */
    const held = selecting()
    const next = book()
    const { rerender } = mount({ marking: held })

    rerender(reader({ marking: held, bookOver: next as unknown as Record<string, unknown> }))
    press('Copy this passage')

    expect(next.deselect).toHaveBeenCalledTimes(1)
  })

  it('does not reach for the clipboard with nothing to put on it', () => {
    mount({ marking: selecting({ selection: { ...selecting().selection, text: '' } }) })

    press('Copy this passage')

    expect(written).toEqual([])
  })

  it('copies the passage with its book, author and place', () => {
    mount({
      marking: selecting(),
      bookOver: {
        meta: { title: 'Moby-Dick', author: 'Herman Melville', pageCount: 0 },
        position: { ...book().position, fraction: 0.31 },
      },
    })

    press('More ways to copy this passage')
    press('Copy the passage with its book, author and place')

    expect(written).toEqual(['“gams”\n\n— Herman Melville, Moby-Dick, Loomings'])
  })

  it('cites a book that has pages by its page, counted from one', () => {
    /* `makePdf` builds one section per page, so the page is the section index
       plus one — and only for a book that has pages at all. */
    mount({
      marking: selecting({ selection: { ...selecting().selection, sectionIndex: 3 } }),
      bookOver: { meta: { title: 'Moby-Dick', author: 'Herman Melville', pageCount: 12 } },
    })

    press('More ways to copy this passage')
    press('Copy the passage with its book, author and place')

    expect(written).toEqual(['“gams”\n\n— Herman Melville, Moby-Dick, p. 4'])
  })

  it('cites a book that declares neither title nor author by its chapter', () => {
    mount({ marking: selecting(), bookOver: { meta: null } })

    press('More ways to copy this passage')
    press('Copy the passage with its book, author and place')

    expect(written).toEqual(['“gams”\n\n— Loomings'])
  })

  it('cites the book as it is now, not as it opened', () => {
    /* A book's metadata arrives after it opens — `onMeta` fires once foliate
       has read it — so a citation built from the open is built from nothing. */
    const held = selecting()
    const { rerender } = mount({ marking: held, bookOver: { meta: null } })

    rerender(
      reader({
        marking: held,
        bookOver: { meta: { title: 'Moby-Dick', author: 'Herman Melville', pageCount: 0 } },
      }),
    )
    press('More ways to copy this passage')
    press('Copy the passage with its book, author and place')

    expect(written).toEqual(['“gams”\n\n— Herman Melville, Moby-Dick, Loomings'])
  })

  it('takes a mark off the passage, and the selection with it', () => {
    const open = book()
    const unmark = vi.fn()
    const selected = { id: 'mk1', kind: 'highlight', tint: 'yellow', style: 'fill', note: '' }
    mount({
      bookOver: open as unknown as Record<string, unknown>,
      marking: selecting({ unmark, selected }),
    })

    press('Remove this mark')

    expect(unmark).toHaveBeenCalledWith(selected)
    expect(open.deselect).toHaveBeenCalledTimes(1)
  })

  it('writes a note on the passage it just marked, and not on the one it did not', () => {
    const open = book()
    const dispatch = vi.fn()
    const focusMark = vi.fn()
    const mark = vi.fn(() => ({ id: 'mk2' }))
    mount({
      dispatch,
      bookOver: open as unknown as Record<string, unknown>,
      marking: selecting({ mark, focusMark }),
    })

    press('Write a note on this passage')

    /* The mark is what gives the note its anchor, and it is made with nothing
       written on it — the note itself is written in the panel. */
    expect(mark).toHaveBeenCalledWith('', { tint: 'yellow', style: 'fill' })
    expect(focusMark).toHaveBeenCalledWith('mk2', true)
    expect(dispatch).toHaveBeenCalledWith({ type: 'openPane', pane: 'marginalia' })
  })

  it('opens Notes on the mark a marked passage already has, without re-marking it', () => {
    /* Re-marking here would lay the LAST-USED appearance over the one the
       passage is already wearing, on the way to writing a note about it. */
    const open = book()
    const mark = vi.fn()
    const focusMark = vi.fn()
    const selected = { id: 'mk3', kind: 'highlight', tint: 'green', style: 'fill', note: '' }
    mount({
      bookOver: open as unknown as Record<string, unknown>,
      marking: selecting({ mark, focusMark, selected }),
    })

    press('Write a note on this passage')

    expect(mark).not.toHaveBeenCalled()
    expect(focusMark).toHaveBeenCalledWith('mk3', true)
    expect(open.deselect).toHaveBeenCalledTimes(1)
  })

  it('reaches the panel the app has now, not the one it opened with', () => {
    const held = selecting({ mark: vi.fn(() => ({ id: 'mk4' })) })
    const later = vi.fn()
    const { rerender } = mount({ dispatch: vi.fn(), marking: held })

    rerender(reader({ dispatch: later, marking: held }))
    press('Write a note on this passage')

    expect(later).toHaveBeenCalledWith({ type: 'openPane', pane: 'marginalia' })
  })

  /**
   * The clipboard's three outcomes, and which of them the reader is told about.
   */
  describe('and the clipboard', () => {
    const settle = async (at: number, how: 'works' | 'refused') => {
      await act(async () => {
        const write = writes[at]
        if (!write) throw new Error(`no clipboard write #${at} was asked for`)
        if (how === 'works') write.resolve()
        else write.reject(new Error('NotAllowedError'))
        await new Promise((done) => setTimeout(done, 0))
      })
    }
    const absent = 'This device has no clipboard available.'

    it('says so on a device that has none at all', async () => {
      Reflect.deleteProperty(navigator, 'clipboard')
      mount({ marking: selecting() })

      press('Copy this passage')
      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.getByText(absent)).toBeTruthy()
    })

    it('takes that down again once a copy works', async () => {
      Reflect.deleteProperty(navigator, 'clipboard')
      const held = selecting()
      const { rerender } = mount({ marking: held })
      press('Copy this passage')
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getByText(absent)).toBeTruthy()

      /* The same device with a clipboard again — a web client that has just
         been granted one. The notice is about the copy, so the copy clears it. */
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (text: string) =>
            new Promise<void>((resolve, reject) => {
              written.push(text)
              writes.push({ resolve, reject })
            }),
        },
      })
      rerender(reader({ marking: held }))
      press('Copy this passage')
      await settle(0, 'works')

      expect(screen.queryByText(absent)).toBeNull()
    })

    it('can be told to take a failure away', async () => {
      mount({ marking: selecting() })
      press('Copy this passage')
      await settle(0, 'refused')
      expect(screen.getByText('That could not be copied to the clipboard.')).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

      expect(screen.queryByText('That could not be copied to the clipboard.')).toBeNull()
    })

    it('leaves a copy from the last book with it, even beside one made in this', async () => {
      /* ON THE GENERATION: a copy still in flight when the book changed
         reported into the next book's screen. The counter has to move far
         enough that the old attempt can never match the new one again. */
      const held = selecting()
      const { rerender } = mount({ marking: held, bookOver: { generation: 1 } })
      press('Copy this passage')

      rerender(reader({ marking: held, bookOver: { generation: 2 } }))
      press('Copy this passage')

      await settle(0, 'refused')
      expect(
        screen.queryByText('That could not be copied to the clipboard.'),
        'the last book’s refusal reported into the next',
      ).toBeNull()
    })

  })

  /* The slot holds one failure of each KIND apart, so a mark that was made
     clears the mark's failure and says nothing about anybody else's. */
  it('says a mark that failed and clears it when the next one is made', () => {
    const mark = vi.fn(() => null)
    const held = selecting({ mark })
    const { rerender } = mount({ marking: held })
    fireEvent.click(markButton())
    expect(screen.getByText('That passage could not be marked.')).toBeTruthy()

    rerender(reader({ marking: selecting({ mark: vi.fn(() => ({ id: 'mk5' })) }) }))
    fireEvent.click(markButton())

    expect(screen.queryByText('That passage could not be marked.')).toBeNull()
  })
})

describe('the margin', () => {
  const noted = (note: string) =>
    ({
      ...marks(),
      current: [
        { id: 'mk1', cfi: 'ch1', kind: 'highlight', tint: 'yellow', style: 'fill', note, text: 'gams' },
      ],
    }) as unknown as MarksView

  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() =>
      box(0, 0, 1000, 800),
    )
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows a note in Notes when it is clicked, without opening its editor', () => {
    /* Clicking a note in the margin is going there to READ it; the editor
       opens only for the note route, which made the mark to write on. */
    const dispatch = vi.fn()
    const focusMark = vi.fn()
    mount({
      dispatch,
      marks: noted('a note'),
      marking: { ...marking(), focusMark, ranges: new Map([['ch1', rangeAt(120)]]) } as unknown as Marking,
      bookOver: { doc: bookDoc },
    })

    fireEvent.click(screen.getByRole('button', { name: /a note/ }))

    expect(focusMark).toHaveBeenCalledWith('mk1', false)
    expect(dispatch).toHaveBeenCalledWith({ type: 'openPane', pane: 'marginalia' })
  })

  it('has no column at all when nothing belongs in it', () => {
    // A highlight with no note stays on the page; the track collapses.
    mount({
      marks: noted(''),
      marking: { ...marking(), ranges: new Map([['ch1', rangeAt(120)]]) } as unknown as Marking,
      bookOver: { doc: bookDoc },
    })

    expect(document.querySelector(`.${styles.margin}`)).toBeNull()
  })
})

describe('the note the reader followed', () => {
  const note = {
    view: { renderer: { getContents: () => [{ doc: { body: { scrollHeight: 40 } } }] } },
    href: '#n1',
    type: 'footnote',
    at: null,
  } as unknown as FootnoteRender

  it('closes on the host’s word', () => {
    const onDismissFootnote = vi.fn()
    mount({ footnote: note, onDismissFootnote })

    fireEvent.click(screen.getByRole('button', { name: 'Close this note', hidden: true }))

    expect(onDismissFootnote).toHaveBeenCalledTimes(1)
  })

  it('closes quietly for a host that gave no way to close it', () => {
    /* Optional at both ends — the browser client mounts the popover without
       one — so a press must be a no-op rather than a TypeError nothing
       catches. React reports an uncaught handler error to the window. */
    const raised: unknown[] = []
    const onError = (event: ErrorEvent) => {
      raised.push(event.error)
      event.preventDefault()
    }
    window.addEventListener('error', onError)
    try {
      mount({ footnote: note })
      fireEvent.click(screen.getByRole('button', { name: 'Close this note', hidden: true }))
    } finally {
      window.removeEventListener('error', onError)
    }

    expect(raised).toEqual([])
  })
})

describe('leaving the reader', () => {
  it('takes the selection with it when another screen is layered over', () => {
    /* The screen stays MOUNTED under the library so foliate is not torn down,
       and the popup sits on §12's popover layer — so a passage left behind put
       a toolbar over the covers. */
    const open = book()
    const held = selecting()
    const { rerender } = mount({ bookOver: open as unknown as Record<string, unknown>, marking: held })
    expect(open.deselect).not.toHaveBeenCalled()

    rerender(
      reader({ bookOver: open as unknown as Record<string, unknown>, marking: held, inert: true }),
    )

    expect(open.deselect).toHaveBeenCalledTimes(1)
    expect(held.setSelection).toHaveBeenCalledWith(null)
  })

  it('is in the focus order until it is', () => {
    const { container, rerender } = mount()
    expect((container.firstChild as HTMLElement).hasAttribute('inert')).toBe(false)

    rerender(reader({ inert: true }))

    expect((container.firstChild as HTMLElement).hasAttribute('inert')).toBe(true)
  })
})

describe('the way back from a jump', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const back = () => screen.queryByRole('button', { name: /← Back to/ })

  it('offers the chapter the reader left, and the key that does the same', () => {
    const onReturn = vi.fn()
    mount({ returnTo: { label: 'Loomings', nonce: 1 }, onReturn })

    const line = back()
    expect(line?.textContent).toBe('← Back to Loomings')
    fireEvent.click(line as HTMLElement)
    expect(onReturn).toHaveBeenCalledTimes(1)
    expect(screen.getByText('⌘[')).toBeTruthy()
  })

  it('spells that key the way the platform does', () => {
    mount({ returnTo: { label: 'Loomings', nonce: 1 }, onReturn: vi.fn(), platform: 'windows' })

    expect(screen.getByText('Ctrl+[')).toBeTruthy()
  })

  it('is not drawn where there is nowhere to go back to', () => {
    const { rerender } = mount({ returnTo: null, onReturn: vi.fn() })
    expect(back()).toBeNull()

    // Nor with a place and no way to go there.
    rerender(reader({ returnTo: { label: 'Loomings', nonce: 1 } }))
    expect(back()).toBeNull()
  })

  it('fades on its own, and a second jump out of one chapter is a second line', () => {
    /* THE NONCE IS NOT DECORATION: two jumps out of one chapter carry the same
       label, so a timer keyed on the text inherits the first one's deadline. */
    const onReturnDone = vi.fn()
    const { rerender } = mount({
      returnTo: { label: 'Loomings', nonce: 1 },
      onReturn: vi.fn(),
      onReturnDone,
    })

    act(() => {
      vi.advanceTimersByTime(5999)
    })
    expect(onReturnDone).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(onReturnDone).toHaveBeenCalledTimes(1)

    rerender(
      reader({ returnTo: { label: 'Loomings', nonce: 2 }, onReturn: vi.fn(), onReturnDone }),
    )
    act(() => {
      vi.advanceTimersByTime(6000)
    })
    expect(onReturnDone).toHaveBeenCalledTimes(2)
  })

  it('sets no timer at all with no hint up', () => {
    const onReturnDone = vi.fn()
    mount({ returnTo: null, onReturnDone })

    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    expect(onReturnDone).not.toHaveBeenCalled()
  })
})

describe('a book that would not open', () => {
  it('says so instead of the reader, and offers another book', () => {
    const open = { ...book(), error: 'That book could not be opened.' } as unknown as Book
    mount({ bookOver: open as unknown as Record<string, unknown> })

    fireEvent.click(screen.getByRole('button', { name: 'Choose another book' }))

    expect(open.close).toHaveBeenCalledTimes(1)
  })
})

describe('with no book open', () => {
  const shut = { source: null }

  it('says a shelf with books on it is not empty', () => {
    /* The app boots to the reader, so relaunching Paper told a reader with ten
       books that they had none. */
    mount({ bookOver: shut, libraryCount: 3 })

    expect(screen.getByText('No book open')).toBeTruthy()
    expect(screen.getByText('Pick up where you left off, or drop a new book here.')).toBeTruthy()
  })

  it('offers the shelf, counted, and opens it', () => {
    const onOpenLibrary = vi.fn()
    const { rerender } = mount({ bookOver: shut, libraryCount: 3, onOpenLibrary })

    const open = screen.getByRole('button', { name: 'Open the library · 3 books' })
    fireEvent.click(open)
    expect(onOpenLibrary).toHaveBeenCalledTimes(1)

    rerender(reader({ bookOver: shut, libraryCount: 1, onOpenLibrary }))
    expect(screen.getByRole('button', { name: 'Open the library · 1 book' })).toBeTruthy()
  })

  it('offers no shelf at all when there is nothing on it', () => {
    mount({ bookOver: shut, libraryCount: 0 })

    expect(screen.queryByRole('button', { name: /^Open the library/ })).toBeNull()
    expect(screen.getByText('Your library is empty')).toBeTruthy()
    expect(
      screen.getByText('Drop an EPUB, PDF, MOBI or CBZ here, or add a folder of them.'),
    ).toBeTruthy()
  })

  it('does not call a shelf it could not read empty', () => {
    /* A failed read produces a count of zero, and saying the alarming thing on
       the strength of a transient error is what this message was rewritten to
       avoid. */
    mount({ bookOver: shut, libraryCount: 0, shelfUnread: true })

    expect(screen.getByText('Your library could not be read')).toBeTruthy()
    expect(
      screen.getByText('Nothing has been changed. Your books are still on disk — try reopening Paper.'),
    ).toBeTruthy()
  })

  it('leads with Add books only where there is no shelf to lead with', () => {
    const onAddBooks = vi.fn()
    const { rerender } = mount({ bookOver: shut, libraryCount: 0, onAddBooks })
    const add = screen.getByRole('button', { name: 'Add books' })
    expect(add.className).toBe(styles.primaryButton)
    fireEvent.click(add)
    expect(onAddBooks).toHaveBeenCalledTimes(1)

    rerender(reader({ bookOver: shut, libraryCount: 3, onAddBooks }))
    expect(screen.getByRole('button', { name: 'Add books' }).className).toBe(styles.secondaryButton)
  })

  it('says what went wrong with the book that would not open, in its own line', () => {
    const { container, rerender } = mount({ bookOver: shut, libraryCount: 3 })
    const quiet = container.querySelectorAll('p').length

    rerender(reader({ bookOver: { ...shut, error: 'That book could not be opened.' }, libraryCount: 3 }))

    expect(screen.getByText('That book could not be opened.').tagName).toBe('P')
    expect(container.querySelectorAll('p')).toHaveLength(quiet + 1)
  })
})

/**
 * A control is drawn only for a callback that exists — `FootNotice`'s rule. A
 * Dismiss that tells nobody is worse than none, and a Retry with no verb behind
 * it is a promise.
 */
describe('a notice at the foot of the column', () => {
  it('offers no Retry for a write it holds no verb for', () => {
    /* A capability writes through the store directly, and `useLibrary` cannot
       re-run that write — so there is nothing to press. */
    mount({
      saveFailure: { message: 'Couldn’t save “Moby-Dick”', retry: null },
      onDismissSaveFailure: vi.fn(),
    })

    expect(screen.getByText('Couldn’t save “Moby-Dick”')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  it('offers no Dismiss for a notice the host cannot take down', () => {
    mount({ importNotice: 'Added 3 marks and 0 cards across 1 book.' })

    expect(screen.getByText('Added 3 marks and 0 cards across 1 book.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })
})
