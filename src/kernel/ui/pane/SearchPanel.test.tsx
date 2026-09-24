// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEBOUNCE_MS, MAX_HITS, SearchPanel, type SearchableBook } from './SearchPanel'
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

/* ------------------------------------------- what the panel says, and when
 *
 * ⚠️ **THE HEADER USED TO SAY THIS WAS "a separate subject and is not asserted
 * here".** It was, and the mutation sweep on 2026-09-24 priced it: 72 mutants
 * this phase ADDED survived in this file, most of them in the sentences a
 * reader is shown and the caps that decide how many rows they get. A panel's
 * whole job is what it says, so leaving that unasserted leaves the job
 * unasserted. */

/** A book that yields nothing, so the empty and failure states are reachable. */
function quiet(over: Partial<SearchableBook> = {}): SearchableBook {
  return {
    source: 'book.epub',
    meta: { title: 'Moby-Dick' } as unknown as SearchableBook['meta'],
    error: null,
    search: async function* () {},
    goTo: vi.fn(),
    ...over,
  } as SearchableBook
}

describe('the in-book field and its empty states', () => {
  it('tells an unopened shelf to open a book, not that the book failed', () => {
    render(<SearchPanel book={quiet({ source: null, meta: null })} />)
    expect(screen.getByText('Search covers the book you are reading. Open one first.')).toBeTruthy()
  })

  it('tells a book that would not open apart from one still opening', () => {
    /* ⚠️ **`source === null` IS TESTED FIRST**, so a book that HAS bytes and
     * failed is the only way to reach this sentence — a fixture with no source
     * gets the shelf's sentence instead, and the case would pass for the wrong
     * reason while asserting nothing about the failure. */
    render(<SearchPanel book={quiet({ meta: null, error: 'nope' })} />)
    expect(screen.getByText('This book did not open, so there is nothing to search.')).toBeTruthy()
  })

  it('says a book is still opening when it has bytes and no metadata yet', () => {
    render(<SearchPanel book={quiet({ meta: null })} />)
    expect(screen.getByText('This book is still opening.')).toBeTruthy()
  })

  it('invites a query before one is typed', () => {
    render(<SearchPanel book={quiet()} />)
    expect(screen.getByText('Type to search this book.')).toBeTruthy()
  })

  it('labels and places the field by scope, and never disables it in the library', () => {
    render(<SearchPanel book={quiet({ source: null, meta: null })} searchLibrary={async () => []} />)
    const inBook = screen.getByLabelText('Search this book') as HTMLInputElement
    expect(inBook.placeholder).toBe('Open a book to search it')
    expect(inBook.disabled).toBe(true)
    choose('Every book')
    const inLibrary = screen.getByLabelText('Search every book') as HTMLInputElement
    expect(inLibrary.placeholder).toBe('Search every book…')
    expect(inLibrary.disabled).toBe(false)
  })

  it('offers the open book’s own placeholder when there is one', () => {
    render(<SearchPanel book={quiet()} />)
    expect((screen.getByLabelText('Search this book') as HTMLInputElement).placeholder).toBe(
      'Search this book…',
    )
  })
})

