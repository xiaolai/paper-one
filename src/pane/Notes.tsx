import { useMemo, useState } from 'react'
import { Layers, Trash2 } from 'lucide-react'
import { cardFromMark } from '../lib/cards'
import type { Mark } from '../lib/marks'
import { ICON } from '../lib/metrics'
import type { CardStore } from '../lib/useCards'
import type { MarkStore } from '../lib/useMarks'
import styles from './SidePane.module.css'

/**
 * Notes — the collection view.
 *
 * Distinct from a margin note: this is every mark across every book, browsable
 * and filterable, where a margin note is one annotation anchored to one line.
 *
 * §15's lexicon governs the labels here. A **mark** is the highlight, a
 * **note** is what you wrote on it, and the companion is never "AI" — which is
 * what the three filters below are named for.
 */

type NoteFilter = 'All' | 'Marks' | 'Notes' | 'Companion'
const FILTERS: readonly NoteFilter[] = ['All', 'Marks', 'Notes', 'Companion']

function matches(mark: Mark, filter: NoteFilter): boolean {
  switch (filter) {
    case 'All':
      return true
    case 'Companion':
      return mark.kind === 'companion'
    case 'Notes':
      return mark.note !== ''
    case 'Marks':
      return mark.kind === 'highlight'
  }
}

export interface NotesProps {
  marks: MarkStore
  /** Where a mark becomes a made thing — §15's line between note and card. */
  cards: CardStore
  /** The open book, so its marks can be shown first. Null when none is open. */
  bookId: string | null
  onGoTo?: (target: string) => void
}

export function Notes({ marks, cards, bookId, onGoTo }: NotesProps) {
  const [filter, setFilter] = useState<NoteFilter>('All')
  /** The mark whose note is being written. One at a time, like a text field. */
  const [editing, setEditing] = useState<string | null>(null)

  const shown = useMemo(
    () => marks.all.filter((mark) => matches(mark, filter)),
    [marks.all, filter],
  )

  /* Counted from what exists rather than written as prose: the fixture said
   * "1,204 highlights · 318 notes" under a list of three. */
  const noteCount = useMemo(
    () => marks.all.filter((mark) => mark.note !== '').length,
    [marks.all],
  )

  if (marks.all.length === 0) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyTitle}>Nothing marked yet</div>
        <div className={styles.emptyBody}>
          Select a passage in the book and choose Mark. Notes you write on a
          mark appear beside the line they belong to.
        </div>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelMeta}>
        <span style={{ flex: 1 }}>
          {marks.all.length} {marks.all.length === 1 ? 'mark' : 'marks'} · {noteCount}{' '}
          {noteCount === 1 ? 'note' : 'notes'}
        </span>
      </div>

      {/* §11: say what happened and what to do. A store that has quietly
          stopped saving looks exactly like one that works. */}
      {!marks.persistent && (
        <div className={styles.panelMeta}>
          <span>Marks are not being saved — this device's storage is unavailable.</span>
        </div>
      )}

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

      {shown.map((mark) => (
        <div key={mark.id} className={styles.note} data-kind={mark.kind}>
          {mark.kind === 'companion' && <div className={styles.noteKind}>Companion</div>}

          <button
            type="button"
            className={styles.noteJump}
            /* Only the open book can be navigated into. A mark from another
               book has nowhere to jump to until that book is opened, and a
               control that silently does nothing is worse than none. */
            disabled={mark.bookId !== bookId || !onGoTo}
            onClick={() => onGoTo?.(mark.cfi)}
          >
            <span className={styles.noteBody}>{mark.text}</span>
          </button>

          {editing === mark.id ? (
            <textarea
              className={styles.noteInput}
              defaultValue={mark.note}
              autoFocus
              placeholder="Write a note"
              onBlur={(event) => {
                marks.setNote(mark.id, event.target.value.trim())
                setEditing(null)
              }}
            />
          ) : (
            <button
              type="button"
              className={styles.noteComment}
              onClick={() => setEditing(mark.id)}
            >
              {mark.note || 'Add a note'}
            </button>
          )}

          <div className={styles.noteSource}>
            <span>{mark.chapter || 'Unknown chapter'}</span>
            <span style={{ display: 'flex', gap: 2 }}>
              {/* Notes stay raw; cards are made. This is the only place the
                  one becomes the other, which is what keeps the distinction
                  §15 draws visible rather than nominal. */}
              <button
                type="button"
                className={styles.noteDelete}
                aria-label="Make a card"
                title="Make a card"
                onClick={() => cards.make(cardFromMark(mark))}
              >
                <Layers size={ICON.inline} strokeWidth={ICON.stroke} />
              </button>
              <button
                type="button"
                className={styles.noteDelete}
                aria-label="Delete mark"
                title="Delete mark"
                onClick={() => marks.remove(mark.id)}
              >
                <Trash2 size={ICON.inline} strokeWidth={ICON.stroke} />
              </button>
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}
