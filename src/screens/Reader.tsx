import { useCallback, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { Plus } from 'lucide-react'
import type { TocItem } from 'foliate-js/view.js'
import type { Platform } from '../lib/metrics'
import {
  ASIDE_MIN_AVAIL,
  ASIDE_TRACK,
  ASIDE_W,
  ICON,
  PANE_W,
  STAGE_PADDING_X,
  proseGrid,
} from '../lib/metrics'
import type { AppDispatch, AppState } from '../lib/state'
import { useAvailableWidth } from '../lib/useAvailableWidth'
import { AsideCard } from '../aside/AsideCard'
import { FoliateView, type ReaderPosition } from '../reader/FoliateView'
import { ReadingRuler } from '../reader/ReadingRuler'
import styles from './Reader.module.css'

export interface ReaderProps {
  state: AppState
  dispatch: AppDispatch
  platform: Platform
}

/** What the reader accepts. §13's empty state names all four. */
const ACCEPT = '.epub,.pdf,.mobi,.azw3,.cbz,.fb2,.fbz'

/**
 * `?book=<url>` opens a book straight from a URL on load. This is how a book
 * already in the library will be opened once one exists, and in the meantime
 * it is what makes the reader testable without driving a file picker.
 */
function initialBook(): string | null {
  return new URLSearchParams(window.location.search).get('book')
}

export function Reader({ state, dispatch, platform }: ReaderProps) {
  const [file, setFile] = useState<File | string | null>(initialBook)
  const [toc, setToc] = useState<readonly TocItem[]>([])
  const [position, setPosition] = useState<ReaderPosition>({ fraction: 0, chapterLabel: '' })
  const [bookDoc, setBookDoc] = useState<Document | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  const stageRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const windowWidth = useAvailableWidth()
  const available = windowWidth - (state.pane ? PANE_W : 0)

  /* §06: the pane collapses on narrow windows, and the aside card goes with
   * it — a 340px card plus a 620px measure does not fit under 880.
   *
   * With no book open there is nothing for either tab to describe, so the card
   * is withheld rather than shown empty: a Contents pane reading "this book has
   * no table of contents" next to an empty-library message is two different
   * claims about the same absence. */
  const asideOpen =
    file !== null && state.asidePanel !== null && available >= ASIDE_MIN_AVAIL

  // The stage is what is left after the aside card, less its own padding.
  const stageInner = available - (asideOpen ? ASIDE_TRACK : 0) - STAGE_PADDING_X * 2
  const grid = proseGrid(stageInner, asideOpen)
  const gridVars = {
    '--stage-pad-x': `${STAGE_PADDING_X}px`,
    '--track-gutter': `${grid.gutter}px`,
    '--track-measure': `${grid.measure}px`,
    '--track-margin': `${grid.marginCol}px`,
    '--track-gap': `${grid.gap}px`,
  } as CSSProperties

  const openFile = useCallback((next: File) => {
    setError(null)
    setToc([])
    setPosition({ fraction: 0, chapterLabel: '' })
    setFile(next)
  }, [])

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setDragging(false)
      const dropped = event.dataTransfer.files.item(0)
      if (dropped) openFile(dropped)
    },
    [openFile],
  )

  const picker = (
    <input
      ref={inputRef}
      type="file"
      accept={ACCEPT}
      hidden
      onChange={(event) => {
        const picked = event.target.files?.item(0)
        if (picked) openFile(picked)
        // Reset so picking the same file twice still fires a change.
        event.target.value = ''
      }}
    />
  )

  return (
    <div className={styles.reader}>
      {asideOpen && (
        <AsideCard
          platform={platform}
          width={ASIDE_W}
          panel={state.asidePanel ?? 'toc'}
          dispatch={dispatch}
          toc={toc}
          currentChapter={position.chapterLabel}
        />
      )}

      <div className={styles.column} data-platform={platform}>
        {file ? (
          <>
            {/* A book that will not open has to say so. Rendering the stage
                anyway leaves an empty column, which reads as "this book has no
                text" rather than "this book failed to load". */}
            {error && (
              <div className={styles.errorBar}>
                <p className={styles.error}>{error}</p>
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={() => {
                    setError(null)
                    setFile(null)
                  }}
                >
                  Choose another book
                </button>
              </div>
            )}
            <div
              className={styles.stage}
              ref={stageRef}
              data-aside={asideOpen}
              style={gridVars}
            >
              <div className={styles.gutter}>
                <ReadingRuler
                  state={state}
                  dispatch={dispatch}
                  doc={bookDoc}
                  stage={stageRef.current}
                />
              </div>

              <div className={styles.text}>
                <FoliateView
                  file={file}
                  stepIdx={state.stepIdx}
                  theme={state.theme}
                  paginated={state.pageLayout === 'paginated'}
                  asideOpen={asideOpen}
                  onToc={setToc}
                  onRelocate={setPosition}
                  onDocument={setBookDoc}
                  onError={setError}
                />
              </div>

              <div className={styles.margin} />
            </div>

            <div
              className={styles.footer}
              style={{ opacity: state.chromeOn || state.pane ? 1 : 0 }}
            >
              <span>{position.chapterLabel}</span>
              {position.chapterLabel && <span>·</span>}
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {Math.round(position.fraction * 100)}%
              </span>
            </div>
          </>
        ) : (
          <div
            className={styles.empty}
            data-dragging={dragging}
            onDragOver={(event) => {
              event.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <h1 className={styles.emptyTitle}>Your library is empty</h1>
            <p className={styles.emptyBody}>
              Drop an EPUB, PDF, MOBI or CBZ here, or connect a folder to watch.
            </p>
            {error && <p className={styles.error}>{error}</p>}
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => inputRef.current?.click()}
            >
              <Plus size={ICON.control} strokeWidth={ICON.stroke} />
              Add books
            </button>
          </div>
        )}
        {picker}
      </div>
    </div>
  )
}
