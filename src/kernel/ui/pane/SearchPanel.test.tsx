// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SearchPanel, type SearchableBook } from './SearchPanel'
import { MAX_LIBRARY_HITS } from './librarySearch'
import type { PassageHit } from '../../core/ports'
import type { SearchHit } from '../hooks/useBook'

/**
 * Where a search hit sends the reader, and through what.
 *
 * WHY THIS FILE DID NOT EXIST BEFORE — the same reason as Marginalia's: the
 * panel had no test, and what that hid was a promise. The ledger's "Back after
 * a jump" row names search hits explicitly among the panels that push onto the
 * jump stack, and every other panel does; this one called `book.goTo` on its
 * own, so a hit moved the reader with no ⌘[ back and no "← Back to" line. It
 * looked exactly like a jump, which is why nothing noticed.
 *
 * The rendering of results — streaming, the cap, the failed-mid-spine notice
 * — is a separate subject and is not asserted here.
 */

afterEach(cleanup)

const HIT: SearchHit = {
  cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:9)',
  label: 'Loomings',
  pre: 'Call me ',
  match: 'Ishmael',
  post: '.',
}

/** A book that answers every query with one hit, and records where it was sent. */
function searchable(): SearchableBook & { goTo: ReturnType<typeof vi.fn> } {
  return {
    source: 'book.epub',
    meta: { title: 'Moby-Dick' } as unknown as SearchableBook['meta'],
    error: null,
    search: async function* () {
      yield HIT
    },
    goTo: vi.fn(),
  } as unknown as SearchableBook & { goTo: ReturnType<typeof vi.fn> }
}

/** Type a query and wait for the hit's row to appear past the debounce. */
async function findHit(): Promise<HTMLElement> {
  fireEvent.change(screen.getByLabelText('Search this book'), { target: { value: 'Ishmael' } })
  return screen.findByRole('button', { name: /Ishmael/ })
}

describe('a search hit', () => {
  it('goes through the host\'s jump when there is one, and not through the book directly', async () => {
    const book = searchable()
    const onGoTo = vi.fn()
    render(<SearchPanel book={book} onGoTo={onGoTo} />)
    ;(await findHit()).click()
    /* THE STRING FORM of a `JumpTarget`: the open book, which is the only book
       a search covers. The host records the departure and navigates, so the
       reader gets the same ⌘[ a mark row or a contents entry gives them. */
    expect(onGoTo).toHaveBeenCalledWith(HIT.cfi)
    /* NOT BOTH. Navigating here as well would move the reader twice — once by
       the panel, once by the host — and stack the origin against a page that
       had already turned. */
    expect(book.goTo).not.toHaveBeenCalled()
  })

  it('falls back to the book\'s own goTo for a host with no jump stack', async () => {
    /* The browser client mounts this panel over a navigator and nothing else —
       it has no jump stack to push onto. A hit there still has to move the
       reader, so the fallback is pinned rather than left to be tidied away. */
    const book = searchable()
    render(<SearchPanel book={book} />)
    ;(await findHit()).click()
    expect(book.goTo).toHaveBeenCalledWith(HIT.cfi)
  })
})

/* ------------------------------------------------- searching the library */

const PASSAGE: PassageHit = {
  bookId: 'book:b',
  sectionIndex: 3,
  offset: 17,
  quote: 'the whale',
  prefix: 'and then we saw ',
  suffix: ' rise beside the boat',
  score: 1.5,
}

/** Type into the field and wait for whatever the current scope answers. */
function ask(value = 'whale') {
  fireEvent.change(screen.getByLabelText(/^Search (this book|every book)$/u), {
    target: { value },
  })
}

/** Choose a scope. */
function choose(which: 'This book' | 'Every book') {
  fireEvent.click(screen.getByRole('radio', { name: which }))
}

