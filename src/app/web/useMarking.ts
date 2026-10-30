import { useCallback, useState } from 'react'
import type { MarkAnchor, SelectionSnapshot } from '../../kernel/ui/browser'
import type { MarkTint } from '../../kernel'
import type { RemoteMarks } from './marks'
import type { TocItem } from 'foliate-js/view.js'

/**
 * MARKING A PASSAGE, and copying one — the whole of what the selection bar can
 * do, in one place.
 *
 * ## Why this is its own module
 *
 * `Reader` held this beside content acquisition, gestures, navigation, search
 * and four tool panes. It is the one part of that component with a boundary
 * anybody could draw: it owns the selection, the tint, the marks drawn on the
 * page, and the two things a reader can do with a selection — nothing else in
 * the reader touches any of them.
 *
 * ## Two failures that were both silent
 *
 * A highlight is drawn from the shelf's ANSWER to `mark.add`, which carries the
 * real id, rather than from a guess made before the write landed. And a copy
 * that fails says so and leaves the selection alone: both halves used to be
 * `catch(() => {})`, so Copy presented as having worked while the text went
 * nowhere and the selection — the one thing the reader could have retried
 * from — was destroyed.
 */

/** What the reader has selected and what may be done with it. */
export interface Marking {
  readonly selection: SelectionSnapshot | null
  readonly setSelection: (next: SelectionSnapshot | null) => void
  readonly tint: MarkTint
  readonly setTint: (next: MarkTint) => void
  /** The marks drawn on the page — from the store, then grown as they land. */
  readonly drawn: readonly MarkAnchor[]
  readonly setDrawn: (next: readonly MarkAnchor[]) => void
  /** Make a mark from the selection, carrying `note` — empty from the bar. */
  readonly highlight: (note: string) => void
  readonly copySelection: () => void
}

/** What `useMarking` needs from the reader around it. */
export interface MarkingDeps {
  readonly marks: RemoteMarks | null
  readonly bookId: string
  /** The table of contents, for the chapter a mark is made in. */
  readonly toc: readonly TocItem[]
  /** The href of the section the reader is in — see `here` in `Reader`. */
  readonly here: string
  /** Say what went wrong, where the reader is looking. */
  readonly onProblem: (why: string | null) => void
  /**
   * Clear the book's own selection.
   *
   * ⚠️ **CLEARING THE STATE IS NOT CLEARING THE SELECTION.** The words stay
   * highlighted inside the book's document until the session is told, so a
   * reader who marked a passage was left looking at the browser's blue
   * selection over their own yellow one. The session owns that; this asks it.
   */
  readonly deselect: () => void
}

export function useMarking({ marks, bookId, toc, here, onProblem, deselect }: MarkingDeps): Marking {
  /** What the reader has selected, or null. Drives the selection bar. */
  const [selection, setSelection] = useState<SelectionSnapshot | null>(null)
  const [tint, setTint] = useState<MarkTint>('yellow')
  /**
   * THE MARKS DRAWN ON THE PAGE. Filled from the store for this book, then
   * grown as the reader highlights — from the shelf's ANSWER to `mark.add`,
   * which carries the real id, rather than from a guess made before the
   * write landed.
   */
  const [drawn, setDrawn] = useState<readonly MarkAnchor[]>([])

/**
 * HIGHLIGHT, from the selection bar.
 *
 * Sent to `mark.add` WITH its recovery context — `prefix` and `suffix` from
 * the snapshot, `chapter` from the contents — which the wire carries since
 * phase 19. The highlight is drawn from the shelf's ANSWER, which has the
 * real id, so nothing on the page claims a mark the shelf never got.
 */
const highlight = useCallback(
  (note: string) => {
    const sel = selection
    if (sel === null || marks === null) return
    setSelection(null)
    deselect()
    void marks
      .add({
        bookId,
        cfi: sel.cfi,
        sectionIndex: sel.sectionIndex,
        text: sel.text,
        prefix: sel.prefix,
        suffix: sel.suffix,
        note,
        tint,
        chapter: toc.find((entry) => entry.href === here)?.label ?? '',
      })
      .catch((cause: unknown) => {
        /* ⚠️ THE DRAWING USED TO HAPPEN HERE TOO, AND IT WAS THE SECOND TIME.
         *
         * `marks.add` puts the new mark in the store and notifies
         * synchronously, and the effect above rebuilds `drawn` from
         * `marks.all` on every notification — so by the time this promise
         * settled the highlight was already on the page. Appending it again
         * painted every new highlight twice, which on a `fill` tint is
         * visibly darker than the ones around it.
         *
         * The subscription is the single source now. It also handles what
         * this could not: a mark the shelf CHANGED on the way in, and one
         * that arrives from anywhere other than this button. */
        console.error('Paper: the shelf would not keep that highlight', cause)
      })
  },
  [selection, marks, bookId, tint, toc, here, deselect, onProblem],
)

/**
 * COPY, and what happens when it does not.
 *
 * ⚠️ **THIS SWALLOWED THE FAILURE AND CLEARED THE SELECTION ANYWAY.** The
 * clipboard is absent in a non-secure context and its write can be refused
 * outright, and both were `catch(() => {})` — so Copy presented as having
 * worked while the text went nowhere AND the selection, the one thing the
 * reader could have retried from, was destroyed. Two losses from one
 * unhandled rejection.
 *
 * The selection is cleared only after a write that resolved. A failure says
 * so and leaves the text highlighted, so the reader can try again or copy it
 * by hand.
 */
const copySelection = useCallback(() => {
  const text = selection?.text ?? ''
  if (text === '') return
  /* `window.navigator`, spelled out: this file's own `navigator` is the
   * book navigator ref, and shadowed the global. */
  const clipboard = window.navigator.clipboard
  if (clipboard === undefined) {
    onProblem('This browser will not let a page copy text. Select it and copy it yourself.')
    return
  }
  void clipboard
    .writeText(text)
    .then(() => {
      onProblem(null)
      setSelection(null)
    })
    .catch(() => {
      onProblem('That could not be copied. The selection is still there — try again.')
    })
}, [selection, onProblem])

  return { selection, setSelection, tint, setTint, drawn, setDrawn, highlight, copySelection }
}
