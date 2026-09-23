// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SidePane, type SidePaneProps } from './SidePane'
import { initialState } from '../state'
import type { Book } from '../hooks/useBook'
import type { SearchHit } from '../hooks/useBook'
import type { MarksView } from '../hooks/useMarks'
import type { CardsView } from '../hooks/useCards'
import type { Bookmarking } from '../hooks/useBookmarking'
import type { TagPrefsStore } from '../hooks/useTagPrefs'

/**
 * What the side pane HANDS each panel — the wiring, which is where two
 * promises were broken without any panel being wrong.
 *
 * Every panel here is tested on its own and every one of those tests passed
 * while the app did not do what the ledger said: `SearchPanel` took an
 * `onGoTo` and was mounted without one, so a hit never entered the jump stack.
 * A component test cannot see a prop its host forgot, which is why this file
 * mounts the host.
 *
 * ⚠️ **THE PHASE-20 AUDIT FOUND TWO SUCH WIRES, AND THE SECOND IS DELETED** —
 * the companion took a `selection` and was mounted without one, so no question
 * it asked ever carried the passage. The lesson it paid for is the one above:
 * both were OPTIONAL props, and an optional prop is one a host can omit with
 * nothing said. Every panel's props here are required now, which is the
 * compile-time version of the same check.
 */

beforeEach(() => {
  /* jsdom has no `ResizeObserver`, and the Settings pane's typeface field
     measures itself — the same stub the behaviour suite next door installs. */
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
})

afterEach(cleanup)

const HIT: SearchHit = {
  cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:9)',
  label: 'Loomings',
  pre: 'Call me ',
  match: 'Ishmael',
  post: '.',
}

/** An open, searchable book — enough of one for the two panels under test. */
const book = () =>
  ({
    bookId: 'open-book',
    source: 'book.epub',
    meta: { title: 'Moby-Dick' },
    error: null,
    toc: [],
    position: { fraction: 0, chapterLabel: 'Loomings', chapterHref: '', cfi: null, sectionIndex: 0, sectionExact: true },
    search: async function* () {
      yield HIT
    },
    goTo: vi.fn(),
  }) as unknown as Book

const marksView = () =>
  ({ all: [], current: [], bookmarks: [], allBookmarks: [], allUnplaced: [], persistent: true, ready: true, loadAll: vi.fn() }) as unknown as MarksView

/**
 * The pane in the reader, on one panel, with only what that panel reads varied.
 *
 * `developerOptions` because an UNFINISHED panel — `cards` — is offered, and so
 * drawn, only with developer options on (`UNFINISHED_PANE_IDS`).
 */
function draw({
  developerOptions = false,
  ...over
}: Partial<SidePaneProps> & {
  pane: 'search' | 'cards' | 'library' | 'marginalia' | 'settings'
  developerOptions?: boolean
}) {
  const onGoTo = vi.fn()
  const props: SidePaneProps = {
    state: { ...initialState, screen: 'reader', pane: over.pane, lastPane: over.pane, developer: developerOptions },
    dispatch: vi.fn(),
    book: book(),
    marks: marksView(),
    bookmarking: { remove: vi.fn() } as unknown as Bookmarking,
    platform: 'macos',
    cards: { all: [] } as unknown as CardsView,
    onGoTo,
    onDeleteMark: vi.fn(),
    markFocus: null,
    onMarkFocusDone: vi.fn(),
    books: [],
    library: {
      onRenameTag: vi.fn(),
      onRemoveTag: vi.fn(),
      tagPrefs: {} as TagPrefsStore,
      lastRemoval: null,
      onUndoRemoveTag: vi.fn(),
      onAdoptTag: vi.fn(),
      onTagBooks: vi.fn(),
    },
    settings: { offered: [], sections: [] },
    contributed: [],
    ...over,
  }
  const view = render(<SidePane {...props} />)
  return {
    onGoTo,
    book: props.book,
    /** Re-render the same pane over a different open book. */
    openAnother: (bookId: string) =>
      view.rerender(
        <SidePane {...props} book={{ ...props.book, bookId } as unknown as Book} />,
      ),
    /** Re-render the same pane with a different shelf behind it. */
    withBooks: (books: SidePaneProps['books']) => view.rerender(<SidePane {...props} books={books} />),
  }
}

describe('the search panel', () => {
  it('sends a hit through the host\'s jump, so it enters the jump stack', async () => {
    const { onGoTo, book } = draw({ pane: 'search' })
    fireEvent.change(screen.getByLabelText('Search this book'), { target: { value: 'Ishmael' } })
    ;(await screen.findByRole('button', { name: /Ishmael/ })).click()
    /* The host's `onGoTo` IS `jumpTo` in App: it pushes the origin and raises
       the "← Back to …" line. The other four panels reach it; this one called
       the book directly and skipped both. */
    expect(onGoTo).toHaveBeenCalledWith(HIT.cfi)
    expect(book.goTo).not.toHaveBeenCalled()
  })
})

