import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TocItem } from 'foliate-js/view.js'
import type { BookmarkPlace, MarkAnchor, SearchHit, SessionNavigator } from '../reader/session'
import type { BookMeta, ReaderPosition } from '../../core/bookMeta'
import { bookIdFor } from '../../core/marks'

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

/* `ReaderPosition` and `BookMeta` are declared in `core/bookMeta` — they are
 * data, and the session that produces them must not import the hook that
 * publishes them. Re-exported so nothing that named them here has moved. */
export type { BookMeta, ReaderPosition } from '../../core/bookMeta'

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
  /**
   * The book cannot reflow — a PDF, or an EPUB declaring `pre-paginated`.
   *
   * Controls that only mean something for a reflowable book read this: Flow
   * cannot change, and the reading ruler depends on scrolled flow, so both
   * would be switches wired to nothing.
   */
  readonly fixedLayout: boolean
  /**
   * Which way this book's text runs, as rendered.
   *
   * Anything positioning itself against the PAGE — rather than against the
   * window — needs it: the page's leading and trailing edges swap in an RTL
   * book, so a `inset-inline-end` resolved against the app's own direction
   * puts the mark on the wrong side of a book it is supposed to belong to.
   * `'ltr'` until a section has rendered, which is what the vast majority are.
   */
  readonly direction: 'ltr' | 'rtl'
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
  /** Dismiss the footnote popover — the session holds its view. */
  closeFootnote: () => void
  /** Register the box notes render into — see the session. */
  setFootnoteMount: (mount: HTMLElement | null, within: HTMLElement | null) => void
  /** Turn the page. The only way through a fixed-layout book. */
  next: () => void
  prev: () => void
  /**
   * The page to one SIDE — which is not the same question as next/prev.
   *
   * In a right-to-left book the next page is the one on the left. foliate
   * resolves that from the book's own `dir`, so a gesture that knows only which
   * way the reader pushed hands the question over instead of answering it.
   */
  goLeft: () => void
  goRight: () => void
  /**
   * Where the reader is, as everything a bookmark is made from — null before
   * the renderer is up, and for a place that cannot be pinned down.
   *
   * Takes no anchor: the session holds the relocation whole, and pairing this
   * hook's copy of the CFI with the session's range is what produced a
   * bookmark describing two different pages. See `ReaderSession.placeHere`.
   */
  placeHere: () => BookmarkPlace | null
  setNavigator: (generation: number, navigator: BookNavigator | null) => void
  /** Renderer callbacks. Each takes the generation it was issued under. */
  setToc: (generation: number, toc: readonly TocItem[]) => void
  setPosition: (generation: number, position: ReaderPosition) => void
  setDoc: (generation: number, doc: Document | null) => void
  setFixedLayout: (generation: number, fixed: boolean) => void
  setDirection: (generation: number, direction: 'ltr' | 'rtl') => void
  setMeta: (generation: number, meta: BookMeta) => void
  /** The book's jacket, or null when it declares none. Never stored as-is. */
  cover: Blob | null
  setCover: (generation: number, cover: Blob | null) => void
  fail: (generation: number, message: string) => void
}

