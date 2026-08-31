// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initialState } from '../state'
import type { Book } from '../hooks/useBook'
import type { Bookmarking } from '../hooks/useBookmarking'
import type { Marking } from '../hooks/useMarking'
import type { MarksView } from '../hooks/useMarks'
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
    /* A book has to be OPEN for the notice slot to exist at all: with
       `book.source` null the screen is the empty state, and the whole chrome
       — footer, notices and margin — is replaced by "No book open". A string
       source is enough; nothing here opens it. */
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
    mark: vi.fn(),
    unmark: vi.fn(),
  }) as unknown as Marking

const bookmarking = (): Bookmarking =>
  ({ here: false, toggle: vi.fn(), marks: [] }) as unknown as Bookmarking

function mount(
  over: {
    importNotice?: string | null
    onDismissImportNotice?: () => void
    bookOver?: Partial<Record<string, unknown>>
  } = {},
) {
  const { bookOver, ...props } = over
  return render(
    <Reader
      state={{ ...initialState, screen: 'reader' }}
      dispatch={vi.fn()}
      platform="macos"
      book={{ ...book(), ...(bookOver ?? {}) } as unknown as Book}
      marks={marks()}
      marking={marking()}
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
    />,
  )
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
