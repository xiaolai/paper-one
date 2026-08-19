import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Renderer, TocItem, View } from 'foliate-js/view.js'
import type { MarkPainter } from 'foliate-js/overlayer.js'
import type { Align, SpacingIndices, Theme, Typeface } from '../lib/state'
import type { BookMeta, BookNavigator, ReaderPosition } from '../lib/useBook'
import { useFontsReady } from '../lib/fontProbe'
import { isPdf } from '../lib/formats'
import { bookCss, markPalette } from './bookCss'
import { balanceRects } from './markGeometry'
import { ReaderSession, type MarkAnchor, type SelectionSnapshot } from './session'
import type { PageIntent } from './wheelPaging'

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
  /**
   * The measure the GRID actually settled on, which is not always the one
   * the reading step asks for — see `proseGrid`, which shrinks it when the
   * stage cannot hold it.
   */
  measure: number
  theme: Theme
  /** The face the BOOK is set in — never the interface's. */
  typeface: Typeface
  /** How open the type is set — see `SPACING`. */
  spacing: SpacingIndices
  /** Justified, or flush to the reading edge. */
  align: Align
  /** The reader's brightness and contrast, resolved — see `bookColours`. */
  brightness: number
  contrast: number
  /** False only when the system asks for reduced motion. Not a preference. */
  animated: boolean
  paginated: boolean
  /**
   * Where this book was last left, or null to open at the start.
   *
   * Read once, when the book finishes parsing — never depended on, for the
   * reason the note on the refs below gives: this value CHANGES as the reader
   * reads, and a book that reopened every time it did would be a book that
   * could not be read at all.
   */
  lastLocation: string | null
  onToc: (generation: number, toc: readonly TocItem[]) => void
  onRelocate: (generation: number, position: ReaderPosition) => void
  /** Called with each spine item's document as it loads, for the ruler and
   *  selection handling, and again with null when the view is torn down. */
  onDocument: (generation: number, doc: Document | null) => void
  onMeta: (generation: number, meta: BookMeta) => void
  /** The book's jacket, or null — see `SessionCallbacks.onCover`. */
  onCover: (generation: number, cover: Blob | null) => void
  onError: (generation: number, message: string) => void
  /** Publishes navigation once the book is parsed; null on teardown. */
  onNavigator: (generation: number, navigator: BookNavigator | null) => void
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
  /**
   * A book was dropped onto the book itself.
   *
   * The window's own drop handling cannot see this: the reader is iframes once
   * a book is open, and a drop over one goes to that document. Unhandled, the
   * webview navigates to the file and the app is gone.
   */
  onFileDropped: (file: File) => void
  /** A wheel gesture asked for another page — see `wheelPaging`. */
  onPageIntent: (intent: PageIntent) => void
  /** The book cannot reflow, so the controls that assume it can must not show. */
  onFixedLayout: (generation: number, fixed: boolean) => void
}

interface Settings {
  stepIdx: number
  /** How open the type is set — see `SPACING`. */
  spacing: SpacingIndices
  /** Justified, or flush to the reading edge. */
  align: Align
  /** Resolved brightness and contrast — see `bookColours`. */
  brightness: number
  contrast: number
  measure: number
  theme: Theme
  typeface: Typeface
  paginated: boolean
  /**
   * Whether a page turn slides.
   *
   * Always true, except for a reader whose system asks for less movement — see
   * `usePrefersReducedMotion`. There is no setting behind this: the slide is the
   * behaviour, not one of several.
   */
  animated: boolean
}

/**
 * Push the reading settings onto a live renderer.
 *
 * `flow` and the measure are ATTRIBUTES — foliate exposes no JS property for
 * them — and `setStyles` is optional because the fixed-layout renderer does
 * not implement it.
 */
export function applySettings(renderer: Renderer, settings: Settings): void {
  applyLayout(renderer, settings)
  renderer.setStyles?.(
    bookCss({
      stepIdx: settings.stepIdx,
      theme: settings.theme,
      typeface: settings.typeface,
      spacing: settings.spacing,
      brightness: settings.brightness,
      contrast: settings.contrast,
      align: settings.align,
    }),
  )
}

/**
 * The renderer's layout ATTRIBUTES, separately from the stylesheet.
 *
 * Split out because the two are different kinds of thing and only one of them
 * needs a document: the attributes are a handful of strings, while the
 * stylesheet is built by `bookCss`, which reads the host's own `@font-face`
 * rules out of `document.styleSheets` to copy them into the book. Keeping them
 * in one function meant the attribute contract — including whether the page
 * turn animates at all — could only be exercised somewhere with a DOM.
 */
