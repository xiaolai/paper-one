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

export function Reader({ content, bookId, name, onClose }: ReaderProps) {
  const [opening, setOpening] = useState<Opening>({ kind: 'locating' })
  const [problem, setProblem] = useState<string | null>(null)
  /* The stage's width decides the measure, and a phone rotates. */
  const [stage, setStage] = useState(() => Math.min(window.innerWidth, 1200))
  const host = useRef<HTMLDivElement | null>(null)

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

      <div className={styles.stage}>
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
          lastLocation={null}
          onToc={ignore}
          onRelocate={ignore}
          onDocument={ignore}
          onMeta={ignore}
          onCover={ignore}
          onError={(_generation, message) => setProblem(message)}
          onNavigator={ignore}
          marks={[]}
          onSelection={ignore}
          onMarkDrawn={ignore}
          onLink={ignore}
          onExternalLink={ignore}
          onFootnote={ignore}
          onFileDropped={ignore}
          onPageIntent={ignore}
          onFixedLayout={ignore}
          onDirection={ignore}
        />
      </div>
    </main>
  )
}