/**
 * ⚠️ **A PANE THE READER IS NOT OFFERED WAS DRAWN IF IT WAS ASKED FOR BY NAME.**
 * Only the remembered `lastPane` was fitted; `state.pane` went straight to the
 * panel switch, so a state naming an unfinished panel with developer options
 * off drew it beside a rail with no button for it (#145). The reducer does not
 * produce that state — this is the pane not depending on it.
 */
describe('a pane asked for that this reader is not offered', () => {
  it('shows the screen’s own default, as the rail does', () => {
    draw({ pane: 'cards' })
    /* The pane's TITLE, which is the one thing every panel puts on screen. */
    expect(screen.queryByText('Cards')).toBeNull()
    expect(screen.getByText('Contents')).not.toBeNull()
  })
})

/* The reader's decisions about their tags — pins, colours, hidden subjects,
   saved views — live in storage the panel writes; when that write is refused
   the panel is where the decision was made, so it is where the refusal is
   said (WI-20.36). */
describe('the library panel', () => {
  const prefs = { pinned: [], colours: {}, hiddenSubjects: [], views: [] }
  const tagPrefs = (persistent: boolean): TagPrefsStore => ({
    prefs,
    persistent,
    togglePinned: vi.fn(),
    setColour: vi.fn(),
    toggleHidden: vi.fn(),
    saveView: vi.fn(),
    renameView: vi.fn(),
    removeView: vi.fn(),
  })
  const library = (persistent: boolean): SidePaneProps['library'] => ({
    onRenameTag: vi.fn(),
    onRemoveTag: vi.fn(),
    tagPrefs: tagPrefs(persistent),
    lastRemoval: null,
    onUndoRemoveTag: vi.fn(),
    onAdoptTag: vi.fn(),
    onTagBooks: vi.fn(),
  })

  /* ON THE LIBRARY SCREEN, the one whose rail offers this panel. These drew it
     in the reader, which only worked because a pane asked for by name was not
     fitted to its screen (#145). */
  const shelf = { ...initialState, screen: 'library' as const, pane: 'library' as const, lastPane: 'library' as const }

  it('says when the tag preferences are not being kept', () => {
    draw({ pane: 'library', state: shelf, library: library(false) })
    expect(screen.getByText(/not being saved/).textContent).toContain('pins')
  })

  it('says nothing when they are', () => {
    draw({ pane: 'library', state: shelf, library: library(true) })
    expect(screen.queryByText(/not being saved/)).toBeNull()
  })
})


/**
 * THE BOOK THE SCREEN SHOWS, not the book the reader holds. The reader stays
 * loaded behind the library, so `book.bookId` still names the last book
 * opened while the library is on screen — and `PaneContext` promises `null`
 * there. A pane fitted to both screens was handed the previous book's id on
 * the library.
 */
describe('what a contributed pane is handed', () => {
  const friends = {
    id: 'circle:friends' as const,
    label: 'Friends',
    icon: 'people' as const,
    screens: ['library', 'reader'] as const,
    render: (context: { readonly bookId: string | null }) => <p>{`book=${String(context.bookId)}`}</p>,
  }
  const on = (screenId: 'library' | 'reader') =>
    draw({
      pane: 'library',
      state: { ...initialState, screen: screenId, pane: 'circle:friends', lastPane: 'circle:friends' },
      contributed: [friends as unknown as SidePaneProps['contributed'][number]],
    })

  it('gets null for the book on the library screen, and the open book in the reader', () => {
    on('library')
    expect(screen.getByText('book=null')).toBeTruthy()
    cleanup()
    on('reader')
    expect(screen.getByText('book=open-book')).toBeTruthy()
  })
})

describe('what Marginalia is told about other books', () => {
  /**
   * ⚠️ **A CROSS-BOOK ROW NAMES THE BOOK IT CAME FROM, and the name comes from
   * the SHELF the Library panel already has.** `titleOf` is the whole of that
   * wiring: the panel asks it, and answers "Another book" when it has nothing
   * — so a `titleOf` that answered nothing for everything would look exactly
   * like a shelf with no titles, on every row, with the suite green.
   */
  const elsewhere = () =>
    ({
      all: [
        {
          id: 'm1',
          bookId: 'a-book-elsewhere',
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
        },
      ],
      current: [],
      bookmarks: [],
      allBookmarks: [],
      allUnplaced: [],
      persistent: true,
      ready: true,
      loadAll: vi.fn(),
    }) as unknown as MarksView

  const shelf = [{ bookId: 'a-book-elsewhere', title: 'Ulysses' }] as unknown as SidePaneProps['books']

  it('names the book a cross-book row came from, from the shelf', () => {
    draw({ pane: 'marginalia', marks: elsewhere(), books: shelf })
    expect(screen.getByText('Ulysses')).toBeTruthy()
    expect(screen.queryByText('Another book'), 'the shelf knew its name').toBeNull()
  })

  it('says another book when the shelf does not hold it', () => {
    /* A book removed from the shelf, or one whose record has not loaded: the
       row still says it is not from the open book. */
    draw({ pane: 'marginalia', marks: elsewhere(), books: [] })
    expect(screen.getByText('Another book')).toBeTruthy()
  })

  it('answers again when the shelf arrives after the panel', () => {
    /* The shelf loads asynchronously, so the first render of a cross-book row
       often precedes it — a name resolved once, at mount, would stay "Another
       book" for the rest of the session. */
    const { withBooks } = draw({ pane: 'marginalia', marks: elsewhere(), books: [] })
    expect(screen.getByText('Another book')).toBeTruthy()
    withBooks(shelf)
    expect(screen.getByText('Ulysses'), 'the panel kept the shelf it was first given').toBeTruthy()
  })
})

