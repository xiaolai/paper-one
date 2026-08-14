import { useEffect, useRef, useState } from 'react'
import type { Renderer, TocItem, View } from 'foliate-js/view.js'
import type { Theme } from '../lib/state'
import { measureForStep } from '../lib/metrics'
import type { BookMeta, BookNavigator, ReaderPosition } from '../lib/useBook'
import { isPdf } from '../lib/formats'
import { bookCss, markPalette } from './bookCss'
import { ReaderSession, type MarkAnchor, type SelectionSnapshot } from './session'

export interface FoliateViewProps {
  /**
   * The book to open — a picked/dropped File, or a URL for a book the app
   * already has on disk. Null renders the empty state instead.
   */
  file: File | string | null
  /** Advances on every open; every callback echoes it back so the book store
   *  can drop results from a reader that has since been replaced. */
  generation: number
  stepIdx: number
  theme: Theme
  paginated: boolean
  onToc: (generation: number, toc: readonly TocItem[]) => void
  onRelocate: (generation: number, position: ReaderPosition) => void
  /** Called with each spine item's document as it loads, for the ruler and
   *  selection handling, and again with null when the view is torn down. */
  onDocument: (generation: number, doc: Document | null) => void
  onMeta: (generation: number, meta: BookMeta) => void
  onError: (generation: number, message: string) => void
  /** Publishes navigation once the book is parsed; null on teardown. */
  onNavigator: (navigator: BookNavigator | null) => void
  /**
   * The open book's marks. Read through a ref rather than depended on, so
   * making a mark redraws the overlay without reopening the book.
   */
  marks: readonly MarkAnchor[]
  /** The book's selection, or null when it collapses. */
  onSelection: (selection: SelectionSnapshot | null) => void
  /** A mark was drawn, with the live Range it resolved to. */
  onMarkDrawn: (cfi: string, range: Range) => void
  /** A drawn mark was clicked, identified by its CFI. */
  onMarkActivated: (cfi: string) => void
  /**
   * A book was dropped onto the book itself.
   *
   * The window's own drop handling cannot see this: the reader is iframes once
   * a book is open, and a drop over one goes to that document. Unhandled, the
   * webview navigates to the file and the app is gone.
   */
  onFileDropped: (file: File) => void
}

interface Settings {
  stepIdx: number
  theme: Theme
  paginated: boolean
}

/**
 * Push the reading settings onto a live renderer.
 *
 * `flow` and the measure are ATTRIBUTES — foliate exposes no JS property for
 * them — and `setStyles` is optional because the fixed-layout renderer does
 * not implement it.
 */
function applySettings(renderer: Renderer, settings: Settings): void {
  /* Order matters. `flow` is what triggers the paginator to re-render, and the
   * sizing attributes are read during that render rather than each being
   * observed independently — so anything set AFTER flow lands too late.
   *
   * These values MUST carry a unit. foliate interpolates each attribute into a
   * CSS custom property and builds its grid from them:
   *
   *   grid-template-columns: … minmax(0, calc(var(--_max-width) - var(--_gap))) …
   *
   * `calc()` cannot subtract a bare number from a length, so a unitless "0"
   * invalidates that declaration, the whole grid-template-columns is dropped,
   * and the tracks fall back to auto — sizing to content instead of to the
   * measure, with every attribute apparently correct and no error anywhere. */
  renderer.setAttribute('margin', '0px')
  renderer.setAttribute('gap', '0px')
  renderer.setAttribute('max-column-count', '1')
  // §09 gives every reading step its own measure; a single constant meant
  // changing the size changed the type but never its designed line width.
  renderer.setAttribute('max-inline-size', `${measureForStep(settings.stepIdx)}px`)
  renderer.setAttribute('flow', settings.paginated ? 'paginated' : 'scrolled')
  renderer.setStyles?.(
    bookCss({
      stepIdx: settings.stepIdx,
      theme: settings.theme,
      justify: true,
      hyphenate: true,
    }),
  )
}

/**
 * React binding for the reader.
 *
 * The lifecycle itself lives in `ReaderSession`, deliberately outside React:
 * startup is a chain of awaits that a component can unmount in the middle of,
 * and the disposal races that creates are only verifiable when they are not
 * entangled with rendering. This file is now just the wiring.
 */
