import { useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { CARD_KINDS, type CardKind } from '../../core/cards'
import { ICON } from '../../core/metrics'
import type { CardsView } from '../hooks/useCards'
import type { JumpTarget } from '../hooks/useJumps'
import { FilterChips } from './FilterChips'
import styles from './SidePane.module.css'

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

export interface CardsProps {
  cards: CardsView
  bookId: string | null
  onGoTo?: (target: JumpTarget) => void
}

export function Cards({ cards, bookId, onGoTo }: CardsProps) {
  const [filter, setFilter] = useState<Filter>('All')

  const shown = useMemo(
    () => cards.all.filter((card) => filter === 'All' || card.kind === filter),
    [cards.all, filter],
  )

  if (cards.all.length === 0) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyTitle}>No cards yet</div>
        <div className={styles.emptyBody}>
          Notes stay raw; cards are made. Mark a passage, then make a card from
          it in Notes.
        </div>
        {/* The warning belongs here too. This branch is reached in exactly the
            case that needs it most: a store that cannot write, whose last card
            was discarded, looks identical to a reader who has never made one. */}
        {!cards.persistent && (
          <div className={styles.emptyBody}>
            Cards are not being saved — this device&apos;s storage is unavailable.
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelMeta}>
        <span style={{ flex: 1 }}>
          {cards.all.length} {cards.all.length === 1 ? 'card' : 'cards'}
        </span>
      </div>

      {/* §11: say what happened and what to do. Cards that are not being saved
          look exactly like cards that are, until the next launch. */}
      {!cards.persistent && (
        <div className={styles.panelMeta}>
          <span>Cards are not being saved — this device&apos;s storage is unavailable.</span>
        </div>
      )}

      <FilterChips options={FILTERS} active={filter} onSelect={setFilter} label="Filter cards" />

      {shown.length === 0 && (
        <div className={styles.empty}>
          <div className={styles.emptyBody}>
            {/* Named, for the same reason as Notes: a blank list under a
                selected chip looks like the cards are gone. */}
            No {filter === 'All' ? 'cards' : `${filter.toLowerCase()} cards`} yet.
          </div>
        </div>
      )}

      {shown.map((card) => (
        <div key={card.id} className={styles.note}>
          <div className={styles.noteKind} data-kind={card.kind}>
            {card.kind}
          </div>

          <button
            type="button"
            className={styles.noteJump}
            /* A card made in another book has nowhere to jump to until that
               book is open, and a card made from nothing has no anchor at all. */
            disabled={card.bookId !== bookId || !card.cfi || !onGoTo}
            onClick={() => card.cfi && onGoTo?.(card.cfi)}
          >
            <span className={styles.noteBody}>{card.body}</span>
          </button>

          {card.answer && <div className={styles.noteComment}>{card.answer}</div>}

          <div className={styles.noteSource}>
            <span>{card.source || 'No source'}</span>
            <button
              type="button"
              className={styles.noteDelete}
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
