import { useEffect, useRef, useState } from 'react'
import type { RelocateDetail, Renderer, TocItem, View } from 'foliate-js/view.js'
import type { Theme } from '../lib/state'
import { MEASURE } from '../lib/metrics'
import type { ReaderPosition } from '../lib/useBook'
import { bookCss } from './bookCss'

export interface FoliateViewProps {
  /**
   * The book to open — a picked/dropped File, or a URL for a book the app
   * already has on disk. Null renders the empty state instead.
   */
  file: File | string | null
  stepIdx: number
  theme: Theme
  paginated: boolean
  onToc: (toc: readonly TocItem[]) => void
  onRelocate: (position: ReaderPosition) => void
  /** Called with each spine item's document as it loads, for the ruler and
   *  selection handling, and again with null when the view is torn down. */
  onDocument: (doc: Document | null) => void
  onError: (message: string) => void
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
   * observed independently — so anything set AFTER flow lands too late and the
   * layout keeps foliate's defaults until something else forces a repaint.
   * Sizing first, flow last.
   *
   * foliate's own margin defaults to 48px and its gap to 7%, both of which eat
   * into the measure. §03 puts the gutter OUTSIDE the text — it is a host grid
   * track where the ruler hint and companion marks live — so letting foliate
   * add its own would double-count it and leave the measure short of the
   * 660/620 the design specifies. */
  /* These values MUST carry a unit.
   *
   * foliate interpolates each attribute straight into a CSS custom property
   * and builds its grid from them:
   *
   *   grid-template-columns: … minmax(0, calc(var(--_max-width) - var(--_gap))) …
   *
   * `calc()` cannot subtract a bare number from a length, so a unitless "0"
   * makes that declaration invalid, the whole grid-template-columns is
   * dropped, and the tracks fall back to auto — sizing to content instead of
   * to the measure. Symptom: the book renders about 420px wide inside a 660px
   * column, with every attribute apparently set correctly and no error
   * anywhere. foliate's own defaults are "7%", "48px" and "720px"; matching
   * that shape is the contract. */
  renderer.setAttribute('margin', '0px')
  renderer.setAttribute('gap', '0px')
  renderer.setAttribute('max-column-count', '1')
  renderer.setAttribute('max-inline-size', `${MEASURE}px`)
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

export function FoliateView({
  file,
  stepIdx,
  theme,
  paginated,
  onToc,
  onRelocate,
  onDocument,
  onError,
}: FoliateViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<View | null>(null)

  /** Bumped once the book is open and `view.renderer` exists. */
  const [ready, setReady] = useState(0)

  /* Callbacks and settings are held in refs so that changing one does not tear
   * the book down and reopen it — reopening loses the reading position. */
  const handlers = useRef({ onToc, onRelocate, onDocument, onError })
  handlers.current = { onToc, onRelocate, onDocument, onError }

  const settings = useRef<Settings>({ stepIdx, theme, paginated })
  settings.current = { stepIdx, theme, paginated }

  useEffect(() => {
    const host = hostRef.current
    if (!host || !file) return

    let disposed = false
    let view: View | null = null

    const open = async () => {
      // Imported for its side effect: defining the <foliate-view> element.
      // Dynamic so the reader's cost is not paid by the library screen.
      await import('foliate-js/view.js')
      if (disposed) return

      view = document.createElement('foliate-view')
      viewRef.current = view
      // Pinned to the host's box rather than sized in percentages: the host is
      // a stretched grid item, and a percentage height against one resolves
      // inconsistently.
      view.style.position = 'absolute'
      view.style.inset = '0'
      host.replaceChildren(view)

      view.addEventListener('load', (event) => {
        const { doc } = (event as CustomEvent<{ doc: Document }>).detail
        handlers.current.onDocument(doc)
      })

      view.addEventListener('relocate', (event) => {
        const detail = (event as CustomEvent<RelocateDetail>).detail
        handlers.current.onRelocate({
          fraction: detail.fraction,
          chapterLabel: detail.tocItem?.label ?? '',
        })
      })

      try {
        await view.open(file)
      } catch (cause) {
        if (disposed) return
        // Fail loud: a book that will not open must say so, not leave an
        // empty column that reads as "this book has no text".
        handlers.current.onError(
          cause instanceof Error ? cause.message : 'This file could not be opened.',
        )
        return
      }
      if (disposed) return

      handlers.current.onToc(view.book.toc ?? [])

      // Settings go on BEFORE the first paint, so the reader never flashes
      // foliate's defaults — paginated, no baseline grid — on the way to the
      // configured layout.
      applySettings(view.renderer, settings.current)

      // `open` parses the book and attaches a renderer but navigates nowhere.
      // Without `init` the view stays empty with a populated table of contents
      // and no iframe, and reports no error to explain it.
      try {
        await view.init({ lastLocation: null, showTextStart: true })
      } catch (cause) {
        if (disposed) return
        handlers.current.onError(
          cause instanceof Error ? cause.message : 'This book could not be displayed.',
        )
        return
      }
      if (disposed) return

      setReady((n) => n + 1)
    }

    // The whole routine is guarded, not just `view.open`: a rejected dynamic
    // import or a custom element that fails to upgrade would otherwise become
    // an unhandled rejection, which surfaces nowhere in a packaged app.
    void open().catch((cause: unknown) => {
      if (disposed) return
      handlers.current.onError(
        cause instanceof Error ? cause.message : 'The reader failed to start.',
      )
    })

    return () => {
      disposed = true
      handlers.current.onDocument(null)
      try {
        view?.close()
      } catch {
        // close() throws if the view never finished opening; nothing to undo.
      }
      viewRef.current = null
      host.replaceChildren()
    }
    // Only the file identity reopens the book. Everything else is applied to
    // the live renderer by the effect below.
  }, [file])

  /* Re-apply on change. Gated on `ready` rather than on `file`, because the
   * renderer does not exist until `open` resolves — an effect keyed on `file`
   * alone runs once, finds nothing, and never runs again. */
  useEffect(() => {
    const renderer = viewRef.current?.renderer
    if (!renderer || ready === 0) return
    applySettings(renderer, { stepIdx, theme, paginated })
  }, [stepIdx, theme, paginated, ready])

  return <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
}