describe('the in-book count, its cap and its failures', () => {
  /** A book answering `n` hits, each with its own anchor unless `sameCfi`. */
  function answering(n: number, sameCfi = false): SearchableBook {
    return quiet({
      search: async function* () {
        for (let i = 0; i < n; i += 1) {
          yield { ...HIT, cfi: sameCfi ? HIT.cfi : `${HIT.cfi}:${i}`, match: `Ishmael${i}` }
        }
      },
    })
  }

  it('counts what it found, with no plus below the cap', async () => {
    render(<SearchPanel book={answering(3)} />)
    ask('Ishmael')
    expect(await screen.findByText(/^3 in this book$/u)).toBeTruthy()
  })

  it('caps the rows and marks the count with a plus above it', async () => {
    render(<SearchPanel book={answering(MAX_HITS + 5)} />)
    ask('Ishmael')
    expect(await screen.findByText(`${MAX_HITS}+ in this book`)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /Ishmael/u }).length).toBe(MAX_HITS)
  })

  it('draws every hit that shares an anchor, rather than collapsing them', async () => {
    /* ⚠️ **A PDF's ANCHOR IS ITS PAGE NUMBER**, so several matches on one page
     * share it — and React collapses duplicate keys to the last of them, which
     * is why the key carries the position too. */
    render(<SearchPanel book={answering(4, true)} />)
    ask('Ishmael')
    await screen.findByText(/in this book/u)
    expect(screen.getAllByRole('button', { name: /Ishmael/u }).length).toBe(4)
  })

  it('says a search stopped early rather than presenting it as complete', async () => {
    /* A failure partway through still has hits, and the count alone would
     * present a truncated search as a whole one. */
    render(
      <SearchPanel
        book={quiet({
          search: async function* () {
            yield HIT
            throw new Error('the spine gave out')
          },
        })}
      />,
    )
    ask('Ishmael')
    expect(
      await screen.findByText('Search stopped early — these are the matches found so far.'),
    ).toBeTruthy()
  })

  it('says a book could not be searched when it failed with nothing to show', async () => {
    render(
      <SearchPanel
        book={quiet({
          search: async function* () {
            throw new Error('the spine gave out')
          },
        })}
      />,
    )
    ask('Ishmael')
    expect(await screen.findByText('This book could not be searched')).toBeTruthy()
  })
})