describe('the scope switch', () => {
  it('is not drawn at all where the library cannot be searched', () => {
    /* ⚠️ **A SWITCH THAT IS THERE AND DOES NOTHING IS WORSE THAN NO SWITCH**: a
     * reader who chooses it is told their library holds nothing. This is also
     * what makes the panel degrade to exactly what it was before phase 31 when
     * the `passages` capability is not composed — which is what
     * `pnpm verify:without` proves. */
    render(<SearchPanel book={searchable()} />)
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('is drawn where it can, and starts on the open book', () => {
    /* ⚠️ **DEFAULTS TO THE OPEN BOOK, ALWAYS.** A bare query silently meaning
     * something different from what it meant yesterday is why library search is
     * not in the shelf field either. */
    render(<SearchPanel book={searchable()} searchLibrary={async () => [PASSAGE]} />)
    expect(screen.getByRole('radio', { name: 'This book' }).getAttribute('aria-checked')).toBe(
      'true',
    )
    expect(screen.getByRole('radio', { name: 'Every book' }).getAttribute('aria-checked')).toBe(
      'false',
    )
  })

  it('stops walking the open book’s spine once the library is the scope', async () => {
    /* ⚠️ **THE ONE EXPENSIVE THING THIS PANEL DOES.** A spine walk per keystroke,
     * for results that are not on screen, while the field is asking a different
     * question. */
    let walks = 0
    const book: SearchableBook = {
      source: 'book.epub',
      meta: { title: 'Moby-Dick' } as unknown as SearchableBook['meta'],
      error: null,
      search: async function* () {
        walks += 1
        yield HIT
      },
      goTo: vi.fn(),
    }
    render(<SearchPanel book={book} searchLibrary={async () => [PASSAGE]} />)
    ask()
    await screen.findByRole('button', { name: /Ishmael/u })
    const inBook = walks
    expect(inBook).toBeGreaterThan(0)
    choose('Every book')
    ask('whale ship')
    await screen.findByRole('button', { name: /the whale/u })
    expect(walks).toBe(inBook)
  })

  it('asks the library only once it has been chosen', async () => {
    const searchLibrary = vi.fn(async () => [PASSAGE])
    render(<SearchPanel book={searchable()} searchLibrary={searchLibrary} />)
    ask()
    await screen.findByRole('button', { name: /Ishmael/u })
    expect(searchLibrary).not.toHaveBeenCalled()
    choose('Every book')
    await screen.findByRole('button', { name: /the whale/u })
    expect(searchLibrary).toHaveBeenCalledWith('whale', expect.any(Number))
  })

  it('asks for one past the cap, so the count can tell “exactly” from “more”', async () => {
    const searchLibrary = vi.fn(async () => [PASSAGE])
    render(<SearchPanel book={searchable()} searchLibrary={searchLibrary} />)
    choose('Every book')
    ask()
    await screen.findByRole('button', { name: /the whale/u })
    expect(searchLibrary).toHaveBeenCalledWith('whale', MAX_LIBRARY_HITS + 1)
  })

  it('searches the library with no book open', async () => {
    /* ⚠️ **THE FIELD WENT DEAD ON THE LIBRARY SCREEN while the one feature that
     * works there was selected.** Searching the shelf does not need a book
     * open — that is the whole point of it. */
    const closed: SearchableBook = {
      source: null,
      meta: null,
      error: null,
      search: async function* () {},
      goTo: vi.fn(),
    }
    render(<SearchPanel book={closed} searchLibrary={async () => [PASSAGE]} />)
    choose('Every book')
    const field = screen.getByLabelText('Search every book')
    expect((field as HTMLInputElement).disabled).toBe(false)
    fireEvent.change(field, { target: { value: 'whale' } })
    await screen.findByRole('button', { name: /the whale/u })
  })
})

describe('a library hit', () => {
  it('names the book it came from', async () => {
    render(
      <SearchPanel
        book={searchable()}
        searchLibrary={async () => [PASSAGE]}
        titleOf={(id) => (id === 'book:b' ? 'Moby-Dick' : undefined)}
      />,
    )
    choose('Every book')
    ask()
    await screen.findByRole('button', { name: /the whale/u })
    expect(screen.getByText('Moby-Dick')).toBeTruthy()
  })

  it('falls back to the id when nothing knows the title', async () => {
    render(<SearchPanel book={searchable()} searchLibrary={async () => [PASSAGE]} />)
    choose('Every book')
    ask()
    await screen.findByRole('button', { name: /the whale/u })
    expect(screen.getByText('book:b')).toBeTruthy()
  })

  it('opens through the host, with the whole hit', async () => {
    /* The host needs the section and the context to LAND it — a cfi does not
       exist yet, and making one is what `useOpenPassage` does. */
    const onOpenPassage = vi.fn()
    render(
      <SearchPanel
        book={searchable()}
        searchLibrary={async () => [PASSAGE]}
        onOpenPassage={onOpenPassage}
      />,
    )
    choose('Every book')
    ask()
    ;(await screen.findByRole('button', { name: /the whale/u })).click()
    expect(onOpenPassage).toHaveBeenCalledWith(PASSAGE)
  })

  it('is not a live control where nothing can act on it', async () => {
    /* ⚠️ **A LINK THAT OPENS NOTHING IS THE CONTROL THIS REPOSITORY REFUSES TO
     * DRAW.** A host that can search the library and not open a second book
     * should not offer a click that does nothing. */
    render(<SearchPanel book={searchable()} searchLibrary={async () => [PASSAGE]} />)
    choose('Every book')
    ask()
    const row = await screen.findByRole('button', { name: /the whale/u })
    expect((row as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('what a library search says when it cannot answer', () => {
  it('tells a query the reader can fix from an index that will not open', async () => {
    /* ⚠️ **TWO SENTENCES.** Reported as a broken index, a reader stops trusting
     * the feature; as a bad query, they retype a perfectly good one for ever. */
    const { unmount } = render(
      <SearchPanel
        book={searchable()}
        searchLibrary={async () => {
          throw { code: 'malformed', message: 'that is a single character' }
        }}
      />,
    )
    choose('Every book')
    ask()
    expect(await screen.findByText('That search cannot be run')).toBeTruthy()
    expect(screen.getByText('that is a single character')).toBeTruthy()
    unmount()

    render(
      <SearchPanel
        book={searchable()}
        searchLibrary={async () => {
          throw new Error('the index will not open')
        }}
      />,
    )
    choose('Every book')
    ask()
    expect(await screen.findByText('Your library could not be searched')).toBeTruthy()
  })

  it('says nothing was found, and where to see how much is indexed', async () => {
    render(<SearchPanel book={searchable()} searchLibrary={async () => []} />)
    choose('Every book')
    ask()
    expect(await screen.findByText(/No matches for/u)).toBeTruthy()
    expect(screen.getByText(/Settings → Library search/u)).toBeTruthy()
  })

  it('invites a query before there is one', () => {
    render(<SearchPanel book={searchable()} searchLibrary={async () => []} />)
    choose('Every book')
    expect(screen.getByText(/Type to search every book/u)).toBeTruthy()
  })

  it('shows nothing that outlives the query it answers', async () => {
    /* The panel's own rule, applied to the library half: during the debounce
       the previous question's answer was both displayed and clickable. */
    render(<SearchPanel book={searchable()} searchLibrary={async () => [PASSAGE]} />)
    choose('Every book')
    ask('whale')
    await screen.findByRole('button', { name: /the whale/u })
    ask('something else')
    expect(screen.queryByRole('button', { name: /the whale/u })).toBeNull()
    expect(screen.getByText('Searching your library…')).toBeTruthy()
  })
})