export function FoliateView({
  file,
  generation,
  stepIdx,
  theme,
  paginated,
  onToc,
  onRelocate,
  onDocument,
  onMeta,
  onError,
  onNavigator,
  marks,
  onSelection,
  onMarkDrawn,
  onMarkActivated,
  onFileDropped,
}: FoliateViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<ReaderSession | null>(null)

  /** Bumped once the book is open and its renderer exists. */
  const [ready, setReady] = useState(0)

  /* Callbacks and settings live in refs so changing one does not tear the book
   * down and reopen it — reopening loses the reading position. */
  const handlers = useRef({
    onToc,
    onRelocate,
    onDocument,
    onMeta,
    onError,
    onNavigator,
    onSelection,
    onMarkDrawn,
    onMarkActivated,
    onFileDropped,
  })
  handlers.current = {
    onToc,
    onRelocate,
    onDocument,
    onMeta,
    onError,
    onNavigator,
    onSelection,
    onMarkDrawn,
    onMarkActivated,
    onFileDropped,
  }

  /* The same reason as the handlers, and one more: the session reads this back
   * whenever a section's overlay is built, which happens as the reader scrolls
   * — long after any value captured at startup went stale. */
  const marksRef = useRef(marks)
  marksRef.current = marks

  const settings = useRef<Settings>({ stepIdx, theme, paginated })
  settings.current = { stepIdx, theme, paginated }

  useEffect(() => {
    const host = hostRef.current
    if (!host || !file) return

    // The generation this mount belongs to, so every callback reports the book
    // it actually loaded rather than whichever is current when it resolves.
    const gen = generation

    /* Read through the ref on every call, never snapshotted.
     *
     * `const h = handlers.current` captured five of them for the LIFETIME of
     * the session — which is the one thing the callback-ref pattern above
     * exists to prevent. A parent that re-rendered with a new `onRelocate`
     * (which happens on any state change that rebuilds the closure) went on
     * being reported to the old one for as long as the book stayed open, while
     * the four callbacks below it, written the other way, followed correctly.
     * Two conventions in one object literal, and only one of them right. */
    const session = new ReaderSession(host, {
      onToc: (toc) => handlers.current.onToc(gen, toc),
      onRelocate: (position) => handlers.current.onRelocate(gen, position),
      onDocument: (doc) => handlers.current.onDocument(gen, doc),
      onMeta: (meta) => handlers.current.onMeta(gen, meta),
      onError: (message) => handlers.current.onError(gen, message),
      onNavigator: (navigator) => handlers.current.onNavigator(navigator),
      onSelection: (selection) => handlers.current.onSelection(selection),
      onMarkDrawn: (cfi, range) => handlers.current.onMarkDrawn(cfi, range),
      onMarkActivated: (cfi) => handlers.current.onMarkActivated(cfi),
      onFileDropped: (file) => handlers.current.onFileDropped(file),
      getMarks: () => marksRef.current,
      getPalette: () => markPalette(settings.current.theme),
    })
    sessionRef.current = session

    void session
      .start(file, {
        // Imported for its side effect: defining the <foliate-view> element.
        // Dynamic so the reader's cost is not paid by the library screen.
        createView: async () => {
          await import('foliate-js/view.js')
          return document.createElement('foliate-view')
        },
        // Same module graph as the view, so this costs no extra round trip —
        // and having it before the first paint is what stops a section
        // rendering once with no marks and then again with them.
        loadPainters: async () => {
          const { Overlayer } = await import('foliate-js/overlayer.js')
          return { highlight: Overlayer.highlight, underline: Overlayer.underline }
        },
        /* foliate has no PDF loader, so a PDF is turned into a Book — one
         * HTML page per PDF page — and opened through the same view. That is
         * what gives PDFs marks, search, the ruler and reading aloud for free
         * rather than needing a second reader that has none of them. Loaded
         * lazily: pdf.js is half a megabyte and an EPUB must not pay for it. */
        prepare: async (input) => {
          if (!isPdf(input)) return input
          const { makePdf } = await import('./makePdf')
          return makePdf(input, {
            // A PDF page has no text until it is painted, and its overlay is
            // created before that — so marks are re-attached once there is
            // something for their anchors to resolve against.
            onPagePainted: () => sessionRef.current?.redrawMarks(),
          })
        },
        applySettings: (view: View) => applySettings(view.renderer, settings.current),
      })
      .then(() => {
        if (!session.disposed) setReady((n) => n + 1)
      })
      /* `start` reports the failures it expects through `onError`; anything
       * that reaches here is one it did not — a settings call that threw, a
       * callback of ours that did. Unhandled, those surfaced only as an
       * unhandled rejection at the window, leaving the reader looking at an
       * empty stage with nothing said about it. */
      .catch((cause: unknown) => {
        console.error('Paper: the reader failed to start', cause)
        if (!session.disposed) {
          handlers.current.onError(gen, 'The reader failed to start.')
        }
      })

    return () => {
      session.dispose()
      sessionRef.current = null
    }
  }, [file, generation])

  /* Re-apply on change. Gated on `ready` rather than on `file`, because the
   * renderer does not exist until startup resolves — an effect keyed on `file`
   * alone runs once, finds nothing, and never runs again. */
  useEffect(() => {
    const session = sessionRef.current
    const renderer = session?.view?.renderer
    if (!session || !renderer || ready === 0) return
    applySettings(renderer, { stepIdx, theme, paginated })
    /* A theme change reaches the book through `setStyles`, which restyles the
     * document WITHOUT rebuilding the section — so no `create-overlay` fires
     * and the marks keep the colour they were painted in. Changing the step or
     * the flow does rebuild, and re-attaching an already-attached mark replaces
     * it rather than stacking a second copy, so this is safe to run for all
     * three rather than only for the one that needs it. */
    session.redrawMarks()
  }, [stepIdx, theme, paginated, ready])

  return <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
}
