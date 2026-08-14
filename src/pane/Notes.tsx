import { useState } from 'react'
import { NOTES } from '../data/fixtures'
import styles from './SidePane.module.css'

type NoteFilter = 'All' | 'Highlights' | 'Companion'
const FILTERS: readonly NoteFilter[] = ['All', 'Highlights', 'Companion']

/**
 * Notes — the collection view.
 *
 * Distinct from a margin note: this is every mark across every book, browsable
 * and filterable, where a margin note is one annotation anchored to one line.
 */
export function Notes() {
  const [filter, setFilter] = useState<NoteFilter>('All')

  const notes = NOTES.filter((note) =>
    filter === 'All'
      ? true
      : filter === 'Companion'
        ? note.kind === 'AI'
        : note.kind === 'Highlight',
  )

  return (
    <div className={styles.panel}>
      <div className={styles.panelMeta}>
        <span style={{ flex: 1 }}>1,204 highlights · 318 notes</span>
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
      {notes.map((note, index) => (
        <button key={index} type="button" className={styles.note} data-kind={note.kind}>
          {note.kind === 'AI' && <div className={styles.noteKind}>Companion</div>}
          <div className={styles.noteBody}>{note.body}</div>
          {note.comment && <div className={styles.noteComment}>{note.comment}</div>}
          <div className={styles.noteSource}>
            {note.book} · {note.at}
          </div>
        </button>
      ))}
    </div>
  )
}
