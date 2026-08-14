import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Mark } from './marks'
import type { SelectionSnapshot } from '../reader/session'
import type { Book } from './useBook'
import type { MarkStore } from './useMarks'

/**
 * Making and unmaking marks from the live selection.
 *
 * Lifted out of the reader because two callers need it now: the reader draws
 * the selection popup, and §11's ⌘D and the command palette both mark whatever
 * is selected. Left in the reader, the palette would need a callback smuggled
 * upward in state to find out whether anything was selected — which is the same
 * coupling, wearing a disguise.
 */

/**
 * A request to show one mark in the Notes panel.
 *
 * `edit` distinguishes the two ways a mark is reached: clicking a highlight or
 * a margin note asks to SEE it, while choosing "Note" on a fresh selection asks
 * to WRITE on it. Both used to do the same thing — open Notes at the top of an
 * unfiltered list and leave the reader to find the mark they had just made,
 * which for a book with any history means scrolling.
 *
 * `nonce` makes the same request twice distinguishable, so clicking the same
 * margin note again brings it back into view instead of doing nothing.
 */
export interface MarkFocus {
  readonly id: string
  readonly edit: boolean
  readonly nonce: number
}

export interface Marking {
  /** The live selection in the book, or null. */
  readonly selection: SelectionSnapshot | null
  setSelection: (selection: SelectionSnapshot | null) => void
  /** Live ranges by CFI for the marks foliate has drawn, for the margin. */
  readonly ranges: ReadonlyMap<string, Range>
  onMarkDrawn: (cfi: string, range: Range) => void
  /** The existing mark on the current selection, if that passage is marked. */
  readonly selected: Mark | null
  /** Mark the selection. Returns the mark, or null if nothing was selected. */
  mark: (note: string) => Mark | null
  unmark: (target: Mark) => void
  /** The mark the Notes panel should reveal, if any. */
  readonly focus: MarkFocus | null
  /** Ask Notes to show a mark — and to open its editor when `edit`. */
  focusMark: (id: string, edit?: boolean) => void
}

export function useMarking(book: Book, marks: MarkStore): Marking {
  const [selection, setSelection] = useState<SelectionSnapshot | null>(null)

  /**
   * Replaced rather than mutated: the margin re-measures when this map's
   * identity changes, so mutating one in place would place the first mark and
   * silently ignore every mark after it.
   */
  const [ranges, setRanges] = useState<ReadonlyMap<string, Range>>(() => new Map())

  const { bookId, drawMark, eraseMark, deselect, doc } = book
  const chapter = book.position.chapterLabel

  /* A section render rebuilds its overlay and re-resolves every mark in it, so
   * ranges from the previous document are stale the moment a new one loads.
   * Clearing here is what stops a note from the last chapter being measured
   * against this one's layout. */
  useEffect(() => {
    setRanges(new Map())
    /* And the selection with them.
     *
     * A `SelectionSnapshot` holds a Range in the document that has just been
     * replaced, plus the CFI and section index it was resolved under. Kept
     * across the change it is worse than stale: the selection popup stays up
     * over the new chapter, and marking from it writes the OLD chapter's
     * anchor against the new chapter's label — a note that points at one
     * passage and says it came from another. */
    setSelection(null)
  }, [doc])

  const onMarkDrawn = useCallback((cfi: string, range: Range) => {
    setRanges((prev) => {
      if (prev.get(cfi) === range) return prev
      return new Map(prev).set(cfi, range)
    })
  }, [])

  const selected = useMemo(
    () => marks.current.find((candidate) => candidate.cfi === selection?.cfi) ?? null,
    [marks.current, selection],
  )

  /**
   * Drawn immediately rather than waiting for the section to re-render:
   * foliate only offers marks to an overlay when it builds one, so without
   * this the highlight would not appear until the reader scrolled away and
   * back.
   */
  const mark = useCallback(
    (note: string): Mark | null => {
      if (!selection || !bookId) return null
      const created = marks.add({
        bookId,
        cfi: selection.cfi,
        sectionIndex: selection.sectionIndex,
        text: selection.text,
        note,
        kind: 'highlight',
        chapter,
      })
      drawMark(created)
      // §07: acting on a selection consumes it. Leaving it up would leave the
      // popup floating over a passage that has already been dealt with.
      deselect()
      setSelection(null)
      return created
    },
    [selection, bookId, marks, chapter, drawMark, deselect],
  )

  const [focus, setFocus] = useState<MarkFocus | null>(null)
  const nonce = useRef(0)
  const focusMark = useCallback((id: string, edit = false) => {
    nonce.current += 1
    setFocus({ id, edit, nonce: nonce.current })
  }, [])

  const unmark = useCallback(
    (target: Mark) => {
      eraseMark(target)
      marks.remove(target.id)
      setRanges((prev) => {
        if (!prev.has(target.cfi)) return prev
        const next = new Map(prev)
        next.delete(target.cfi)
        return next
      })
    },
    [eraseMark, marks],
  )

  return useMemo<Marking>(
    () => ({
      selection,
      setSelection,
      ranges,
      onMarkDrawn,
      selected,
      mark,
      unmark,
      focus,
      focusMark,
    }),
    [selection, ranges, onMarkDrawn, selected, mark, unmark, focus, focusMark],
  )
}
