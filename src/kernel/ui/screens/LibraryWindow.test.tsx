// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Library } from './Library'
import { PREMEASURE, VIRTUALISE_ABOVE } from '../../core/virtualGrid'
import { moment, onFirstPaint } from '../devTiming'
import type { IndexedBook } from '../../core/bookIndex'

/**
 * THE WINDOW THE SHELF DRAWS, and the layout it reads to decide.
 *
 * `gridWindow` is pure arithmetic and has its own suite; what had none is the
 * half that feeds it — the row height read off the first cell and the
 * stylesheet's own gap, the column count taken from the resolved tracks rather
 * than divided out of a width, and the scroll position measured relative to the
 * shelf rather than to the box that scrolls. Every one of those has been wrong
 * once, and each is invisible in a browser: a row short at the bottom looks
 * like the end of the library, a column out looks like a scroll glitch.
 *
 * jsdom lays nothing out, so the layout is STUBBED — the offsets, the scroll
 * position and the two resolved properties this file reads. Nothing else about
 * the screen is faked: the effect, the observers and the listener are the real
 * ones, and the assertions are the cells the shelf actually renders and the
 * space it reserves for the ones it does not.
 */

/* The one collaborator that cannot answer under vitest: `devTiming` is off in a
   test run by its own rule (`import.meta.env.MODE !== 'test'`), so what the
   shelf reports about its first frame is unobservable without standing in for
   it. Nothing else in this tree imports it. */
vi.mock('../devTiming', () => ({ moment: vi.fn(), onFirstPaint: vi.fn() }))

afterEach(cleanup)

interface Watcher {
  readonly cb: ResizeObserverCallback
  readonly targets: Set<Element>
}
const watchers = new Set<Watcher>()
globalThis.ResizeObserver = class {
  cb: ResizeObserverCallback
  targets = new Set<Element>()
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
    watchers.add(this as unknown as Watcher)
  }
  observe(el: Element) {
    this.targets.add(el)
  }
  unobserve(el: Element) {
    this.targets.delete(el)
  }
  disconnect() {
    this.targets.clear()
    watchers.delete(this as unknown as Watcher)
  }
} as never

/** What the browser does when a box it is watching changes size. */
const resized = (el: Element) => {
  act(() => {
    for (const watcher of watchers) {
      if (watcher.targets.has(el)) watcher.cb([], watcher as unknown as ResizeObserver)
    }
  })
}

/* ── the stubbed layout ──────────────────────────────────────────────────── */

interface Box {
  offsetTop: number
  offsetHeight: number
  offsetWidth: number
  clientHeight: number
  scrollTop: number
}
const NOTHING: Box = { offsetTop: 0, offsetHeight: 0, offsetWidth: 0, clientHeight: 0, scrollTop: 0 }

let boxOf: (el: HTMLElement) => Box = () => NOTHING
for (const property of ['offsetTop', 'offsetHeight', 'offsetWidth', 'clientHeight', 'scrollTop'] as const) {
  Object.defineProperty(HTMLElement.prototype, property, {
    configurable: true,
    get(this: HTMLElement) {
      return boxOf(this)[property]
    },
  })
}

const isScroller = (el: HTMLElement) => el.hasAttribute('data-scroll')
const isRack = (el: HTMLElement) => el.parentElement !== null && isScroller(el.parentElement)
const isCell = (el: HTMLElement) => el.parentElement !== null && isRack(el.parentElement)

/** How many times the shelf has read the layout it is laid out in. */
let measures = 0
let tracks = '120px 120px  120px 120px'
let rowGap = '8px'
const realStyle = window.getComputedStyle.bind(window)
beforeEach(() => {
  vi.mocked(moment).mockClear()
  vi.mocked(onFirstPaint).mockClear()
  measures = 0
  tracks = '120px 120px  120px 120px'
  rowGap = '8px'
  vi.spyOn(window, 'getComputedStyle').mockImplementation(((el: Element, pseudo?: string | null) => {
    const style = realStyle(el, pseudo ?? undefined)
    if (!(el instanceof HTMLElement) || !isRack(el)) return style
    measures += 1
    return new Proxy(style, {
      get(target, key) {
        if (key === 'rowGap') return rowGap
        if (key === 'gridTemplateColumns') return tracks
        const value = Reflect.get(target, key) as unknown
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value
      },
    })
  }) as typeof window.getComputedStyle)
})

/**
 * A shelf inside a scroller, with a first cell to measure.
 *
 * The numbers are chosen so every arithmetic mistake this effect can make lands
 * on a different row: the shelf starts 110px below the scroller's own top, so
 * adding that offset instead of subtracting it moves the window more than a row.
 */
