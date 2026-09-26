import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TocItem } from 'foliate-js/view.js'
import type { BookmarkPlace, SessionNavigator } from '../reader/session'
import type { SearchHit } from '../reader/bookSearch'
import type { MarkAnchor } from '../reader/markPaint'
import type { PassOutcome, PendingMark } from '../reader/reanchorPass'
import type { BookMeta, ReaderPosition } from '../../core/bookMeta'
import type { StepPace } from '../../core/autoAdvance'

/** What a book with no derivable pace answers — `restPerStep` refuses it. */
const NO_PACE: StepPace = { bookWords: null, sectionBytes: 0, spineBytes: 0, steps: 0 }
import { bookIdFor } from '../../core/marks'

export type { SearchHit }

/**
 * The open book.
 *
 * Lifted out of the reader because the book is no longer the reader's private
 * business: Contents needs its table of contents and Search needs the book to
 * scan, and both live in the side pane rather than in a column the reader
 * owns. One pane holding every tool means one place holding the state those
 * tools read.
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
  /** Go to a place, 0…1 through the book — see `SessionNavigator.goToFraction`. */
  goToFraction: (fraction: number) => void
  /** Search the open book. Yields nothing until a book is parsed. */
  search: (query: string, signal: AbortSignal) => AsyncGenerator<SearchHit>
  /** Draw a mark in the open book. No-op before the renderer is up. */
  drawMark: (anchor: MarkAnchor) => void
  eraseMark: (anchor: MarkAnchor) => void
  /** Clear the book's own text selection. */
  deselect: () => void
  /**
   * Walk this book for marks with no anchor here — WI-22.A2, `useReanchor`'s.
   *
   * Reads through the navigator ref like everything else here, so it answers
   * about whatever book is open now. Before a navigator exists the answer is an
   * empty INCOMPLETE walk — `complete: false`, never `true` — because a walk
   * that did not happen has established nothing, and a caller that took it for
   * a completed one would remember every mark as a miss.
   */
  reanchor: (pending: readonly PendingMark[]) => Promise<PassOutcome>
  /**
   * Every section's readable text, for an export — see the session.
   *
   * `[]` before a navigator exists, which is the honest empty: no book is open,
   * so there is nothing to read. An export refuses that by name rather than
   * writing a file with no chapters in it.
   */
  /* THE NAVIGATOR'S OWN TYPE, not a re-declared copy of its parameters — the copy
     here named two of three, and a type that names fewer is exactly how the
     third went missing without the compiler saying so. */
  sectionTexts: BookNavigator['sectionTexts']
  /** Dismiss the footnote popover — the session holds its view. */
  closeFootnote: () => void
  /** Register the box notes render into — see the session. */
  setFootnoteMount: (mount: HTMLElement | null, within: HTMLElement | null) => void
  /** Turn the page. The only way through a fixed-layout book. */
  next: () => void
  /** One hands-free step; false when it moved nothing. See `useAutoAdvance`. */
  step: () => Promise<boolean>
  /** What auto-advance derives its pace from — see `core/autoAdvance.ts`. */
  pace: () => StepPace
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
  printPage: '',
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
/**
 * A source that names nothing is no source.
 *
 * ⚠️ **`?book=` GAVE THE EMPTY STRING, AND IT WAS TREATED AS A BOOK.** `get`
 * answers `''` for a present-but-empty parameter, the identity effect below only
 * refused `null`, and `bookIdFor('')` then fetched `''` — which resolves to the
 * APPLICATION'S OWN DOCUMENT. So the app hashed its own HTML and recorded a
 * phantom book id, while `Reader` treated the falsy source as no book at all:
 * two halves of one state disagreeing about whether a book was open.
 * `open('')` reached the same place. Both go through this now.
 */
function sourceOf(source: BookSource): BookSource {
  return source === '' ? null : source
}

function initialSource(): BookSource {
  return sourceOf(new URLSearchParams(window.location.search).get('book'))
}

interface Loaded {
  readonly source: BookSource
  readonly generation: number
}