describe('what the library half says, and what it refuses to say', () => {
  /** `n` passages, spread over `books` different books. */
  function passages(n: number, books = 1): PassageHit[] {
    return Array.from({ length: n }, (_, i) => ({
      ...PASSAGE,
      bookId: `book:${i % books}`,
      sectionIndex: i,
      offset: i * 10,
      quote: `the whale ${i}`,
    }))
  }

  it('invites a query before one is typed, in the library’s own words', () => {
    render(<SearchPanel book={quiet()} searchLibrary={async () => []} />)
    choose('Every book')
    expect(screen.getByText(/Type to search/u)).toBeTruthy()
  })

  it('asks nothing at all while the needle is empty', async () => {
    const searchLibrary = vi.fn(async () => passages(1))
    render(<SearchPanel book={quiet()} searchLibrary={searchLibrary} />)
    choose('Every book')
    ask('whale')
    await screen.findByRole('button', { name: /the whale/u })
    searchLibrary.mockClear()
    ask('')
    /* ⚠️ **PAST THE DEBOUNCE, OR THIS PASSES FOR THE WRONG REASON.** At 120 ms
     * against a 250 ms debounce the call had not been made YET, so the case
     * could not tell "never asked" from "not asked yet" — the mutation sweep
     * priced it: both guards survived. `DEBOUNCE_MS` is read, not copied. */
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 2))
    expect(searchLibrary).not.toHaveBeenCalled()
  })

  it('stops asking the library the moment the scope goes back to the book', async () => {
    const searchLibrary = vi.fn(async () => passages(1))
    render(<SearchPanel book={quiet()} searchLibrary={searchLibrary} />)
    choose('Every book')
    ask('whale')
    await screen.findByRole('button', { name: /the whale/u })
    searchLibrary.mockClear()
    choose('This book')
    ask('harpoon')
    /* ⚠️ **PAST THE DEBOUNCE, OR THIS PASSES FOR THE WRONG REASON.** At 120 ms
     * against a 250 ms debounce the call had not been made YET, so the case
     * could not tell "never asked" from "not asked yet" — the mutation sweep
     * priced it: both guards survived. `DEBOUNCE_MS` is read, not copied. */
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 2))
    expect(searchLibrary).not.toHaveBeenCalled()
  })

  it('reports a query the index refused as the reader’s to fix', async () => {
    /* ⚠️ **TWO DIFFERENT SENTENCES.** Told the index is broken, a reader stops
     * trusting the feature; told their query is, they retype a perfectly good
     * question for ever. */
    const refused = Object.assign(new Error('「树」 is a single character'), { kind: 'badQuery' })
    render(<SearchPanel book={quiet()} searchLibrary={async () => { throw refused }} />)
    choose('Every book')
    ask('树')
    expect(await screen.findByText(/single character/u)).toBeTruthy()
    expect(screen.queryByText(/could not be searched/u)).toBeNull()
  })

  it('reports an index that would not answer as a failure, not as a bad query', async () => {
    render(
      <SearchPanel
        book={quiet()}
        searchLibrary={async () => { throw new Error('the index would not open') }}
      />,
    )
    choose('Every book')
    ask('whale')
    expect(await screen.findByText(/would not open/u)).toBeTruthy()
  })

  it('caps the rows it draws and says the count is a floor', async () => {
    render(<SearchPanel book={quiet()} searchLibrary={async () => passages(MAX_LIBRARY_HITS + 3)} />)
    choose('Every book')
    ask('whale')
    await screen.findByText(new RegExp(`${MAX_LIBRARY_HITS}`, 'u'))
    expect(screen.getAllByRole('button', { name: /the whale/u }).length).toBe(MAX_LIBRARY_HITS)
  })

  it('draws every passage that shares a book and a section, rather than collapsing them', async () => {
    /* A book id and a section number are not unique across the list, and React
     * collapses duplicate keys to the last of them — which is why the key
     * carries the position too. */
    const same = Array.from({ length: 3 }, () => ({ ...PASSAGE }))
    render(<SearchPanel book={quiet()} searchLibrary={async () => same} />)
    choose('Every book')
    ask('whale')
    await screen.findByText(/in your library/u)
    expect(screen.getAllByRole('button', { name: /the whale/u }).length).toBe(3)
  })

  it('groups the rows under the book they came from', async () => {
    render(
      <SearchPanel
        book={quiet()}
        searchLibrary={async () => passages(4, 2)}
        titleOf={(id) => (id === 'book:0' ? 'Moby-Dick' : 'Endurance')}
      />,
    )
    choose('Every book')
    ask('whale')
    expect(await screen.findByText('Moby-Dick')).toBeTruthy()
    expect(screen.getByText('Endurance')).toBeTruthy()
  })

  it('falls back to the book id when the host cannot name the book', async () => {
    render(<SearchPanel book={quiet()} searchLibrary={async () => passages(1)} />)
    choose('Every book')
    ask('whale')
    expect(await screen.findByText('book:0')).toBeTruthy()
  })

  it('disables a row a host cannot act on rather than drawing a dead control', async () => {
    /* ⚠️ **A HOST THAT CAN SEARCH AND NOT OPEN** should not offer a click that
     * does nothing. */
    render(<SearchPanel book={quiet()} searchLibrary={async () => passages(1)} />)
    choose('Every book')
    ask('whale')
    const row = await screen.findByRole('button', { name: /the whale/u })
    expect((row as HTMLButtonElement).disabled).toBe(true)
  })

  it('hands the whole hit to the host when it can open one', async () => {
    const onOpenPassage = vi.fn()
    render(
      <SearchPanel book={quiet()} searchLibrary={async () => passages(1)} onOpenPassage={onOpenPassage} />,
    )
    choose('Every book')
    ask('whale')
    const row = await screen.findByRole('button', { name: /the whale/u })
    expect((row as HTMLButtonElement).disabled).toBe(false)
    row.click()
    /* THE WHOLE HIT, offset included — the landing needs it to settle an
     * ambiguous passage, which `landPassage` measured on the real library. */
    expect(onOpenPassage).toHaveBeenCalledWith(expect.objectContaining({ bookId: 'book:0', offset: 0 }))
  })

  it('shows nothing from the previous question while the next one is in flight', async () => {
    /* ⚠️ **NOTHING ON SCREEN MAY OUTLIVE THE QUERY IT ANSWERS.** During the
     * debounce the previous answer was both displayed and clickable. */
    let answer: PassageHit[] = passages(1)
    render(<SearchPanel book={quiet()} searchLibrary={async () => answer} />)
    choose('Every book')
    ask('whale')
    await screen.findByRole('button', { name: /the whale 0/u })
    answer = []
    ask('harpoon')
    expect(screen.queryByRole('button', { name: /the whale 0/u })).toBeNull()
  })
})