const laidOut = (over: Partial<{ cellHeight: number; cellWidth: number; scrollTop: number; viewport: number }> = {}) => {
  const { cellHeight = 192, cellWidth = 120, scrollTop = 0, viewport = 400 } = over
  boxOf = (el) => {
    if (isScroller(el)) return { ...NOTHING, offsetTop: 20, clientHeight: viewport, scrollTop }
    if (isRack(el)) return { ...NOTHING, offsetTop: 130 }
    if (isCell(el)) return { ...NOTHING, offsetHeight: cellHeight, offsetWidth: cellWidth }
    return NOTHING
  }
}

const book = (over: Partial<IndexedBook> = {}): IndexedBook =>
  ({ bookId: 'bk1', title: 'Bad Blood', author: 'Carreyrou, John', addedAt: 1, progress: 0.5, ...over }) as IndexedBook

/** A shelf of `count` books, newest first — so `Book 0` is at the top. */
const many = (count: number) =>
  Array.from({ length: count }, (_, at) => book({ bookId: `bk${at}`, title: `Book ${at}`, addedAt: count - at }))

const shelf = {
  books: many(80),
  platform: 'macos',
  onOpen: vi.fn(),
  importing: null,
  enriching: 0,
  importNotice: null,
  libraryQuery: '',
  onQueryChange: vi.fn(),
  bookActions: [],
  bookStatuses: [],
} as const

const rack = () => document.querySelector('[data-scroll] > div') as HTMLElement
const scroller = () => document.querySelector('[data-scroll]') as HTMLElement
const drawn = () =>
  [...document.querySelectorAll('[title^="Open "]')].map((el) => el.getAttribute('title')?.replace('Open ', ''))
const scrollTo = (to: number) => {
  laidOut({ scrollTop: to })
  act(() => {
    fireEvent.scroll(scroller())
  })
}

describe('a shelf too long to draw whole', () => {
  it('draws the rows near the viewport and reserves the space for the rest', () => {
    /* Four columns of 200px rows — 192px of cell and the stylesheet's 8px row
       gap — in a 400px viewport, so three rows are visible and two more are
       rendered above and below as warning. */
    laidOut()
    render(<Library {...shelf} />)
    expect(drawn().length, 'five rows of four').toBe(20)
    expect(drawn()[0]).toBe('Book 0')
    expect(rack().style.paddingBlockStart).toBe('0px')
    expect(rack().style.paddingBlockEnd, 'fifteen rows still to come').toBe('3000px')
  })

  it('moves the window with the scroller, in the shelf’s own coordinates', () => {
    /* The scroller's `scrollTop` counts from ITS top, which is 110px above the
       shelf's. Fed straight to the arithmetic it says the reader is further
       down the shelf than they are. */
    laidOut()
    render(<Library {...shelf} />)
    scrollTo(1120)
    expect(drawn().length).toBe(28)
    expect(drawn()[0], 'row three, four books to a row').toBe('Book 12')
    expect(rack().style.paddingBlockStart).toBe('600px')
    expect(rack().style.paddingBlockEnd).toBe('2000px')
  })

  it('never slices from the end when the scroller is above the shelf', () => {
    /* Clamped at zero: a shelf scrolled to the top is 110px ABOVE its own
       origin, and an unclamped position takes the window negative — which
       slices from the end of the array and puts the last books at the top. */
    laidOut({ scrollTop: 40 })
    render(<Library {...shelf} />)
    expect(drawn()[0]).toBe('Book 0')
    expect(drawn().length).toBe(20)
  })

  it('reads the row height from the gap the stylesheet actually uses', () => {
    /* Hardcoded to 24px once, against a stylesheet using something else: the
       row height was wrong by a few pixels a row, which is invisible near the
       top and selects the wrong rows entirely a few hundred books down. */
    laidOut()
    rowGap = '40px'
    render(<Library {...shelf} />)
    scrollTo(1120)
    expect(rack().style.paddingBlockStart, 'two rows of 232px').toBe('464px')
  })

  it('falls back to no gap when the stylesheet reports one it cannot read', () => {
    laidOut()
    rowGap = 'normal'
    render(<Library {...shelf} />)
    scrollTo(1120)
    expect(rack().style.paddingBlockStart, 'three rows of 192px').toBe('576px')
  })

  it('counts the columns the browser laid out, however the tracks are spaced', () => {
    /* THE BROWSER'S OWN ANSWER, not a width divided by a card: the old
       arithmetic counted six columns where CSS laid out five, and every slice
       past the threshold was off by a column per row. */
    laidOut()
    tracks = '120px 120px 120px 120px 120px'
    render(<Library {...shelf} />)
    expect(drawn().length, 'five to a row now').toBe(25)
    expect(drawn()[0]).toBe('Book 0')
  })

  it('renders a screenful and no more while the grid is still unmeasured', () => {
    /* A cell with no width has not been laid out yet. Rendering EVERYTHING for
       that frame mounted two thousand cells and started their cover loads, and
       an image request does not un-send when the measured render unmounts the
       cell. */
    laidOut({ cellWidth: 0, cellHeight: 0 })
    render(<Library {...shelf} />)
    expect(drawn().length).toBe(PREMEASURE)
  })

  it('keeps every book on a shelf small enough not to need a window', () => {
    laidOut()
    render(<Library {...shelf} books={many(VIRTUALISE_ABOVE)} />)
    expect(drawn().length).toBe(VIRTUALISE_ABOVE)
    expect(rack().style.paddingBlockStart, 'and reserves no space at all').toBe('')
  })

  it('asks the DOM nothing about scrolling until there is a window to place', () => {
    /* ⚠️ **THE LOOKUP IS WORK, and it was moved above the threshold check once
       on the grounds that the guard answered the same either way.** It does —
       after `closest` has walked the shelf's ancestors for a box the effect is
       about to decide it does not need. Below the threshold this screen asks
       the DOM nothing at all, and that is a branch a test can hold. */
    laidOut()
    const closest = vi.spyOn(Element.prototype, 'closest')
    try {
      const asked = () => closest.mock.calls.filter(([selector]) => selector === '[data-scroll]').length
      const { rerender } = render(<Library {...shelf} books={many(10)} />)
      expect(asked(), 'a shelf of ten has no window to place').toBe(0)

      rerender(<Library {...shelf} books={many(80)} />)
      expect(asked(), 'and asks once it has').toBeGreaterThan(0)
    } finally {
      closest.mockRestore()
    }
  })

  it('starts measuring when the shelf grows past the threshold', () => {
    laidOut()
    const { rerender } = render(<Library {...shelf} books={many(10)} />)
    expect(drawn().length).toBe(10)
    rerender(<Library {...shelf} books={many(80)} />)
    expect(drawn().length).toBe(20)
  })
})