/**
 * ⚠️ **ONE HOOK FOR SEVERAL JOBS, AND THE INTERFACE LEAKS ONE OF THEM — BOTH
 * NAMED BY AN AUDIT, ONE ANSWERED HERE AND ONE LEFT STANDING ON PURPOSE.**
 *
 * The half that was fixable without moving anything is fixed: the load
 * transition, the guarded setters and the memo's dependencies were each a
 * hand-kept copy of something else, and each is derived now.
 *
 * The half that stands is real and is worth saying plainly: `Book` hands every
 * consumer the RENDERER's publication channel — `setToc`, `setPosition`,
 * `setDoc` and the rest — beside the public commands, so anything that reads a
 * book can also write one. They are safe to call only because each is
 * generation-guarded, which makes a stray write inert rather than impossible.
 * The proper shape is two faces: a public `Book`, and a renderer port handed to
 * `FoliateView` alone. That threads a second object from here through `App` to
 * the reader, and changes the one contract every reading surface is built on,
 * which is a change of its own and not a cleanup's.
 */
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

  /**
   * Replace whatever is loaded — a book, or nothing.
   *
   * ⚠️ **`open` AND `close` EACH SPELLED THIS OUT, AND A FIELD ADDED TO ONE
   * WOULD HAVE BEEN A PARTIAL RESET IN THE OTHER.** They differed only in the
   * source. One transition now, so closing a book and opening another cannot
   * come to disagree about what "starting over" clears.
   */
  const load = useCallback(
    (source: BookSource) => {
      reset()
      /* Dropped here, not on the next effect. The navigator points at the
       * PREVIOUS book's renderer until the new session publishes its own, and
       * anything the reader does in that gap — a search, a page turn, marking
       * what is on screen — was being sent to the book they just closed. */
      navigatorRef.current = null
      generationRef.current += 1
      setLoaded({ source: sourceOf(source), generation: generationRef.current })
    },
    // Stryker disable next-line ArrayDeclaration: `reset` has no dependency of its own, so a constant list is a constant identity whatever is in it.
    [reset],
  )
  const open = useCallback(
    (next: File | string) => load(next),
    // Stryker disable next-line ArrayDeclaration: `load` follows only `reset`, which never moves, so this list and an empty one rebuild this callback equally often — never.
    [load],
  )
  const close = useCallback(
    () => load(null),
    // Stryker disable next-line ArrayDeclaration: as above, for the same `load`.
    [load],
  )

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
    /* ⚠️ **CANCELLED WHEN THE BOOK CHANGES, AND IT USED TO RUN TO THE END.** The
       generation check below stopped a stale id being APPLIED, and nothing
       stopped it being COMPUTED: a reader flicking through three books paid for
       three downloads and three hashes, and Strict Mode issued the same full
       download twice. It also logged a superseded book's failure as though it
       were the current one's. */
    const abort = new AbortController()
    void bookIdFor(source, abort.signal)
      .then((id) => {
        if (generation === generationRef.current) setBookId(id)
      })
      .catch((cause: unknown) => {
        /* A book the reader has already left did not FAIL to be identified;
           it stopped being asked about. */
        if (abort.signal.aborted) return
        /* ⚠️ **THIS SAID "this is not silent" AND IN A RELEASE BUILD IT IS.**
           `console.error` reaches no diagnostics ring — nothing captures it — so
           a shipped app records this nowhere. What makes that tolerable is how
           narrow the case is, stated here rather than assumed:

           - a FILE's identity is a SHA-256 over a sample, which does not fail in
             practice, so only a URL can reach this line;
           - and a URL whose fetch fails ALSO fails to render — the reader sees
             the book refuse to open, which is loud.

           So "the reading works, the remembering does not" needs the identity
           fetch to fail while the RENDERER'S separate fetch of the same URL
           succeeds: a race between two requests for one resource. The fix for
           that is the same as for the double download above it — fetch the URL
           once and hand the one blob to both — which would make the two fail
           together. It changes `open`'s contract for a URL from "render this
           address" to "render these bytes", which is its own change. */
        console.error('Paper: could not identify this book', cause)
      })
    return () => abort.abort()
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
  const goToFraction = useCallback((fraction: number) => navigatorRef.current?.goToFraction(fraction), [])
  const search = useCallback(async function* (query: string, signal: AbortSignal) {
    const nav = navigatorRef.current
    if (!nav) return
    yield* nav.search(query, signal)
  }, [])
  const drawMark = useCallback((anchor: MarkAnchor) => navigatorRef.current?.drawMark(anchor), [])
  const eraseMark = useCallback((anchor: MarkAnchor) => navigatorRef.current?.eraseMark(anchor), [])
  const deselect = useCallback(() => navigatorRef.current?.deselect(), [])
  /* Reads through the ref like everything else here, so it answers about
     whatever book is open now rather than the one this callback was made
     for. `[]` before a navigator exists — the honest empty. */
  /* `complete: false` for the absent navigator — see the interface. */
  const reanchor = useCallback(
    (pending: readonly PendingMark[]): Promise<PassOutcome> =>
      navigatorRef.current?.reanchor(pending) ??
      Promise.resolve({ found: [], missed: [], complete: false, walked: 0 }),
    [],
  )
  const sectionTexts = useCallback<BookNavigator['sectionTexts']>(
    (...args) =>
      /* ⚠️ **`complete: false` FOR AN ABSENT NAVIGATOR, NOT AN EMPTY WALK.** No
         book is open, so nothing has been established about one — the same
         distinction `reanchorUnplaced` draws. Answering `complete: true` here
         would let the export write a nought-chapter file and call it done.

         ⚠️ **AND EVERY ARGUMENT GOES THROUGH.** This was
         `(toc, shouldStop) => navigator.sectionTexts(toc, shouldStop)`, so the
         reader's footnote choice — added as a third argument — stopped here and
         the export always used the default. See the navigator in `session.ts`,
         which dropped two. */
      navigatorRef.current?.sectionTexts(...args) ?? Promise.resolve({ sections: [], complete: false }),
    // Stryker disable next-line ArrayDeclaration: everything this reads is a ref, so the list is constant either way and the callback is built once.
    [],
  )
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
  /* ⚠️ **A `navigation` COUNTER RODE ON THESE FOUR AND IS GONE** (2026-09-19
   * audit). It advanced on every asked-for turn, for a surface anchored to the
   * page the reader was on — the deleted gloss's anchor, its only consumer. Left
   * behind, it called `setNavigation` on the app's hottest interaction and
   * re-rendered every reader of this hook for a value nothing read. The verbs
   * delegate and nothing else now. */
  const next = useCallback(() => navigatorRef.current?.next(), [])
  /**
   * One step of hands-free reading, resolving to whether it moved.
   *
   * ⚠️ **AWAITS THE TURN, BECAUSE THE CALLER DERIVES THE NEXT REST FROM WHERE
   * IT LANDS.** The first version returned `true` the moment `next()` was
   * called, so a chapter boundary scheduled the incoming section's first rest at
   * the OUTGOING section's pace, with the load counted as reading time.
   * `SessionNavigator.step` holds the await and the end check together.
   */
  const step = useCallback(async (): Promise<boolean> => {
    /* ⚠️ **THE METHOD IS CHECKED, NOT JUST THE NAVIGATOR.** `?.` guards a null
       navigator and not one that is missing a member, and this runs where a
       throw takes the whole reader down: `offered` is read during App's render,
       so `pace is not a function` was an uncaught exception that unmounted the
       app — 52 cases in one file, all of them timing out because App never
       mounted. A navigator without this answers "cannot advance", which is a
       correct answer; crashing for a missing optional feature is not. */
    try {
      const navigator = navigatorRef.current
      if (typeof navigator?.step !== 'function') return false
      return await navigator.step()
    } catch {
      /* Same reason as `pace` below. A step that cannot be taken is "no", which
         stops the advance cleanly; a throw here would arrive inside a timer
         callback, where nothing is listening for it. */
      return false
    }
  }, [])
  /** What auto-advance derives its pace from — see `core/autoAdvance.ts`. */
  const pace = useCallback((): StepPace => {
    /* ⚠️ **NOTHING READ HERE MAY THROW, BECAUSE THIS RUNS DURING RENDER.**
       `useAutoAdvance.offered` calls this on every render of `App`, so an
       exception is an uncaught one that unmounts the whole reader — which is
       exactly what happened: `renderer.pages` is a GETTER that throws before
       the paginator has a view, and the app came up as *"Uncaught error —
       TypeError: undefined is not an object"* over a blank window.
       `session.ts`'s `stepCount` catches that at the layer that touches the
       fork; this is the second layer, and it earns its keep because the cost of
       being wrong is the entire app rather than one absent feature. Even the
       `typeof` test is inside the try: reading a property INVOKES a getter. */
    try {
      const navigator = navigatorRef.current
      return typeof navigator?.pace === 'function' ? navigator.pace() : NO_PACE
    } catch {
      return NO_PACE
    }
  }, [])
  const prev = useCallback(() => navigatorRef.current?.prev(), [])
  const goLeft = useCallback(() => navigatorRef.current?.goLeft(), [])
  const goRight = useCallback(() => navigatorRef.current?.goRight(), [])
  const placeHere = useCallback(() => navigatorRef.current?.placeHere() ?? null, [])
  /* GENERATION-TAGGED like every other renderer callback. It was the only one
   * that was not, so a session being torn down could install ITS navigator over
   * the one belonging to the book that replaced it — and page turns then went to
   * a renderer for a book nobody was looking at. */
  const setNavigator = useCallback(
    (generation: number, navigator: BookNavigator | null) => {
      if (!current(generation)) return
      navigatorRef.current = navigator
      /* The mount the host registered before this session existed. Every new
         book gets a fresh navigator, so without this the popover would work
         for exactly no books — see `setFootnoteMount`. */
      if (navigator && footnoteMountRef.current)
        navigator.setFootnoteMount(footnoteMountRef.current, footnoteSpaceRef.current)
    },
    /* `[current]` like every sibling setter, and this declared `[]` while calling
       it. Not observable today — `current` has no dependencies of its own, so its
       identity never moves — which is exactly what makes it a trap: the day
       `current` gains one, this is the only guarded setter that keeps the old
       one, and the symptom is a torn-down session installing its navigator over
       the book that replaced it. That is the defect the comment above describes. */
    // Stryker disable next-line ArrayDeclaration: `current` has no dependency of its own — that is the paragraph above, stated where the gate reads it.
    [current],
  )
  /**
   * The renderer's setters, each dropping a value from a superseded session.
   *
   * ⚠️ **EIGHT COPIES OF ONE GUARD, AND ONE OF THEM HAD ALREADY DRIFTED.** Each
   * was its own `useCallback` over `if (current(generation)) set(value)` with its
   * own dependency list — and `setNavigator` above declared `[]` while calling
   * `current`, which is exactly the divergence eight lists invite. Built once
   * here, from one `guard` and one dependency, they cannot disagree: a setter
   * added later gets the same check by being a line in this object, and there is
   * no second list to forget it in. React's state setters are stable and so is
   * `current`, so the memo's identity is fixed for the hook's life.
   *
   * `setNavigator` stays apart because it does more than set a value — it
   * re-installs the footnote mount on the new navigator.
   */
  const { setToc, setPosition, setDoc, setFixedLayout, setDirection, setCover, setMeta, fail } =
    useMemo(() => {
      const guard =
        <T,>(set: (value: T) => void) =>
        (generation: number, value: T) => {
          if (current(generation)) set(value)
        }
      return {
        setToc: guard<readonly TocItem[]>(setTocState),
        setPosition: guard<ReaderPosition>(setPositionState),
        setDoc: guard<Document | null>(setDocState),
        setFixedLayout: guard<boolean>(setFixedLayoutState),
        setDirection: guard<'ltr' | 'rtl'>(setDirectionState),
        setCover: guard<Blob | null>(setCoverState),
        setMeta: guard<BookMeta>(setMetaState),
        fail: guard<string>(setError),
      }
    },
    // Stryker disable next-line ArrayDeclaration: `current` never moves, so the memo is built once with this list and once with an empty one.
    [current],
    )

  /**
   * The book, as one value a consumer may depend on.
   *
   * ⚠️ **THE DEPENDENCY LIST IS DERIVED FROM THE OBJECT, AND IT WAS A SECOND
   * HAND-WRITTEN COPY OF IT.** Forty entries mirrored forty properties, and the
   * two had already come apart once: `fixedLayout` was in the object and not the
   * list, so the memo kept handing out a stale `false` — which is what the wheel
   * policy asks before deciding a gesture is a page turn, so every PDF gesture
   * dropped for as long as nothing else in the list happened to change. This
   * repository runs no JS linter in its gate, so an exhaustive-deps rule was
   * never going to catch the next one.
   *
   * `Object.values` of the literal below IS the dependency list: every property
   * is a dependency and nothing else is, by construction. Its length is fixed by
   * the literal's keys, which is the one thing React requires of it. The object
   * is rebuilt each render — forty assignments — and the memo hands back the
   * previous one whenever no value in it moved, which is the identity a consumer
   * like `App`'s commands memo relies on.
   */
  const book: Book = {
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
    goToFraction,
    search,
    drawMark,
    eraseMark,
    deselect,
    reanchor,
    sectionTexts,
    closeFootnote,
    setFootnoteMount,
    next,
    step,
    pace,
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
  }
  return useMemo(() => book, Object.values(book))
}
