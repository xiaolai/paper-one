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
  /**
   * The three members this pane reads — not all seven of `CardsView`.
   *
   * NARROWED the way `SearchPanel`'s `book` and `Marginalia`'s `marks` were:
   * indexed access into the original, so the two cannot drift and every
   * existing caller still passes a whole `CardsView`. A host with a channel and
   * `card.list` can satisfy three; it cannot satisfy `make`, which is
   * synchronous and hands a `Card` straight back.
   *
   * ⚠️ **`discard` IS OPTIONAL, because one host cannot supply it truthfully.**
   *
   * The narrowing above stops one member short. A host with a channel and
   * `card.list` satisfies `all` and `persistent` — and `discard` calls
   * `card.remove`, which is `card:write`. The browser client holds exactly one
   * grant and it is a READ one — the host that serves a browser composes the
   * kernel's own read/write split, and says at length why widening it is a
   * decision. So every `card.remove` it sends is refused, always, by design.
   *
   * Requiring it did not make the browser able to discard; it made the browser
   * pass a function that could not work. The card vanished optimistically, the
   * refusal came back, and it reappeared — a delete button that undoes itself,
   * which reads as a bug in the shelf rather than as a permission.
   *
   * Absent, the control is not drawn. That is the honest rendering of "this
   * session may read cards and not change them", and it is the same shape
   * `onGoTo` and `onShelf` already use here.
   */
  cards: {
    readonly all: CardsView['all']
    readonly persistent: CardsView['persistent']
    readonly discard?: CardsView['discard'] | undefined
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
  onGoTo?: (target: JumpTarget) => void
}

export function Cards({ cards, bookId, onShelf, onGoTo }: CardsProps) {
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
            <span className={styles.noteBody}>{card.body}</span>
          </button>

          {card.answer && <div className={styles.noteComment}>{card.answer}</div>}

          <div className={styles.noteSource}>
            <span>{card.source || 'No source'}</span>
            {/* NOT DRAWN WITHOUT `discard`. A disabled button would still say
                "you could discard this, but not now", which is false — the
                browser client can never discard a card. Absence is the accurate
                statement. */}
            {cards.discard && (
              <button
                type="button"
                className={styles.noteDelete}
                aria-label="Discard card"
                onClick={() => cards.discard?.(card.id)}
              >
                <Trash2 size={ICON.inline} strokeWidth={ICON.stroke} />
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