export function applyLayout(renderer: Renderer, settings: Settings): void {
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
  /* THE MEASURE THE GRID SETTLED ON, not the one the reading step asks for.
   *
   * §09 gives every step its own measure and this read it directly, which is
   * right only while the stage can afford it. `proseGrid` shrinks the measure
   * when it cannot — after the margin column and the gutter have already given
   * what they can — and nothing told foliate. So the grid reserved a 24px
   * gutter, the renderer went on laying text out at the step's full width, and
   * the text was drawn straight over the gutter the grid had just protected:
   * measured at a 760px window, a 688px renderer with `max-inline-size: 700`
   * and zero space either side of the words.
   *
   * That is the same edge-to-edge symptom the pane threshold fixed from the
   * other direction, and it survived that fix because the grid was never what
   * drew the text. One number, computed once in `Reader`, now reaches both. */
  // FLOORED, not rounded: a rounded-up value can exceed the fractional width
  // the grid actually allocated, by up to half a pixel — which is a column
  // break's worth on a paginated page. Floor never asks for more than exists.
  renderer.setAttribute('max-inline-size', `${Math.floor(settings.measure)}px`)
  /* The page slide, which foliate has always been able to do and Paper never
   * asked for: `#scrollTo` eases over 300ms when this attribute is present and
   * jumps when it is not. It was `0ms` in §08's motion table for exactly as long
   * as nothing set this.
   *
   * `toggleAttribute` rather than `setAttribute`, because foliate tests for
   * PRESENCE — `hasAttribute('animated')` — so `animated="false"` would animate.
   *
   * WHAT THIS DOES NOT COVER, because the claim was made too broadly at first:
   * only the reflowable paginator reads this. A PDF is rendered by
   * `foliate-fxl`, which never looks at the attribute and swaps spreads
   * immediately, and a turn that crosses into a different spine item is a load
   * rather than a scroll and does not ease either. So: page turns WITHIN a
   * reflowable section slide. Everything else still jumps, and making those
   * animate is a change to the fork. */
  renderer.toggleAttribute('animated', settings.animated)
  /* ONE SETTING, TWO RENDERERS, and this pair of lines is the whole of it.
   *
   * The reflowable paginator reads `flow` and has never read `zoom`;
   * `foliate-fxl` reads `zoom` and has never read `flow` — its
   * `observedAttributes` is `['zoom']`. So both are derived from the same
   * boolean and each renderer picks up the one it understands. No branch on the
   * book type, and no way for the two to disagree. They are not WRITTEN the same
   * way — `flow` every time, `zoom` only when it changes — and the note at the
   * write itself says why that asymmetry is deliberate.
   *
   * What `zoom` means here is not a zoom control. `fit-page` scales a page so
   * the whole of it is visible, which is a paged reading experience; `fit-width`
   * scales it to the viewport's width, so a portrait page overflows and the
   * renderer — `:host { overflow: auto }` — scrolls it. That IS a PDF's scroll
   * mode, and it was always there. Paper simply never set the attribute, so
   * every PDF sat on fxl's implicit fit-page default and the Flow control had
   * nothing to change.
   *
   * The attempt before this one made the PDF `reflowable` instead, to put it on
   * the paginator. That was wrong in a way worth recording: the paginator
   * columnises the loaded document by the READING MEASURE, so a rigid page
   * canvas was laid out inside a ~600px text column and drew at half the
   * window. It also measures the document to size the scrollport, and a PDF
   * page paints asynchronously — so it measured an empty document and there was
   * nothing to scroll. Both modes came out broken. A fixed-size page belongs in
   * the fixed-layout renderer; the mistake was reaching for flow when the
   * renderer already had the concept under a different name. */
  renderer.setAttribute('flow', settings.paginated ? 'paginated' : 'scrolled')

  /* `zoom` is written only when it CHANGES, and `flow` deliberately is not.
   *
   * `attributeChangedCallback` fires on every `setAttribute`, not only on ones
   * that alter the value — so rewriting `zoom` unconditionally re-ran fxl's
   * `#render`, which calls back into `makePdf`'s `onZoom` and REPAINTS EVERY
   * PDF PAGE. Changing the theme, or the typeface, or the reading size — none
   * of which mean anything to a fixed-layout book — threw away a page render
   * and its text layer and did them again.
   *
   * The asymmetry is not an oversight. `flow` being written every time is what
   * makes the paginator re-render, and the sizing attributes above are read
   * during that render rather than observed on their own: guard `flow` too and
   * a type-size change would set `max-inline-size` with nothing to act on it,
   * leaving the measure stale until something else moved. So the reflowable
   * side keeps its unconditional write, and only the fixed-layout side — where
   * no other attribute matters and the cost of a needless render is a repaint
   * of the whole page — is guarded. */
  const zoom = settings.paginated ? 'fit-page' : 'fit-width'
  if (renderer.getAttribute('zoom') !== zoom) renderer.setAttribute('zoom', zoom)
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
  measure,
  theme,
  typeface,
  spacing,
  align,
  brightness,
  contrast,
  animated,
  paginated,
  lastLocation,
  onToc,
  onRelocate,
  onDocument,
  onMeta,
  onCover,
  onError,
  onNavigator,
  marks,
  onSelection,
  onMarkDrawn,
  onFileDropped,
  onPageIntent,
  onFixedLayout,
}: FoliateViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<ReaderSession | null>(null)

  /** Bumped once the book is open and its renderer exists. */
  const [ready, setReady] = useState(0)
  const fontsReady = useFontsReady()

  /* Callbacks and settings live in refs so changing one does not tear the book
   * down and reopen it — reopening loses the reading position.
   *
   * Built ONCE and committed in a layout effect, for two reasons. The object
   * used to be written out twice, so adding a callback to one copy and not the
   * other produced exactly the stale handler this file warns about further
   * down. And assigning during render published values from a render React may
   * still abandon: under a concurrent or discarded render the live session
   * could read a callback belonging to a tree that never committed. A layout
   * effect runs after commit and before the session-creating effect below, so
   * the session never sees an uncommitted value and never sees a missing one.
   */
  const currentHandlers = {
    onToc,
    onRelocate,
    onDocument,
    onMeta,
    onCover,
    onError,
    onNavigator,
    onSelection,
    onMarkDrawn,
    onFileDropped,
    onPageIntent,
    onFixedLayout,
  }
  const handlers = useRef(currentHandlers)

  /* The same reason as the handlers, and one more: the session reads this back
   * whenever a section's overlay is built, which happens as the reader scrolls
   * — long after any value captured at startup went stale. */
  const marksRef = useRef(marks)
  const settings = useRef<Settings>({ stepIdx, measure, theme, typeface, spacing, align, brightness, contrast, animated, paginated })
  /* Through a ref for the same reason, and for one that is specific to it: the
   * saved position is derived from the book's content id, which resolves a few
   * milliseconds AFTER the reader mounts. A prop read at mount is read before
   * the answer exists; the session reads this once, after the book is parsed. */
  const lastLocationRef = useRef(lastLocation)

  /* All four refs commit together, after render — see the note on `handlers`.
   * `useLayoutEffect` rather than `useEffect` because it runs before the
   * session-creating effect below, so startup reads current values rather than
   * the ones this component mounted with. */
  useLayoutEffect(() => {
    handlers.current = currentHandlers
    marksRef.current = marks
    settings.current = { stepIdx, measure, theme, typeface, spacing, align, brightness, contrast, animated, paginated }
    lastLocationRef.current = lastLocation
  })

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
      onCover: (cover) => handlers.current.onCover(gen, cover),
      onError: (message) => handlers.current.onError(gen, message),
      onNavigator: (navigator) => handlers.current.onNavigator(gen, navigator),
      onSelection: (selection) => handlers.current.onSelection(selection),
      onMarkDrawn: (cfi, range) => handlers.current.onMarkDrawn(cfi, range),
      onFileDropped: (file) => handlers.current.onFileDropped(file),
      onPageIntent: (intent) => handlers.current.onPageIntent(intent),
      onFixedLayout: (fixed) => handlers.current.onFixedLayout(gen, fixed),
      getMarks: () => marksRef.current,
      getPalette: () =>
        markPalette(
          settings.current.theme,
          settings.current.brightness,
          settings.current.contrast,
        ),
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
          return {
            /* foliate's own painter, handed rects that have been moved onto
             * the words first. Composed rather than replaced: the SVG it
             * builds is what reads the blend-mode and opacity properties, and
             * reimplementing it here would fork that quietly. */
            // Options are OPTIONAL in foliate's painter contract; requiring
            // them here would have thrown on any caller that omitted them.
            // `rects` arrives as a `DOMRectList` — foliate hands over
            // `range.getClientRects()` untouched — so it is materialised
            // before the geometry sees it. See `MarkPainter`.
            fill: ((rects, options = {}) =>
              Overlayer.highlight(
                balanceRects(Array.from(rects), options.doc ?? null, options.at ?? null),
                options,
              )) satisfies MarkPainter,
            underline: Overlayer.underline,
            // The Overlayer's own name for the wavy rule. Renamed at this seam
            // because "squiggly" is foliate's word and §15's is "wave".
            wave: Overlayer.squiggly,
          }
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
            /* `session`, not `sessionRef.current`. A PDF page can finish
             * painting after its book has been replaced, and the ref by then
             * holds the NEW session — so a late paint from a disposed book
             * redrew the marks of whatever is on screen now. `redrawMarks`
             * already ignores a disposed session, so capturing it directly is
             * both narrower and self-cancelling. */
            onPagePainted: () => session.redrawMarks(),
          })
        },
        applySettings: (view: View) => applySettings(view.renderer, settings.current),
        lastLocation: () => lastLocationRef.current,
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
    /* Guarded exactly as startup guards the same call. `start` treats
     * `applySettings` as fallible and routes its failure through `onError`;
     * here it was bare, so a renderer that threw on a settings change escaped
     * the effect and unmounted the React tree — the reader vanished instead of
     * the theme failing to change. */
    try {
      applySettings(renderer, { stepIdx, measure: settings.current.measure, theme, typeface, spacing, align, brightness, contrast, animated, paginated })
      /* A theme change reaches the book through `setStyles`, which restyles the
       * document WITHOUT rebuilding the section — so no `create-overlay` fires
       * and the marks keep the colour they were painted in. Changing the step or
       * the flow does rebuild, and re-attaching an already-attached mark replaces
       * it rather than stacking a second copy, so this is safe to run for all
       * three rather than only for the one that needs it. */
      session.redrawMarks()
    } catch (cause) {
      console.error('Paper: applying reader settings failed', cause)
      handlers.current.onError(generation, 'That setting could not be applied.')
    }
    /* `measure` is deliberately NOT a dependency here — see the effect below.
     * It is read through the ref so a settings change carries the current
     * measure without this effect re-running for measure alone. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    /* `fontsReady` is in here so the book is re-set once webfonts land. The
     * size a face is given is corrected by that face's x-height, and before its
     * webfont arrives the stack resolves to a fallback whose x-height is
     * somebody else's — a book opened during startup would otherwise keep a
     * size measured off Georgia until the reader changed some other setting. */
    /* `spacing` is here because it is part of the stylesheet: without it the
     * settings were re-applied for a theme or a face and not for the four
     * controls that change how the type is set, so the pips moved and the page
     * did not. Its identity is stable — the reducer returns the SAME state when
     * a spacing has not moved — so depending on the object cannot loop. */
  }, [stepIdx, theme, typeface, spacing, align, brightness, contrast, animated, paginated, ready, generation, fontsReady])

  /* THE MEASURE ALONE, and only the layout attributes for it.
   *
   * The measure changes on every frame of a pane opening — 220ms of it — and it
   * was in the effect above, so each frame rebuilt the whole book stylesheet
   * (`bookCss` reads the host's `@font-face` rules out of `document.styleSheets`
   * every time) and redrew every mark, for a change `bookCss` does not even
   * take. Foliate re-renders on the attribute regardless; the stylesheet and
   * the marks were pure waste, a dozen times over per animation. */
  useEffect(() => {
    const session = sessionRef.current
    const renderer = session?.view?.renderer
    if (!session || !renderer || ready === 0) return
    try {
      applyLayout(renderer, settings.current)
    } catch (cause) {
      console.error('Paper: applying the measure failed', cause)
      handlers.current.onError(generation, 'That setting could not be applied.')
    }
  }, [measure, ready, generation])

  /* Redraw when the MARKS change, not only when a setting does.
   *
   * They are read through a ref, so nothing re-ran when they arrived — and they
   * arrive asynchronously, one file read after the book opens. A section drawn
   * before that read landed stayed unannotated until something else happened to
   * rebuild it: the reader's own highlights, invisible in the book they are in.
   *
   * `redrawMarks` only walks the sections currently on screen, and re-attaching
   * an already-attached mark replaces it rather than stacking a second copy, so
   * running this on every change costs nothing and needs no diff. */
  useEffect(() => {
    const session = sessionRef.current
    if (!session || ready === 0) return
    try {
      session.redrawMarks()
    } catch (cause) {
      console.error('Paper: could not draw the marks', cause)
    }
  }, [marks, ready])

  return <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
}
