// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKernelServices, rowHue, type Card } from '../../../kernel'
import { Deck, DeckPane } from './Deck'

/**
 * Which cards can be followed back to the passage they came from.
 *
 * THE SECOND HALF OF ONE DEFECT. Marginalia narrowed its guard from "not the
 * open book" to "not on the shelf" when the jump stack landed, and this panel
 * kept the old test — so a mark from another book was reachable and a card
 * from that same book was a dead control. Two panels of one shape behaving
 * differently is the thing this repository calls a class rather than two bugs.
 */

afterEach(cleanup)

const CARD = (over: Partial<Card> = {}): Card =>
  ({
    id: 'c1',
    bookId: 'open-book',
    kind: 'recall',
    body: 'who narrates',
    answer: 'Ishmael',
    source: 'Loomings',
    cfi: 'epubcfi(/6/4!/4/2)',
    createdAt: 1,
    ...over,
  }) as Card

const view = (all: readonly Card[], persistent = true) => ({ all, persistent, discard: vi.fn() })

function draw(all: readonly Card[], onShelf?: (bookId: string) => boolean) {
  const onGoTo = vi.fn<(target: { bookId: string; cfi: string }) => void>()
  render(
    <Deck
      cards={view(all)}
      bookId="open-book"
      {...(onShelf ? { onShelf } : {})}
      onGoTo={onGoTo}
    />,
  )
  return { onGoTo }
}

const row = (body: string) => screen.getByRole('button', { name: new RegExp(body, 'i') })

/* A ROW WITHOUT `--card-hue` DRAWS NO BAR AT ALL, and says nothing about it: the
   shared `.paper-cap-card::before` has no fallback colour. */
describe('a card row', () => {
  it('carries its own hue for the colour bar', () => {
    draw([CARD({ id: 'c7' })])
    const drawn = row('who narrates').closest<HTMLElement>('[style]')
    expect(drawn?.style.getPropertyValue('--card-hue')).toBe(String(rowHue('c7')))
  })
})

describe('a card from the open book', () => {
  it('is enabled and jumps to its own anchor', () => {
    const { onGoTo } = draw([CARD()])
    expect(row('who narrates').hasAttribute('disabled')).toBe(false)
    row('who narrates').click()
    expect(onGoTo).toHaveBeenCalledWith({ bookId: 'open-book', cfi: 'epubcfi(/6/4!/4/2)' })
  })
})

describe('a card from another book', () => {
  it('is enabled when that book is on the shelf', () => {
    /* The behaviour Marginalia already had. A card is explicitly cross-book —
       that is §15's line between a card and a mark — so if either panel should
       reach across, it is this one. */
    const other = CARD({ id: 'c2', bookId: 'other-book', body: 'stately plump' })
    const { onGoTo } = draw([other], (id) => id === 'other-book')
    expect(row('stately plump').hasAttribute('disabled')).toBe(false)
    row('stately plump').click()
    expect(onGoTo).toHaveBeenCalledWith({ bookId: 'other-book', cfi: other.cfi })
  })

  it('stays disabled when that book has left the shelf', () => {
    draw([CARD({ id: 'c3', bookId: 'gone', body: 'a lost card' })], () => false)
    expect(row('a lost card').hasAttribute('disabled')).toBe(true)
  })

  it('stays disabled when nothing was asked about the shelf', () => {
    draw([CARD({ id: 'c4', bookId: 'other-book', body: 'unasked' })])
    expect(row('unasked').hasAttribute('disabled')).toBe(true)
  })
})

describe('a card made from no passage', () => {
  it('stays disabled however reachable its book is', () => {
    /* THE REASON THAT DID NOT NARROW. A card need not come from a passage at
       all, and one with no anchor has nowhere to go even in the open book —
       which is exactly what distinguishes a card from a mark. */
    draw([CARD({ id: 'c5', cfi: null, body: 'made from nothing' })], () => true)
    expect(row('made from nothing').hasAttribute('disabled')).toBe(true)
  })
})