const NOWHERE: ReaderPosition = {
  fraction: 0,
  chapterLabel: '',
  chapterHref: '',
  cfi: null,
  /* Null, not 0 — the name of this constant is the argument. Nowhere is not
   * the first section; nothing has been rendered yet. See
   * `ReaderPosition.sectionIndex`. */
  sectionIndex: null,
  sectionExact: false,
}

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
  const [cover, setCoverState] = useState<Blob | null>(null)
  const [doc, setDocState] = useState<Document | null>(null)
  const [fixedLayout, setFixedLayoutState] = useState(false)
  const [direction, setDirectionState] = useState<'ltr' | 'rtl'>('ltr')
  const [error, setError] = useState<string | null>(null)
  /**
   * The book's durable identity, resolved from its content.
   *
   * State rather than a derived value because `bookIdFor` reads part of the
   * file — see its note on why identity cannot come from the name. Null until
   * it resolves, which is a few milliseconds and which every consumer already
   * handles: no id means no marks and no cards, which is the correct answer
   * for a book whose identity is not yet known. Showing the PREVIOUS book's id
   * for those milliseconds would not be.
   */
  const [bookId, setBookId] = useState<string | null>(null)

  const navigatorRef = useRef<BookNavigator | null>(null)
  /**
   * The current generation, advanced SYNCHRONOUSLY by open and close.
   *
   * It used to be assigned during render from `loaded.generation`, which left a
   * window between the call and the next commit where the guards below still
   * accepted the OLD book's generation as current. Every late callback from a
   * book being closed — a relocate, a document, a metadata read — passed the
   * check in that window and wrote itself back over the state that had just
   * been cleared for its replacement. The ref is the source of truth now, and
   * `loaded.generation` is a copy of it for rendering.
   */
  const generationRef = useRef(0)

  const reset = useCallback(() => {
    setTocState([])
    setPositionState(NOWHERE)
    setMetaState(null)
    setCoverState(null)
    setDocState(null)
    setFixedLayoutState(false)
    setDirectionState('ltr')
    setError(null)
    setBookId(null)
  }, [])

  const open = useCallback(
    (next: File | string) => {
      reset()
      /* Dropped here, not on the next effect. The navigator points at the
       * PREVIOUS book's renderer until the new session publishes its own, and
       * anything the reader does in that gap — a search, a page turn, marking
       * what is on screen — was being sent to the book they just closed. */
      navigatorRef.current = null
      generationRef.current += 1
      const generation = generationRef.current
      setLoaded({ source: next, generation })
    },
    [reset],
  )

  const close = useCallback(() => {
    reset()
    navigatorRef.current = null
    generationRef.current += 1
    const generation = generationRef.current
    setLoaded({ source: null, generation })
  }, [reset])

  /* Resolve the identity of whatever is loaded. Guarded by generation rather
   * than by a local flag, so an id that arrives after the reader has moved on
   * is discarded instead of being applied to the next book. */
  useEffect(() => {
    const source = loaded.source
    if (source === null) {
      setBookId(null)
      return
    }
    const generation = loaded.generation
    void bookIdFor(source)
      .then((id) => {
        if (generation === generationRef.current) setBookId(id)
      })
      .catch((cause: unknown) => {
        // Without an id there are no marks and no library entry, so this is
        // not silent: the reading works, the remembering does not.
        console.error('Paper: could not identify this book', cause)
      })
  }, [loaded])

  /** Drop anything issued under a superseded generation. */
  const current = useCallback(
    (generation: number) => generation === generationRef.current,
    [],
  )

  /* Every action is stabilised, and none of them close over book state.
   *
   * The Book object still changes identity whenever the reading position does —
   * it carries the position, so it must — but its CALLBACKS no longer do. They
   * used to be rebuilt inside the same memo, which meant `book.search` was a
   * new function on every relocate: the search panel's effect depends on it,
   * so a full-book search aborted and restarted from the beginning every time
   * the reader turned a page, including the page turn caused by clicking one
   * of its own results. Everything below reads through `navigatorRef`, so
   * stable identity costs nothing in correctness. */
  const goTo = useCallback((target: string) => navigatorRef.current?.goTo(target), [])
  const search = useCallback(async function* (query: string, signal: AbortSignal) {
    const nav = navigatorRef.current
    if (!nav) return
    yield* nav.search(query, signal)
  }, [])
  const drawMark = useCallback((anchor: MarkAnchor) => navigatorRef.current?.drawMark(anchor), [])
  const eraseMark = useCallback((anchor: MarkAnchor) => navigatorRef.current?.eraseMark(anchor), [])
  const deselect = useCallback(() => navigatorRef.current?.deselect(), [])
  const closeFootnote = useCallback(() => navigatorRef.current?.closeFootnote(), [])
  /**
   * The box notes render into, remembered across books.
   *
   * HELD HERE AND RE-APPLIED, not merely forwarded. The popover registers on
   * mount, which is BEFORE any book has finished parsing — so there is no
   * navigator yet and a straight forward was a no-op that silently never
   * happened. The note then rendered into the session's fallback, off-screen,
   * and the popover showed an empty box: the extraction had worked and nobody
   * could see it. Same shape as `lastLocation`, which is read once when the
   * book is ready rather than when the host happens to know it.
   */
  const footnoteMountRef = useRef<HTMLElement | null>(null)
  const footnoteSpaceRef = useRef<HTMLElement | null>(null)
  const setFootnoteMount = useCallback(
    (mount: HTMLElement | null, within: HTMLElement | null) => {
      footnoteMountRef.current = mount
      /* The box the popover is POSITIONED IN, kept beside the box notes render
         into — see `FootnotePopover.onMount`. Held in a ref for the same reason
         the mount is: the navigator may not exist yet. */
      footnoteSpaceRef.current = within
      navigatorRef.current?.setFootnoteMount(mount, within)
    },
    [],
  )
  const next = useCallback(() => navigatorRef.current?.next(), [])
  const prev = useCallback(() => navigatorRef.current?.prev(), [])
  const goLeft = useCallback(() => navigatorRef.current?.goLeft(), [])
  const goRight = useCallback(() => navigatorRef.current?.goRight(), [])
  const placeHere = useCallback(() => navigatorRef.current?.placeHere() ?? null, [])
  /* GENERATION-TAGGED like every other renderer callback. It was the only one
   * that was not, so a session being torn down could install ITS navigator over
   * the one belonging to the book that replaced it — and page turns then went to
   * a renderer for a book nobody was looking at. */
  const setNavigator = useCallback((generation: number, navigator: BookNavigator | null) => {
    if (!current(generation)) return
    navigatorRef.current = navigator
    /* The mount the host registered before this session existed. Every new
       book gets a fresh navigator, so without this the popover would work
       for exactly no books — see `setFootnoteMount`. */
    if (navigator && footnoteMountRef.current)
      navigator.setFootnoteMount(footnoteMountRef.current, footnoteSpaceRef.current)
  }, [])
  const setToc = useCallback(
    (generation: number, value: readonly TocItem[]) => {
      if (current(generation)) setTocState(value)
    },
    [current],
  )
  const setPosition = useCallback(
    (generation: number, value: ReaderPosition) => {
      if (current(generation)) setPositionState(value)
    },
    [current],
  )
  const setDoc = useCallback(
    (generation: number, value: Document | null) => {
      if (current(generation)) setDocState(value)
    },
    [current],
  )
  const setFixedLayout = useCallback(
    (generation: number, value: boolean) => {
      if (current(generation)) setFixedLayoutState(value)
    },
    [current],
  )
  const setDirection = useCallback(
    (generation: number, value: 'ltr' | 'rtl') => {
      if (current(generation)) setDirectionState(value)
    },
    [current],
  )
  const setCover = useCallback(
    (generation: number, value: Blob | null) => {
      if (current(generation)) setCoverState(value)
    },
    [current],
  )
  const setMeta = useCallback(
    (generation: number, value: BookMeta) => {
      if (current(generation)) setMetaState(value)
    },
    [current],
  )
  const fail = useCallback(
    (generation: number, msg: string) => {
      if (current(generation)) setError(msg)
    },
    [current],
  )

  return useMemo<Book>(
    () => ({
      source: loaded.source,
      bookId,
      generation: loaded.generation,
      toc,
      position,
      meta,
      doc,
      fixedLayout,
      direction,
      error,
      open,
      close,
      goTo,
      search,
      drawMark,
      eraseMark,
      deselect,
      closeFootnote,
      setFootnoteMount,
      next,
      prev,
      goLeft,
      goRight,
      placeHere,
      setNavigator,
      setToc,
      setPosition,
      setDoc,
      setFixedLayout,
      setDirection,
      setMeta,
      cover,
      setCover,
      fail,
    }),
    [
      loaded,
      bookId,
      toc,
      position,
      meta,
      doc,
      /* Omitting this was a real staleness bug, not a lint nit: `fixedLayout` is
       * what the wheel policy asks before deciding a gesture is a page turn, so
       * a stale `false` made every PDF gesture drop for as long as nothing else
       * in this list happened to change. */
      fixedLayout,
      direction,
      error,
      open,
      close,
      goTo,
      search,
      drawMark,
      eraseMark,
      deselect,
      closeFootnote,
      setFootnoteMount,
      next,
      prev,
      goLeft,
      goRight,
      placeHere,
      setNavigator,
      setToc,
      setPosition,
      setDoc,
      setFixedLayout,
      setDirection,
      setMeta,
      cover,
      setCover,
      fail,
    ],
  )
}
