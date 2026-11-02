// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { PaneContext } from '../../core/capability'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SidePane, type SidePaneProps } from './SidePane'
import { initialState, type AppState } from '../state'
import { createDiagnosticLog } from '../../core/diagnosticsLog'
import { offeredFaces } from '../../core/typefaces'
import type { Book, SearchHit } from '../hooks/useBook'
import type { MarksView } from '../hooks/useMarks'
import type { Bookmarking } from '../hooks/useBookmarking'
import type { TagPrefsStore } from '../hooks/useTagPrefs'

/**
 * WHAT THE SIDE PANE DOES, measured through what it draws and what it
 * dispatches.
 *
 * `SidePane.test.tsx` pins two wires the phase-20 audit found, and pins the
 * rail's rows by reading this component's source — which is why a mutation
 * sweep cannot run it against a mutated copy, and why the pane went unscored.
 * This file asks the same component, rendered, every question its code
 * answers: which panel a state shows, which tabs the rail offers and which one
 * is lit, what each panel is handed, and which action each control sends. It
 * reads no source text.
 */

/**
 * ⚠️ **EVERY ELEMENT HAS A BOX**, and in jsdom none of them do — so the
 * typeface menu's anchor always reads as detached and the menu shuts inside
 * the commit that opened it. `Settings.test.tsx` carries the same stub, for
 * the same reason.
 */
Element.prototype.getBoundingClientRect = function (): DOMRect {
  return { x: 40, y: 40, top: 40, left: 40, right: 140, bottom: 72, width: 100, height: 32, toJSON: () => ({}) } as DOMRect
}

