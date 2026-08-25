import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FoliateView } from '../../kernel/ui/reader/FoliateView'
import {
  BRIGHTNESS,
  CONTRAST,
  DEFAULT_ALIGN,
  DEFAULT_READING_STYLE,
  DEFAULT_SPACING,
  DEFAULT_STEP_IDX,
  DEFAULT_THEME,
  DEFAULT_TYPEFACE,
  measureForStep,
  pageMargins,
  proseGrid,
  stepAt,
} from '../../kernel/core/metrics'
import type { RemoteContent } from './content'
import { browserPositions, type ReadingPositions } from './positions'
import { tapIntent } from './tapToTurn'
import styles from './Reader.module.css'

/**
 * A book, read in a browser (phase 18).
 *
 * ## The same reader, not a second one
 *
 * This mounts `FoliateView` — the component the desktop mounts. That was
 * impossible until `bookVault.ts`'s Tauri binding moved out: the reader reaches
 * `bookFolder`, which imports `extensionFor` from the vault, which imported the
 * filesystem plugin. A browser has no such plugin, so the whole subtree was out
 * of reach through one value import nothing on that path ever called.
 *
 * Writing a second reader instead would have been the expensive answer to a
 * four-line problem, and every feature after it would have been built twice.
 *
 * ## Where the bytes come from
 *
 * An EPUB is assembled into a `File` and handed over whole, because a zip's
 * central directory is at the end and foliate walks the archive freely. A PDF
 * is handed a RANGE TRANSPORT instead, so pdf.js asks the shelf for the byte
 * ranges of the page it is drawing — the difference between opening a 300 MB
 * scanned book and downloading one. `content.locate` says which, and gives the
 * length the transport cannot work without.
 *
 * ## What this surface is NOT
 *
 * There are no settings here. The desktop's reader is driven by fifteen values
 * a reader can change and a reducer that persists them; this build has no
 * settings screen and no store to keep them in, so it opens every book at the
 * design system's own defaults — the same constants `initialState` uses, from
 * the same module, so the two cannot drift.
 *
 * Marks, search, the ruler and reading aloud are likewise absent: they are the
 * desktop's panes, not the reader's. What is here is the book, legible, at the
 * measure it was designed for.
 */

export interface ReaderProps {
  readonly content: RemoteContent
  readonly bookId: string
  /** What the shelf called it — the parser routes on this suffix. */
  readonly name: string
  readonly onClose: () => void
  /** Injected so a test needs no browser storage. */
  readonly positions?: ReadingPositions
}

/** What is known about the book while it is being fetched. */
type Opening =
  | { readonly kind: 'locating' }
  /* A `File` for an EPUB, or a ranged source for a PDF. Spelled structurally
   * rather than imported: `RangedSource` lives in `formats.ts`, which is not on
   * the browser client's short list of kernel modules, and the shape is two
   * fields. `FoliateView` accepts either. */
  | { readonly kind: 'reading'; readonly source: File | { readonly range: object; readonly name: string } }
  | { readonly kind: 'failed'; readonly why: string }