describe('a run that is no longer the one on screen', () => {
  it('cannot put its answer on the panel after a newer query started', async () => {
    /* ⚠️ **THE RACE, AND THE GUARD IS AN IDENTITY RATHER THAN A COUNTER.**
     * A slow first query resolving after a fast second one would otherwise
     * paint the first one's hits under the second one's needle. */
    const gate: Array<(hits: PassageHit[]) => void> = []
    const searchLibrary = vi.fn(
      (needle: string) =>
        new Promise<readonly PassageHit[]>((resolve) => {
          gate.push(resolve as (hits: PassageHit[]) => void)
          if (needle === 'harpoon') resolve([{ ...PASSAGE, quote: 'the harpoon' }])
        }),
    )
    render(<SearchPanel book={quiet()} searchLibrary={searchLibrary} />)
    choose('Every book')
    ask('whale')
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 2))
    ask('harpoon')
    await screen.findByRole('button', { name: /the harpoon/u })
    /* Now let the FIRST query answer, late. */
    gate[0]?.([{ ...PASSAGE, quote: 'the stale whale' }])
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByRole('button', { name: /the stale whale/u })).toBeNull()
    expect(screen.getByRole('button', { name: /the harpoon/u })).toBeTruthy()
  })

  it('cannot put its FAILURE on the panel either', async () => {
    /* The same guard sits on the catch, and a late failure would replace a
     * perfectly good newer answer with an error about an older question. */
    const gate: Array<(why: Error) => void> = []
    const searchLibrary = vi.fn(
      (needle: string) =>
        new Promise<readonly PassageHit[]>((resolve, reject) => {
          gate.push(reject as (why: Error) => void)
          if (needle === 'harpoon') resolve([{ ...PASSAGE, quote: 'the harpoon' }])
        }),
    )
    render(<SearchPanel book={quiet()} searchLibrary={searchLibrary} />)
    choose('Every book')
    ask('whale')
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 2))
    ask('harpoon')
    await screen.findByRole('button', { name: /the harpoon/u })
    gate[0]?.(new Error('the stale index would not open'))
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByText(/stale index/u)).toBeNull()
    expect(screen.getByRole('button', { name: /the harpoon/u })).toBeTruthy()
  })
})

describe('the in-book walk is not started for nothing', () => {
  it('walks no spine at all while the field is empty', async () => {
    let walks = 0
    render(
      <SearchPanel
        book={quiet({
          search: async function* () {
            walks += 1
            yield HIT
          },
        })}
      />,
    )
    ask('Ishmael')
    await screen.findByRole('button', { name: /Ishmael/u })
    const after = walks
    expect(after).toBeGreaterThan(0)
    ask('')
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 2))
    expect(walks).toBe(after)
    expect(screen.getByText('Type to search this book.')).toBeTruthy()
  })

  it('walks no spine for a book that cannot be searched', async () => {
    let walks = 0
    render(
      <SearchPanel
        book={quiet({
          meta: null,
          search: async function* () {
            walks += 1
            yield HIT
          },
        })}
      />,
    )
    fireEvent.change(screen.getByLabelText('Search this book'), { target: { value: 'Ishmael' } })
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 2))
    expect(walks).toBe(0)
  })

  it('says it is still searching beside the count, and stops saying it', async () => {
    /* A BOX, because TypeScript narrows a `let` to its initialiser and does not
     * account for an assignment made inside a closure — `release?.()` then
     * reads as `never`. */
    const gate: { release: (() => void) | null } = { release: null }
    render(
      <SearchPanel
        book={quiet({
          search: async function* () {
            yield HIT
            await new Promise<void>((r) => {
              gate.release = r
            })
          },
        })}
      />,
    )
    ask('Ishmael')
    expect(await screen.findByText(/1 in this book · searching…/u)).toBeTruthy()
    gate.release?.()
    await screen.findByText(/^1 in this book$/u)
  })
})

