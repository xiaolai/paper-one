import { useCallback, useEffect, useRef, useState } from 'react'
import type { BookPort, OwnOpinion } from '../lib/opinionPort'

/**
 * The reader's own opinion of one book, and its switch, as the book's pane
 * reads them — WI-23.B4. The read model only: what the port holds, for which
 * book, and whether the read failed. What the reader DOES with it is
 * `OpinionEditor`'s, with action state of its own.
 */
export interface OpinionRead {
  /**
   * `undefined` is not read yet; `null` is read, and the book is not on the
   * shelf — two answers that drew the same blank pane, for ever, for a book
   * that had been removed.
   */
  readonly own: OwnOpinion | null | undefined
  readonly publishing: boolean | null
  /**
   * Which book `own` and `publishing` were read FOR. Cleared in an effect
   * they would stand one render too long under a new book; compared at
   * render they never do.
   */
  readonly ownBook: string | null
  /**
   * A failed READ replaces the pane, because there is nothing true to draw
   * the controls from. KEYED BY BOOK, so the render after a switch cannot
   * show the previous book's failure while the effect that clears it has
   * not run.
   */
  readonly failure: { readonly book: string; readonly message: string } | null
  /** Read again — after an act of the editor's, or when the port says something changed. */
  readonly refresh: () => Promise<void>
}

export function useOpinion(port: BookPort | null, bookId: string | null): OpinionRead {
  const [own, setOwn] = useState<OwnOpinion | null | undefined>(undefined)
  const [publishing, setPublishing] = useState<boolean | null>(null)
  const [ownBook, setOwnBook] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ readonly book: string; readonly message: string } | null>(null)
  /** Which read is newest, so a slow answer cannot overwrite a later one. */
  const read = useRef(0)

  const refresh = useCallback(async () => {
    /* Stryker disable next-line ConditionalExpression: with no port the read fails into a failure nobody draws, since the pane draws nothing without one. */
    if (port === null || bookId === null) return
    /* Stryker disable next-line UpdateOperator: counting down tells reads apart as well as counting up. */
    const mine = ++read.current
    try {
      const held = await port.own(bookId)
      const on = await port.publishing(bookId)
      if (read.current !== mine) return
      setOwn(held)
      setPublishing(on)
      setOwnBook(bookId)
      setFailure(null)
    } catch (cause) {
      if (read.current !== mine) return
      setFailure({ book: bookId, message: cause instanceof Error ? cause.message : String(cause) })
    }
  }, [port, bookId])

  useEffect(() => {
    /* A new book's opinion and switch must not stand as the new book's until
       the read lands. */
    // Stryker disable all: the render guard (`ownBook !== bookId`) already hides the previous book's state until the new read lands; these resets keep it from leaking into that read's comparisons, which no render can show.
    setOwn(undefined)
    setPublishing(null)
    setFailure(null)
    // Stryker restore all
    void refresh()
    return port?.subscribe(() => void refresh())
  }, [port, refresh])

  return { own, publishing, ownBook, failure, refresh }
}
