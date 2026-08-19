import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Layers, Trash2 } from 'lucide-react'
import { cardFromMark } from '../../core/cards'
import type { Mark } from '../../core/marks'
import type { MarkFocus } from '../hooks/useMarking'
import { ICON } from '../../core/metrics'
import { onBeforeClose } from '../../core/beforeClose'
import type { CardsView } from '../hooks/useCards'
import type { MarksView } from '../hooks/useMarks'
import { FilterChips } from './FilterChips'
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

/**
 * The note editor, which saves whatever it is holding when it goes away.
 *
 * Blur alone was not enough, and the gap was silent: closing the pane, changing
 * the filter, opening another book or quitting the window all remove a focused
 * textarea WITHOUT a blur event, so the note the reader had just typed was
 * discarded with no indication that it had not been kept. It saves on blur, on
 * unmount, and when the window is hidden or put away.
 */
interface NoteEditorProps {
  initial: string
  onCommit: (value: string) => void
  onDone: () => void
}

function NoteEditor({ initial, onCommit, onDone }: NoteEditorProps) {
  /**
   * The latest text, tracked as it is typed.
   *
   * Read from here rather than from the element, because by the time the
   * unmount cleanup runs React has already detached the ref — `field.current`
   * is null and the save silently keeps nothing, which is the exact failure
   * this editor exists to prevent, moved one step later. The element is still
   * needed for the initial value and for blur; it is just not the source of
   * truth at teardown.
   */
  const draft = useRef(initial)
  /** What is already stored, so an unchanged note is not written again. */
  const stored = useRef(initial)
  const commit = useRef(onCommit)
  commit.current = onCommit

  const save = useCallback(() => {
    const value = draft.current.trim()
    if (value === stored.current) return
    stored.current = value
    commit.current(value)
  }, [])

  /**
   * Hand the draft over before the window closes.
   *
   * THIS is what makes a note survive quitting, and it is a handover rather than
   * a save: `save` puts the text into the marks store, whose queue the close
   * handler then drains. Two halves of one thing — see `beforeClose`.
   *
   * `pagehide` cannot do this job and never could. It fires as the webview is
   * torn down, so it starts work nothing will finish; and Tauri's close-request
   * arrives BEFORE it, so by the time it ran the queue had already been declared
   * empty. It stays below as the browser's path, where there is no close-request
   * to intercept.
   */
  useEffect(() => onBeforeClose(save), [save])

  /**
   * And save while they type, which covers what no shutdown hook can.
   *
   * A close is orderly. A crash, a force-quit or a power cut is not, and neither
   * runs anything. A pause of a second is the difference between losing a
   * paragraph and losing a sentence.
   */
  useEffect(() => {
    const idle = window.setInterval(save, 1000)
    return () => window.clearInterval(idle)
  }, [save])

  useEffect(() => {
    // `pagehide` rather than `beforeunload`: it fires on the path a webview
    // actually takes when the window goes away, and it is not blocked by the
    // conditions that make `beforeunload` unreliable. In Tauri the close is
    // intercepted before this; in a browser this is all there is.
    window.addEventListener('pagehide', save)
    document.addEventListener('visibilitychange', save)
    return () => {
      window.removeEventListener('pagehide', save)
      document.removeEventListener('visibilitychange', save)
      save()
    }
  }, [save])

  return (
    <textarea
      className={styles.noteInput}
      defaultValue={initial}
      autoFocus
      placeholder="Write a note"
      onChange={(event) => {
        draft.current = event.target.value
      }}
      onBlur={() => {
        save()
        onDone()
      }}
    />
  )
}