describe('what the shelf watches while the window is open', () => {
  it('measures again when the shelf itself is resized', () => {
    laidOut()
    render(<Library {...shelf} />)
    laidOut({ cellHeight: 92 })
    resized(rack())
    /* 100px rows in a 400px viewport: four visible and two of warning below. */
    expect(drawn().length).toBe(28)
    expect(rack().style.paddingBlockEnd).toBe('1300px')
  })

  it('measures again when the SCROLLER is resized, which the shelf cannot feel', () => {
    /* The selection bar appears, the chips wrap onto a second line, the window
       itself grows. Observed only through the shelf, those left the height
       stale and the bottom of the newly exposed viewport unrendered. */
    laidOut()
    render(<Library {...shelf} />)
    expect(drawn().length).toBe(20)
    laidOut({ viewport: 1000 })
    resized(scroller())
    expect(drawn().length).toBe(32)
  })

  it('stops watching once the shelf no longer needs a window', () => {
    laidOut()
    const { rerender } = render(<Library {...shelf} />)
    rerender(<Library {...shelf} books={many(10)} />)
    measures = 0
    scrollTo(1120)
    resized(scroller())
    expect(measures, 'a layout read is a reflow — none of them is free').toBe(0)
  })

  it('stops watching when the shelf goes', () => {
    laidOut()
    const { unmount } = render(<Library {...shelf} />)
    const box = scroller()
    unmount()
    measures = 0
    fireEvent.scroll(box)
    expect(measures).toBe(0)
    expect(watchers.size, 'and disconnects what it was observing').toBe(0)
  })
})

describe('what the shelf reports about its first frame', () => {
  it('says what it cost, once, and says the window drew', () => {
    /* Three numbers that are usually assumed equal, and the first thing to
       check when the screen is slow: the library, what the scope leaves, and
       what this render actually handed to React. */
    laidOut()
    render(<Library {...shelf} libraryQuery="Book 1" />)
    expect(moment).toHaveBeenCalledTimes(1)
    expect(moment).toHaveBeenCalledWith('the shelf rendered', {
      library: 80,
      shelf: 11,
      cells: 11,
      virtualising: false,
    })
    expect(onFirstPaint).toHaveBeenCalledWith('the shelf drew its first frame')
  })

  it('says it once and not again, however much the shelf moves afterwards', () => {
    laidOut()
    render(<Library {...shelf} />)
    expect(moment).toHaveBeenCalledTimes(1)
    /* `cells` is the FIRST frame's, which is the unmeasured screenful — the
       measuring effect runs in the same commit and its viewport lands in the
       next one. That is the number worth having: it is what the first paint
       actually cost, and it is still nothing like the 80 a shelf that failed
       to virtualise would report. */
    expect(moment).toHaveBeenCalledWith('the shelf rendered', {
      library: 80,
      shelf: 80,
      cells: PREMEASURE,
      virtualising: true,
    })
    scrollTo(1120)
    expect(moment).toHaveBeenCalledTimes(1)
    expect(onFirstPaint).toHaveBeenCalledTimes(1)
  })
})