beforeEach(() => {
  /* jsdom has no `ResizeObserver`; the typeface field measures itself. */
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const HIT: SearchHit = {
  cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:9)',
  label: 'Loomings',
  pre: 'Call me ',
  match: 'Ishmael',
  post: '.',
}

/** An open book with one chapter in its contents. */
const openBook = (over: Record<string, unknown> = {}): Book =>
  ({
    bookId: 'open-book',
    source: 'book.epub',
    meta: { title: 'Moby-Dick' },
    error: null,
    toc: [{ label: 'Loomings', href: 'ch1.xhtml' }],
    position: { fraction: 0, chapterLabel: 'Loomings', chapterHref: 'ch1.xhtml', cfi: null, sectionIndex: 0, sectionExact: true },
    search: async function* () {
      yield HIT
    },
    goTo: vi.fn(),
    ...over,
  }) as unknown as Book


const tagPrefs = (): TagPrefsStore => ({
  prefs: { pinned: [], colours: {}, hiddenSubjects: [], views: [] },
  persistent: true,
  togglePinned: vi.fn(),
  setColour: vi.fn(),
  toggleHidden: vi.fn(),
  saveView: vi.fn(),
  renameView: vi.fn(),
  removeView: vi.fn(),
})

/** The reader on Contents unless told otherwise. */
const stateOf = (over: Partial<AppState> = {}): AppState => ({
  ...initialState,
  screen: 'reader',
  pane: 'toc',
  lastPane: 'toc',
  ...over,
})

function propsOf(over: Partial<SidePaneProps> = {}): SidePaneProps {
  return {
    state: stateOf(),
    dispatch: vi.fn(),
    book: openBook(),
    marks: { all: [], current: [], bookmarks: [], allBookmarks: [], allUnplaced: [], persistent: true, ready: true, loadAll: vi.fn() } as unknown as MarksView,
    bookmarking: { remove: vi.fn() } as unknown as Bookmarking,
    platform: 'macos',
    onGoTo: vi.fn(),
    onDeleteMark: vi.fn(),
    markFocus: null,
    onMarkFocusDone: vi.fn(),
    books: [],
    library: {
      onRenameTag: vi.fn(),
      onRemoveTag: vi.fn(),
      tagPrefs: tagPrefs(),
      lastRemoval: null,
      onUndoRemoveTag: vi.fn(),
      onAdoptTag: vi.fn(),
      onTagBooks: vi.fn(),
    },
    settings: { offered: offeredFaces(new Set(['Literata'])), sections: [] },
    contributed: [],
    ...over,
  }
}

function draw(over: Partial<SidePaneProps> = {}) {
  const props = propsOf(over)
  const view = render(<SidePane {...props} />)
  return {
    ...view,
    props,
    dispatch: vi.mocked(props.dispatch),
    onGoTo: vi.mocked(props.onGoTo!),
    /** The same pane with some props changed — the host re-rendering it. */
    redraw: (next: Partial<SidePaneProps>) => view.rerender(<SidePane {...props} {...next} />),
  }
}

/** The rail's tabs, in order — the last thing the pane draws. */
const railOf = (container: HTMLElement): HTMLElement[] => within(container.lastElementChild as HTMLElement).getAllByRole('button')
const railNames = (container: HTMLElement): (string | null)[] => railOf(container).map((tab) => tab.getAttribute('aria-label'))

/** One thing only each panel draws, so a panel drawn beside another is seen. */
const MARKERS = {
  toc: () => screen.queryByRole('button', { name: 'Loomings' }),
  marginalia: () => screen.queryByText('Nothing kept yet'),
  search: () => screen.queryByLabelText('Search this book'),
  dev: () => screen.queryByText('Diagnostics are not being recorded'),
  settings: () => screen.queryByRole('switch', { name: 'Follow system appearance' }),
  library: () => screen.queryByText('All books'),
} as const
type Marked = keyof typeof MARKERS

function expectOnlyPanel(shown: Marked): void {
  for (const [pane, marker] of Object.entries(MARKERS)) {
    if (pane === shown) expect(marker(), `${pane} was not drawn`).not.toBeNull()
    else expect(marker(), `${pane} was drawn beside ${shown}`).toBeNull()
  }
}

describe('the panel a state shows', () => {
  it.each([
    ['toc', 'reader', 'Contents'],
    ['marginalia', 'reader', 'Marginalia'],
    ['search', 'reader', 'Search'],
    ['dev', 'reader', 'Developer'],
    ['settings', 'reader', 'Settings'],
    ['library', 'library', 'Library'],
  ] as const)('draws %s, and only %s, under its title', (pane, screenId, title) => {
    const { container } = draw({ state: stateOf({ screen: screenId, pane, lastPane: pane, developer: true }) })
    expectOnlyPanel(pane)
    expect(container.firstElementChild?.textContent).toBe(title)
  })

  /* The slot stays mounted while the pane is closed, so the panel the reader
     last had is the one kept warm. */
  it('keeps the last panel drawn while the pane is closed', () => {
    draw({ state: stateOf({ pane: null, lastPane: 'marginalia' }) })
    expectOnlyPanel('marginalia')
  })

  it('draws the panel asked for, not the one last open', () => {
    draw({ state: stateOf({ pane: 'search', lastPane: 'toc' }) })
    expectOnlyPanel('search')
  })

  it('draws the screen’s own default for a panel this reader is not offered', () => {
    draw({ state: stateOf({ pane: 'dev', lastPane: 'dev', developer: false }) })
    expectOnlyPanel('toc')
  })

  /* A contributed screen owns the whole window. */
  it('draws nothing at all over a contributed screen', () => {
    const { container } = draw({ state: stateOf({ screen: 'circle:home', pane: 'library', lastPane: 'library' }) })
    expect(container.innerHTML).toBe('')
  })
})

describe('the rail', () => {
  const friends = { id: 'circle:friends', label: 'Friends', icon: 'people', screens: ['library', 'reader'], render: () => <p>friends</p> } as unknown as SidePaneProps['contributed'][number]
  const publish = { id: 'public:book', label: 'Publish', icon: 'globe', screens: ['reader'], render: () => <p>publish</p> } as unknown as SidePaneProps['contributed'][number]

  it('offers the reader its finished panels, in rail order', () => {
    const { container } = draw()
    expect(railNames(container)).toEqual(['Contents', 'Marginalia', 'Search', 'Settings'])
  })

  it('adds Developer under developer options, in rail order', () => {
    const { container } = draw({ state: stateOf({ developer: true }) })
    expect(railNames(container)).toEqual(['Contents', 'Marginalia', 'Search', 'Settings', 'Developer'])
  })

  it('offers the library its own panels and none of the book’s', () => {
    const { container } = draw({ state: stateOf({ screen: 'library', pane: 'library', lastPane: 'library' }) })
    expect(railNames(container)).toEqual(['Marginalia', 'Library', 'Settings'])
  })

  it('leaves out a contributed panel that calls itself unfinished, until it is offered', () => {
    const contributed = [{ id: 'deck:panel', label: 'Deck', icon: 'globe', screens: ['reader'], unfinished: true, render: () => null }] as never
    const off = draw({ contributed })
    expect(railNames(off.container)).not.toContain('Deck')
    cleanup()
    const on = draw({ contributed, state: stateOf({ developer: true }) })
    expect(railNames(on.container)).toContain('Deck')
    cleanup()
    const hid = draw({ contributed, state: stateOf({ developer: true, hiddenPanes: ['deck:panel'] }) })
    expect(railNames(hid.container)).not.toContain('Deck')
  })

  it('puts a contributed pane after the kernel’s, only on the screens it fits', () => {
    const shelf = draw({ state: stateOf({ screen: 'library', pane: 'library', lastPane: 'library' }), contributed: [friends, publish] })
    expect(railNames(shelf.container)).toEqual(['Marginalia', 'Library', 'Settings', 'Friends'])
    cleanup()
    const reader = draw({ contributed: [friends, publish] })
    expect(railNames(reader.container)).toEqual(['Contents', 'Marginalia', 'Search', 'Settings', 'Friends', 'Publish'])
  })

  /* `data-on` is paint; `aria-pressed` is what a screen reader hears. */
  it('lights the shown panel’s tab and no other, in paint and aloud', () => {
    const { container } = draw({ state: stateOf({ pane: 'search', lastPane: 'search' }), contributed: [friends] })
    for (const tab of railOf(container)) {
      const lit = String(tab.getAttribute('aria-label') === 'Search')
      expect(tab.getAttribute('aria-pressed'), tab.getAttribute('aria-label') ?? '').toBe(lit)
      expect(tab.getAttribute('data-on'), tab.getAttribute('aria-label') ?? '').toBe(lit)
    }
  })

  it('opens the panel a tab names, a contributed one included', () => {
    const { container, dispatch } = draw({ contributed: [friends] })
    fireEvent.click(within(container.lastElementChild as HTMLElement).getByRole('button', { name: 'Marginalia' }))
    fireEvent.click(within(container.lastElementChild as HTMLElement).getByRole('button', { name: 'Friends' }))
    expect(dispatch.mock.calls).toEqual([[{ type: 'openPane', pane: 'marginalia' }], [{ type: 'openPane', pane: 'circle:friends' }]])
  })

  it('follows developer options, hidden panels, the screen and the composition as they change', () => {
    const { container, redraw } = draw()
    expect(railNames(container)).toEqual(['Contents', 'Marginalia', 'Search', 'Settings'])
    redraw({ state: stateOf({ developer: true }) })
    expect(railNames(container)).toEqual(['Contents', 'Marginalia', 'Search', 'Settings', 'Developer'])
    redraw({ state: stateOf({ developer: true, screen: 'library', pane: 'library', lastPane: 'library' }) })
    expect(railNames(container)).toEqual(['Marginalia', 'Library', 'Settings', 'Developer'])
    redraw({ state: stateOf({ developer: true, screen: 'library', pane: 'library', lastPane: 'library' }), contributed: [friends] })
    expect(railNames(container)).toEqual(['Marginalia', 'Library', 'Settings', 'Developer', 'Friends'])
  })
})

describe('a contributed panel', () => {
  it('is handed the jump every kernel panel makes, and the book the screen shows', () => {
    let seen: PaneContext | undefined
    const pane = { id: 'deck:panel', label: 'Deck', icon: 'globe', screens: ['reader'], render: (context: PaneContext) => {
      seen = context
      return <p>the deck</p>
    } } as const
    const { onGoTo } = draw({ state: stateOf({ pane: 'deck:panel', lastPane: 'deck:panel' }), contributed: [pane] })
    expect(seen?.bookId).toBe('open-book')
    seen?.goTo?.({ bookId: 'typee', cfi: 'epubcfi(/6/8!/4/2)' })
    expect(onGoTo.mock.calls).toEqual([[{ bookId: 'typee', cfi: 'epubcfi(/6/8!/4/2)' }]])
  })

  it('is given no jump by a host that has none', () => {
    let seen: PaneContext | undefined
    const pane = { id: 'deck:panel', label: 'Deck', icon: 'globe', screens: ['reader'], render: (context: PaneContext) => {
      seen = context
      return <p>the deck</p>
    } } as const
    const { onGoTo: _none, ...props } = propsOf({ state: stateOf({ pane: 'deck:panel', lastPane: 'deck:panel' }), contributed: [pane] })
    render(<SidePane {...props} />)
    expect(seen).toEqual({ bookId: 'open-book' })
  })
})

describe('the navigating panels', () => {
  it('sends a search hit through the host’s jump, so it enters the jump stack', async () => {
    const { onGoTo, props } = draw({ state: stateOf({ pane: 'search', lastPane: 'search' }) })
    fireEvent.change(screen.getByLabelText('Search this book'), { target: { value: 'Ishmael' } })
    fireEvent.click(await screen.findByRole('button', { name: /Ishmael/ }))
    expect(onGoTo.mock.calls).toEqual([[HIT.cfi]])
    expect(props.book.goTo).not.toHaveBeenCalled()
  })

  it('sends a contents row through the host’s jump', () => {
    const { onGoTo } = draw()
    fireEvent.click(screen.getByRole('button', { name: 'Loomings' }))
    expect(onGoTo.mock.calls).toEqual([['ch1.xhtml']])
  })
})

/**
 * A ROW FROM ANOTHER BOOK FOLLOWS THE SHELF AS IT CHANGES. Whether such a row
 * can be followed is asked of the shelf the pane was last handed, not the one it
 * was first drawn with: a book imported while Notes is open makes its marks
 * reachable without the panel being closed and opened again.
 */
describe('the notes panel and the shelf', () => {
  const elsewhere = {
    id: 'm9',
    bookId: 'other-book',
    cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:9)',
    sectionIndex: 0,
    text: 'stately plump buck',
    prefix: '',
    suffix: '',
    note: '',
    kind: 'highlight',
    tint: 'yellow',
    style: 'fill',
    chapter: 'Telemachus',
    createdAt: 1,
  }

  it('lets a row from another book be followed once that book is on the shelf, and not before', () => {
    const marks = { ...propsOf().marks, all: [elsewhere] } as unknown as MarksView
    const { redraw } = draw({ state: stateOf({ pane: 'marginalia' }), marks })
    const row = () => screen.getByRole('button', { name: /stately plump buck/i })
    expect(row().hasAttribute('disabled')).toBe(true)

    redraw({ books: [{ bookId: 'other-book', title: 'Ulysses' } as unknown as SidePaneProps['books'][number]] })
    expect(row().hasAttribute('disabled')).toBe(false)
  })
})