export interface NotesProps {
  marks: MarksView
  /** Where a mark becomes a made thing — §15's line between note and card. */
  cards: CardsView
  /** The open book, so its marks can be shown first. Null when none is open. */
  bookId: string | null
  /**
   * Removes a mark from the STORE and from the page.
   *
   * Deleting used to call `marks.remove` straight, which leaves the drawn
   * annotation and its cached Range exactly where they were: the note vanished
   * from this list while its highlight stayed on the text, and the margin went
   * on showing it, until something else happened to force a redraw.
   */
  onDelete: (mark: Mark) => void
  /**
   * The mark to reveal, from a click on the page or on a margin note.
   *
   * Opening the panel is not showing the mark: the list holds every mark in
   * every book, so "open Notes" for a reader with any history means landing at
   * the top of a long list with no indication of which row was being asked
   * for. This scrolls to it, and opens its editor when the request was to
   * write rather than to read.
   */
  focus?: MarkFocus | null
  onGoTo?: (target: string) => void
}

export function Notes({ marks, cards, bookId, onDelete, focus, onGoTo }: NotesProps) {
  const [filter, setFilter] = useState<NoteFilter>('All')
  /** The mark whose note is being written. One at a time, like a text field. */
  /* Cross-book marks are read HERE, on mount, because this is the only view
   * that wants them — marks live in each book's folder, so answering "every
   * book's marks" costs one read per book. This pane mounts only when it is
   * open, so a reader who never opens Notes never pays for the scan. */
  const { loadAll } = marks
  useEffect(() => {
    loadAll()
  }, [loadAll])

  const [editing, setEditing] = useState<string | null>(null)
  const rows = useRef(new Map<string, HTMLDivElement>())

  /* The open book's marks first, which the prop contract promises and this
   * did not do: `marks.all` is every book's, in store order, so a reader with
   * any history opened Notes onto somebody else's chapter. Within each group
   * the store's own order is kept — it is already book order. */
  const shown = useMemo(() => {
    const matching = marks.all.filter((mark) => matches(mark, filter))
    if (!bookId) return matching
    return [
      ...matching.filter((mark) => mark.bookId === bookId),
      ...matching.filter((mark) => mark.bookId !== bookId),
    ]
  }, [marks.all, filter, bookId])

  /* Reveal whatever was asked for.
   *
   * The filter is cleared first when it would hide the mark: asking to see a
   * highlight while the list is filtered to Notes would otherwise scroll to a
   * row that is not rendered, which looks exactly like the click doing
   * nothing. Keyed on the whole focus object, nonce included, so asking twice
   * for the same mark works twice. */
  useEffect(() => {
    if (!focus) return
    const target = marks.all.find((mark) => mark.id === focus.id)
    if (!target) return
    if (!matches(target, filter)) setFilter('All')
    if (focus.edit) setEditing(focus.id)
    // After paint, so the row exists to scroll to when the filter just changed.
    const frame = requestAnimationFrame(() => {
      rows.current.get(focus.id)?.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
    // `filter` is deliberately absent: this reacts to a focus request, not to
    // the reader changing the filter themselves afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, marks.all])

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

      <FilterChips options={FILTERS} active={filter} onSelect={setFilter} label="Filter marks" />

      {shown.length === 0 && marks.all.length > 0 && (
        <div className={styles.empty}>
          <div className={styles.emptyBody}>
            {/* Says which filter is empty. A blank panel under a selected chip
                reads as the marks having been lost. */}
            No {filter === 'All' ? 'marks' : filter.toLowerCase()} yet.
          </div>
        </div>
      )}

      {shown.map((mark) => (
        <div
          key={mark.id}
          ref={(node) => {
            if (node) rows.current.set(mark.id, node)
            else rows.current.delete(mark.id)
          }}
          className={styles.note}
          data-kind={mark.kind}
          data-tint={mark.tint}
          data-focused={mark.id === focus?.id}
        >
          {mark.kind === 'companion' && (
            // The kind is stated as data as well as text: the amber that means
            // "the companion wrote this" is keyed on it — see `.noteKind`.
            <div className={styles.noteKind} data-kind="Companion">
              Companion
            </div>
          )}

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
            <NoteEditor
              initial={mark.note}
              onCommit={(value) => marks.setNote(mark.id, value)}
              onDone={() => setEditing(null)}
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
                onClick={() => onDelete(mark)}
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
