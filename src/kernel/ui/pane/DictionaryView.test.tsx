// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cardFromLookup, type Lookup, type LookupOccurrence } from '../../core/lookups'
import type { CardsView } from '../hooks/useCards'
import type { GlossState } from '../hooks/useGloss'
import { DictionaryView, type DictionaryViewProps } from './DictionaryView'

/**
 * The Dictionary view on its own (phase 17, WI-17.3) — the rules the view
 * makes, rendered. `Marginalia.test.tsx` holds what the PANEL does with it: the
 * chip, the count, turning to it when a lookup starts.
 */

afterEach(cleanup)

const place = (over: Partial<LookupOccurrence> = {}): LookupOccurrence => ({
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

const lookup = (over: Partial<Lookup> = {}): Lookup => ({
  term: 'wharves',
  occurrences: [place()],
  firstAt: 1_000,
  lastAt: 1_000,
  ...over,
})

function draw(over: Partial<DictionaryViewProps> = {}) {
  const props: DictionaryViewProps = {
    lookups: [lookup()],
    persistent: true,
    live: { kind: 'idle' },
    bookId: 'open-book',
    thisBookOnly: false,
    now: 61_000,
    platform: 'macos',
    ...over,
  }
  return render(<DictionaryView {...props} />)
}

const sentenceButton = (text: RegExp) => screen.getByRole('button', { name: text })

describe('the history', () => {
  it('shows the word as it was spelled, the sense it had, and where it came from', () => {
    draw({ lookups: [lookup({ occurrences: [place({ spelled: 'Wharves' })] })] })

    expect(screen.getByText('Wharves')).not.toBeNull()
    expect(screen.getByText('Structures along a shore where ships dock.')).not.toBeNull()
    /* The open book is not named: the reader is in it. */
    expect(screen.getByText(/^Loomings · 1 min/)).not.toBeNull()
    expect(screen.queryByText(/Another book/)).toBeNull()
  })

  /* One word met in two places is two rows under one headword, and React must be
     able to tell them apart — a shared key is a console error and, on the next
     update, a sense drawn beside the wrong sentence. */
  it('keeps two places of one word apart', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    draw({
      lookups: [lookup({ occurrences: [place(), place({ cfi: 'epubcfi(/6/8!/4/2,/1:0,/1:7)', sentence: 'Wharves again.' })] })],
    })

    expect(screen.getAllByRole('button', { name: /Belted round|Wharves again/ })).toHaveLength(2)
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  /* TWO UNANCHORED PLACES IN ONE BOOK ARE TWO PLACES. The record tells them
     apart by chapter and sentence (`placeKey`); keyed by book and anchor alone,
     both rows here shared one key — a console error, and on the next update a
     sense drawn beside the other place's sentence. */
  it('keeps two unanchored places in one book apart', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    draw({
      lookups: [
        lookup({
          occurrences: [
            place({ cfi: '', sentence: 'Wharves, unanchored.' }),
            place({ cfi: '', sentence: 'Wharves again, unanchored.' }),
          ],
        }),
      ],
    })

    expect(screen.getAllByRole('button', { name: /unanchored/ })).toHaveLength(2)
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('names another book, and says so when it has no title', () => {
    draw({
      lookups: [
        lookup({ occurrences: [place({ bookId: 'ulysses', sentence: 'One.' })] }),
        lookup({ term: 'gam', occurrences: [place({ bookId: 'untitled', spelled: 'gam', sentence: 'Two.' })] }),
      ],
      titleOf: (id) => (id === 'ulysses' ? 'Ulysses' : undefined),
    })

    expect(screen.getByText(/^Ulysses · Loomings/)).not.toBeNull()
    expect(screen.getByText(/^Another book · Loomings/)).not.toBeNull()
  })

  it('says a chapter it does not know is unknown', () => {
    draw({ lookups: [lookup({ occurrences: [place({ chapter: '' })] })] })

    expect(screen.getByText(/Unknown chapter/)).not.toBeNull()
  })

  it('narrows to this book’s places, and hides a word with none there', () => {
    draw({
      thisBookOnly: true,
      lookups: [
        lookup({ occurrences: [place(), place({ bookId: 'other', cfi: 'x', sentence: 'Elsewhere.' })] }),
        lookup({ term: 'gam', occurrences: [place({ bookId: 'other', spelled: 'gam', sentence: 'A gam.' })] }),
      ],
    })

    expect(screen.queryByText('gam')).toBeNull()
    expect(screen.queryByRole('button', { name: /Elsewhere/ })).toBeNull()
    expect(sentenceButton(/Belted round/)).not.toBeNull()
  })

  /* NEWEST FIRST, BY WHAT IS SHOWN. The store orders words by their newest place
     in ANY book, so under This book a word met elsewhere a moment ago sat above
     one met here since (#123). Handed over in an order the tie has to settle:
     two words met at once are ordered by term. */
  it('orders words under This book by their newest place in it', () => {
    draw({
      thisBookOnly: true,
      lookups: [
        lookup({
          term: 'gam',
          lastAt: 5_000,
          occurrences: [
            place({ bookId: 'other', cfi: 'a', spelled: 'gam', sentence: 'A gam elsewhere.', at: 5_000 }),
            place({ cfi: 'b', spelled: 'gam', sentence: 'A gam here.', at: 1_000 }),
          ],
        }),
        lookup({ term: 'wharves', lastAt: 3_000, occurrences: [place({ at: 3_000 })] }),
        lookup({ term: 'coral', lastAt: 3_000, occurrences: [place({ cfi: 'c', spelled: 'coral', sentence: 'Coral.', at: 3_000 })] }),
      ],
    })

    expect(screen.getAllByText(/^(coral|gam|wharves)$/u).map((node) => node.textContent)).toEqual(['coral', 'wharves', 'gam'])
  })

  /* With no book open, "this book" names nothing, so nothing is narrowed. */
  it('narrows nothing when no book is open', () => {
    draw({ thisBookOnly: true, bookId: null, lookups: [lookup({ occurrences: [place({ bookId: 'other' })] })] })

    expect(screen.getByText('wharves')).not.toBeNull()
  })
})

/** Marginalia's reachability rule, for a place. */
describe('whether a place can be jumped to', () => {
  it('jumps to a place in the open book', () => {
    const onGoTo = vi.fn()
    draw({ onGoTo })

    sentenceButton(/Belted round/).click()

    expect(onGoTo).toHaveBeenCalledWith({ bookId: 'open-book', cfi: 'epubcfi(/6/4!/4/2,/1:66,/1:73)' })
  })

  it('jumps to another book that is on the shelf, and not to one that has left it', () => {
    draw({
      onGoTo: vi.fn(),
      onShelf: (id) => id === 'shelved',
      lookups: [
        lookup({
          occurrences: [
            place({ bookId: 'shelved', cfi: 'a', sentence: 'On the shelf.' }),
            place({ bookId: 'gone', cfi: 'b', sentence: 'Left the shelf.' }),
          ],
        }),
      ],
    })

    expect(sentenceButton(/On the shelf/).hasAttribute('disabled')).toBe(false)
    expect(sentenceButton(/Left the shelf/).hasAttribute('disabled')).toBe(true)
  })

  /* Another book is reachable only when the host says it is on the shelf; with
     nothing to ask, it is not assumed to be. */
  it('does not jump to another book when nothing can say it is on the shelf', () => {
    const onGoTo = vi.fn()
    draw({ onGoTo, lookups: [lookup({ occurrences: [place({ bookId: 'elsewhere' })] })] })

    expect(sentenceButton(/Belted round/).hasAttribute('disabled')).toBe(true)
  })

  it('does not jump to a place with no anchor, nor anywhere with no way to go', () => {
    draw({ onGoTo: vi.fn(), lookups: [lookup({ occurrences: [place({ cfi: '' })] })] })
    expect(sentenceButton(/Belted round/).hasAttribute('disabled')).toBe(true)
    cleanup()

    draw()
    expect(sentenceButton(/Belted round/).hasAttribute('disabled')).toBe(true)
  })
})

describe('what a reader can do with a word', () => {
  it('removes a word by its term, where the host can remove', () => {
    const onRemove = vi.fn()
    draw({ onRemove })

    fireEvent.click(screen.getByRole('button', { name: 'Remove “wharves” from your lookups' }))

    expect(onRemove).toHaveBeenCalledWith('wharves')
  })

  it('offers no remove where the host cannot remove', () => {
    draw()

    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull()
  })

  it('makes a card of a place, where the host can make one', () => {
    const make = vi.fn()
    draw({ cards: { make } as unknown as CardsView })

    fireEvent.click(screen.getByRole('button', { name: 'Make a card of “wharves”' }))

    expect(make).toHaveBeenCalledWith(cardFromLookup(place()))
  })

  it('offers no card where the host cannot make one', () => {
    draw()

    expect(screen.queryByRole('button', { name: /Make a card/ })).toBeNull()
  })
})

/** The lookup happening now — the lookup face's doctrine, in a row. */
describe('the live entry', () => {
  it.each([
    ['asking', { kind: 'asking', term: 'gam' } as const, 'Looking up', 'Looking…'],
    ['ready', { kind: 'ready', term: 'gam', text: 'A meeting.' } as const, 'Looked up', 'A meeting.'],
  ])('is amber while %s', (_name, live, label, body) => {
    draw({ live })

    const entry = screen.getByRole('status')
    expect(entry.getAttribute('data-kind')).toBe('companion')
    expect(entry.textContent).toContain(label)
    expect(entry.textContent).toContain('gam')
    expect(entry.textContent).toContain(body)
  })

  it.each([
    ['failed', { kind: 'failed', term: 'gam', reason: 'The runtime stopped' } as const, 'Paper couldn’t define “gam”. The runtime stopped'],
    ['unavailable', { kind: 'unavailable', term: 'gam', installAt: null } as const, 'Paper needs a language model to define “gam”.'],
    ['tooLong', { kind: 'tooLong' } as const, 'That passage is too long to look up — select a word or a short phrase.'],
  ])('is not amber when %s', (_name, live: GlossState, said) => {
    draw({ live })

    const entry = screen.getByRole('status')
    expect(entry.getAttribute('data-kind')).not.toBe('companion')
    expect(entry.getAttribute('data-place')).toBe('true')
    expect(entry.textContent).toContain('Look up')
    /* THE LINE EXACTLY, not merely containing it: a state with no cause has
       nothing to run after its sentence, and running the missing one on anyway
       showed the reader the word "null" where a reason would be. */
    expect(screen.getByText(said)).not.toBeNull()
  })

  it('draws no live entry while nothing is being looked up', () => {
    draw()

    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('what it says around the list', () => {
  it('invites a first lookup, naming the key, when there is nothing to show', () => {
    draw({ lookups: [] })

    expect(screen.getByText(/^No lookups yet\. Select a word and choose Look up, or press ⌃⌘D/)).not.toBeNull()
  })

  /* WHAT IT PROMISES TO KEEP IS WHAT IT KEEPS (#126): a lookup is filed when
     Paper defines the word, not when it is asked — and a history that is not
     being saved is held only until Paper closes. */
  it('promises to keep only definitions, and only for as long as it can', () => {
    draw({ lookups: [] })
    expect(screen.getByText(/— every word Paper defines is kept here\.$/u)).not.toBeNull()
    cleanup()

    draw({ lookups: [], persistent: false })
    expect(screen.queryByText(/kept here/u)).toBeNull()
    expect(screen.getByText(/— the words Paper defines are listed here until you close Paper\.$/u)).not.toBeNull()
  })

  it('says it is this book that has none, under This book', () => {
    draw({ lookups: [], thisBookOnly: true })

    expect(screen.getByText(/^No lookups in this book yet\./)).not.toBeNull()
  })

  /* With no book open there is no "this book" to have none in. */
  it('does not say "this book" when no book is open', () => {
    draw({ lookups: [], thisBookOnly: true, bookId: null })

    expect(screen.getByText(/^No lookups yet\./)).not.toBeNull()
  })

  it('names the key the way this keyboard spells it', () => {
    draw({ lookups: [], platform: 'windows' })

    expect(screen.getByText(/press Ctrl\+Shift\+D/)).not.toBeNull()
  })

  /* A LOOKUP ON NOW IS SOMETHING TO SHOW: the invitation does not stand under it. */
  it('does not invite a lookup while one is on', () => {
    draw({ lookups: [], live: { kind: 'asking', term: 'gam' } })

    expect(screen.queryByText(/No lookups/)).toBeNull()
  })

  it('states the caps beside a list, and not over an empty one', () => {
    draw()
    expect(screen.getByText('Paper keeps the last 500 words you looked up, and 3 places for each.')).not.toBeNull()
    cleanup()

    draw({ lookups: [] })
    expect(screen.queryByText(/Paper keeps the last/)).toBeNull()
  })

  it('says a history that is not being saved', () => {
    draw({ persistent: false })

    expect(screen.getByText("Your lookups are not being saved — this device's storage is unavailable.")).not.toBeNull()
  })

  it('says nothing about saving while it saves', () => {
    draw()

    expect(screen.queryByText(/not being saved/)).toBeNull()
  })
})