describe('the caps, at the exact boundary', () => {
  /* ⚠️ **`>` AND `>=` ANSWER THE SAME ABOVE AND BELOW A BOUND — ONLY THE BOUND
   * ITSELF TELLS THEM APART.** A case built on "the cap plus five" cannot see
   * the difference, and four mutants survived the sweep on exactly that. */
  it('says exactly the cap, with no plus, for an in-book search that hit it', async () => {
    render(
      <SearchPanel
        book={quiet({
          search: async function* () {
            for (let i = 0; i < MAX_HITS; i += 1) yield { ...HIT, cfi: `c${i}`, match: `Ishmael${i}` }
          },
        })}
      />,
    )
    ask('Ishmael')
    expect(await screen.findByText(`${MAX_HITS} in this book`)).toBeTruthy()
    expect(screen.queryByText(`${MAX_HITS}+ in this book`)).toBeNull()
  })

  it('says exactly the cap, with no plus, for a library search that hit it', async () => {
    const exact = Array.from({ length: MAX_LIBRARY_HITS }, (_, i) => ({
      ...PASSAGE,
      sectionIndex: i,
      quote: `the whale ${i}`,
    }))
    render(<SearchPanel book={quiet()} searchLibrary={async () => exact} />)
    choose('Every book')
    ask('whale')
    const line = await screen.findByText(/in your library/u)
    expect(line.textContent).toContain(String(MAX_LIBRARY_HITS))
    expect(line.textContent).not.toContain('+')
  })

  it('marks the library count as a floor one past the cap', async () => {
    const over = Array.from({ length: MAX_LIBRARY_HITS + 1 }, (_, i) => ({
      ...PASSAGE,
      sectionIndex: i,
      quote: `the whale ${i}`,
    }))
    render(<SearchPanel book={quiet()} searchLibrary={async () => over} />)
    choose('Every book')
    ask('whale')
    const line = await screen.findByText(/in your library/u)
    expect(line.textContent).toContain('+')
  })
})

describe('the stopped-early notice', () => {
  it('is absent when the search finished', async () => {
    /* ⚠️ **A NOTICE THAT IS ALWAYS THERE SAYS NOTHING.** Without this the
     * condition could be replaced with `true` and no case would notice. */
    render(<SearchPanel book={searchable()} />)
    ask('Ishmael')
    await screen.findByRole('button', { name: /Ishmael/u })
    expect(screen.queryByText(/Search stopped early/u)).toBeNull()
  })

  it('is absent while the answer on screen belongs to an older question', async () => {
    /* `answered` is the second half of the condition, and it is what stops a
     * PREVIOUS query's failure being reported under the current needle. */
    render(
      <SearchPanel
        book={quiet({
          search: async function* () {
            yield HIT
            throw new Error('the spine gave out')
          },
        })}
      />,
    )
    ask('Ishmael')
    await screen.findByText(/Search stopped early/u)
    ask('Ahab')
    expect(screen.queryByText(/Search stopped early/u)).toBeNull()
  })
})

