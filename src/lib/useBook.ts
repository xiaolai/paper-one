import { useCallback, useMemo, useRef, useState } from 'react'
import type { TocItem } from 'foliate-js/view.js'
import type { MarkAnchor, SearchHit, SessionNavigator } from '../reader/session'
import { bookIdFor } from './marks'

export type { SearchHit }

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
  /** Stable identity of the current TOC entry — labels repeat, hrefs do not. */
  readonly chapterHref: string
}

export interface BookMeta {
  readonly title: string
  readonly author: string
}

/** A File when picked or dropped; a URL for a book already on disk. */
export type BookSource = File | string | null

/**
 * Everything the host can ask of a parsed book, published once it is.
 *
 * The same shape the session publishes: this is a re-export rather than a
 * narrower copy because every method on it has a caller in the host, and a
 * hand-maintained subset drifts the moment one is added.
 */
export type BookNavigator = SessionNavigator

export interface BookState {
  readonly source: BookSource
  /**
   * Stable identity for the open book, or null when none is open. Marks are
   * keyed by it, which is what lets them be found again on the next open.
   */
  readonly bookId: string | null
  /**
   * Increments on every `open`. Callbacks carry the generation they were
   * created under, so a `load` or `relocate` arriving late from a torn-down
   * reader cannot overwrite the book that replaced it.
   */
  readonly generation: number
  readonly toc: readonly TocItem[]
  readonly position: ReaderPosition
  readonly meta: BookMeta | null
  /** The current spine item's document, for the ruler and selection. */
  readonly doc: Document | null
  readonly error: string | null
}

export interface Book extends BookState {
  open: (source: File | string) => void
  close: () => void
  /** Navigate the open book. No-op until the renderer publishes a navigator. */
  goTo: (target: string) => void
  /** Search the open book. Yields nothing until a book is parsed. */
  search: (query: string, signal: AbortSignal) => AsyncGenerator<SearchHit>
  /** Draw a mark in the open book. No-op before the renderer is up. */
  drawMark: (anchor: MarkAnchor) => void
  eraseMark: (anchor: MarkAnchor) => void
  /** Clear the book's own text selection. */
  deselect: () => void
  /** Turn the page. The only way through a fixed-layout book. */
  next: () => void
  prev: () => void
  setNavigator: (navigator: BookNavigator | null) => void
  /** Renderer callbacks. Each takes the generation it was issued under. */
  setToc: (generation: number, toc: readonly TocItem[]) => void
  setPosition: (generation: number, position: ReaderPosition) => void
  setDoc: (generation: number, doc: Document | null) => void
  setMeta: (generation: number, meta: BookMeta) => void
  fail: (generation: number, message: string) => void
}

const NOWHERE: ReaderPosition = { fraction: 0, chapterLabel: '', chapterHref: '' }

/**
 * `?book=<url>` opens a book straight from a URL on load. This is how a book
 * already in the library will be opened once one exists, and in the meantime
 * it is what makes the reader testable without driving a file picker.
 */
function initialSource(): BookSource {
  return new URLSearchParams(window.location.search).get('book')
}

interface Loaded {
  readonly source: BookSource
  readonly generation: number
}

export function useBook(): Book {
  /* Source and generation move together. Keeping them in one state value is
   * what makes re-opening the SAME file work: `setSource(same)` would bail on
   * an unchanged reference and leave the reader showing a book whose metadata
   * had just been cleared, whereas the generation always advances. */
  const [loaded, setLoaded] = useState<Loaded>(() => ({
    source: initialSource(),
    generation: 0,
  }))
  const [toc, setTocState] = useState<readonly TocItem[]>([])
  const [position, setPositionState] = useState<ReaderPosition>(NOWHERE)
  const [meta, setMetaState] = useState<BookMeta | null>(null)
  const [doc, setDocState] = useState<Document | null>(null)
  const [error, setError] = useState<string | null>(null)

  const navigatorRef = useRef<BookNavigator | null>(null)
  /* Read by the guards below. A ref, not `loaded.generation`, because a stale
   * callback closes over the render it was created in. */
  const generationRef = useRef(0)
  generationRef.current = loaded.generation

  const reset = useCallback(() => {
    setTocState([])
    setPositionState(NOWHERE)
    setMetaState(null)
    setDocState(null)
    setError(null)
  }, [])

  const open = useCallback(
    (next: File | string) => {
      reset()
      setLoaded((prev) => ({ source: next, generation: prev.generation + 1 }))
    },
    [reset],
  )

  const close = useCallback(() => {
    reset()
    navigatorRef.current = null
    setLoaded((prev) => ({ source: null, generation: prev.generation + 1 }))
  }, [reset])

  /** Drop anything issued under a superseded generation. */
  const current = useCallback(
    (generation: number) => generation === generationRef.current,
    [],
  )

  return useMemo<Book>(
    () => ({
      source: loaded.source,
      bookId: loaded.source === null ? null : bookIdFor(loaded.source),
      generation: loaded.generation,
      toc,
      position,
      meta,
      doc,
      error,
      open,
      close,
      goTo: (target) => navigatorRef.current?.goTo(target),
      search: async function* (query, signal) {
        const nav = navigatorRef.current
        if (!nav) return
        yield* nav.search(query, signal)
      },
      drawMark: (anchor) => navigatorRef.current?.drawMark(anchor),
      eraseMark: (anchor) => navigatorRef.current?.eraseMark(anchor),
      deselect: () => navigatorRef.current?.deselect(),
      next: () => navigatorRef.current?.next(),
      prev: () => navigatorRef.current?.prev(),
      setNavigator: (navigator) => {
        navigatorRef.current = navigator
      },
      setToc: (generation, next) => {
        if (current(generation)) setTocState(next)
      },
      setPosition: (generation, next) => {
        if (current(generation)) setPositionState(next)
      },
      setDoc: (generation, next) => {
        if (current(generation)) setDocState(next)
      },
      setMeta: (generation, next) => {
        if (current(generation)) setMetaState(next)
      },
      fail: (generation, message) => {
        if (current(generation)) setError(message)
      },
    }),
    [loaded, toc, position, meta, doc, error, open, close, current],
  )
}
