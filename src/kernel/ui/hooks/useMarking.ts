import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { findMark } from '../../core/markMatch'
import type { Mark } from '../../core/marks'
import type { SelectionSnapshot } from '../reader/session'
import type { Book } from './useBook'
import type { MarksView } from './useMarks'

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

export function useMarking(book: Book, marks: MarksView): Marking {
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

  /**
   * Drop one anchor's cached range.
   *
   * The map's contract is "ranges for the marks foliate has drawn", so every
   * erase has to take the entry with it. Shared because it is needed from two
   * places that had drifted apart: `unmark` did it, and replacing an
   * overlapping mark in `mark` did not — leaving a Range pointing at DOM that
   * had just been erased, which the margin then measured.
   */
  const forgetRange = useCallback((cfi: string) => {
    setRanges((prev) => {
      if (!prev.has(cfi)) return prev
      const next = new Map(prev)
      next.delete(cfi)
      return next
    })
  }, [])

  /**
   * The mark under the selection — by OVERLAP, not by a byte-identical CFI.
   *
   * Byte equality asked whether the reader had reproduced an anchor exactly,
   * which is not a question a gesture can answer: selecting part of a marked
   * paragraph found nothing and offered to mark it again, and snapping the
   * selection to whole words widened every anchor, putting marks made before
   * that change out of reach of the gesture that made them. `findMark` carries
   * the rule, and the tie-break when a selection covers two marks.
   */
  const selected = useMemo(
    () =>
      selection && bookId
        ? findMark(marks.current, {
            cfi: selection.cfi,
            sectionIndex: selection.sectionIndex,
            bookId,
          })
        : null,
    [marks.current, selection, bookId],
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
        // Captured here because here is the only place it exists. See `Mark`.
        prefix: selection.prefix,
        suffix: selection.suffix,
        note,
        kind: 'highlight',
        chapter,
      })
      /* The overlay of the mark this one replaced goes with it. The store drops
       * the superseded row — `marks.add` resolves the same mark `selected`
       * did, from the same selection — but foliate has already drawn it at its
       * own anchor, and a highlight nothing in the store accounts for stays on
       * the page until the section is rebuilt. Skipped when the anchors match,
       * because there the new drawing lands exactly on the old one. */
      if (selected && selected.cfi !== created.cfi) {
        eraseMark(selected)
        forgetRange(selected.cfi)
      }
      drawMark(created)
      // §07: acting on a selection consumes it. Leaving it up would leave the
      // popup floating over a passage that has already been dealt with.
      deselect()
      setSelection(null)
      return created
    },
    [selection, bookId, marks, chapter, drawMark, eraseMark, selected, deselect, forgetRange],
  )

  const [focus, setFocus] = useState<MarkFocus | null>(null)
  const nonce = useRef(0)
  const focusMark = useCallback((id: string, edit = false) => {
    nonce.current += 1
    setFocus({ id, edit, nonce: nonce.current })
  }, [])

  const unmark = useCallback(
    (target: Mark) => {
      /* The row always goes. The DRAWING only goes when the mark belongs to the
       * book on screen: `eraseMark` and the range cache both address the
       * current renderer, and a CFI is only unique within a section of one
       * book. Unmarking another book's note — from a list that spans books —
       * used to erase whatever the current book happened to have at the same
       * anchor, and drop its cached range with it. */
      marks.remove(target.id)
      if (target.bookId !== bookId) return
      eraseMark(target)
      forgetRange(target.cfi)
    },
    [eraseMark, marks, bookId, forgetRange],
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