export function Reader({ content, bookId, name, onClose, positions }: ReaderProps) {
  /* ONE STORE FOR THE LIFE OF THE COMPONENT. Built in a ref rather than on
   * every render, because `browserPositions` touches `localStorage`, which is a
   * getter that THROWS in some configurations. */
  const store = useRef<ReadingPositions | null>(null)
  store.current ??= positions ?? browserPositions()

  /**
   * WHERE THIS BOOK WAS LEFT, READ ONCE.
   *
   * `FoliateView`'s own note is emphatic: `lastLocation` is read when the book
   * finishes parsing and must never be depended on, because the value CHANGES
   * as the reader reads — "a book that reopened every time it did would be a
   * book that could not be read at all". Captured at mount, in state, so the
   * prop is stable for as long as the book is open.
   */
  const [lastLocation] = useState(() => store.current?.get(bookId) ?? null)
  const [opening, setOpening] = useState<Opening>({ kind: 'locating' })
  const [problem, setProblem] = useState<string | null>(null)
  /* The stage's width decides the measure, and a phone rotates. */
  const [stage, setStage] = useState(() => Math.min(window.innerWidth, 1200))
  const host = useRef<HTMLDivElement | null>(null)
  /** The reading area, which is wider than the book — see `watchTaps`. */
  const stageEl = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onResize = () => setStage(Math.min(window.innerWidth, 1200))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    let live = true
    setOpening({ kind: 'locating' })
    void (async () => {
      try {
        const facts = await content.locate(bookId)
        if (!live) return
        if (!facts.here) {
          setOpening({ kind: 'failed', why: 'Your library does not have this book’s pages.' })
          return
        }
        /* A PDF GOES THROUGH THE TRANSPORT — but only when the shelf could
         * measure it. pdf.js is told a length before it asks for a byte, and a
         * shelf that answers `null` has no length to give; falling back to the
         * whole file is slower and correct, which is the right way round. */
        /* THE NAME A PARSER ROUTES ON, rebuilt from what the shelf stores.
         * The shelf sends a TITLE — "Moby-Dick" — and every parser Paper uses
         * routes on the suffix; foliate rejects a name without one as an
         * unsupported type. `content.locate` knows the stored extension, which
         * is exactly what `storedBookName` does on the desktop side. */
        const filename = facts.ext === null ? name : `${name}.${facts.ext}`

        if (facts.ext === 'pdf' && facts.size !== null) {
          const { pdfRangeTransport } = await import('./pdfRange')
          const range = await pdfRangeTransport(content, bookId, facts.size, {
            onFailure: (cause) =>
              setProblem(cause instanceof Error ? cause.message : String(cause)),
          })
          if (!live) return
          setOpening({ kind: 'reading', source: { range, name: filename } })
          return
        }
        const file = await content.fileOf(bookId, filename)
        if (!live) return
        setOpening({ kind: 'reading', source: file })
      } catch (thrown) {
        if (!live) return
        setOpening({ kind: 'failed', why: thrown instanceof Error ? thrown.message : String(thrown) })
      }
    })()
    return () => {
      live = false
    }
  }, [content, bookId, name])

  /* THE SAME ARITHMETIC THE DESKTOP DOES, from the same module — the measure
   * the grid settled on rather than the one the step asked for, because the
   * renderer draws over the gutter otherwise. */
  const grid = useMemo(() => proseGrid(stage, false, measureForStep(DEFAULT_STEP_IDX)), [stage])

  const ignore = useCallback(() => {}, [])

  /**
   * THE PAGE TURN, which this surface shipped without.
   *
   * `onPageIntent` was a no-op, so a book opened and could not be advanced: a
   * tap did nothing, a swipe did nothing, the arrow keys did nothing. The
   * reader looked complete and was a single page — found by trying to turn one,
   * which no test here could have done.
   *
   * The navigator arrives from the session once the book is open, so it lives
   * in a ref rather than in state: it is not rendered, and setting state on it
   * would re-render the whole surface the moment a book finished parsing.
   */
  /** Removes the last document's tap listeners — see `watchDocument`. */
  const tapCleanup = useRef<(() => void) | null>(null)

  const navigator = useRef<{
    next: () => void
    prev: () => void
    goLeft: () => void
    goRight: () => void
  } | null>(null)

  const takeNavigator = useCallback((_generation: number, next: unknown) => {
    navigator.current = next as typeof navigator.current
  }, [])

  /* FOUR INTENTS, TWO PAIRS, and they are not interchangeable. A horizontal
   * gesture names a SIDE and foliate resolves which page that is from the
   * book's own direction; a vertical one names a DIRECTION OF TRAVEL, which
   * needs no resolving — routing it through goLeft/goRight would reverse the
   * wheel in a right-to-left book. The desktop's reader makes the same
   * distinction, in the same words. */
  const turn = useCallback((intent: 'left' | 'right' | 'next' | 'prev') => {
    const nav = navigator.current
    if (nav === null) return
    if (intent === 'left') nav.goLeft()
    else if (intent === 'right') nav.goRight()
    else if (intent === 'next') nav.next()
    else nav.prev()
  }, [])

  /**
   * TAP TO TURN, attached to each book document as it loads.
   *
   * A page intent reaches `FoliateView` from ONE gesture — the wheel — and a
   * phone has none. The book is in an iframe, so a tap on it never reaches this
   * page; `onDocument` hands over the book's own `Document`, which is where the
   * listener has to go.
   *
   * Registered per document and removed when the document goes, because
   * foliate loads a new one per section and keeps neighbours alive: without the
   * teardown a book would accumulate a listener per section read.
   */
  /**
   * Attach tap-to-turn to one event target, and hand back the way to remove it.
   *
   * TWO TARGETS NEED THIS, which is why it is a function. A book's iframe is
   * narrower than the stage it sits in — 748px inside 1280px, measured — so a
   * tap near the screen edge lands on the paginator's margin and never reaches
   * the book's document at all. Attaching only there meant the most natural
   * gesture on a phone, a thumb at the very edge, did nothing.
   *
   * Events do not cross an iframe boundary, so the two listeners never both
   * fire for one tap. Each measures against ITS OWN width, and because the book
   * is centred in the stage the two agree about which side a tap was on.
   */
  const watchTaps = useCallback(
    (
      target: Document | HTMLElement,
      widthOf: () => number,
      selectionOf: () => string,
    ): (() => void) => {
      let downAt: { x: number; y: number } | null = null
      const onDown = (event: Event) => {
        const pointer = event as PointerEvent
        downAt = { x: pointer.clientX, y: pointer.clientY }
      }
      const onUp = (event: Event) => {
        const pointer = event as PointerEvent
        const from = downAt
        downAt = null
        const intent = tapIntent({
          x: pointer.clientX,
          /* HOW FAR IT TRAVELLED, not where it ended. A drag that begins in the
           * middle and ends at the edge is a selection, not a page turn. */
          moved: from === null ? 0 : Math.hypot(pointer.clientX - from.x, pointer.clientY - from.y),
          width: widthOf(),
          selected: selectionOf() !== '',
          /* A LINK WINS. foliate is already handling it, and turning the page
           * as well would leave the reader somewhere they did not choose. */
          onControl:
            (pointer.target as Element | null)?.closest?.('a, button, input, [role="button"]') != null,
        })
        if (intent !== null) turn(intent)
      }
      target.addEventListener('pointerdown', onDown, { passive: true })
      target.addEventListener('pointerup', onUp, { passive: true })
      return () => {
        target.removeEventListener('pointerdown', onDown)
        target.removeEventListener('pointerup', onUp)
      }
    },
    [turn],
  )

  /* THE MARGINS. A tap that misses the book still asked to turn a page. */
  useEffect(() => {
    const element = stageEl.current
    if (element === null) return
    return watchTaps(
      element,
      () => element.clientWidth,
      () => window.getSelection()?.toString() ?? '',
    )
  }, [watchTaps])

  /**
   * THE BOOK ITSELF. `onDocument` hands over each section's document as it
   * loads; foliate keeps neighbours alive, so the previous one is released
   * first or a book accumulates a listener per section read.
   */
  const watchDocument = useCallback(
    (_generation: number, doc: Document | null) => {
      tapCleanup.current?.()
      tapCleanup.current = null
      if (doc === null) return
      tapCleanup.current = watchTaps(
        doc,
        () => doc.documentElement.clientWidth,
        () => doc.getSelection()?.toString() ?? '',
      )
    },
    [watchTaps],
  )


  /* SAVED ON EVERY RELOCATE, which is every page turn and every resize. The
   * store refuses a write when the position has not moved, so a turn that lands
   * on the same CFI costs nothing — and a null cfi never overwrites a good
   * position, which the fixed-layout renderer would otherwise do. */
  const remember = useCallback(
    (_generation: number, position: { cfi: string | null }) => {
      store.current?.set(bookId, position.cfi)
    },
    [bookId],
  )

  if (opening.kind === 'failed') {
    return (
      <main className={styles.screen}>
        <p className="paper-cap-hint">{opening.why}</p>
        <button className="paper-cap-button" type="button" onClick={onClose}>
          Back to the shelf
        </button>
      </main>
    )
  }

  return (
    <main className={styles.screen} ref={host}>
      <header className={styles.bar}>
        <button className="paper-cap-button" type="button" onClick={onClose}>
          ‹ Shelf
        </button>
        <span className={styles.title}>{name.replace(/\.[^.]+$/, '')}</span>
      </header>

      {problem !== null && (
        /* A RANGE READ THAT FAILED. pdf.js has no error channel of its own, so
           without saying this the book simply stops on a blank page. */
        <p className={styles.problem} role="alert">
          The connection to your library dropped. {problem}
        </p>
      )}

      <div className={styles.stage} ref={stageEl}>
        <FoliateView
          file={opening.kind === 'reading' ? opening.source : null}
          generation={0}
          style={DEFAULT_READING_STYLE}
          stepIdx={DEFAULT_STEP_IDX}
          measure={grid.measure}
          pageMargins={pageMargins(grid)}
          theme={DEFAULT_THEME}
          typeface={DEFAULT_TYPEFACE}
          spacing={DEFAULT_SPACING}
          align={DEFAULT_ALIGN}
          brightness={stepAt(BRIGHTNESS, BRIGHTNESS.def)}
          contrast={stepAt(CONTRAST, CONTRAST.def)}
          animated
          paginated
          lastLocation={lastLocation}
          onToc={ignore}
          onRelocate={remember}
          onDocument={watchDocument}
          onMeta={ignore}
          onCover={ignore}
          onError={(_generation, message) => setProblem(message)}
          onNavigator={takeNavigator}
          marks={[]}
          onSelection={ignore}
          onMarkDrawn={ignore}
          onLink={ignore}
          onExternalLink={ignore}
          onFootnote={ignore}
          onFileDropped={ignore}
          onPageIntent={turn}
          onFixedLayout={ignore}
          onDirection={ignore}
        />
      </div>
    </main>
  )
}