describe('the states the panel passes through, and the styling hook it sets', () => {
  it('says it is searching the library before the answer arrives', async () => {
    /* The `searching` state between the keystroke and the answer is a state a
     * reader sees, so it is one a case has to see too. */
    const gate: { resolve: ((hits: PassageHit[]) => void) | null } = { resolve: null }
    /* ⚠️ **ONE IDENTITY, HOISTED.** An inline arrow is a new function on every
     * render, and the library effect lists `searchLibrary` among its
     * dependencies — so it re-subscribes each time, and a promise resolved
     * from outside lands on a run that is no longer the current one. Every
     * host supplies a stable one (`main.web.tsx` memoises it); a case that
     * does not is testing something the app never does. */
    const searchLibrary = () =>
      new Promise<readonly PassageHit[]>((r) => {
        gate.resolve = r as (hits: PassageHit[]) => void
      })
    render(<SearchPanel book={quiet()} searchLibrary={searchLibrary} />)
    choose('Every book')
    ask('whale')
    /* The searching state is set the moment the keystroke lands — BEFORE the
     * debounce fires and therefore before `searchLibrary` has been called at
     * all, which is the whole point of showing it. So the answer cannot be
     * released until the call has actually been made. */
    expect(await screen.findByText(/Searching/u)).toBeTruthy()
    expect(gate.resolve).toBeNull()
    await vi.waitFor(() => expect(gate.resolve).not.toBeNull(), { timeout: DEBOUNCE_MS * 8 })
    gate.resolve?.([PASSAGE])
    await screen.findByRole('button', { name: /the whale/u })
    /* AND THE DONE LINE DOES NOT STILL SAY SO. `countLine`'s third argument is
     * `false` here, and a `true` would leave "· searching…" beside a finished
     * count for ever. */
    expect(screen.getByText(/in your library/u).textContent).not.toContain('searching')
  })

  it('goes back to inviting a query when the field is cleared', async () => {
    render(<SearchPanel book={quiet()} searchLibrary={async () => [PASSAGE]} />)
    choose('Every book')
    ask('whale')
    await screen.findByRole('button', { name: /the whale/u })
    ask('')
    expect(await screen.findByText(/Type to search/u)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /the whale/u })).toBeNull()
  })

  it('asks once for a query typed in pieces, not once per keystroke', async () => {
    /* ⚠️ **THE DEBOUNCE'S CLEANUP IS WHAT MAKES THAT TRUE**, and without it
     * every intermediate needle would reach the index — which at library scale
     * is a BM25 query per character. */
    const searchLibrary = vi.fn(async () => [PASSAGE])
    render(<SearchPanel book={quiet()} searchLibrary={searchLibrary} />)
    choose('Every book')
    ask('w')
    ask('wh')
    ask('wha')
    ask('whale')
    await screen.findByRole('button', { name: /the whale/u })
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 2))
    expect(searchLibrary).toHaveBeenCalledTimes(1)
    expect(searchLibrary).toHaveBeenCalledWith('whale', MAX_LIBRARY_HITS + 1)
  })

  it('marks the chosen scope with the attribute its styling keys on', () => {
    /* ⚠️ **AN ATTRIBUTE A SELECTOR READS IS BEHAVIOUR.** `check-dead-css`
     * cannot see a rule whose attribute nothing writes — the phase-30 section
     * records three such rules shipping — so the value is pinned here. */
    render(<SearchPanel book={quiet()} searchLibrary={async () => [PASSAGE]} />)
    const inBook = screen.getByRole('radio', { name: 'This book' })
    const everyBook = screen.getByRole('radio', { name: 'Every book' })
    expect(inBook.getAttribute('data-chosen')).toBe('true')
    expect(everyBook.getAttribute('data-chosen')).toBeNull()
    choose('Every book')
    expect(screen.getByRole('radio', { name: 'Every book' }).getAttribute('data-chosen')).toBe('true')
    expect(screen.getByRole('radio', { name: 'This book' }).getAttribute('data-chosen')).toBeNull()
  })
})

describe('rows that share a book and a section survive a re-render', () => {
  it('replaces every one of them when the answer changes', async () => {
    /* Three rows that share a book, a section AND an offset — which the index
     * never produces, since that would be one passage — driven through a
     * re-render so the list changes under them.
     *
     * ⚠️ **THIS DOES NOT TEST THE KEY, AND IT WAS WRITTEN BELIEVING IT DID.**
     * Measured by applying the mutant: with every key replaced by one constant
     * this case still passes, because React warns about duplicate keys and
     * renders them anyway. What it does test is that a whole answer is
     * replaced, which is worth having on its own. The key's mutant is disabled
     * beside the code with that measurement. */
    const same = (mark: string) =>
      Array.from({ length: 3 }, () => ({ ...PASSAGE, quote: `the whale ${mark}` }))
    let answer = same('one')
    const searchLibrary = async () => answer
    render(<SearchPanel book={quiet()} searchLibrary={searchLibrary} />)
    choose('Every book')
    ask('whale')
    await screen.findByText(/in your library/u)
    expect(screen.getAllByRole('button', { name: /the whale one/u }).length).toBe(3)
    answer = same('two')
    ask('whales')
    await vi.waitFor(() =>
      expect(screen.getAllByRole('button', { name: /the whale two/u }).length).toBe(3),
    )
    expect(screen.queryByRole('button', { name: /the whale one/u })).toBeNull()
  })
})
