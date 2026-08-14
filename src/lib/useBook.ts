import { useCallback, useState } from 'react'
import type { TocItem } from 'foliate-js/view.js'

/**
 * The open book.
 *
 * Lifted out of the reader because the book is no longer the reader's private
 * business: Contents needs its table of contents and Companion needs the
 * current chapter, and both now live in the side pane rather than in a column
 * the reader owns. One pane holding every tool means one place holding the
 * state those tools read.
 */

export interface ReaderPosition {
  readonly fraction: number
  readonly chapterLabel: string
}

/** A File when picked or dropped; a URL for a book already on disk. */
export type BookSource = File | string | null

export interface BookState {
  readonly source: BookSource
  readonly toc: readonly TocItem[]
  readonly position: ReaderPosition
  /** The current spine item's document, for the ruler and selection. */
  readonly doc: Document | null
  readonly error: string | null
  /**
   * How many marks the current book has — highlights and pinned companion
   * notes. Drives whether the reader reserves its margin column.
   *
   * Always 0 today: nothing writes marks yet. It is a field rather than a
   * constant so the margin appears on its own once an annotation store exists,
   * instead of the layout quietly staying collapsed forever.
   */
  readonly markCount: number
}

export interface Book extends BookState {
  open: (source: File | string) => void
  close: () => void
  setToc: (toc: readonly TocItem[]) => void
  setPosition: (position: ReaderPosition) => void
  setDoc: (doc: Document | null) => void
  fail: (message: string) => void
}

const NOWHERE: ReaderPosition = { fraction: 0, chapterLabel: '' }

/**
 * `?book=<url>` opens a book straight from a URL on load. This is how a book
 * already in the library will be opened once one exists, and in the meantime
 * it is what makes the reader testable without driving a file picker.
 */
function initialSource(): BookSource {
  return new URLSearchParams(window.location.search).get('book')
}

export function useBook(): Book {
  const [source, setSource] = useState<BookSource>(initialSource)
  const [toc, setToc] = useState<readonly TocItem[]>([])
  const [position, setPosition] = useState<ReaderPosition>(NOWHERE)
  const [doc, setDoc] = useState<Document | null>(null)
  const [error, setError] = useState<string | null>(null)

  const open = useCallback((next: File | string) => {
    // Everything derived from the previous book is cleared together, so a
    // stale table of contents can never outlive the book it came from.
    setError(null)
    setToc([])
    setPosition(NOWHERE)
    setDoc(null)
    setSource(next)
  }, [])

  const close = useCallback(() => {
    setSource(null)
    setToc([])
    setPosition(NOWHERE)
    setDoc(null)
    setError(null)
  }, [])

  return {
    source,
    toc,
    position,
    doc,
    error,
    markCount: 0,
    open,
    close,
    setToc,
    setPosition,
    setDoc,
    fail: setError,
  }
}