describe('the developer panel', () => {
  const devState = stateOf({ pane: 'dev', lastPane: 'dev', developer: true })

  it('shows the host’s log while recording, and hands on its copy and its clear', async () => {
    const log = createDiagnosticLog()
    log.record({ at: Date.UTC(2026, 8, 15, 12), level: 'warn', scope: 'sync', event: 'session-failed', fields: {} })
    const onCopy = vi.fn(() => Promise.resolve('copied' as const))
    const onCleared = vi.fn()
    draw({ state: devState, developer: { log, recording: true, onCopy, onCleared } })
    expect(screen.getByText('session-failed')).not.toBeNull()
    const jsonl = log.toJsonl()
    fireEvent.click(screen.getByRole('button', { name: 'Copy as JSONL' }))
    expect(onCopy.mock.calls).toEqual([[jsonl]])
    expect(await screen.findByRole('button', { name: 'Copied' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onCleared).toHaveBeenCalledTimes(1)
  })

  /* `state.developer` alone decides that the panel is drawn; what the host
     hands over is data, and a host with none still gets a panel. */
  it('says nothing is being recorded when the host hands over nothing', () => {
    draw({ state: devState })
    expect(screen.getByText('Diagnostics are not being recorded')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
  })

  it('says nothing is being recorded when the host is not recording', () => {
    draw({ state: devState, developer: { log: createDiagnosticLog(), recording: false } })
    expect(screen.getByText('Diagnostics are not being recorded')).not.toBeNull()
  })
})

describe('the settings panel', () => {
  const settingsState = (over: Partial<AppState> = {}) => stateOf({ pane: 'settings', lastPane: 'settings', ...over })
  const openGroup = (title: string) => fireEvent.click(screen.getByRole('button', { name: title }))

  it.each([
    ['a theme', () => fireEvent.click(screen.getByRole('button', { name: 'Slate' })), { type: 'setTheme', theme: 'slate' }],
    ['following the system', () => fireEvent.click(screen.getByRole('switch', { name: 'Follow system appearance' })), { type: 'setThemeFollowsOs', follows: false }],
    ['the flow', () => fireEvent.click(screen.getByRole('button', { name: /^Flow/ })), { type: 'setPageLayout', layout: 'paginated' }],
    ['the ruler', () => fireEvent.click(screen.getByRole('switch', { name: 'Reading ruler' })), { type: 'toggleRuler' }],
    ['the scrollbar', () => fireEvent.click(screen.getByRole('switch', { name: 'Scrollbar' })), { type: 'toggleScrollbar' }],
    ['the progress rule', () => fireEvent.click(screen.getByRole('switch', { name: 'Progress rule' })), { type: 'toggleProgressLine' }],
    ['the side', () => fireEvent.click(screen.getByRole('button', { name: /^Side pane position/ })), { type: 'setSide', side: 'left' }],
    ['the text size', () => fireEvent.click(screen.getByRole('button', { name: 'Smaller text' })), { type: 'setStepIdx', idx: 5 }],
    [
      'a spacing',
      () => {
        openGroup('Spacing')
        fireEvent.click(screen.getByRole('button', { name: 'More letter' }))
      },
      { type: 'setSpacing', key: 'letter', idx: 2 },
    ],
    ['the alignment', () => fireEvent.click(screen.getByRole('button', { name: /^Alignment/ })), { type: 'setAlign', align: 'justified-no-hyphens' }],
    ['a reading style', () => fireEvent.click(screen.getByRole('button', { name: /^Typography/ })), { type: 'setReadingStyle', key: 'fidelity', value: 'publisher' }],
    ['the brightness', () => fireEvent.click(screen.getByRole('button', { name: 'Less brightness' })), { type: 'setBrightness', idx: 3 }],
    ['the contrast', () => fireEvent.click(screen.getByRole('button', { name: 'Less contrast' })), { type: 'setContrast', idx: 3 }],
  ] as const)('sends %s as the action that sets it', (_what, press, action) => {
    const { dispatch } = draw({ state: settingsState() })
    press()
    expect(dispatch.mock.calls).toEqual([[action]])
  })

  it('sends a typeface as the action that sets it', () => {
    const { dispatch } = draw({ state: settingsState() })
    fireEvent.click(screen.getByRole('button', { name: /^Typeface:/ }))
    const other = screen.getAllByRole('menuitemradio').find((face) => face.getAttribute('aria-checked') !== 'true')
    expect(other, 'the menu offered no other face').toBeDefined()
    fireEvent.click(other!)
    expect(dispatch.mock.calls).toEqual([[{ type: 'setTypeface', typeface: expect.any(String) }]])
    expect(dispatch.mock.calls[0]?.[0]).not.toEqual({ type: 'setTypeface', typeface: initialState.typeface })
  })

  it('hides and shows an unfinished panel from the developer band', () => {
    const contributed = [{ id: 'deck:panel', label: 'Deck', icon: 'globe', screens: ['reader'], unfinished: true, render: () => null }] as const
    const { dispatch, redraw } = draw({ state: settingsState({ developer: true }), contributed })
    openGroup('Unfinished panels')
    fireEvent.click(screen.getByRole('switch', { name: 'Deck' }))
    redraw({ state: settingsState({ developer: true, hiddenPanes: ['deck:panel'] }), contributed })
    fireEvent.click(screen.getByRole('switch', { name: 'Deck' }))
    expect(dispatch.mock.calls).toEqual([
      [{ type: 'setPaneHidden', pane: 'deck:panel', hidden: true }],
      [{ type: 'setPaneHidden', pane: 'deck:panel', hidden: false }],
    ])
  })

  it('draws no developer band without developer options', () => {
    draw({ state: settingsState({ developer: false }), developer: { recording: true } })
    expect(screen.queryByRole('button', { name: 'Unfinished panels' })).toBeNull()
  })

  it('tells the developer band whether the host is recording', () => {
    draw({ state: settingsState({ developer: true }), developer: { recording: true } })
    openGroup('Diagnostics')
    expect(screen.getByText('Diagnostics are being recorded. The Developer panel shows the window.')).not.toBeNull()
  })

  it('tells the developer band nothing is recorded when the host hands over nothing', () => {
    draw({ state: settingsState({ developer: true }) })
    openGroup('Diagnostics')
    expect(screen.getByText(/^Diagnostics are not being recorded on this build\./)).not.toBeNull()
  })

})

/**
 * THE BOOK THE SCREEN SHOWS, not the book the reader holds: the reader stays
 * loaded behind the library, and `PaneContext` promises `null` there.
 */
describe('a contributed pane', () => {
  const friendsOn = (render: (context: { readonly bookId: string | null }) => unknown) =>
    [{ id: 'circle:friends', label: 'Friends', icon: 'people', screens: ['library', 'reader'], render }] as unknown as SidePaneProps['contributed']
  const onFriends = (screenId: 'library' | 'reader') => stateOf({ screen: screenId, pane: 'circle:friends', lastPane: 'circle:friends' })

  it('is handed no book on the library, and the open book in the reader', () => {
    const contributed = friendsOn((context) => <p>{`book=${String(context.bookId)}`}</p>)
    draw({ state: onFriends('library'), contributed })
    expect(screen.getByText('book=null')).not.toBeNull()
    cleanup()
    draw({ state: onFriends('reader'), contributed })
    expect(screen.getByText('book=open-book')).not.toBeNull()
  })

  it('draws nothing of a contributed pane under a kernel panel', () => {
    draw({ contributed: friendsOn(() => <p>friends drawn</p>) })
    expect(screen.queryByText('friends drawn')).toBeNull()
    expectOnlyPanel('toc')
  })

  /** A pane that throws until it is mended, and says which book it was given once it draws. */
  const mendable = () => {
    const state = { broken: true }
    const contributed = friendsOn((context) => {
      if (state.broken) throw new Error('the port went away')
      return <p>{`mended for ${String(context.bookId)}`}</p>
    })
    return { state, contributed }
  }
  const FAILED = 'Friends could not be drawn. Everything else still works.'

  it('starts over in the reader when another book is opened', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const pane = mendable()
    const { redraw } = draw({ state: onFriends('reader'), contributed: pane.contributed })
    expect(screen.getByText(FAILED)).not.toBeNull()
    pane.state.broken = false
    redraw({ state: onFriends('reader'), contributed: pane.contributed })
    expect(screen.getByText(FAILED), 'a failure was retried with nothing changed').not.toBeNull()
    act(() => redraw({ state: onFriends('reader'), contributed: pane.contributed, book: openBook({ bookId: 'another-book' }) }))
    expect(screen.getByText('mended for another-book')).not.toBeNull()
  })

  /* On the library the pane is about no book, so a book opened behind it is
     not a reason to start over. */
  it('does not start over on the library when the book held behind it changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const pane = mendable()
    const { redraw } = draw({ state: onFriends('library'), contributed: pane.contributed })
    expect(screen.getByText(FAILED)).not.toBeNull()
    pane.state.broken = false
    act(() => redraw({ state: onFriends('library'), contributed: pane.contributed, book: openBook({ bookId: 'another-book' }) }))
    expect(screen.getByText(FAILED)).not.toBeNull()
  })
})

/**
 * ⚠️ **THE SCAN IS SAID IN THE TITLE ROW, WHICH DOES NOT MOVE.** It used to be a
 * row above the list, so the list dropped when a scan began and rose when it
 * ended: the pane visibly shook once each time it opened.
 */
describe('the cross-book scan, beside the pane title', () => {
  const scanning = { scanning: true } as Partial<MarksView>
  const marksWith = (over: Partial<MarksView>) => ({ ...propsOf().marks, ...over }) as MarksView

  it('marks the running scan in the title row, by name for whoever cannot see the icon', () => {
    draw({ state: stateOf({ pane: 'marginalia' }), marks: marksWith(scanning) })
    const status = screen.getByRole('status', { name: 'Reading your marks…' })
    expect(status.parentElement?.textContent).toBe('Marginalia')
  })

  it('takes the mark away once the scan has landed', () => {
    const { redraw } = draw({ state: stateOf({ pane: 'marginalia' }), marks: marksWith(scanning) })
    redraw({ marks: marksWith({ scanning: false }) })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('says nothing about marks over another panel, whatever the scan is doing', () => {
    draw({ state: stateOf({ pane: 'toc' }), marks: marksWith(scanning) })
    expect(screen.queryByRole('status')).toBeNull()
  })
})