describe('what the Voice group is handed', () => {
  /**
   * ⚠️ **THE HOST ANSWERS TWO FACTS AND APP STATE ANSWERS FIVE, AND THIS IS
   * WHERE THEY MEET.** The open book's language and the machine's voice list
   * are the host's; the chosen voice, the speed and the two gaps are the
   * reader's. Seventeen mutants lived in that composition because no test
   * rendered the pane with a narration at all — every one of them a wire from a
   * control to a reducer action, which is what this suite exists for.
   */
  /* A voice the floor accepts, so the picker has something to offer — see
     `voiceChoice.ts`: below the floor the group refuses every voice and there
     is nothing to choose. */
  const ZOE = {
    name: 'Zoe',
    lang: 'en-US',
    voiceURI: 'com.apple.voice.enhanced.en-US.Zoe',
    localService: true,
  }
  const narration = { lang: 'en-US', voices: [ZOE], packs: [] }

  function voiceRows(over: Partial<SidePaneProps> = {}) {
    const dispatch = vi.fn()
    const props: Partial<SidePaneProps> = {
      pane: 'settings',
      narration,
      dispatch,
      ...over,
    } as Partial<SidePaneProps> & { pane: 'settings' }
    draw(props as Parameters<typeof draw>[0])
    fireEvent.click(screen.getByRole('button', { name: 'Voice' }))
    return dispatch
  }

  it('reads the reader’s own choices out of state', () => {
    voiceRows({
      state: {
        ...initialState,
        screen: 'reader',
        pane: 'settings',
        lastPane: 'settings',
        readingRate: 1.5,
        sentenceGapMs: 500,
        paragraphGapMs: 900,
      },
    })
    /* Each stepper's own readout says where in its scale it stands, which is
       the only observable proof the composed value arrived: 1.5x is the fifth
       of eight speeds, and 500ms and 900ms are each the fourth of their own six
       gaps. */
    const steps = screen.getAllByRole('img').map((pips) => pips.getAttribute('aria-label'))
    expect(steps).toEqual(expect.arrayContaining(['Step 5 of 8', 'Step 4 of 6']))
    expect(steps.filter((label) => label === 'Step 4 of 6'), 'both gaps').toHaveLength(2)
  })

  it('writes a picked voice under the book’s own language', () => {
    /* ⚠️ **THE LANGUAGE IS HALF THE WIRE.** The stored choice is a map — one
       voice per language — so a handler that dropped the language would put an
       English voice under every book the reader opens. */
    const dispatch = voiceRows()
    fireEvent.change(screen.getByRole('combobox', { name: 'Voice' }), {
      target: { value: ZOE.voiceURI },
    })
    expect(dispatch).toHaveBeenCalledWith({
      type: 'setReadingVoice',
      lang: 'en',
      voice: ZOE.voiceURI,
    })
  })

  it.each([
    ['More speed', { type: 'setReadingRate', rate: 1.25 }],
    ['More pause between sentences', { type: 'setSentenceGap', ms: 300 }],
    ['More pause between paragraphs', { type: 'setParagraphGap', ms: 900 }],
  ])('sends %s to the reducer', (control, action) => {
    const dispatch = voiceRows()
    fireEvent.click(screen.getByRole('button', { name: control }))
    expect(dispatch).toHaveBeenCalledWith(action)
  })

  it('sends the note-reading switch to the reducer', () => {
    const dispatch = voiceRows()
    fireEvent.click(screen.getByRole('switch', { name: 'Read footnotes' }))
    expect(dispatch).toHaveBeenCalledWith({ type: 'toggleReadingNotes' })
  })

  it('draws no Voice group at all on a host with no reader', () => {
    draw({ pane: 'settings', narration: undefined })
    expect(screen.queryByRole('button', { name: 'Voice' })).toBeNull()
  })
})