describe('what the panel says', () => {
  it('names an empty deck, and how to start one', () => {
    render(<Deck cards={view([])} bookId={null} />)
    expect(screen.getByText('No cards yet')).toBeTruthy()
    expect(screen.getByText(/Mark a passage, then make a card from it in Notes/)).toBeTruthy()
    expect(screen.queryByText(/not being saved/)).toBeNull()
  })

  it('says cards are not being saved, over an empty deck and over a full one', () => {
    render(<Deck cards={view([], false)} bookId={null} />)
    expect(screen.getByText("Cards are not being saved — this device's storage is unavailable.")).toBeTruthy()
    cleanup()
    render(<Deck cards={view([CARD()], false)} bookId={null} />)
    expect(screen.getByText("Cards are not being saved — this device's storage is unavailable.")).toBeTruthy()
  })

  it('counts its cards in the singular and the plural', () => {
    render(<Deck cards={view([CARD()])} bookId={null} />)
    expect(screen.getByText('1 card')).toBeTruthy()
    cleanup()
    render(<Deck cards={view([CARD(), CARD({ id: 'c2' })])} bookId={null} />)
    expect(screen.getByText('2 cards')).toBeTruthy()
  })

  it('shows no answer line for a card with none, and says so when it has no source', () => {
    render(<Deck cards={view([CARD({ answer: '', source: '' })])} bookId={null} />)
    expect(screen.queryByText('Ishmael')).toBeNull()
    expect(screen.getByText('No source')).toBeTruthy()
  })

  it('filters by kind and names the kind it found none of', () => {
    render(<Deck cards={view([CARD({ kind: 'Idea', body: 'an idea' }), CARD({ id: 'c2', kind: 'Excerpt', body: 'a quote' })])} bookId={null} />)
    const filters = screen.getByRole('group', { name: 'Filter cards' })
    expect(within(filters).getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(filters).getByRole('button', { name: 'Excerpt' }))
    expect(screen.queryByText('an idea')).toBeNull()
    expect(screen.getByText('a quote')).toBeTruthy()
    expect(within(filters).getByRole('button', { name: 'Excerpt' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(filters).getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(within(filters).getByRole('button', { name: 'Recall' }))
    expect(screen.getByText('No recall cards yet.')).toBeTruthy()
  })

  it('discards the card whose bin was pressed', () => {
    const cards = view([CARD({ id: 'c9' })])
    render(<Deck cards={cards} bookId={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Discard card' }))
    expect(cards.discard).toHaveBeenCalledWith('c9')
  })
})

describe('the panel over the kernel stores', () => {
  const stored = async () => {
    const services = createKernelServices({ fs: null, storage: null })
    await services.cards.add({ ...CARD(), bookId: 'open-book', body: 'in the store' })
    return services
  }

  it('reads the store, and a discard goes back to it', async () => {
    const services = await stored()
    render(<DeckPane services={services} bookId={null} />)
    expect(screen.getByText('in the store')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Discard card' }))
    await waitFor(() => expect(services.cards.getSnapshot().all).toEqual([]))
    expect(screen.getByText('No cards yet')).toBeTruthy()
  })

  it('asks the shelf whether a book can be opened', async () => {
    const services = await stored()
    const goTo = vi.fn()
    render(<DeckPane services={services} bookId={null} goTo={goTo} />)
    /* Not the open book and not on the shelf: nowhere to go. */
    expect(screen.getByRole('button', { name: /in the store/ }).hasAttribute('disabled')).toBe(true)
    cleanup()
    render(<DeckPane services={services} bookId="open-book" goTo={goTo} />)
    fireEvent.click(screen.getByRole('button', { name: /in the store/ }))
    expect(goTo).toHaveBeenCalledWith({ bookId: 'open-book', cfi: 'epubcfi(/6/4!/4/2)' })
  })
})
