// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Cards } from './Cards'
import type { Card } from '../../core/cards'
import type { CardsView } from '../hooks/useCards'
import type { JumpTarget } from '../hooks/useJumps'

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

const view = (all: readonly Card[]): CardsView =>
  ({ all, persistent: true, make: vi.fn(), discard: vi.fn(), rekey: vi.fn() }) as unknown as CardsView

function draw(all: readonly Card[], onShelf?: (bookId: string) => boolean) {
  const onGoTo = vi.fn<(target: JumpTarget) => void>()
  render(
    <Cards
      cards={view(all)}
      bookId="open-book"
      {...(onShelf ? { onShelf } : {})}
      onGoTo={onGoTo}
    />,
  )
  return { onGoTo }
}

const row = (body: string) => screen.getByRole('button', { name: new RegExp(body, 'i') })

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

/**
 * A SESSION THAT MAY ONLY READ CARDS IS DRAWN AS ONE.
 *
 * `discard` was a required member of the narrowed `cards` prop, so the browser
 * client had to supply one — and it calls `card.remove`, which is `card:write`.
 * A browser session holds `readingGrant` alone (`webhost/lib/pump.ts`), so
 * every discard was refused after the card had already been removed
 * optimistically: the reader watched it vanish and reappear, which reads as the
 * shelf being broken rather than as a permission.
 */
describe('a read-only host', () => {
  it('draws no discard control when the host supplied no discard', () => {
    render(
      <Cards
        cards={{ all: [CARD()], persistent: true }}
        bookId="open-book"
        onGoTo={vi.fn()}
      />,
    )
    /* The card is still there to read — read-only, not absent. */
    expect(screen.getByRole('button', { name: /who narrates/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /discard card/i })).toBeNull()
  })

  /* Pinned so the guard above cannot be met by removing the control for every
     host, which would take the desktop's discard with it. */
  it('still draws it for a host that supplied one', () => {
    draw([CARD()])
    expect(screen.getByRole('button', { name: /discard card/i })).toBeTruthy()
  })
})
