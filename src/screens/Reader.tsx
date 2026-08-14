import { useCallback, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { Plus } from 'lucide-react'
import type { Platform } from '../lib/metrics'
import { ICON, PANE_TRACK, STAGE_PADDING_X, proseGrid } from '../lib/metrics'
import type { AppDispatch, AppState } from '../lib/state'
import type { Book } from '../lib/useBook'
import { useAvailableWidth } from '../lib/useAvailableWidth'
import { FoliateView } from '../reader/FoliateView'
import { ReadingRuler } from '../reader/ReadingRuler'
import styles from './Reader.module.css'

export interface ReaderProps {
  state: AppState
  dispatch: AppDispatch
  platform: Platform
  book: Book
}

/** What the reader accepts. §13's empty state names all four. */
const ACCEPT = '.epub,.pdf,.mobi,.azw3,.cbz,.fb2,.fbz'

export function Reader({ state, dispatch, platform, book }: ReaderProps) {
  const [dragging, setDragging] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const windowWidth = useAvailableWidth()
  const available = windowWidth - (state.pane ? PANE_TRACK : 0)

  // The stage is what is left after the pane, less its own padding. The margin
  // column is only reserved once the book has marks to put in it.
  const grid = proseGrid(available - STAGE_PADDING_X * 2, book.markCount > 0)
  const gridVars = {
    '--stage-pad-x': `${STAGE_PADDING_X}px`,
    '--track-gutter': `${grid.gutter}px`,
    '--track-measure': `${grid.measure}px`,
    '--track-margin': `${grid.marginCol}px`,
    '--track-gap': `${grid.gap}px`,
  } as CSSProperties

  const { open } = book
  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setDragging(false)
      const dropped = event.dataTransfer.files.item(0)
      if (dropped) open(dropped)
    },
    [open],
  )

  const picker = (
    <input
      ref={inputRef}
      type="file"
      accept={ACCEPT}
      hidden
      onChange={(event) => {
        const picked = event.target.files?.item(0)
        if (picked) open(picked)
        // Reset so picking the same file twice still fires a change.
        event.target.value = ''
      }}
    />
  )

  return (
    <div className={styles.reader}>
      <div className={styles.column} data-platform={platform}>
        {book.source ? (
          <>
            {/* A book that will not open has to say so. Rendering the stage
                anyway leaves an empty column, which reads as "this book has no
                text" rather than "this book failed to load". */}
            {book.error && (
              <div className={styles.errorBar}>
                <p className={styles.error}>{book.error}</p>
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={() => book.close()}
                >
                  Choose another book
                </button>
              </div>
            )}

            <div
              className={styles.stage}
              ref={stageRef}
              style={gridVars}
            >
              <div className={styles.gutter}>
                <ReadingRuler
                  state={state}
                  dispatch={dispatch}
                  doc={book.doc}
                  stage={stageRef.current}
                />
              </div>

              <div className={styles.text}>
                <FoliateView
                  file={book.source}
                  stepIdx={state.stepIdx}
                  theme={state.theme}
                  paginated={state.pageLayout === 'paginated'}
                  onToc={book.setToc}
                  onRelocate={book.setPosition}
                  onDocument={book.setDoc}
                  onError={book.fail}
                />
              </div>

              <div className={styles.margin} />
            </div>

            <div
              className={styles.footer}
              style={{ opacity: state.chromeOn || state.pane ? 1 : 0 }}
            >
              <span>{book.position.chapterLabel}</span>
              {book.position.chapterLabel && <span>·</span>}
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {Math.round(book.position.fraction * 100)}%
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
            {book.error && <p className={styles.error}>{book.error}</p>}
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
