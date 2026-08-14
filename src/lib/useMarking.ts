import { useCallback, useEffect, useMemo, useState } from 'react'
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

export interface Marking {
  /** The live selection in the book, or null. */
  readonly selection: SelectionSnapshot | null
  setSelection: (selection: SelectionSnapshot | null) => void
  /** Live ranges by CFI for the marks foliate has drawn, for the margin. */
  readonly ranges: ReadonlyMap<string, Range>
  onMarkDrawn: (cfi: string, range: Range) => void
  /** The existing mark on the current selection, if that passage is marked. */
  readonly selected: Mark | null
  /** Mark the selection. No-op when nothing is selected. */
  mark: (note: string) => void
  unmark: (target: Mark) => void
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
    (note: string) => {
      if (!selection || !bookId) return
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
    },
    [selection, bookId, marks, chapter, drawMark, deselect],
  )

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
    () => ({ selection, setSelection, ranges, onMarkDrawn, selected, mark, unmark }),
    [selection, ranges, onMarkDrawn, selected, mark, unmark],
  )
}
