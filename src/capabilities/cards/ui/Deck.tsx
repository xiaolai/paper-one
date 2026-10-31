import { useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { Trash2 } from 'lucide-react'
import { CAPABILITY_UI as ui, CARD_KINDS, ICON, rowHue, type Card, type CardKind, type KernelServices } from '../../../kernel'

/**
 * Cards — the made things, in the pane.
 *
 * §15: a note is raw and a card is made, so this is not another view of Notes.
 * What it shows is only what the reader has actually made — the design's own
 * card fixtures are not seeded here, for the same reason the Notes fixtures
 * were removed: a shelf of worked ideas about a book you have not read is a
 * claim about your reading that is not true.
 */

type Filter = 'All' | CardKind
const FILTERS: readonly Filter[] = ['All', ...CARD_KINDS]

/** A jump: the same shape the panel's host hands every contributed pane. */
type GoTo = (target: { bookId: string; cfi: string }) => void

export interface CardsProps {
  cards: {
    readonly all: readonly Card[]
    readonly persistent: boolean
    readonly discard: (id: string) => void
  }
  bookId: string | null
  /**
   * Whether a book is on the shelf, and so can be opened at all.
   *
   * THE SAME RULE MARGINALIA USES, and it is here because leaving it out was
   * the visible half of one defect. That panel narrowed its guard from "not
   * the open book" to "not on the shelf" when the jump stack landed; this one
   * kept the old test, so a mark from another book was reachable and a card
   * from that same book was a dead control. Two panels of one shape, two
   * behaviours.
   *
   * Absent, every card outside the open book stays disabled — which is what
   * this panel did before there was anywhere to come back to.
   */
  onShelf?: ((bookId: string) => boolean) | undefined
  onGoTo?: GoTo | undefined
}

export function Deck({ cards, bookId, onShelf, onGoTo }: CardsProps) {
  const [filter, setFilter] = useState<Filter>('All')

  const shown = useMemo(
    () => cards.all.filter((card) => filter === 'All' || card.kind === filter),
    [cards.all, filter],
  )

  if (cards.all.length === 0) {
    return (
      <div className={ui.empty}>
        <div className={ui.emptyTitle}>No cards yet</div>
        <div className={ui.emptyBody}>
          Notes stay raw; cards are made. Mark a passage, then make a card from
          it in Notes.
        </div>
        {/* The warning belongs here too. This branch is reached in exactly the
            case that needs it most: a store that cannot write, whose last card
            was discarded, looks identical to a reader who has never made one. */}
        {!cards.persistent && (
          <div className={ui.emptyBody}>
            Cards are not being saved — this device&apos;s storage is unavailable.
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={ui.panel}>
      <div className={ui.panelMeta}>
        <span className={ui.grow}>
          {cards.all.length} {cards.all.length === 1 ? 'card' : 'cards'}
        </span>
      </div>

      {/* §11: say what happened and what to do. Cards that are not being saved
          look exactly like cards that are, until the next launch. */}
      {!cards.persistent && (
        <div className={ui.panelMeta}>
          <span>Cards are not being saved — this device&apos;s storage is unavailable.</span>
        </div>
      )}

      <div className={ui.filters} role="group" aria-label="Filter cards">
        {FILTERS.map((option) => (
          <button
            key={option}
            type="button"
            className={ui.filter}
            data-on={filter === option}
            aria-pressed={filter === option}
            onClick={() => setFilter(option)}
          >
            {option}
          </button>
        ))}
      </div>

      {shown.length === 0 && (
        <div className={ui.empty}>
          <div className={ui.emptyBody}>
            {/* Named, for the same reason as Notes: a blank list under a
                selected chip looks like the cards are gone. */}
            No {filter === 'All' ? 'cards' : `${filter.toLowerCase()} cards`} yet.
          </div>
        </div>
      )}

      {shown.map((card) => (
        <div key={card.id} className={ui.card} style={{ '--card-hue': rowHue(card.id) } as CSSProperties}>
          <div className={ui.cardKind} data-kind={card.kind}>
            {card.kind}
          </div>

          <button
            type="button"
            className={ui.cardJump}
            /* TWO REASONS A CARD CANNOT BE FOLLOWED, and only one of them
               narrowed. A card made from nothing has no anchor and never will
               — §15's line between a card and a mark is precisely that a card
               need not come from a passage. But "another book" is no longer a
               reason: the host opens that book at the anchor and ⌘[ brings the
               reader home, exactly as it does for a mark. What remains is a
               book that has LEFT the shelf, which cannot be opened at all. */
            disabled={!card.cfi || !onGoTo || !(card.bookId === bookId || (onShelf?.(card.bookId) ?? false))}
            onClick={() => card.cfi && onGoTo?.({ bookId: card.bookId, cfi: card.cfi })}
          >
            <span className={ui.cardBody}>{card.body}</span>
          </button>

          {card.answer && <div className={ui.cardAnswer}>{card.answer}</div>}

          <div className={ui.cardFoot}>
            <span>{card.source || 'No source'}</span>
          <button
            type="button"
            className={ui.iconButton}
            aria-label="Discard card"
            onClick={() => cards.discard(card.id)}
          >
            <Trash2 size={ICON.inline} strokeWidth={ICON.stroke} />
          </button>
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * The deck, reading the kernel's stores: cards from the card store and "is it on
 * the shelf" from the library. The panel itself takes plain values, so it can be
 * drawn in a test without either.
 */
export function DeckPane({
  services,
  bookId,
  goTo,
}: {
  services: Pick<KernelServices, 'cards' | 'library'>
  bookId: string | null
  goTo?: GoTo | undefined
}) {
  const { cards, library } = services
  const snapshot = useSyncExternalStore(cards.subscribe, cards.getSnapshot, cards.getSnapshot)
  const books = useSyncExternalStore(library.subscribe, library.getSnapshot, library.getSnapshot)
  /* One set per change of the shelf: a panel of a few hundred rows asks per row. */
  const onShelf = useMemo(() => {
    const ids = new Set(books.map((one) => one.bookId))
    return (id: string) => ids.has(id)
  }, [books])
  const view = useMemo(
    () => ({
      all: snapshot.all,
      persistent: snapshot.persistent,
      /* A rejection is a store that could not take the write, and `persistent`
         is what says so. What must not happen is an unhandled rejection. */
      discard: (id: string) => void cards.remove(id).catch(() => {}),
    }),
    [snapshot.all, snapshot.persistent, cards],
  )
  return <Deck cards={view} bookId={bookId} onShelf={onShelf} onGoTo={goTo} />
}
