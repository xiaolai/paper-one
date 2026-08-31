// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidePane, type SidePaneProps } from './SidePane'
import { initialState } from '../state'
import type { AnswerEnd, AskContext, CompanionProvider } from '../../core/companion'
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
 * `onGoTo` and was mounted without one, so a hit never entered the jump stack;
 * `Companion` took a `selection` and was mounted without one, so no question
 * ever carried the passage. A component test cannot see a prop its host forgot,
 * which is why this file mounts the host.
 *
 * Only the two wires the phase-20 audit found are pinned. The other panels'
 * props are typed as required, which is the compile-time version of the same
 * check; these two were optional, and an optional prop is one a host can omit
 * with nothing said.
 */

afterEach(cleanup)

const HIT: SearchHit = {
  cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:9)',
  label: 'Loomings',
  pre: 'Call me ',
  match: 'Ishmael',
  post: '.',
}

function provider(): CompanionProvider & { asked: AskContext[] } {
  const asked: AskContext[] = []
  return {
    name: 'fake',
    configured: true,
    asked,
    async *ask(_question: string, context: AskContext): AsyncGenerator<string, AnswerEnd> {
      asked.push(context)
      yield 'an answer'
      return { citations: [], hadUnknownCitation: false }
    },
  }
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
    passages: () => [],
  }) as unknown as Book

const marksView = () =>
  ({ all: [], current: [], bookmarks: [], allBookmarks: [], allUnplaced: [], persistent: true, ready: true, loadAll: vi.fn() }) as unknown as MarksView

/** The pane in the reader, on one panel, with only what that panel reads varied. */
function draw(over: Partial<SidePaneProps> & { pane: 'search' | 'companion' | 'library' }) {
  const onGoTo = vi.fn()
  const props: SidePaneProps = {
    state: { ...initialState, screen: 'reader', pane: over.pane, lastPane: over.pane },
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
    selection: null,
    companion: provider(),
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
    companion: props.companion as ReturnType<typeof provider>,
    book: props.book,
    /** Re-render the same pane over a different open book. */
    openAnother: (bookId: string) =>
      view.rerender(
        <SidePane {...props} book={{ ...props.book, bookId } as unknown as Book} />,
      ),
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

describe('the companion panel', () => {
  it('is handed the reader\'s selection, so a question carries it', () => {
    const { companion } = draw({ pane: 'companion', selection: 'Call me Ishmael.' })
    const input = screen.getByLabelText('Ask the companion about this chapter')
    fireEvent.change(input, { target: { value: 'who is speaking?' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(companion.asked[0]?.selection).toBe('Call me Ishmael.')
  })

  /**
   * ⚠️ **THE THREAD OUTLIVED THE BOOK IT WAS ABOUT.**
   *
   * The pane stays mounted across an open, and nothing tied the exchange or
   * the composer's draft to a book — so switching books left the previous
   * book's questions and answers on screen under the new book's heading, and
   * a half-typed question ready to be sent grounded in a book it was not
   * asked about. "grounded in this book only" is the panel's own line.
   */
  it('starts a new thread when the reader opens another book', async () => {
    const { openAnother } = draw({ pane: 'companion' })
    const input = screen.getByLabelText('Ask the companion about this chapter')
    fireEvent.change(input, { target: { value: 'who is speaking?' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('who is speaking?')).toBeTruthy()

    openAnother('another-book')
    expect(
      screen.queryByText('who is speaking?'),
      'the previous book’s exchange was shown under the new book',
    ).toBeNull()
    expect(
      (screen.getByLabelText('Ask the companion about this chapter') as HTMLInputElement).value,
      'the draft followed the reader into a book it was not about',
    ).toBe('')
  })

  /* The draft too: a question typed and not sent is about the book it was
     typed in. */
  it('clears a half-typed question when the book changes', () => {
    const { openAnother } = draw({ pane: 'companion' })
    fireEvent.change(screen.getByLabelText('Ask the companion about this chapter'), {
      target: { value: 'what is a gam?' },
    })
    openAnother('another-book')
    expect(
      (screen.getByLabelText('Ask the companion about this chapter') as HTMLInputElement).value,
    ).toBe('')
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

  it('says when the tag preferences are not being kept', () => {
    draw({ pane: 'library', library: library(false) })
    expect(screen.getByText(/not being saved/).textContent).toContain('pins')
  })

  it('says nothing when they are', () => {
    draw({ pane: 'library', library: library(true) })
    expect(screen.queryByText(/not being saved/)).toBeNull()
  })
})

/**
 * The rail's exhaustiveness check (`RailCoversEveryPane`) catches a MISSING
 * pane and cannot catch a DUPLICATE one: a second row for an id compiles,
 * then renders two buttons under one React key. A pin on the source, on the
 * `pageTurn.test.ts` precedent, because the entries are a module constant
 * nothing exports.
 */
describe('the rail', () => {
  it('lists every kernel pane once — a duplicated row would draw two buttons under one key', async () => {
    const { readFileSync } = await import('node:fs')
    /* From the repository root, not `import.meta.url`: under jsdom that URL
       carries an http scheme and `readFileSync` refuses it. */
    const source = readFileSync(`${process.cwd()}/src/kernel/ui/pane/SidePane.tsx`, 'utf8')
    const block = source.slice(source.indexOf('const RAIL_ENTRIES'), source.indexOf('as const satisfies'))
    const ids = [...block.matchAll(/id: '([a-z]+)'/g)].map((m) => m[1])
    expect(ids.length, 'the pin found the rail').toBeGreaterThan(3)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
