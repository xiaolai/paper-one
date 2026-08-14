import { useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { CARD_KINDS, type CardKind } from '../lib/cards'
import { ICON } from '../lib/metrics'
import type { CardStore } from '../lib/useCards'
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
  cards: CardStore
  bookId: string | null
  onGoTo?: (target: string) => void
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

      <div className={styles.filters}>
        {FILTERS.map((label) => (
          <button
            key={label}
            type="button"
            className={styles.filter}
            data-on={filter === label}
            onClick={() => setFilter(label)}
          >
            {label}
          </button>
        ))}
      </div>

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
